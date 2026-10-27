import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpellRunner, startWorker } from '../spell-runner.js'

const message = text => ({ content: [{ type: 'reasoning', text: '<执行>ignore</执行>' }, { type: 'text', text }] })
const agent = id => ({ session: { id } })

test('serial casts preserve order, deduplicate session/seq and return real sourced feedback', async () => {
  const ran = [], feedback = []
  let active = 0
  const runner = new SpellRunner({
    runSpell: async cast => { assert.equal(active++, 0); await new Promise(r => setTimeout(r, 5)); ran.push(cast.body); active--; return cast.body },
    followupOf: owner => reply => feedback.push({ owner, reply }),
  })
  const a = agent('qq-a'), b = agent('qq-b')
  const first = runner.handleAssistantMessage(a, message('<执行>one</执行><读取>two</读取>'), 1)
  const duplicate = runner.handleAssistantMessage(a, message('<执行>one</执行>'), 1)
  const second = runner.handleAssistantMessage(b, message('<执行>three</执行>'), 1)
  await Promise.all([first, duplicate, second])
  assert.deepEqual(ran, ['one', 'two', 'three'])
  assert.equal(feedback.length, 2)
  assert.equal(feedback[0].reply.source.kind, 'companion-spell')
  assert.ok(feedback[0].reply.id)
  assert.match(feedback[0].reply.content[0].text, /【终端反馈·执行】\none[\s\S]*【终端反馈·读取】\ntwo/)
  await runner.dispose()
})

test('errors are reported; absent, incomplete, expired and destroyed casts never wake the main session', async () => {
  let calls = 0, time = 0
  const feedback = [], abandoned = []
  let resolve
  const runner = new SpellRunner({ now: () => time,
    runSpell: async cast => { calls++; if (cast.body === 'fail') throw new Error('真实错误'); await new Promise(r => { resolve = r }); return 'done' },
    followupOf: () => reply => feedback.push(reply),
    onAbandoned: (owner, results) => { abandoned.push({ owner, results }) },
  })
  const a = agent('qq-a')
  await runner.handleAssistantMessage(a, message('闲聊'), 1)
  await runner.handleAssistantMessage(a, message('<执行>没闭合'), 2)
  assert.equal(calls, 0)
  await runner.handleAssistantMessage(a, message('<执行>fail</执行>'), 3)
  assert.match(feedback[0].content[0].text, /失败：真实错误/)
  const destroyed = runner.handleAssistantMessage(a, message('<执行>wait</执行>'), 4)
  await new Promise(r => setImmediate(r))
  runner.detach(a); resolve(); await destroyed
  assert.equal(feedback.length, 1)
  // 会话没了不等于结果没了:交给补投,而不是丢弃。
  assert.equal(abandoned.length, 1)
  assert.equal(abandoned[0].owner, a)
  assert.equal(abandoned[0].results[0].text, 'done')
  const expired = runner.handleAssistantMessage(a, message('<执行>wait</执行>'), 5)
  await new Promise(r => setImmediate(r))
  // 半小时是回填上限;超过之后不再叫醒主会话,同样改走补投。
  time = 1800001; resolve(); await expired
  assert.equal(feedback.length, 1)
  assert.equal(abandoned.length, 2)
  await runner.dispose()
})

test('standard workers have no preset, extract final text, dispose on failure and cancel on timeout', async () => {
  let options, sent, disposed = 0, cancelled = 0
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: message('{"ok":true,"text":"actual output"}') } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const restrictions = [], mounted = []
  const handle = { agent: { session: { snapshotEvents: () => events }, followup(input) { sent = input },
    async whenIdle() {}, cancel() { cancelled++ },
    ctx: { tools: { restrict(filter) { restrictions.push(filter) } } } },
    async dispose() { disposed++ } }
  // 工具来自 preset:没有注册表的工作会话只能查会话历史,连命令都跑不了。
  const registry = { async mount(scope, id) { mounted.push(id); return { id } } }
  const tools = { view: () => ({ visible: new Map([['pwsh', {}], ['read', {}]]) }) }
  const ctx = { get: name => name === 'agentPresets' ? registry : name === 'tools' ? tools
    : { async create(value) { options = value; return handle } } }
  const request = { prompt: 'echo hi', provider: 'p', model: 'm', cwd: process.cwd() }
  assert.equal(await startWorker(ctx, request), 'actual output')
  // preset 挂在 agent 作用域上;meta.agentPreset 只是记录,不触发挂载。
  assert.deepEqual(mounted, ['standard'])
  assert.equal(options.meta.agentPreset, undefined)
  assert.match(options.sessionId, /^companion-spell-/)
  assert.deepEqual(options.agentOptions, { provider: 'p', model: 'm' })
  assert.equal(sent.source.kind, 'companion-spell')
  // working_directory 曾在真实会话里把 worker 卡进死循环(355 次调用/零次 pwsh),
  // 所以在建会话时就要摘掉它,而不是等它自己停下来。
  assert.deepEqual(restrictions, [{ deny: ['working_directory'] }])
  events[0].data.message = message('{"ok":false,"text":"command exit 1"}')
  await assert.rejects(startWorker(ctx, request), /command exit 1/)
  events[0].data.message = message('没有执行')
  await assert.rejects(startWorker(ctx, request), /JSON/)
  events.at(-1).data.reason = { kind: 'error', error: { message: 'worker failed' } }
  await assert.rejects(startWorker(ctx, request), /worker failed/)
  handle.agent.whenIdle = () => new Promise(() => {})
  const keepAlive = setInterval(() => {}, 1000)
  try { await assert.rejects(startWorker(ctx, { ...request, timeoutMs: 10 }), /超时/) }
  finally { clearInterval(keepAlive) }
  assert.equal(cancelled, 1)
  assert.equal(disposed, 5)
})
