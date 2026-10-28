import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply, Config, MEMORY_RULES, RULES_CHAR_LIMIT, renderIncrement } from '../index.js'
import { MemoryClient, classifyHttpError } from '../memory-client.js'
import { decodeLog, deleteSessionDirectory, listSessionDirectories } from '../session-store.js'

/**
 * 一个只会说“好”的假服务。
 *
 * `state` 用来逐项制造失败,让同一份代码在“正常 / 503 / 410 / 409 失效 /
 * 清理待办 / 发送回执”之间切换,而不是每个场景各写一套 fixture。
 */
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const requests = []
  const state = {
    persona: '温柔而直白。',
    version: 'pub-1',
    revisions: 1,
    failTurns: 0,
    failMode: 'unavailable',
    cleanup: [],
    memoryEntries: [],
    correct: null,
    forget: null,
    contextStale: false,
    ...overrides,
  }
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : Object.fromEntries(new URL(request.url, 'http://x').searchParams)
    const path = request.url.split('?')[0]
    requests.push({ path, body, client: request.headers['x-companion-client'] })
    response.setHeader('Content-Type', 'application/json')
    if (path === '/v1/health') {
      response.end(JSON.stringify({ storage: { status: 'ready' }, chat: { status: 'ready' } }))
      return
    }
    if (path === '/v1/cleanup/pending') {
      response.end(JSON.stringify({ items: state.cleanup }))
      return
    }
    if (path === '/v1/memory/entries') {
      response.end(JSON.stringify({ subject: 'private', items: state.memoryEntries }))
      return
    }
    if (path === '/v1/memory/correct') {
      if (!state.correct) { response.statusCode = 403; response.end(JSON.stringify({ code: 'forbidden' })); return }
      response.end(JSON.stringify(state.correct))
      return
    }
    if (path === '/v1/memory/forget') {
      if (state.forget) {
        response.statusCode = state.forget.status ?? 200
        response.end(JSON.stringify(state.forget.body))
        return
      }
      response.end(JSON.stringify({ deletion_id: 'del-1', status: 'completed' }))
      return
    }
    if (path === '/v1/context') {
      if (state.contextStale) {
        response.statusCode = 409
        response.end(JSON.stringify({ code: 'context_stale', message: 'basis moved' }))
        return
      }
      response.end(JSON.stringify({
        persona: state.persona,
        persona_version: state.version,
        card_revision: state.revisions,
        context_receipt_id: `ctx-${requests.length}`,
        corrections: { block: '不要使用旧称呼' },
        context: { result: 'hit', context: '用户喜欢红茶', memory_ids: state.memoryIds ?? ['fact-1'] },
        recent_turns: [],
      }))
      return
    }
    if (path === '/v1/turns') {
      if (state.failTurns > 0) {
        state.failTurns -= 1
        response.statusCode = state.failMode === 'gone' ? 410 : 503
        response.end(JSON.stringify({ code: state.failMode === 'gone' ? 'deleted' : 'unavailable' }))
        return
      }
      response.end(JSON.stringify({ status: 'committed', durable: true }))
      return
    }
    if (path.startsWith('/v1/cleanup/') && path.endsWith('/ack')) {
      if (body.status === 'cleaned') state.cleanup = state.cleanup.filter(item => !path.includes(item.deletion_id))
      response.end(JSON.stringify({ status: 'cleaned' }))
      return
    }
    response.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const config = {
    enabled: true,
    url: `http://127.0.0.1:${server.address().port}`,
    clientId: 'dsh-desktop',
    characterId: 'companion',
    subject: 'private',
    pluginId: 'dsh_memory',
    tokenEnv: 'DSH_MEMORY_TEST_TOKEN',
    tokenFile: '',
    timeoutMs: 1000,
    sessionPrefixes: ['qq-'],
    memoryTools: true,
    stateDirectory: root,
    sessionsDirectory: join(root, 'sessions'),
    maxPending: 8,
    retryIntervalMs: 60000,
    retireSessionsOnCleanup: true,
  }
  return { root, server, requests, state, config }
}

/** 一个最小的 Host 替身:记录注册了什么,并允许按事件名触发。 */
function host({ home, bridge } = {}) {
  const hooks = new Map()
  const tools = []
  const services = new Map()
  const listeners = new Set()
  const bindings = new Map()
  const admissions = new Set()
  const external = bridge
  bridge = {
    ...external,
    binding: id => bindings.get(id),
    subscribe(listener) {
      listeners.add(listener)
      const off = external?.subscribe?.(listener)
      return { dispose() { listeners.delete(listener); off?.dispose() } }
    },
    subscribeAdmission(listener) { admissions.add(listener); return { dispose: () => admissions.delete(listener) } },
    async prepare(input) {
      bindings.set(input.sessionId, input)
      for (const listener of admissions) await listener(input)
    },
    publish(report) { for (const listener of listeners) listener(report) },
    async retireSession(id) {
      const agent = live.get(id)
      if (agent) { agent.cancel(); ctx.emit('agent/disposed', { agent }) }
      bindings.delete(id)
    },
  }
  services.set('qqBridgeEvents', bridge)
  const live = new Map()
  const globalTools = []
  const ctx = {
    profileContext: { home },
    logger: { info() {}, warn() {}, error() {} },
    on(name, callback) {
      const list = hooks.get(name) ?? []
      list.push(callback)
      hooks.set(name, list)
      return () => hooks.set(name, (hooks.get(name) ?? []).filter(item => item !== callback))
    },
    get(name) { return services.get(name) },
    agents: { list: () => [] },
    tools: {
      register(definition) {
        tools.push(definition)
        globalTools.push(definition)
        return () => { tools.splice(tools.indexOf(definition), 1); globalTools.splice(globalTools.indexOf(definition), 1) }
      },
    },
    emit(name, payload) {
      if (name === 'agent/created') {
        const agent = payload.agent
        live.set(agent.session.id, agent)
        agent.bridge = bridge
        bindings.set(agent.session.id, { sessionId: agent.session.id, scope: agent.boundScope ?? 'private', owner: agent.boundOwner ?? true, input: '' })
        agent.ctx.tools = { register(definition) {
          tools.push(definition)
          return () => tools.splice(tools.indexOf(definition), 1)
        } }
      }
      for (const callback of hooks.get(name) ?? []) callback(payload)
    },
  }
  return { ctx, hooks, tools, globalTools, services, bridge, bindings }
}

