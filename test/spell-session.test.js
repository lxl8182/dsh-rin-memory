import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRuntime } from '../index.js'
import { normalizeConfig } from '../config.js'
import { MainSessionScope } from '../main-session.js'

test('friend and group chat keep separate public voices and tool isolation with memory off', async () => {
  const f = fixture()
  f.runtime.client.request = async path => {
    assert.equal(path, '/v1/qq/persona')
    return { text: '铃芽的好友私聊人设' }
  }
  f.runtime.bridge = { binding: id => ({ owner: id === 'qq-group', scope: id === 'qq-group' ? 'group' : 'private' }) }
  const history = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message-${index}` }))
  for (const id of ['qq-friend-a', 'qq-friend-b', 'qq-group']) {
    const main = f.agent(id)
    f.runtime.observeAgent(main)
    const admission = { sessionId: id, owner: id === 'qq-group', scope: id === 'qq-group' ? 'group' : 'private', userId: 42 }
    await f.runtime.prepareBridgeInput(admission)
    assert.equal(admission.chatOnlyReady, true)
    const scope = f.runtime.chatScopes.get(main)
    assert.ok(scope)
    const shaped = await scope.shapeAssembly({}, async () => ({ messages: history, contexts: [{ text: 'runtime' }],
      sections: [{ name: 'deployment:persona-prefix', text: '公开的QQ角色' }, { name: 'coding', text: '工作说明' }],
      tools: [{ name: 'pwsh' }] }))
    assert.equal(shaped.messages, history)
    assert.equal(shaped.messages.length, 80)
    assert.deepEqual(shaped.tools, [])
    assert.deepEqual(shaped.contexts, [])
    assert.equal(shaped.sections[0].text, id === 'qq-group' ? '公开的QQ角色' : '铃芽的好友私聊人设')
    assert.doesNotMatch(JSON.stringify(shaped.sections), /魔法|读取|翻本子|执行|工作说明|本地完整人格/)
    assert.equal(f.runtime.spellScopes.has(main), false)
    assert.equal(f.runtime.attached.has(main), false)
    f.emit(main, '<执行>echo secret</执行>', 1)
    f.runtime.detach(main)
    assert.equal(f.runtime.chatScopes.has(main), false)
  }
  await f.runtime.spellRunner.tail
  assert.equal(f.workers.length, 0)
  await f.runtime.spellRunner.dispose()
})

test('QQ scope skips native pressure and overflow compression; workers and unload preserve the native policy', async () => {
  const calls = []
  const native = async (agent, trigger) => { calls.push([agent.session.id, trigger]); return 'native' }
  const service = { compactIfNeeded: native }
  const agent = { session: { id: 'qq-compaction-guard' }, ctx: {
    on: () => () => {}, get: () => service, tools: { guard: () => () => {} },
  } }
  const scope = new MainSessionScope(agent, { logger: { warn() {} } })
  assert.equal(scope.install(), true)
  assert.equal(await service.compactIfNeeded(agent, 'pressure'), null)
  assert.equal(await service.compactIfNeeded(agent, 'context-overflow'), null)
  assert.equal(await service.compactIfNeeded({ session: { id: 'worker' } }, 'pressure'), 'native')
  assert.deepEqual(calls, [['worker', 'pressure']])
  scope.dispose()
  assert.equal(service.compactIfNeeded, native)
})

test('QQ friend chat uses the local date and resolves a labeled lookup with tools still empty', async t => {
  const f = fixture(), agent = f.agent('qq-friend')
  const previousKey = process.env.ANYSEARCH_API_KEY
  process.env.ANYSEARCH_API_KEY = 'mock-key'
  t.after(() => {
    if (previousKey === undefined) delete process.env.ANYSEARCH_API_KEY
    else process.env.ANYSEARCH_API_KEY = previousKey
  })
  let now = '2026-11-09T16:01:00Z'
  f.runtime.client.now = () => now
  f.runtime.bridge = { binding: id => id === agent.session.id
    ? { owner: false, scope: 'private', input: '最近的求职方向' } : undefined, resolveResearch() {} }
  f.runtime.observeAgent(agent)
  await f.runtime.prepareBridgeInput({ sessionId: agent.session.id, owner: false, scope: 'private', userId: 42 })
  const scope = f.runtime.chatScopes.get(agent)
  const next = async () => ({ sections: [], tools: [{ name: 'search' }], contexts: [] })
  const first = await scope.shapeAssembly({}, next)
  assert.deepEqual(first.tools, [])
  assert.match(first.sections.find(row => row.name === 'rin-memory:date').text, /2026-11-10/)
  assert.match(first.sections.find(row => row.name === 'rin-memory:chat').text, /<查资料>/)
  now = '2026-11-10T04:00:00Z'
  assert.deepEqual((await scope.shapeAssembly({}, next)).sections, first.sections)
  const query = '2026 年 11 月 软件工程 招聘'
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    code: 0, data: { results: [{ title: '招聘资讯', url: 'https://example.com/jobs' }] },
  }))
  const result = await f.runtime.resolveResearch(agent.session.id, `查资料:<查资料>${query}</查资料>`)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).query, query)
  assert.match(result.text, /终端反馈·查资料/)
  assert.match(result.history, /example\.com\/jobs/)
  f.runtime.detach(agent)
})

function fixture() {
  const feedback = [], workers = [], hooks = new Map()
  // 工作会话的工具由 preset 挂载;这里给出最小可用的注册表与工具视图。
  const registry = { async mount() { return { id: 'standard' } } }
  const tools = { view: () => ({ visible: new Map([['pwsh', {}]]) }) }
  const ctx = { profileContext: { home: process.cwd() }, get: name => name === 'agentPresets' ? registry
    : name === 'tools' ? tools : name === 'agents' ? {
    async create(options) {
      workers.push(options)
      return { agent: { followup() {}, async whenIdle() {},
        session: { snapshotEvents: () => [
          { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '{"ok":true,"text":"local result"}' }] } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ] },
        // mountWorkerTools 会在 agent.ctx 上挂 preset 并可能加限制。
        ctx: { tools: { restrict() {} } } }, async dispose() {} }
    },
  } : undefined }
  const client = { isRetired: () => false, scope: sessionId => ({ session_id: sessionId }),
    async request() { return { persona: '本地完整人格', persona_version: 'p1', context_receipt_id: 'local-context', corrections: { block: '' } } } }
  const runtime = new MemoryRuntime(ctx, normalizeConfig({}), client, { warn() {} })
  function agent(id, header = { agentPreset: 'dsh-qq-bridge' }) {
    const listeners = new Map()
    const value = { session: { id, header }, options: { provider: 'test', model: 'model' },
      followup: message => feedback.push(message), ctx: {
        effect: callback => callback(),
        on(name, callback) {
          const list = listeners.get(name) ?? []
          list.push(callback); listeners.set(name, list)
          return () => listeners.set(name, list.filter(item => item !== callback))
        },
        tools: { guard: () => () => {} },
        systemPrompt: { suppressRuntimeContext: () => () => {} },
      },
    }
    hooks.set(value, listeners)
    return value
  }
  function emit(owner, text, seq) {
    const event = { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
    for (const listener of hooks.get(owner).get('session/event') ?? []) listener(owner.session, event)
  }
  return { runtime, agent, emit, feedback, workers, hooks }
}

test('a desktop QQ preset executes and follows up with no bridge or QQ binding', async () => {
  const f = fixture(), main = f.agent('desktop-local')
  f.runtime.observeAgent(main)
  assert.equal(f.runtime.bridge, null)
  assert.equal(f.runtime.attached.size, 0, 'personal memory attachment is independent')
  assert.equal(f.runtime.spellScopes.size, 1)
  const assemble = f.hooks.get(main).get('system-prompt/assemble')[0]
  const shaped = await assemble({}, {}, async () => ({ sections: [], tools: [{ name: 'pwsh' }] }))
  assert.deepEqual(shaped.sections.map(s => s.name), ['deployment:persona-prefix', 'rin-memory:magic'])
  assert.equal(shaped.sections[0].text, '本地完整人格')
  assert.deepEqual(shaped.tools, [])
  f.emit(main, '<执行>echo hi</执行>', 1)
  await f.runtime.spellRunner.tail
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].meta.agentPreset, undefined)
  assert.equal(f.feedback[0].source.kind, 'companion-spell')
  assert.match(f.feedback[0].content[0].text, /local result/)
  f.emit(main, '<执行>echo hi</执行>', 1)
  await f.runtime.spellRunner.tail
  assert.equal(f.workers.length, 1)
  f.runtime.detach(main)
  assert.equal(f.runtime.spellScopes.size, 0)
  f.emit(main, '<执行>after destroy</执行>', 2)
  await f.runtime.spellRunner.tail
  assert.equal(f.workers.length, 1)
  await f.runtime.spellRunner.dispose()
})

test('ordinary sessions and workers stay outside the spell runner; a selected preset overrides its creation header', async () => {
  const f = fixture()
  for (const owner of [f.agent('ordinary', {}), f.agent('companion-spell-worker'),
    f.agent('child', { agentPreset: 'dsh-qq-bridge', origin: 'subagent' })]) {
    f.runtime.observeAgent(owner)
    assert.equal(f.runtime.spellScopes.has(owner), false)
  }
  const main = f.agent('desktop-selected')
  const originalGet = f.runtime.ctx.get
  f.runtime.ctx.get = name => name === 'sessionProjections' ? { stateOf: () => null } : originalGet(name)
  f.runtime.observeAgent(main)
  assert.equal(f.runtime.spellScopes.has(main), false)
  await f.runtime.spellRunner.dispose()
})

test('bridge ownership only gates QQ and personal memory, never standalone general casts', async () => {
  const f = fixture(), main = f.agent('desktop-local')
  f.runtime.observeAgent(main)
  f.emit(main, '<翻本子>私人内容</翻本子>', 1)
  await f.runtime.spellRunner.tail
  assert.match(f.feedback[0].content[0].text, /失败：这个会话没有个人记忆权限/)
  f.runtime.bridge = { binding: id => id === 'qq-stranger' ? { owner: false, scope: 'private' } : undefined }
  const remote = f.agent('qq-stranger')
  f.runtime.observeAgent(remote)
  assert.equal(f.runtime.spellScopes.has(remote), false)
  f.emit(main, '<执行>写一个文件</执行>', 2)
  await f.runtime.spellRunner.tail
  assert.equal(f.workers.length, 1)
  assert.match(f.feedback.at(-1).content[0].text, /【终端反馈·执行】/)
  f.runtime.detach(main)
  await f.runtime.spellRunner.dispose()
})
