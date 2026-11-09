import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SEGMENT_DEFAULTS, SegmentStore, estimateTokens, exchangeTokens,
  renderCarry, segmentSwitchReason, selectCarry,
} from '../session-store.js'
import { normalizeConfig, normalizeSegment } from '../config.js'
import { apply as applyRuntime, segmentPolicyFor } from '../index.js'
import { createServer } from 'node:http'


const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 造一段有 n 个完整交换的段状态;每条正文长度可控。 */
function record(count, { tokens = 0, pad = 4, lastUserAt = 0, startedAt = 0 } = {}) {
  const exchanges = Array.from({ length: count }, (_, index) => ({
    at: startedAt + index,
    user: '主'.repeat(pad),
    reply: '答'.repeat(pad),
  }))
  return {
    segment_id: 'seg_test',
    started_at: startedAt,
    last_user_at: lastUserAt,
    tokens,
    exchanges,
  }
}

async function tempStore(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rin-segment-'))
  const statePath = join(directory, 'segments.json')
  const store = new SegmentStore({ statePath, ...options })
  await store.open()
  return { store, statePath, directory }
}

test('token 估算按字符类别折算,不会把中文低估成四分之一', () => {
  // 一个汉字在主流分词器上基本就是一个 token;按 4 字符 1 token 折算会让
  // 128K 预算放进五十万字,上限就形同虚设。
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello world'), 3)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined), 0)
  // 中英混排:两侧各自折算后相加。
  assert.equal(estimateTokens('你好hello'), 2 + 2)
  assert.ok(estimateTokens('你'.repeat(1000)) >= 1000)
  // 一次交换 = 两侧正文 + 每侧的分帧开销。
  assert.equal(exchangeTokens({ user: '你好', reply: '在' }), 2 + 1 + 8)
})

test('软上限按最少轮数生效:轮数不够时宁可不换,也不抖动', () => {
  const limits = SEGMENT_DEFAULTS
  const now = DAY
  const little = record(limits.minTurns - 1, { tokens: limits.budgetTokens, lastUserAt: now })
  assert.equal(segmentSwitchReason(little, { now, limits }), null)
  const enough = record(limits.minTurns, { tokens: limits.budgetTokens, lastUserAt: now })
  assert.equal(segmentSwitchReason(enough, { now, limits }), 'budget')
})

test('硬上限绕开最少轮数:单条超长文本或大图不能冲破上限', () => {
  const limits = SEGMENT_DEFAULTS
  const now = DAY
  const tiny = record(1, { tokens: limits.hardTokens, lastUserAt: now })
  assert.equal(segmentSwitchReason(tiny, { now, limits }), 'hard')
  // 硬上限优先:同时越过两条线时报告硬上限,便于看出是异常输入而不是正常长聊。
  const both = record(20, { tokens: limits.hardTokens, lastUserAt: now })
  assert.equal(segmentSwitchReason(both, { now, limits }), 'hard')
})

test('空闲按真实用户互动计时,主动消息与后台任务不让它续命', async () => {
  const limits = SEGMENT_DEFAULTS
  const startedAt = 0
  const lastUserAt = 10 * DAY
  const now = lastUserAt + limits.idleHours * HOUR
  const state = record(limits.minTurns, { tokens: 1000, lastUserAt, startedAt })
  assert.equal(segmentSwitchReason(state, { now: now - 1, limits }), null)
  assert.equal(segmentSwitchReason(state, { now, limits }), 'idle')
  // 空闲计时只看 last_user_at:即便段龄很久,刚聊过就不换。
  const fresh = record(limits.minTurns, { tokens: 1000, lastUserAt: now, startedAt: 0 })
  assert.equal(segmentSwitchReason(fresh, { now, limits }), null)
})

test('段龄是软上限:在两次回合之间生效,不打断进行中的回合', () => {
  const limits = SEGMENT_DEFAULTS
  // 用真实毫秒时间戳,而不是 0:0 在段状态里表示「未知」,不该被当成 1970 年。
  const startedAt = 1_700_000_000_000
  const young = startedAt + DAY
  const old = startedAt + limits.maxAgeDays * DAY + 1
  // 段还年轻:什么都不换。
  const fresh = record(limits.minTurns, { tokens: 1000, lastUserAt: young, startedAt })
  assert.equal(segmentSwitchReason(fresh, { now: young, limits }), null)

  // 默认参数下 idle(24h)先于 age(14d)到:超过一天的空档按空闲换段,原因记为 idle。
  const stale = record(limits.minTurns, { tokens: 1000, lastUserAt: startedAt, startedAt })
  assert.equal(segmentSwitchReason(stale, { now: old, limits }), 'idle')
  assert.equal(segmentSwitchReason({ ...stale, tokens: limits.hardTokens }, { now: old, limits }), 'idle')

  // age 是 idle_hours 被调大之后仍然存在的兜底:段龄到线就换,即便主人刚刚说过话。
  // 这不是「打断回合」—— 判定只发生在两次回合之间(上一轮已结束、下一轮未开始)。
  const wide = { ...limits, idleHours: limits.maxAgeDays * 24 + 1 }
  assert.equal(segmentSwitchReason(stale, { now: old, limits: wide }), 'age')
  const chatty = record(limits.minTurns, { tokens: 1000, lastUserAt: old, startedAt })
  assert.equal(segmentSwitchReason(chatty, { now: old, limits: wide }), 'age')

  // 没有段,就没有可换的东西。
  assert.equal(segmentSwitchReason(undefined, { now: old, limits }), null)
})