/** 一个最小 agent:自己的 ctx 与 session。 */
function makeAgent(sessionId, { events = [] } = {}) {
  const hooks = new Map()
  const sections = []
  const agent = {
    session: { id: sessionId, events },
    cancelled: 0,
    cancel() { agent.cancelled += 1 },
    ctx: {
      effect(callback) { return callback() },
      on(name, callback) {
        const list = hooks.get(name) ?? []
        list.push(callback)
        hooks.set(name, list)
        return () => hooks.set(name, (hooks.get(name) ?? []).filter(item => item !== callback))
      },
      systemPrompt: {
        getSectionOrder() { return 0 },
        section(value) { sections.push(value); return () => sections.splice(sections.indexOf(value), 1) },
      },
    },
    emit(name, ...args) { return (hooks.get(name) ?? []).reduce((last, cb) => cb(...args, last), undefined) },
    async preStep(payload) {
      const input = payload.messages?.find(message => message.source?.kind === 'user')
      if (input) {
        agent.input = input
        const binding = agent.bridge.binding(sessionId)
        binding.input = agent.boundInput ?? input.content.map(part => part.text ?? '').join('')
      }
      const hook = (hooks.get('agent/pre-step') ?? [])[0]
      assert.ok(hook, 'pre-step hook missing')
      return await hook(payload, async () => ({ kind: 'enter', messages: [...(payload.messages ?? [])] }))
    },
    turnEnd(turn, events) {
      agent.session.events = events
      for (const hook of hooks.get('session/event') ?? []) {
        hook(agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      }
      if (agent.autoReport !== false) {
        const reply = events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content
          .filter(part => part.type === 'text').map(part => part.text).join('') ?? ''
        agent.bridge.publish({ status: 'completed', owner: true, scope: 'private', sessionId,
          turnMessageId: agent.input.id, input: agent.bridge.binding(sessionId).input, reply, parts: [] })
      }
    },
    hooks,
    sections,
  }
  // 与宿主装配同形:段的 text 可以是 provider,这里按当前状态解析出正文。
  agent.sectionText = name => {
    const section = sections.find(item => item.name === name)
    if (!section) return undefined
    return typeof section.text === 'function' ? section.text({}) : section.text
  }
  return agent
}

const userMessage = (id, text) => ({
  id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
})
const assistantEvent = (turn, text) => ({
  type: 'assistant/message', data: { turn, message: { content: [{ type: 'think', text: 'internal' }, { type: 'text', text }] } },
})

async function start(t, f, options = {}) {
  const home = options.home ?? f.root
  const hostHandle = host({ home, bridge: options.bridge })
  const previous = process.env.DSH_MEMORY_TEST_TOKEN
  process.env.DSH_MEMORY_TEST_TOKEN = 'isolated-token'
  const dispose = await apply(hostHandle.ctx, { ...f.config, ...options.config, enabled: true })
  t.after(async () => {
    await dispose?.()
    if (previous === undefined) delete process.env.DSH_MEMORY_TEST_TOKEN
    else process.env.DSH_MEMORY_TEST_TOKEN = previous
  })
  return { ...hostHandle, dispose }
}

test('the persona lives in the system section; only new background is injected; one reply saved', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  // 系统里只有人格一份:不再有常驻规则段。
  // 注册表里只有人格段:魔法段由组装钩子追加,不进注册表。
  assert.equal(agent.sections.length, 1, 'the persona slot is the only registered section')
  const personaSection = agent.sections.find(section => section.name === 'deployment:persona-prefix')
  assert.ok(personaSection, 'the persona occupies the host persona slot')
  assert.ok(!agent.sections.some(section => section.name === 'rin-memory:rules'),
    'no standing rule section competes with the persona')
  // 下沉后的那句话仍然是有界、无每轮数据的静态正文。
  assert.ok(Array.from(MEMORY_RULES).length <= RULES_CHAR_LIMIT,
    `the material note must stay within ${RULES_CHAR_LIMIT} characters`)
  assert.ok(!/pub-1|\d{4}-\d{2}-\d{2}|request/i.test(MEMORY_RULES), 'no version, timestamp or request id')

  const first = await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '记住我喜欢红茶')] })
  const injected = first.messages.find(message => message.source?.kind === 'rin-memory')
  assert.equal(injected.source.kind, 'rin-memory')
  // The persona is in the system section, never repeated in the message.
  assert.equal(agent.sectionText('deployment:persona-prefix'), '温柔而直白。')
  assert.ok(!injected.content[0].text.includes('温柔而直白。'), 'the full persona is not in the user message')
  assert.ok(!/\[当前人格\]|发布版本/.test(injected.content[0].text), 'no persona card or release fence')
  assert.match(injected.content[0].text, /不要使用旧称呼/)
  assert.match(injected.content[0].text, /主人喜欢红茶/)
  assert.ok(!injected.content[0].text.includes('记住我喜欢红茶'), 'the user input is not echoed back')

  // A second step in the same turn shares the prepared turn: no second context
  // read, no second injection.
  const second = await agent.preStep({ turn: 1, step: 2, messages: [] })
  assert.equal(second.messages.length, 0, 'tool steps do not get injected again')
  assert.equal(f.requests.filter(row => row.path === '/v1/context').length, 1)

  agent.turnEnd(1, [
    { type: 'turn/start', data: { turn: 1 } },
    assistantEvent(1, '好，记住了。'),
  ])
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/receipts'); n++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const committed = f.requests.find(row => row.path === '/v1/turns')
  assert.equal(committed.body.persona_version, 'pub-1')
  assert.equal(committed.body.messages.length, 1)
  assert.equal(committed.body.messages[0].content, '记住我喜欢红茶')
  assert.equal(committed.body.reply, '好，记住了。')
  assert.ok(committed.body.source_key.startsWith('plugin:dsh_memory:companion:private:'))

  // A new publication replaces the system section text; the unchanged
  // background is not posted a second time.
  f.state.version = 'pub-2'
  f.state.persona = '更安静的版本。'
  const next = await agent.preStep({ turn: 2, step: 1, messages: [userMessage('m2', '今天吃什么')] })
  assert.equal(agent.sectionText('deployment:persona-prefix'), '更安静的版本。',
    'the next turn adopts the newly published persona')
  assert.equal(f.requests.filter(row => row.path === '/v1/context').length, 2)
  assert.ok(f.requests.every(row => row.client === 'dsh-desktop'))

  // Check 1: consecutive turns each carry their own user text exactly once, and
  // an unchanged background adds no message at all.
  assert.equal(next.messages.length, 1, 'no new background means no injected message')
  for (const [messages, text] of [[first.messages, '记住我喜欢红茶'], [next.messages, '今天吃什么']]) {
    assert.equal(messages.filter(message => JSON.stringify(message).includes(text)).length, 1,
      `"${text}" appears exactly once in its own request`)
  }
  assert.ok(!JSON.stringify(next.messages).includes('记住我喜欢红茶'),
    'the previous turn input is not replayed into the next request')

  // A genuinely new memory entry is delivered once and only once.
  f.state.memoryIds = ['fact-2']
  const third = await agent.preStep({ turn: 3, step: 1, messages: [userMessage('m3', '还记得吗')] })
  const fresh = third.messages.find(message => message.source?.kind === 'rin-memory')
  assert.equal(fresh.source.kind, 'rin-memory')
  assert.match(fresh.content[0].text, /主人喜欢红茶/)
  assert.ok(!fresh.content[0].text.includes('不要使用旧称呼'), 'an unchanged correction is not repeated')

  const fourth = await agent.preStep({ turn: 4, step: 1, messages: [userMessage('m4', '继续')] })
  assert.equal(fourth.messages.length, 1, 'already-injected entries are not re-posted')
})

