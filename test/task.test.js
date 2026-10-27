import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../task-store.js'
import { createTaskTools } from '../task-tools.js'

/**
 * 一个原生执行端替身:记录派发了什么、被中断了什么,不连真宿主。
 *
 * 它就是 task-tools 唯一依赖的执行边界 —— startActivation / interrupt /
 * listChildren。替身能让"只派发一次""重启不重放"这类断言变成对调用次数的
 * 检查,而不是对真实后台会话的猜测。
 */
function fakeSubagents({ childId = 'child-1', children } = {}) {
  const calls = { start: [], interrupt: [], list: 0 }
  const service = {
    async startActivation(input) {
      calls.start.push(input)
      return { childId }
    },
    async interrupt(id, parent) {
      calls.interrupt.push({ id, parent })
    },
    async listChildren() {
      calls.list += 1
      return children ?? []
    },
  }
  return { service, calls }
}

/** 一个最小 agent:自己的 ctx 能取到 subagents 替身。 */
function makeAgent(sessionId, subagents) {
  return {
    session: { id: sessionId },
    ctx: { get: name => (name === 'subagents' ? subagents.service : undefined) },
  }
}

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new TaskStore({ statePath: join(root, 'tasks.json'), logger: { warn() {}, info() {} } })
  await store.open()
  return { root, store }
}

const quiet = { warn() {}, info() {}, error() {} }

test('同一幂等键重放返回同一 taskId 且只派发一次', async t => {
  const { store } = await makeStore(t)
  const subagents = fakeSubagents()
  const agent = makeAgent('qq-owner', subagents)
  const tools = createTaskTools({ store, config: { owner: 'owner-1' }, logger: quiet })

  // 同一次工具调用(同 callId、同源轮次)重放:模型重试或宿主重投都会走到这里。
  const exec = { agent, callId: 'call-1', rootCallId: 'turn-1' }
  const first = await tools.definitions[0].execute({ action: 'start', goal: '整理下载目录' }, exec)
  const second = await tools.definitions[0].execute({ action: 'start', goal: '整理下载目录' }, exec)

  assert.equal(second.task_id, first.task_id, '重放必须返回原任务')
  assert.equal(second.replay, true)
  assert.equal(subagents.calls.start.length, 1, '重放不得二次派发')

  // 同一句话换一个轮次就是新任务:幂等键绑定的是轮次,不是句子。
  const next = await tools.definitions[0].execute(
    { action: 'start', goal: '整理下载目录' },
    { agent, callId: 'call-2', rootCallId: 'turn-2' },
  )
  assert.notEqual(next.task_id, first.task_id)
  assert.equal(subagents.calls.start.length, 2)

  // 走一次终态,确认结果能落到台账并进入待通知队列。
  await tools.onSubagentEnd(
    { id: 'child-1', stopReason: 'completed', lastAssistantMessage: { content: [{ type: 'text', text: '已整理 12 个文件' }] } },
    agent,
  )
  const settled = store.get(first.task_id)
  assert.equal(settled.status, 'completed')
  assert.match(settled.resultSummary, /已整理 12 个文件/)
  assert.equal(store.get(next.task_id).status, 'running', '只结算匹配到的那个子会话')
  assert.deepEqual(store.pendingNotifications().map(task => task.taskId), [first.task_id])
})

test('recover() 把 running/queued 改成 interrupted/unknown 且不重新派发', async t => {
  const { root, store } = await makeStore(t)
  const subagents = fakeSubagents({ childId: 'child-9' })
  const agent = makeAgent('qq-owner', subagents)
  const tools = createTaskTools({ store, config: { owner: 'owner-1' }, logger: quiet })

  // 一条已经派发出子会话(running),一条在派发中途崩溃(仍是 queued)。
  const started = await tools.definitions[0].execute(
    { action: 'start', goal: '跑一次构建' },
    { agent, callId: 'call-a', rootCallId: 'turn-a' },
  )
  const queued = await store.reserve('crashed-key', {
    owner: 'owner-1', qqSessionId: 'qq-1', sourceTurnRequestId: 'turn-b', parentSessionId: 'qq-owner',
  })
  assert.equal(subagents.calls.start.length, 1)

  // 模拟重启:新进程重新读同一个台账。
  const reopened = new TaskStore({ statePath: join(root, 'tasks.json'), logger: quiet })
  await reopened.open()
  const touched = await reopened.recover()

  assert.equal(reopened.get(started.task_id).status, 'interrupted')
  assert.equal(reopened.get(queued.task.taskId).status, 'unknown')
  assert.deepEqual(touched.map(row => row.to).sort(), ['interrupted', 'unknown'])
  // 关键:重启不重放。派发次数还是 1,没有新增 startActivation。
  assert.equal(subagents.calls.start.length, 1)
  assert.equal(Object.values(reopened.state.tasks).filter(task => task.status === 'running').length, 0)

  // 收敛结果落盘,第二次 recover 不再改动已完成的任务。
  const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8'))
  assert.equal(saved.tasks[started.task_id].status, 'interrupted')
  assert.deepEqual(await reopened.recover(), [])
})

test('非本人 owner 的 status/cancel 被拒', async t => {
  const { store } = await makeStore(t)
  const subagents = fakeSubagents()
  const owner = makeAgent('qq-owner', subagents)
  const stranger = makeAgent('qq-stranger', subagents)
  let current = 'owner-1'
  const tools = createTaskTools({
    store,
    config: { ownerOf: () => current },
    logger: quiet,
  })

  const started = await tools.definitions[0].execute(
    { action: 'start', goal: '查一下今天的天气' },
    { agent: owner, callId: 'call-1', rootCallId: 'turn-1' },
  )

  current = 'owner-2'
  const peek = await tools.definitions[0].execute({ action: 'status', task_id: started.task_id }, { agent: stranger })
  assert.equal(peek.status, 'denied')
  // 列表也不能泄露别人的任务。
  const listed = await tools.definitions[0].execute({ action: 'status' }, { agent: stranger })
  assert.deepEqual(listed.tasks, [])

  const stop = await tools.definitions[0].execute({ action: 'cancel', task_id: started.task_id }, { agent: stranger })
  assert.equal(stop.status, 'denied')
  assert.equal(subagents.calls.interrupt.length, 0, '别人的任务不得被中断')
  assert.equal(store.get(started.task_id).status, 'running', '被拒的取消不得改动状态')

  // 主人自己做同样的事就能通过。
  current = 'owner-1'
  const mine = await tools.definitions[0].execute({ action: 'status', task_id: started.task_id }, { agent: owner })
  assert.equal(mine.task_id, started.task_id)
  assert.equal(mine.childSessionId, 'child-1')
})