test('带入历史永不拆半轮,轮数与正文两个上限取先到', () => {
  const limits = SEGMENT_DEFAULTS
  const many = record(limits.carryTurns + 10, { pad: 1 })
  const picked = selectCarry(many, limits)
  assert.equal(picked.exchanges.length, limits.carryTurns)
  // 取的是最近的那些,顺序仍是「先发生先出现」。
  assert.deepEqual(picked.exchanges, many.exchanges.slice(-limits.carryTurns))

  // 正文上限先到:整交换地放弃,不取半句。
  const fat = record(10, { pad: 4000 })
  const byTokens = selectCarry(fat, limits)
  assert.ok(byTokens.tokens <= limits.carryTokens)
  assert.ok(byTokens.exchanges.length < fat.exchanges.length)
  for (const exchange of byTokens.exchanges) {
    assert.ok(exchange.user && exchange.reply, 'a half exchange must never be carried')
  }
  const latestOversize = { user: '超'.repeat(8001), reply: '回复' }
  assert.deepEqual(selectCarry({ exchanges: [...many.exchanges, latestOversize] }, limits), picked)
  // 空段与缺失输入都不炸。
  assert.deepEqual(selectCarry(undefined, limits), { exchanges: [], tokens: 0 })
  assert.deepEqual(selectCarry(record(0), limits), { exchanges: [], tokens: 0 })
})

test('带入正文按真实角色呈现,不加额外说明段', () => {
  const text = renderCarry([{ user: '上次那个服务器', reply: '记得,还在修。' }])
  assert.equal(text, '主人: 上次那个服务器\n铃芽: 记得,还在修。')
})