test('failed submit survives a restart and replays the same body once', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '记住我喜欢红茶')] })
  f.state.failTurns = 99
  agent.turnEnd(1, [assistantEvent(1, '好。')])
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/turns'); n++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const persisted = JSON.parse(await readFile(join(f.root, 'outbox.json'), 'utf8'))
  assert.equal(Object.keys(persisted.pending).length, 1)
  const firstBody = Object.values(persisted.pending)[0].body
  assert.equal(firstBody.background, undefined, 'the injected text is never persisted')
  // The already-injected fingerprints outlive the process, so a restart does
  // not re-post the same memory into this context a second time.
  assert.ok(Object.keys(persisted.injected ?? {}).length > 0, 'the injection index is on disk')

  // Restart: same queue, same body.
  f.state.failTurns = 0
  const reopened = new MemoryClient(f.config, 'isolated-token', { statePath: join(f.root, 'outbox.json') })
  await reopened.open()
  await reopened.flush()
  const submits = f.requests.filter(row => row.path === '/v1/turns')
  assert.equal(submits.length, 2)
  assert.deepEqual(submits[1].body, firstBody)
  assert.deepEqual(reopened.state.pending, {})
})

test('a cleanup pending blocks replay, deletes the named session, and only then acknowledges', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '记住我喜欢红茶')] })
  const cached = makeAgent('qq-cached')
  h.ctx.emit('agent/created', { agent: cached })
  await cached.preStep({ turn: 1, step: 1, messages: [userMessage('m-cache', '问一下喜好')] })
  f.state.memoryIds = ['unrelated-fact']
  const unrelated = makeAgent('qq-unrelated')
  h.ctx.emit('agent/created', { agent: unrelated })
  await unrelated.preStep({ turn: 1, step: 1, messages: [userMessage('m-other', '其它话题')] })

  // Plant a real session log in the layout DSH uses.
  const project = join(f.root, 'sessions', '--C-Users-test--')
  const sessionDir = join(project, 'qq-owner')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', text: '记住我喜欢红茶' })}\n`)))
  for (const id of ['qq-cached', 'qq-unrelated']) {
    const directory = join(project, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v4.jsonl'), 'synthetic log')
  }

  f.state.failTurns = 1
  agent.turnEnd(1, [assistantEvent(1, '好。')])
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/turns'); n++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const before = f.requests.filter(row => row.path === '/v1/turns').length

  // A deletion now names our source. The pending body must NOT be replayed.
  f.state.cleanup = [{
    deletion_id: 'deletion-1',
    memory_ids: ['fact-1'],
    source_keys: [Object.keys(JSON.parse(await readFile(join(f.root, 'outbox.json'), 'utf8')).pending)[0]
      ? 'plugin:dsh_memory:companion:private:qq-owner:dsh_placeholder' : ''],
  }]
  f.state.cleanup[0].source_keys = ['plugin:dsh_memory:companion:private:qq-owner:dsh_x']
  await f.config && (await new Promise(resolve => setTimeout(resolve, 10)))
  const h2 = h
  // Drive one tick through the public path (the retry timer is 60s in the fixture).
  const dispose = h2.hooks
  assert.ok(dispose)
  // Instead of waiting for the timer, call the same client path the tick uses.
  const reopened = new MemoryClient(f.config, 'isolated-token', { statePath: join(f.root, 'outbox.json') })
  await reopened.open()
  await assert.rejects(reopened.flush(), error => error.kind === 'cleanup')
  assert.equal(f.requests.filter(row => row.path === '/v1/turns').length, before)
  await assert.rejects(h.bridge.prepare({ sessionId: 'qq-owner', scope: 'private', owner: true, input: '继续' }), /MEMORY_REQUIRED/)
  assert.equal(agent.cancelled, 1, 'the old live agent is stopped before cleanup is acknowledged')
  assert.equal(agent.hooks.get('agent/pre-step')?.length ?? 0, 0)
  const remaining = await listSessionDirectories(f.config.sessionsDirectory)
  assert.deepEqual(remaining.map(row => row.sessionId), ['qq-unrelated'])
  assert.equal(cached.cancelled, 1, 'a recalled copy is retired too')
  assert.equal(unrelated.cancelled, 0)
  assert.equal(unrelated.sections.length, 1)
  await reopened.open()
  assert.equal(Object.keys(reopened.state.pending).length, 0)
  assert.equal(Object.keys(reopened.state.generated).length, 1, 'unrelated input is preserved')
  const replacement = makeAgent('qq-owner-new')
  h.ctx.emit('agent/created', { agent: replacement })
  assert.equal(replacement.sections.length, 1, 'a new QQ session can resume memory-backed chat')
})

test('permanent deletion stops replay and retires the session instead of retrying forever', async t => {
  const f = await fixture(t)
  f.state.failTurns = 1
  f.state.failMode = 'gone'
  const client = new MemoryClient(f.config, 'isolated-token', { statePath: join(f.root, 'outbox.json') })
  await client.open()
  await client.serial(async () => {
    client.state.pending.req1 = {
      body: { request_id: 'req1', reply: 'x' },
      scope: client.scope('qq-owner'),
    }
    await client.save()
  })
  await client.flush()
  assert.deepEqual(client.state.pending, {}, 'a gone request is not kept for replay')
  assert.equal(client.state.retiredSessions.length, 1)
})

test('the queue is bounded and says so instead of dropping a turn', async t => {
  const f = await fixture(t)
  const h = await start(t, f, { config: { maxPending: 1 } })
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '第一句')] })
  f.state.failTurns = 99
  agent.turnEnd(1, [assistantEvent(1, '好。')])
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/turns'); n++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const second = makeAgent('qq-second')
  h.ctx.emit('agent/created', { agent: second })
  await assert.rejects(second.preStep({ turn: 1, step: 1, messages: [userMessage('m2', '第二句')] }), /MEMORY_REQUIRED.*队列已满/)
  await new Promise(resolve => setTimeout(resolve, 60))
  const persisted = JSON.parse(await readFile(join(f.root, 'outbox.json'), 'utf8'))
  assert.equal(Object.keys(persisted.pending).length, 1, 'the second turn is refused, not silently dropped')
})

test('without credentials the plugin reports why and registers nothing', async t => {
  const f = await fixture(t)
  const hostHandle = host({ home: f.root })
  const previous = process.env.DSH_MEMORY_TEST_TOKEN
  delete process.env.DSH_MEMORY_TEST_TOKEN
  const dispose = await apply(hostHandle.ctx, { ...f.config, enabled: true })
  if (previous !== undefined) process.env.DSH_MEMORY_TEST_TOKEN = previous
  assert.equal(dispose, undefined)
  assert.equal(hostHandle.hooks.size, 0, 'no listeners are left behind')
  assert.equal(f.requests.length, 0)
})

test('disabled means disabled: nothing is registered and no request is made', async t => {
  const f = await fixture(t)
  const hostHandle = host({ home: f.root })
  const dispose = await apply(hostHandle.ctx, { ...f.config, enabled: false })
  assert.equal(dispose, undefined)
  assert.equal(hostHandle.hooks.size, 0)
  assert.equal(hostHandle.tools.length, 0)
  assert.equal(f.requests.length, 0)
})