test('段状态落盘并重启恢复:换过的段不会被当成没换过而再换一次', async () => {
  const { store, statePath, directory } = await tempStore({ now: () => 1000 })
  try {
    const begun = await store.begin('private:1', { sessionId: 'qq-a-0', reason: 'initial' })
    assert.match(begun.segment_id, /^seg_/)
    await store.recordExchange('private:1', { user: '你好', reply: '在。' })
    await store.touchUser('private:1', 2000)

    const reopened = new SegmentStore({ statePath, now: () => 3000 })
    await reopened.open()
    const restored = reopened.current('private:1')
    assert.equal(restored.segment_id, begun.segment_id)
    assert.equal(restored.session_id, 'qq-a-0')
    assert.equal(restored.exchanges.length, 1)
    assert.equal(restored.last_user_at, 2000)
    assert.equal(restored.tokens, exchangeTokens({ user: '你好', reply: '在。' }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('换段保留上一段身份,并且重置累计与计时', async () => {
  const { store, directory } = await tempStore()
  try {
    await store.begin('private:1', { sessionId: 'qq-a-0' })
    await store.recordExchange('private:1', { user: '一句话', reply: '回一句' })
    const next = await store.begin('private:1', { sessionId: 'qq-a-1', reason: 'budget' })
    assert.equal(next.session_id, 'qq-a-1')
    assert.equal(next.previous_session_id, 'qq-a-0')
    assert.equal(next.reason, 'budget')
    assert.notEqual(next.segment_id, 'seg_test')
    assert.equal(next.exchanges.length, 0)
    assert.equal(next.tokens, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('半轮不入账:只有主人原话没有实际回复的那一轮不记', async () => {
  const { store, directory } = await tempStore()
  try {
    await store.begin('private:1', { sessionId: 'qq-a-0' })
    await store.recordExchange('private:1', { user: '只说了半句', reply: '   ' })
    await store.recordExchange('private:1', { user: '', reply: '只有回复' })
    assert.equal(store.current('private:1').exchanges.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('段状态损坏时从空状态继续,不让聊天起不来', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rin-segment-'))
  const statePath = join(directory, 'segments.json')
  try {
    await writeFile(statePath, '{ this is not json', 'utf8')
    const store = new SegmentStore({ statePath, logger: { warn() {} } })
    await store.open()
    assert.equal(store.current('private:1'), undefined)
    // 原文件保留给排查,不被静默覆盖成空。
    assert.match(await readFile(statePath, 'utf8'), /this is not json/)
    await store.begin('private:1', { sessionId: 'qq-a-0' })
    const reopened = new SegmentStore({ statePath })
    await reopened.open()
    assert.ok(reopened.current('private:1'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('没有落盘路径时也可只在内存中工作', async () => {
  const store = new SegmentStore()
  await store.open()
  await store.begin('private:1', { sessionId: 'qq-a-0' })
  await store.recordExchange('private:1', { user: 'hi', reply: 'hey' })
  assert.equal(store.current('private:1').exchanges.length, 1)
  await store.save()
})

test('配置收敛:七个参数按卡上的默认值,写坏或自相矛盾时回落到默认', () => {
  assert.deepEqual(normalizeConfig({}).segment, SEGMENT_DEFAULTS)
  assert.deepEqual(normalizeConfig({}).segment, {
    budgetTokens: 128000,
    hardTokens: 160000,
    carryTurns: 30,
    carryTokens: 8000,
    idleHours: 24,
    minTurns: 6,
    maxAgeDays: 14,
  })
  // 硬上限不高于软上限:软上限永远先到,硬上限形同虚设,必须拉回。
  const inverted = normalizeSegment({ budgetTokens: 50000, hardTokens: 40000 })
  assert.equal(inverted.budgetTokens, 50000)
  assert.ok(inverted.hardTokens > inverted.budgetTokens)
  // 带入上限不小于软上限:新段首次请求会自带超限。
  assert.equal(normalizeSegment({ budgetTokens: 50000, carryTokens: 60000 }).carryTokens,
    SEGMENT_DEFAULTS.carryTokens)
  // 非法类型与越界值一律回落,不带着矛盾的上限运行。
  const junk = normalizeSegment({ idleHours: 0, minTurns: 'many', carryTurns: -3, maxAgeDays: Number.NaN })
  assert.equal(junk.idleHours, SEGMENT_DEFAULTS.idleHours)
  assert.equal(junk.minTurns, SEGMENT_DEFAULTS.minTurns)
  assert.equal(junk.carryTurns, SEGMENT_DEFAULTS.carryTurns)
  assert.equal(junk.maxAgeDays, SEGMENT_DEFAULTS.maxAgeDays)
})


// ---------------------------------------------------------------------------
// 接线验收:用真假服务 + 宿主替身跑完整装配
// ---------------------------------------------------------------------------

/**
 * 分段接线的集成验收。
 *
 * 用一个真的假服务(而不是 mock 掉 client)跑完整链路,因为这一卡的要害全在
 * 「什么时候问、问完做什么、重启后还记不记得」这三件事上,这些只有真的走一遍
 * 装配、存储与事件才看得出来。
 *
 * 这里的桥接替身同时扮演两个角色:
 * - Agent 侧:把本插件注册的系统段与 pre-step 钩子接起来;
 * - 段端口侧:按生产接线方式调用 segmentSwitchReason / onSegmentSwitched,
 *   也就是 AgentTeams 里桥接层即将补上的那两处调用。
 */
async function fixture(t, { segment = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-'))
  const requests = []
  const state = {
    // 服务端默认没有续聊便条路由:便条本来就是可选的。
    noteRoute: false,
    noteText: '',
    openThreads: [],
    friendAllowed: true,
    friendLookupAvailable: true,
  }
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const path = request.url.split('?')[0]
    requests.push({ path, body })
    response.setHeader('Content-Type', 'application/json')
    if (path === '/v1/health') {
      response.end(JSON.stringify({ storage: { status: 'ready' }, chat: { status: 'ready' } }))
      return
    }
    if (path === '/v1/cleanup/pending') {
      response.end(JSON.stringify({ items: [] }))
      return
    }
    if (path === '/v1/qq/persona') {
      if (!state.friendLookupAvailable) {
        response.statusCode = 503
        response.end(JSON.stringify({ code: 'unavailable' }))
        return
      }
      const subject = new URL(request.url, 'http://localhost').searchParams.get('subject')
      response.end(JSON.stringify({ text: '我是公开版铃芽。', revision: 1,
        memory_allowed: state.friendAllowed && subject === 'qq-friend:42', memory_enabled: true }))
      return
    }
    if (path === '/v1/segment/note') {
      if (!state.noteRoute) { response.statusCode = 404; response.end(JSON.stringify({ code: 'not_found' })); return }
      response.end(JSON.stringify({ text: state.noteText }))
      return
    }
    if (path === '/v1/context') {
      const segment = body.segment_history
      const friend = body.subject?.startsWith('qq-friend:')
      response.end(JSON.stringify({
        persona: friend ? '' : '温柔而直白。', persona_version: friend ? '' : 'pub-1', card_revision: friend ? 0 : 1,
        context_receipt_id: 'ctx-' + requests.length,
        // requirePersona 要求「已发布人格或必需更正」至少其一:这里给一份更正。
        corrections: { block: friend ? '' : '不要用旧称呼' },
        context: { result: 'miss', context: '', memory_ids: [],
          ...(segment ? { segment_sources: segment.mode === 'topic' && body.text === '早安'
            ? [] : segment.exchanges.map(row => row.source_key),
            selection: { version: 1, status: 'empty', items: [] } } : {}) },
        recent_turns: [],
      }))
      return
    }
    response.end(JSON.stringify({ status: 'ok', durable: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const config = {
    enabled: true,
    url: 'http://127.0.0.1:' + server.address().port,
    clientId: 'dsh-desktop', characterId: 'companion', subject: 'private',
    pluginId: 'dsh_memory', tokenEnv: 'DSH_SEGMENT_TEST_TOKEN', tokenFile: '',
    timeoutMs: 1000, sessionPrefixes: ['qq-'], memoryTools: true,
    stateDirectory: root, sessionsDirectory: join(root, 'sessions'),
    maxPending: 8, retryIntervalMs: 60000, retireSessionsOnCleanup: true,
    segment: { ...SEGMENT_DEFAULTS, ...segment },
  }
  process.env[config.tokenEnv] = 'test-token'
  return { root, requests, state, config }
}

/** 用真实装配路径建一个运行时:MemoryRuntime + 真 client + 真假服务。 */
async function loadRuntime(harness, config, { open = true } = {}) {
  const { MemoryClient } = await import('../memory-client.js')
  const { MemoryRuntime } = await import('../index.js')
  const logger = { info() {}, warn() {}, error() {} }
  const client = new MemoryClient(config, process.env[config.tokenEnv], {
    statePath: join(config.stateDirectory, 'outbox.json'), logger,
  })
  await client.open()
  const runtime = new MemoryRuntime(harness.ctx, config, client, logger)
  if (open) {
    await runtime.segments.open()
    runtime.bridge = harness.services.get('qqBridgeEvents')
  }
  return runtime
}

/** 最小 Host 替身:装配插件、投递事件,并把桥接的绑定/轮次报告接上。 */
function host({ home, bridge: external } = {}) {
  const hooks = new Map()
  const services = new Map()
  const listeners = new Set()
  const admissions = new Set()
  const bindings = new Map()
  const bridge = {
    ...external,
    binding: id => bindings.get(id),
    subscribe(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    subscribeAdmission(listener) { admissions.add(listener); return { dispose: () => admissions.delete(listener) } },
    async prepare(input) {
      bindings.set(input.sessionId, input)
      for (const listener of admissions) await listener(input)
    },
    async publish(report) { for (const listener of listeners) await listener(report) },
    pushPrivate: async () => {},
    async retireSession(id) { bindings.delete(id) },
  }
  services.set('qqBridgeEvents', bridge)
  const ctx = {
    profileContext: { home },
    logger: { info() {}, warn(...a) { console.log('WARN', ...a) }, error(...a) { console.log('ERR', ...a) } },
    on(name, callback) {
      const list = hooks.get(name) ?? []
      list.push(callback)
      hooks.set(name, list)
      return () => hooks.set(name, (hooks.get(name) ?? []).filter(item => item !== callback))
    },
    get: name => services.get(name),
    agents: { list: () => [] },
    tools: { register: () => () => {} },
    emit(name, payload) {
      for (const callback of hooks.get(name) ?? []) callback(payload)
    },
    provide(name, value) {
      services.set(name, value)
      return () => { if (services.get(name) === value) services.delete(name) }
    },
  }
  return { ctx, hooks, services, bridge, bindings }
}

/** 最小 agent;pre-step 与系统段都按宿主的形状接到同一个 ctx 上。 */
function makeAgent(sessionId) {
  const hooks = new Map()
  const agent = {
    session: { id: sessionId, events: [], header: { origin: 'chat' } },
    ctx: {
      effect(callback) { return callback() },
      on(name, callback) {
        const list = hooks.get(name) ?? []
        list.push(callback)
        hooks.set(name, list)
        return () => hooks.set(name, (hooks.get(name) ?? []).filter(item => item !== callback))
      },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      get: () => ({ register: () => () => {} }),
      tools: { register: () => () => {} },
    },
    followup() {},
    async whenIdle() {},
    emitSession(event) {
      for (const listener of hooks.get('session/event') ?? []) listener(this.session, event)
    },
    preStep: (payload, next) => (hooks.get('agent/pre-step') ?? []).reduce(
      (tail, callback) => tail.then(rest => callback(rest, () => next(rest))), Promise.resolve(payload)),
  }
  return agent
}

test('段状态落盘:重启后仍是同一段、同一会话、同样的累计', async t => {
  const { root, config, requests: requestsList } = await fixture(t)
  const first = host({ home: root })
  const dispose = await applyRuntime(first.ctx, config)
  const agent = makeAgent('qq-owner-1')
  first.bindings.set(agent.session.id, { sessionId: agent.session.id, sessionKey: 'private:1', scope: 'private', owner: true, input: '' })
  first.ctx.emit('agent/created', { agent })
  await first.bridge.prepare({ sessionId: agent.session.id, sessionKey: 'private:1', scope: 'private', owner: true, userId: 1, input: '你好' })
  // 真实路径:pre-step 才会走到 ensureTurn(ensureTurn 依赖本轮真实用户消息)。
  const decision = await agent.preStep(
    { turn: 1, step: 1, messages: [{ id: 'm-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] },
    payload => ({ kind: 'enter', messages: payload.messages }),
  )
  assert.equal(decision.kind, 'enter')
  // 走一轮完整交换的记账路径。
  await first.bridge.publish({
    sessionKey: 'private:1', sessionId: agent.session.id, scope: 'private', owner: true,
    turnMessageId: 'm-1', input: '你好', reply: '在。', status: 'completed',
    generationStatus: 'completed', parts: [{ index: 0, ok: true, chars: 2, replyText: '在。' }],
  })
  await dispose()
  const raw = await readFile(join(root, 'segments.json'), 'utf8')
  const saved = JSON.parse(raw)
  const record = saved.segments['private:1']
  assert.ok(record?.segment_id, 'segment must be persisted')
  assert.equal(record.session_id, agent.session.id)
  assert.equal(record.exchanges.length, 1)
  assert.equal(record.exchanges[0].user, '你好')
  assert.match(record.exchanges[0].source_key, /^plugin:dsh_memory:companion:private:/)
  assert.ok(record.tokens > 0)

  // 重启:同一份文件必须被重新读成同一个段。
  const second = host({ home: root })
  const disposeAgain = await applyRuntime(second.ctx, config)
  const reopened = JSON.parse(await readFile(join(root, 'segments.json'), 'utf8'))
  assert.deepEqual(reopened.segments['private:1'].segment_id, record.segment_id)
  await disposeAgain()
})

test('满预算换段:按生产接线调用判定与通知,新段只带最近完整轮且旧话只出现一次', async t => {
  const { root, config } = await fixture(t, { segment: { budgetTokens: 1000, carryTurns: 2, minTurns: 2 } })
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const agent = makeAgent('qq-owner-2')
  const KEY = 'private:2'
  h.bindings.set(agent.session.id, { sessionId: agent.session.id, sessionKey: KEY, scope: 'private', owner: true, input: '' })
  h.ctx.emit('agent/created', { agent })

  // runtime 是插件内部实例;通过装配后的桥接行为间接驱动,不碰私有字段。
  const runtime = await loadRuntime(h, config)
  await runtime.bindSegment(KEY, agent.session.id)

  const lines = ['第一句' + '啊'.repeat(700), '第二句' + '啊'.repeat(700), '第三句' + '啊'.repeat(700)]
  for (const [index, line] of lines.entries()) {
    await h.bridge.prepare({ sessionId: agent.session.id, sessionKey: KEY, scope: 'private', owner: true, userId: 2, input: line })
    await runtime.segments.recordExchange(KEY, { user: line, reply: '回' + index, sourceKey: 'src-' + index })
  }
  assert.equal(runtime.segments.current(KEY).exchanges.length, 3)

  // 判定:累计已越过软上限且轮数足够。
  const reason = runtime.segmentSwitchReason(KEY, agent.session.id)
  assert.equal(reason, 'budget')
  runtime.candidates.set(agent.session.id, agent)
  agent.session.snapshotEvents = () => [{ type: 'assistant/message',
    data: { usage: { inputTokens: 10000, cacheReadTokens: 144000, outputTokens: 1000 } } }]
  assert.equal(runtime.segmentSwitchReason(KEY, agent.session.id, { text: '接着来', imageCount: 1 }), 'hard')

  // 生产接线的通知:带上旧会话与新会话。
  await runtime.onSegmentSwitched(KEY, { previousSessionId: agent.session.id, sessionId: 'qq-new-1', reason })
  const after = runtime.segments.current(KEY)
  assert.equal(after.exchanges.length, 0, 'new segment starts empty')
  assert.equal(after.session_id, 'qq-new-1')
  assert.equal(after.previous_session_id, agent.session.id)

  // 只带最近两轮,而且按时间顺序。
  const restarted = await loadRuntime(h, config)
  assert.equal(restarted.segmentSwitchReason(KEY, agent.session.id), 'budget')
  await restarted.onSegmentSwitched(KEY, { previousSessionId: agent.session.id, sessionId: 'qq-new-after-restart', reason })
  const restored = restarted.segments.current(KEY)
  assert.equal(restored.session_id, 'qq-new-after-restart')
  assert.equal(restored.previous_session_id, agent.session.id)
  const context = { context: { segment_sources: ['src-1', 'src-2'] } }
  const carry = renderCarry(restarted.approvedSegmentCarry(restored, context).exchanges)
  assert.ok(carry.includes('第三句'), 'most recent exchange must be carried')
  assert.ok(carry.includes('第二句'), 'carryTurns = 2 means the last two exchanges')
  assert.ok(!carry.includes('第一句'), 'nothing older than the window is carried')
  // 带入的是完整轮,不是半句:每一轮都同时有主人与铃芽两行。
  assert.equal(carry.split('主人: ').length - 1, 2)
  assert.equal(carry.split('铃芽: ').length - 1, 2)
  assert.ok(carry.split('\n').length <= 4, 'at most carryTurns exchanges (2 lines each)')
  await restarted.segments.adoptCarry(KEY, restored.segment_id, ['src-1', 'src-2'])
  assert.equal(restarted.approvedSegmentCarry(restored, context), undefined)
  await dispose()
})

test('同一个段不会被重复判定为要换:换过之后重新计时', async t => {
  const { root, config } = await fixture(t, { segment: { budgetTokens: 1000, minTurns: 1 } })
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const runtime = await loadRuntime(h, config)
  const KEY = 'private:3'
  await runtime.bindSegment(KEY, 'qq-s-0')
  await runtime.segments.recordExchange(KEY, { user: '一'.repeat(700), reply: '二'.repeat(700) })
  assert.equal(runtime.segmentSwitchReason(KEY, 'qq-s-0'), 'budget')
  await runtime.onSegmentSwitched(KEY, { previousSessionId: 'qq-s-0', sessionId: 'qq-s-1', reason: 'budget' })
  // 新段是空的:刚换过就不该再换,否则会连丢两段上下文。
  assert.equal(runtime.segmentSwitchReason(KEY, 'qq-s-1'), undefined)
  await dispose()
})

test('跨日续聊回放按 12 / 20 轮上限选同话题原话，并优先保留命中的早期原话', async t => {
  const { root, config, requests } = await fixture(t)
  const runtime = await loadRuntime(host({ home: root }), config)
  const exchanges = Array.from({ length: 25 }, (_, i) => ({
    at: i, source_key: 'topic-' + i, user: '海边露营清单第' + i + '项', reply: '收到这一项',
  }))
  const record = await runtime.segments.begin('private:8', { sessionId: 'qq-next-day', reason: 'idle',
    handoff: { mode: 'topic', exchanges } })
  const context = { context: { segment_sources: exchanges.map(item => item.source_key), segment_anchors: ['topic-0'] } }
  const normal = runtime.approvedSegmentCarry(record, context).exchanges
  assert.equal(normal.length, 12)
  assert.equal(normal[0].source_key, 'topic-0')
  context.context.segment_detail = true
  assert.equal(runtime.approvedSegmentCarry(record, context).exchanges.length, 20)
  context.context.segment_sources = []
  assert.deepEqual(runtime.approvedSegmentCarry(record, context).exchanges, [])
  const scope = runtime.client.scope('qq-next-day')
  const greeting = await runtime.turnContext(scope, '早安', 'private:8', 'qq-next-day')
  assert.deepEqual(runtime.approvedSegmentCarry(record, greeting).exchanges, [])
  await runtime.segments.adoptCarry('private:8', record.segment_id, [])
  assert.ok(record.handoff.deferred)
  await runtime.turnContext(scope, '今天想吃面', 'private:8', 'qq-next-day')
  assert.equal(requests.at(-1).body.segment_history, undefined)
  const resumed = await runtime.turnContext(scope, '继续聊昨晚的露营清单', 'private:8', 'qq-next-day')
  assert.equal(runtime.approvedSegmentCarry(record, resumed).exchanges.length, 12)
  await runtime.stop()
})

test('手工切会话从新段开始，旧段预算和带入材料随原会话保留', async t => {
  const { root, config } = await fixture(t, { segment: { budgetTokens: 1000, minTurns: 1 } })
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const runtime = await loadRuntime(h, config)
  const KEY = 'private:4'
  await runtime.bindSegment(KEY, 'qq-old')
  await runtime.segments.recordExchange(KEY, { user: '一'.repeat(700), reply: '二'.repeat(700) })
  // 宿主自己换了会话(重启/手工 /new-session):不该因此再换一次段并丢掉带入。
  assert.equal(runtime.segmentSwitchReason(KEY, 'qq-other'), undefined)
  await runtime.bindSegment(KEY, 'qq-other')
  assert.equal(runtime.segments.current(KEY).session_id, 'qq-other')
  assert.equal(runtime.segments.current(KEY).tokens, 0)
  assert.equal(runtime.segments.current(KEY).handoff, undefined)
  await dispose()
})

test('没有续聊便条路由时不影响任何一轮,也不反复告警', async t => {
  const { root, config, requests } = await fixture(t)
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const runtime = await loadRuntime(h, config)
  await runtime.bindSegment('private:5', 'qq-n-0')
  // 服务端没有这条路由:降级为空串,而不是抛错或补一句话。
  assert.equal(await runtime.segmentNoteFor('private:5', 'qq-n-0'), '')
  assert.ok(requests.some(row => row.path === '/v1/segment/note'))
  await dispose()
})

test('新段第一次请求只带允许的东西:没有原生压缩摘要、没有 tools 字段', async t => {
  const { root, config } = await fixture(t, { segment: { budgetTokens: 1000, carryTurns: 2, minTurns: 1 } })
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const KEY = 'private:6'
  const SESSION = 'qq-clean-0'

  // 生产接线就是这个端口:桥接插件从宿主服务里取到它,装到 executor 上。
  const policy = h.services.get('companionSegmentPolicy')
  assert.ok(policy, 'segment policy must be published for the bridge to install')

  // 第一段:一轮能越过软上限的交换。
  const agent0 = makeAgent(SESSION)
  h.bindings.set(SESSION, { sessionId: SESSION, sessionKey: KEY, scope: 'private', owner: true, input: '' })
  h.ctx.emit('agent/created', { agent: agent0 })
  await h.bridge.prepare({ sessionId: SESSION, sessionKey: KEY, scope: 'private', owner: true, userId: 6, input: '上次那个服务器还没修好' })
  await agent0.preStep(
    { turn: 1, step: 1, messages: [{ id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上次那个服务器还没修好' + '啊'.repeat(700) }] }] },
    payload => ({ kind: 'enter', messages: payload.messages }),
  )
  await h.bridge.publish({
    sessionKey: KEY, sessionId: SESSION, scope: 'private', owner: true, turnMessageId: 'u0',
    input: '上次那个服务器还没修好' + '啊'.repeat(700), reply: '记着呢。' + '嗯'.repeat(700) + '未送达部分',
    status: 'failed', generationStatus: 'completed', parts: [
      { index: 0, ok: true, chars: 704, replyText: '记着呢。' + '嗯'.repeat(700) },
      { index: 1, ok: false, chars: 5 },
    ],
  })

  // 判定与通知都走端口,与桥接层即将补上的两处调用完全一致。
  const reason = await policy.shouldStartNewSegment(KEY, SESSION)
  assert.equal(reason, 'budget')
  await policy.carryOverText(KEY, SESSION, 'qq-clean-1', reason)

  // 新段第一轮。
  const agent = makeAgent('qq-clean-1')
  h.bindings.set('qq-clean-1', { sessionId: 'qq-clean-1', sessionKey: KEY, scope: 'private', owner: true, input: '' })
  h.ctx.emit('agent/created', { agent })
  await h.bridge.prepare({ sessionId: 'qq-clean-1', sessionKey: KEY, scope: 'private', owner: true, userId: 6, input: '上次那个服务器' })
  const decision = await agent.preStep(
    { turn: 1, step: 1, messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上次那个服务器' }] }] },
    payload => ({ kind: 'enter', messages: payload.messages }),
  )
  const kinds = decision.messages.map(message => message.source?.kind ?? '')
  // 带入的旧话有自己的来源标记:既不是主人这次说的话,也不是记忆资料。
  assert.ok(kinds.includes('segment-carry'), 'carried history must be marked: ' + kinds.join(','))
  // 主人这一次的原话仍然存在,并且是最后一条——带入不能顶替或盖住它。
  const last = decision.messages.at(-1)
  assert.equal(last.source?.kind, 'user')
  assert.equal(last.content[0].text, '上次那个服务器')
  // 干净输入:新会话日志里没有原生压缩摘要节点,带入也不引入 tools 字段。
  assert.ok(!JSON.stringify(decision.messages).includes('compact-checkpoint'), 'no native compaction summary')
  assert.equal(decision.tools, undefined, 'carry must not introduce a tools field')
  // 历史携带材料保留原说话者和先前时间。
  const carry = decision.messages.find(message => message.source?.kind === 'segment-carry')
  assert.match(carry.content[0].text, /当时的说话者和顺序/)
  assert.match(carry.content[0].text, /服务器/)
  assert.doesNotMatch(carry.content[0].text, /未送达部分/)
  const staged = JSON.parse(await readFile(join(root, 'segments.json'), 'utf8')).segments[KEY]
  assert.ok(!staged.handoff.adopted)
  for (const message of decision.messages) agent.emitSession({ type: 'user/message', data: message })
  agent.emitSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.bridge.prepare({ sessionId: 'qq-clean-1', sessionKey: KEY, scope: 'private', owner: true, userId: 6, input: '那下次呢' })
  const next = await agent.preStep(
    { turn: 2, step: 1, messages: [{ id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '那下次呢' }] }] },
    payload => ({ kind: 'enter', messages: payload.messages }),
  )
  assert.ok(!next.messages.some(message => message.source?.kind === 'segment-carry'))
  const reopened = await loadRuntime(h, config)
  const source = staged.handoff.exchanges[0].source_key
  assert.deepEqual(new Set(reopened.sessionsForDeletion({ source_keys: [source] })), new Set([SESSION, 'qq-clean-1']))
  await reopened.handleCleanup([{ deletion_id: 'delete-test', source_keys: [source] }])
  assert.equal(reopened.segments.current(KEY), undefined)
  await dispose()
})

test('获授权好友复用私聊换段与送达来源，按好友身份带入和清理', async t => {
  const { root, config, requests, state } = await fixture(t, { segment: { budgetTokens: 1000, minTurns: 1 } })
  config.friendMemoryEnabled = false
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  t.after(dispose)
  const key = 'private:42'
  const owner = false
  async function input(sessionId, id, text, memorySetting = {}) {
    const agent = makeAgent(sessionId)
    agent.ctx.tools.guard = () => () => {}
    h.ctx.emit('agent/created', { agent })
    await h.bridge.prepare({ sessionId, sessionKey: key, userId: 42, scope: 'private', owner, input: text,
      friendMemoryEnabled: true, ...memorySetting })
    return agent.preStep({ turn: 1, step: 1, messages: [
      { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    ] }, payload => ({ kind: 'enter', messages: payload.messages }))
  }
  const oldSession = 'qq-friend-old'
  const oldText = '露营清单'.repeat(270)
  await input(oldSession, 'friend-old', oldText)
  await h.bridge.publish({ sessionId: oldSession, sessionKey: key, owner, scope: 'private',
    status: 'completed', turnMessageId: 'friend-old', input: oldText, reply: '带一盏灯。',
    parts: [{ index: 0, chars: 5, ok: true, replyText: '带一盏灯。' }] })

  const policy = h.services.get('companionSegmentPolicy')
  const continuation = { owner, userId: 42, text: '接着聊', imageCount: 0, friendMemoryEnabled: true }
  const reason = await policy.shouldStartNewSegment(key, oldSession, continuation)
  assert.equal(reason, 'budget')
  assert.equal(continuation.friendMemoryStatus.state, 'enabled')
  await policy.carryOverText(key, oldSession, 'qq-friend-new', reason)
  const decision = await input('qq-friend-new', 'friend-new', '接着聊', continuation)
  const carry = decision.messages.find(message => message.source?.kind === 'segment-carry').content[0].text
  assert.match(carry, /朋友: 露营清单/)
  assert.match(carry, /我: 带一盏灯/)
  assert.doesNotMatch(carry, /主人/)
  const context = requests.findLast(row => row.path === '/v1/context')
  const [exchange] = context.body.segment_history.exchanges
  assert.equal(context.body.subject, 'qq-friend:42')
  assert.match(exchange.source_key, /^plugin:dsh_memory:companion:qq-friend_42:/)
  const reopened = await loadRuntime(h, config)
  assert.deepEqual(new Set(reopened.sessionsForDeletion({ source_keys: [exchange.source_key] })),
    new Set([oldSession, 'qq-friend-new']))
  state.friendLookupAvailable = false
  assert.equal(await policy.shouldStartNewSegment(key, 'qq-friend-new', continuation), undefined)
  assert.equal(continuation.friendMemoryStatus.state, 'unavailable')
  await assert.rejects(() => h.bridge.prepare({ sessionId: 'qq-friend-new', sessionKey: key, scope: 'private',
    input: '接着聊', ...continuation }), /MEMORY_REQUIRED/)
  state.friendLookupAvailable = true
  state.friendAllowed = false
  assert.equal(await policy.shouldStartNewSegment(key, 'qq-friend-new', continuation), 'memory-off')
  assert.equal(continuation.friendMemoryStatus.state, 'ungranted')
  await policy.carryOverText(key, 'qq-friend-new', 'qq-friend-off', 'memory-off')
  const requestCount = requests.length
  await input('qq-friend-off', 'friend-off', '接着聊', continuation)
  assert.ok(!requests.slice(requestCount).some(row => row.path === '/v1/context' || row.path === '/v1/qq/persona'))
  assert.equal(await policy.shouldStartNewSegment(key, 'qq-friend-off', continuation), undefined)
})

test('空闲只认真实用户互动:主动消息与后台任务不重置计时', async t => {
  const { root, config } = await fixture(t, { segment: { idleHours: 1, minTurns: 0 } })
  const h = host({ home: root })
  const dispose = await applyRuntime(h.ctx, config)
  const KEY = 'private:7'
  const runtime = await loadRuntime(h, config)
  await runtime.bindSegment(KEY, 'qq-idle-0')
  const record = runtime.segments.current(KEY)
  // 把「最后一次真实互动」推到两小时前,越过 idle 线。
  record.last_user_at = Date.now() - 2 * 60 * 60 * 1000
  assert.equal(runtime.segmentSwitchReason(KEY, 'qq-idle-0'), 'idle')
  // 主动消息到达:桥接会 publish 一条 companion-proactive 的轮次报告,它不该续命。
  h.bridge.publish({
    sessionKey: KEY, sessionId: 'qq-idle-0', scope: 'private', owner: true,
    turnMessageId: 'proactive-1', input: '在吗', reply: '我在这儿。', status: 'completed',
    generationStatus: 'completed', parts: [{ index: 0, ok: true }],
  })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(runtime.segmentSwitchReason(KEY, 'qq-idle-0'), 'idle',
    'a proactive message must not reset the idle clock')
  await dispose()
})