test('repeated enable/disable leaves no duplicate listener, tool or section', async t => {
  const f = await fixture(t)
  const hostHandle = host({ home: f.root })
  const previous = process.env.DSH_MEMORY_TEST_TOKEN
  process.env.DSH_MEMORY_TEST_TOKEN = 'isolated-token'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_MEMORY_TEST_TOKEN
    else process.env.DSH_MEMORY_TEST_TOKEN = previous
  })
  const firstDispose = await apply(hostHandle.ctx, { ...f.config, enabled: true })
  hostHandle.ctx.emit('agent/created', { agent: makeAgent('qq-owner') })
  const firstTools = hostHandle.tools.length
  const firstHooks = hostHandle.hooks.get('agent/created')?.length ?? 0
  // 三个受限记忆工具 + 统一任务入口,一共四个;顺序即请求里的 schema 顺序。
  // 注册表里仍有四个工具;主会话的组装结果才把它们全部丢掉(见 main-session.js)。
  assert.equal(firstTools, 4)
  assert.equal(firstHooks, 1)
  await firstDispose()
  assert.equal(hostHandle.tools.length, 0, 'tools are released')
  assert.equal(hostHandle.hooks.get('agent/created')?.length ?? 0, 0, 'listeners are released')
  const secondDispose = await apply(hostHandle.ctx, { ...f.config, enabled: true })
  hostHandle.ctx.emit('agent/created', { agent: makeAgent('qq-owner-2') })
  assert.equal(hostHandle.tools.length, firstTools)
  assert.equal(hostHandle.hooks.get('agent/created')?.length ?? 0, 1)
  await secondDispose()
})

test('a non-matching session is left completely alone', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('plain-coding-session')
  h.ctx.emit('agent/created', { agent })
  assert.equal(agent.sections.length, 0)
  assert.equal(agent.hooks.get('agent/pre-step')?.length ?? 0, 0, 'no memory hook is installed')
  assert.equal(agent.hooks.get('session/event')?.length ?? 0, 0)
  assert.equal(f.requests.filter(row => row.path === '/v1/context').length, 0)
  assert.equal(h.globalTools.length, 0)
})

test('an unbound speaker is not the owner: bridge turns without owner are ignored', async t => {
  const reports = []
  const bridge = { subscribe(listener) { reports.push(listener); return { dispose() {} } }, platform: 'official' }
  const f = await fixture(t)
  const h = await start(t, f, { bridge })
  const stranger = makeAgent('qq-stranger')
  stranger.boundOwner = false
  h.ctx.emit('agent/created', { agent: stranger })
  const group = makeAgent('qq-group')
  group.boundScope = 'group'
  h.ctx.emit('agent/created', { agent: group })
  assert.equal(h.tools.length, 0)
  assert.equal(stranger.sections.length, 0)
  assert.equal(group.sections.length, 0)
  const listener = reports[0]
  listener({
    sessionKey: 'private:stranger', sessionId: 'qq-stranger', scope: 'private',
    userId: 999, owner: false, input: '我是白名单', reply: '哦', parts: [], status: 'completed',
  })
  listener({
    sessionKey: 'group:7', sessionId: 'qq-group', scope: 'group',
    userId: 10001, owner: true, input: '群里说', reply: '嗯', parts: [], status: 'completed',
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.requests.filter(row => row.path === '/v1/receipts').length, 0)
})

test('a sent receipt records only the accepted parts and never claims delivery', async t => {
  const reports = []
  const bridge = { subscribe(listener) { reports.push(listener); return { dispose() {} } }, platform: 'official' }
  const f = await fixture(t)
  const h = await start(t, f, { bridge })

  // A real turn first: a receipt must attach to a turn the service has seen.
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m-host-1', '在吗')] })
  agent.turnEnd(1, [assistantEvent(1, '在的。')])
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/receipts'); n++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  reports[0]({
    sessionKey: 'private:10001', sessionId: 'qq-owner', scope: 'private',
    userId: 10001, owner: true, input: '在吗', reply: '在的。', status: 'completed',
    turnMessageId: 'm-host-1',
    parts: [
      { index: 0, chars: 2, platformId: 'msg-1', ok: true },
      { index: 1, chars: 1, ok: false, error: 'timeout' },
    ],
  })
  // The receipt is written down first and posted on the next flush; drive that
  // flush the same way the retry timer would.
  for (let n = 0; n < 100; n++) {
    const state = JSON.parse(await readFile(join(f.root, 'outbox.json'), 'utf8'))
    if (Object.keys(state.sent ?? {}).length > 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  {
    const reopened = new MemoryClient(f.config, 'isolated-token', { statePath: join(f.root, 'outbox.json') })
    await reopened.open()
    await reopened.flush()
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  // The send receipt names the turn the save used, and only the parts the
  // platform actually accepted.
  const saved = f.requests.find(row => row.path === '/v1/turns')
  const receipts = f.requests.filter(row => row.path === '/v1/receipts')
  const sent = receipts.find(row => row.body.kind === 'sent')
  assert.ok(sent, 'accepted parts are recorded')
  assert.equal(sent.body.request_id, saved.body.request_id,
    'the receipt names the same turn the save used')
  assert.equal(sent.body.transport, 'qq_official')
  assert.deepEqual(sent.body.parts, [{ platform_id: 'msg-1', chars: 2 }])
  assert.ok(!receipts.some(row => row.body.kind === 'delivered'), 'the bridge cannot prove the user read it')
})

test('a send receipt that arrives before the save is held, then posted with it', async t => {
  const reports = []
  const bridge = { subscribe(listener) { reports.push(listener); return { dispose() {} } }, platform: 'official' }
  const f = await fixture(t)
  const h = await start(t, f, { bridge })

  // The QQ side finishes sending while the save is still failing: posting the
  // receipt now would name a request the service has never accepted.
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m-host-2', '累了吗')] })
  f.state.failTurns = 1
  agent.turnEnd(1, [assistantEvent(1, '有点。')])
  reports[0]({
    sessionKey: 'private:10001', sessionId: 'qq-owner', scope: 'private',
    userId: 10001, owner: true, input: '累了吗', reply: '有点。', status: 'completed',
    turnMessageId: 'm-host-2',
    parts: [{ index: 0, chars: 2, platformId: 'msg-9', ok: true }],
  })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.requests.filter(row => row.body?.kind === 'sent').length, 0,
    'no receipt is posted for a turn the service has not accepted')
  const persisted = JSON.parse(await readFile(join(f.root, 'outbox.json'), 'utf8'))
  assert.equal(Object.keys(persisted.sent ?? {}).length, 1, 'the receipt is held on disk')

  // The retry succeeds; the held receipt goes with that same turn.
  const reopened = new MemoryClient(f.config, 'isolated-token', { statePath: join(f.root, 'outbox.json') })
  await reopened.open()
  await reopened.flush()
  const sent = f.requests.find(row => row.body?.kind === 'sent')
  assert.ok(sent, 'the held receipt is posted once the turn exists')
  assert.equal(sent.body.parts[0].platform_id, 'msg-9')
  assert.deepEqual(reopened.state.sent, {})
})

test('memory tools are only registered when both sides allow them', async t => {
  const f = await fixture(t)
  const off = await start(t, f, { config: { memoryTools: false } })
  assert.equal(off.tools.length, 0)
  const on = await start(t, f, { home: f.root, config: { memoryTools: true } })
  on.ctx.emit('agent/created', { agent: makeAgent('qq-owner') })
  assert.equal(on.tools.length, 4, 'the tools still exist in the registry')
  const names = on.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, ['companion_correct', 'companion_forget', 'companion_recall', 'companion_task'])
  // …但主会话的组装结果里一个都不上报(见 main-session.js 的思考稳定说明)。
  assert.equal(on.globalTools.length, 0, 'personal memory is never a global tool')
  assert.throws(() => on.tools[0].execute({}, { agent: makeAgent('plain-coding') }), /没有个人记忆权限/)
})

test('forget reports an ambiguous match as candidates instead of deleting one', async t => {
  const f = await fixture(t)
  f.state.forget = {
    status: 409,
    body: {
      code: 'ambiguous_target',
      message: 'several memories match',
      candidates: [
        { type: 'fact', id: 'f1', text: '她养了一只叫小满的猫' },
        { type: 'fact', id: 'f2', text: '她养了一只叫阿吉的狗' },
      ],
    },
  }
  const h = await start(t, f)
  h.ctx.emit('agent/created', { agent: makeAgent('qq-owner') })
  const tool = h.tools.find(item => item.name === 'companion_forget')
  const result = await tool.execute({ text: '养了一只' })
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.candidates.length, 2)
})

test('correct reports the real service outcome and is idempotent by request id', async t => {
  const f = await fixture(t)
  f.state.correct = {
    correction_id: 'corr-1', version: 2, applied: true, duplicate: false,
    status: 'active', invalidated_fact_ids: ['f1'], replacement_fact_id: 'f2',
  }
  const h = await start(t, f)
  h.ctx.emit('agent/created', { agent: makeAgent('qq-owner') })
  const tool = h.tools.find(item => item.name === 'companion_correct')
  const result = await tool.execute({ old_text: '红茶', new_text: '乌龙茶' })
  assert.equal(result.status, 'corrected')
  assert.equal(result.invalidated_facts, 1)
  const first = f.requests.filter(row => row.path === '/v1/memory/correct')
  const again = await tool.execute({ old_text: '红茶', new_text: '乌龙茶' })
  assert.equal(again.status, 'corrected')
  const both = f.requests.filter(row => row.path === '/v1/memory/correct')
  assert.equal(both[0].body.request_id, both[1].body.request_id, 'the same request is replayed, not duplicated')
  assert.equal(first[0].body.old_text, '红茶')
})

test('recoverable, stale, gone, config and conflict failures are classified apart', () => {
  assert.equal(classifyHttpError(503, 'unavailable'), 'retry')
  assert.equal(classifyHttpError(429, 'capacity'), 'retry')
  assert.equal(classifyHttpError(409, 'context_stale'), 'stale')
  assert.equal(classifyHttpError(410, 'deleted'), 'gone')
  assert.equal(classifyHttpError(401, 'unauthorized'), 'config')
  assert.equal(classifyHttpError(403, 'forbidden'), 'config')
  assert.equal(classifyHttpError(409, 'request_conflict'), 'conflict')
  assert.equal(classifyHttpError(400, 'invalid_argument'), 'fatal')
})

test('the injected background keeps the three kinds of material apart, without the persona', () => {
  const { text, fingerprints } = renderIncrement({
    persona: '名字: 小潮',
    corrections: { block: '不要叫我小潮' },
    context: { block: '- 用户喜欢红茶' },
    recent_turns: [
      { type: 'human', data: { content: '我说过我喜欢红茶' } },
      { type: 'ai', data: { content: '嗯,记住了' } },
    ],
  })
  assert.match(text, /\[必须遵守的更正\]/)
  assert.match(text, /\[可能相关的记忆\]/)
  assert.match(text, /\[近期对话\]/)
  assert.match(text, /主人:我说过我喜欢红茶/)
  assert.match(text, /我:嗯,记住了/)
  // The persona belongs to the system section; repeating it here was the
  // reason every message carried a full card.
  assert.ok(!/名字: 小潮/.test(text), 'the persona is not repeated in the message')
  assert.ok(!/\[当前人格\]/.test(text), 'no persona heading in the message')
  assert.equal(fingerprints.length, 4, 'one correction, one memory, two turns are fingerprinted')

  // Nothing new in this context: no text at all, so no message is injected.
  const seen = Object.fromEntries(fingerprints.map(key => [key, 'now']))
  const again = renderIncrement({
    corrections: { block: '不要叫我小潮' },
    context: { block: '- 用户喜欢红茶' },
    recent_turns: [{ type: 'human', data: { content: '我说过我喜欢红茶' } }],
  }, seen)
  assert.equal(again.text, '')
  assert.deepEqual(again.fingerprints, [])
})

test('a compaction opens a new context generation, so material can be re-delivered', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '红茶怎么样')] })
  const quiet = await agent.preStep({ turn: 2, step: 1, messages: [userMessage('m2', '在干嘛')] })
  assert.equal(quiet.messages.length, 1, 'unchanged material is not re-posted')

  // Native compaction rewrote the history: the background may no longer be in
  // front of the model, so the next turn is allowed to deliver it again.
  for (const hook of agent.hooks.get('session/event') ?? []) {
    hook(agent.session, { type: 'compaction/end', data: { turn: 2 } })
  }
  await new Promise(resolve => setTimeout(resolve, 40))
  const again = await agent.preStep({ turn: 3, step: 1, messages: [userMessage('m3', '继续说')] })
  assert.equal(again.messages[0]?.source?.kind, 'rin-memory',
    'after compaction the material is delivered again')
  assert.match(again.messages[0].content[0].text, /不要使用旧称呼/)
})

test('a retired session is never re-attached', async t => {
  const f = await fixture(t)
  // A real cleanup: the plugin retires the named session and confirms it. The
  // fast retry interval lets the public tick path do the work.
  const project = join(f.root, 'sessions', '--C-Users-test--')
  const sessionDir = join(project, 'qq-owner')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from('{"type":"user/message"}\n')))
  f.state.cleanup = [{
    deletion_id: 'deletion-1',
    source_keys: ['plugin:dsh_memory:companion:private:qq-owner:dsh_x'],
  }]
  const h = await start(t, f, { config: { retryIntervalMs: 1000 } })
  for (let n = 0; n < 100 && f.state.cleanup.length > 0; n++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  // The acknowledgement is what makes a cleanup point-in-time complete.
  for (let n = 0; n < 100 && !f.requests.some(row => row.path.endsWith('/ack')); n++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  f.state.cleanup = []

  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  assert.equal(agent.sections.length, 0, 'a retired session is not instrumented')
  assert.equal(agent.hooks.get('agent/pre-step')?.length ?? 0, 0)
})

test('the session log is really removed, including a zstd frame, and a missing one is not invented', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'sessions', '--C-Users-test--')
  const target = join(project, 'qq-target')
  const bystander = join(project, 'qq-bystander')
  await mkdir(target, { recursive: true })
  await mkdir(bystander, { recursive: true })

  const raw = Buffer.from(`${JSON.stringify({ type: 'user/message', content: '要忘掉的话' })}\n`)
  // Both physical encodings DSH uses: plain JSONL and a zstd frame.
  await writeFile(join(target, 'session.v4.jsonl'), raw)
  await writeFile(join(target, 'session.v3.jsonl.zstd'), zstdCompressSync(raw))

  const listed = await listSessionDirectories(join(root, 'sessions'))
  assert.deepEqual(listed.map(entry => entry.sessionId).sort(), ['qq-bystander', 'qq-target'])
  assert.match(decodeLog(raw), /要忘掉的话/)
  assert.match(decodeLog(zstdCompressSync(raw)), /要忘掉的话/)

  const removed = await deleteSessionDirectory(target)
  assert.equal(removed.deleted, true, removed.reason)
  const remaining = await listSessionDirectories(join(root, 'sessions'))
  assert.deepEqual(remaining.map(entry => entry.sessionId), ['qq-bystander'],
    'only the named session is gone')

  // Deleting something already absent is reported as absent, not as success on
  // a path that never existed.
  const again = await deleteSessionDirectory(target)
  assert.equal(again.reason, 'already-absent')
  // A path that is a file rather than a session directory is refused.
  const notDir = join(project, 'stray.txt')
  await writeFile(notDir, 'x')
  const refused = await deleteSessionDirectory(notDir)
  assert.equal(refused.deleted, false)
  assert.equal(refused.reason, 'not-a-directory')
})

test('disabling releases the bridge subscription, so no turn is handled afterwards', async t => {
  const listeners = new Set()
  const bridge = {
    platform: 'official',
    subscribe(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
  const f = await fixture(t)
  const hostHandle = host({ home: f.root, bridge })
  const previous = process.env.DSH_MEMORY_TEST_TOKEN
  process.env.DSH_MEMORY_TEST_TOKEN = 'isolated-token'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_MEMORY_TEST_TOKEN
    else process.env.DSH_MEMORY_TEST_TOKEN = previous
  })
  const dispose = await apply(hostHandle.ctx, { ...f.config, enabled: true })
  assert.equal(listeners.size, 1, 'the plugin subscribed exactly once')
  const [listener] = [...listeners]
  listener({
    sessionKey: 'private:10001', sessionId: 'qq-owner', scope: 'private',
    userId: 10001, owner: true, input: '在吗', reply: '在的。', status: 'completed',
    turnMessageId: 'm-1', parts: [{ index: 0, chars: 2, platformId: 'p1', ok: true }],
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const before = f.requests.filter(row => row.path === '/v1/receipts').length

  await dispose()
  assert.equal(listeners.size, 0, 'the subscription is released on disable')
  // Even if something held the old callback, it must not act for a stopped
  // plugin.
  listener({
    sessionKey: 'private:10001', sessionId: 'qq-owner', scope: 'private',
    userId: 10001, owner: true, input: '再说一次', reply: '嗯。', status: 'completed',
    turnMessageId: 'm-2', parts: [{ index: 0, chars: 1, platformId: 'p2', ok: true }],
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(f.requests.filter(row => row.path === '/v1/receipts').length, before,
    'a stopped plugin records nothing')
})

test('status.json is written for inspection and carries no credential or body', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const file = join(f.root, 'status.json')
  const status = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(status.character_id, 'companion')
  assert.equal(status.subject, 'private')
  assert.equal(typeof status.pending, 'number')
  assert.ok(status.health, 'the health block is present')
  const text = await readFile(file, 'utf8')
  assert.ok(!text.includes('isolated-token'), 'the token is never written')
  // A turn moves the counters and the file is refreshed after the save.
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m1', '记住我喜欢红茶')] })
  agent.turnEnd(1, [assistantEvent(1, '好。')])
  for (let n = 0; n < 100; n++) {
    const now = JSON.parse(await readFile(file, 'utf8'))
    if (now.last_saved) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(after.last_saved?.request_id, 'a saved turn is visible')
  assert.ok(!JSON.stringify(after).includes('记住我喜欢红茶'), 'no conversation body is written')
})

test('native volatile configuration enables the plugin and hot updates release its resources', async t => {
  const f = await fixture(t)
  const h = host({ home: f.root })
  const previous = process.env.DSH_MEMORY_TEST_TOKEN
  process.env.DSH_MEMORY_TEST_TOKEN = 'isolated-token'
  t.after(() => { if (previous === undefined) delete process.env.DSH_MEMORY_TEST_TOKEN; else process.env.DSH_MEMORY_TEST_TOKEN = previous })
  const native = Config(f.config)
  assert.equal(native.get().enabled, true)
  const stopNative = await apply(h.ctx, native)
  assert.equal(h.hooks.get('agent/created')?.length, 1)
  await stopNative()
  let snapshot = { ...f.config, enabled: false }
  const stop = await apply(h.ctx, { get: () => snapshot })
  t.after(stop)
  snapshot = { ...snapshot, enabled: true }
  h.ctx.emit('loader/volatile-update')
  for (let n = 0; n < 100 && !(h.hooks.get('agent/created')?.length); n++) await new Promise(resolve => setTimeout(resolve, 10))
  h.ctx.emit('agent/created', { agent: makeAgent('qq-owner') })
  assert.equal(h.tools.length, 4, 'registered tools still exist in the registry')
  snapshot = { ...snapshot, enabled: false }
  h.ctx.emit('loader/volatile-update')
  for (let n = 0; n < 100 && h.tools.length; n++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(h.tools.length, 0)
  assert.equal(h.hooks.get('agent/created')?.length ?? 0, 0)
})

test('only the trusted bridge final text is committed, even when platform sending failed', async t => {
  const f = await fixture(t)
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  agent.autoReport = false
  agent.boundInput = '你好'
  h.ctx.emit('agent/created', { agent })
  await agent.preStep({ turn: 1, step: 1, messages: [userMessage('m-final', '风格包装\nUser QQ Message:\n你好')] })
  agent.turnEnd(1, [assistantEvent(1, '你好。\n```qq-control\n内部控制块\n```')])
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.requests.filter(row => row.path === '/v1/turns').length, 0)
  h.bridge.publish({ status: 'failed', generationStatus: 'completed', owner: true, scope: 'private',
    sessionId: 'qq-owner', turnMessageId: 'm-final', input: '你好', reply: '你好。', parts: [] })
  for (let n = 0; n < 100 && !f.requests.some(row => row.path === '/v1/turns'); n++) await new Promise(resolve => setTimeout(resolve, 10))
  const saved = f.requests.find(row => row.path === '/v1/turns').body
  assert.deepEqual(saved.messages, [{ role: 'user', content: '你好' }])
  assert.equal(saved.reply, '你好。')
})

test('missing required context blocks the native model boundary instead of falling through', async t => {
  const f = await fixture(t, { contextStale: true })
  const h = await start(t, f)
  const agent = makeAgent('qq-owner')
  h.ctx.emit('agent/created', { agent })
  await assert.rejects(agent.preStep({ turn: 1, step: 1, messages: [userMessage('m-block', '请继续')] }), /MEMORY_REQUIRED/)
  assert.equal(f.requests.filter(row => row.path === '/v1/turns').length, 0)
  f.state.contextStale = false
  f.state.persona = ''
  await assert.rejects(agent.preStep({ turn: 2, step: 1, messages: [userMessage('m-block', '请继续')] }), /MEMORY_REQUIRED/)
  f.state.persona = '恢复后的已发布人格'
  const admitted = await agent.preStep({ turn: 2, step: 1, messages: [userMessage('m-block', '请继续')] })
  assert.equal(admitted.messages[0].source.kind, 'rin-memory')
})
