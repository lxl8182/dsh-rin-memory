/**
 * M6 交付 A:renderIncrement 的扩展渲染(state / episode / growth / working_summary)。
 *
 * 两条必须守住的语义:
 * 1. 增量:同一份材料只在**确实进入过模型输入**之后登记指纹,之后不再重贴;
 * 2. 不破坏新话题:旧事项一旦交付过,就不会在后续无关轮次里被硬拉回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRuntime, renderIncrement } from '../index.js'
import { normalizeConfig } from '../config.js'
import { MATERIAL_NOTE } from '../main-session.js'

/** 一份 M5 之后 /v1/context 会返回的上下文:老字段原样 + 四层新字段。 */
function context(overrides = {}) {
  return {
    persona: '温柔而直白。',
    persona_version: 'pub-1',
    card_revision: 3,
    context_receipt_id: 'ctx-1',
    corrections: { block: '' },
    context: { block: '' },
    recent_turns: [],
    // M5 additive layers
    working_summary: {
      sections: {
        growth: {
          name: 'growth',
          block: '相处与成长\n- 约好：晚上不催睡觉',
          items: [
            { kind: 'rule', id: 'r1', teaching_id: 't1', text: '晚上不催睡觉', label: '约好' },
            { kind: 'growth', id: 'g1', text: '开始习惯一起看比赛', label: '变化' },
          ],
        },
        important_facts: {
          name: 'important_facts',
          block: '重要事实\n- 喜欢红茶',
          items: [{ kind: 'fact', id: 'f1', text: '喜欢红茶', importance: 8 }],
        },
        open_threads: {
          name: 'open_threads',
          block: '未完话题\n- [进行中] 准备面试：下一步 模拟问答',
          items: [{ kind: 'thread', thread_id: 'th1', state: 'open', text: '准备面试', next_step: '模拟问答' }],
        },
        episode: {
          name: 'episode',
          block: '这段经历\n参与者：主人，我\n主人这边：定了面试日期\n结果：约好周日下午模拟\n终态：进行中',
          items: [{ kind: 'episode', episode_id: 'ep1', state: 'open', result: '约好周日下午模拟' }],
        },
      },
      episode: { episode_id: 'ep1', state: 'open', result: '约好周日下午模拟' },
    },
    state: {
      block: '想法：她今天有点累（强度 0.42）',
      version: 7,
      updated_at: '2026-10-27T10:00:00+08:00',
      items: [],
      state: {
        thoughts: [{ id: 's1', text: '她今天有点累' }],
        moods: [{ id: 'm1', label: '安心', cause: '聊开了', intensity: 0.8, effective_intensity: 0.42 }],
        concerns: [{ id: 'c1', text: '面试会不会太紧张' }],
        progress: [{ id: 'p1', text: '模拟问答还没做' }],
      },
    },
    episode: { episode_id: 'ep1' },
    ...overrides,
  }
}

test('every M6 layer reaches the model input, each under its own heading', () => {
  const { text, fingerprints } = renderIncrement(context(), {})
  assert.match(text, /\[相处与成长\]/)
  assert.match(text, /约好：晚上不催睡觉/)
  assert.match(text, /变化：开始习惯一起看比赛/)
  assert.match(text, /\[重要事实\]/)
  assert.match(text, /喜欢红茶/)
  assert.match(text, /\[当前状态\]/)
  assert.match(text, /想法：她今天有点累/)
  assert.match(text, /情绪：安心（因为聊开了）/)
  assert.match(text, /\[正在进行的事\]/)
  assert.match(text, /关注：面试会不会太紧张/)
  assert.match(text, /进展：模拟问答还没做/)
  assert.match(text, /进行中.*准备面试/)
  assert.match(text, /\[这段经历\]/)
  assert.match(text, /结果：约好周日下午模拟/)
  // 资料标注必须在:模型要能分辨"这是资料,不是主人刚说的话"。
  assert.ok(text.startsWith(MATERIAL_NOTE), 'the material note heads the block')
  // 人格不进消息(它只在系统段里一份)。
  assert.ok(!text.includes('温柔而直白。'))
  // 一份材料一个指纹,重贴判定才有依据:2 规则/变化 + 1 事实 + 2 自己的状态
  // + 3 进行中的事 + 1 这次经历 = 9。
  assert.equal(fingerprints.length, 9, 'one fingerprint per delivered item')
  assert.equal(new Set(fingerprints).size, fingerprints.length, 'fingerprints are unique')
})

test('the same material is never re-delivered once it really reached the model', () => {
  const first = renderIncrement(context(), {})
  assert.notEqual(first.text, '')
  const seen = Object.fromEntries(first.fingerprints.map(key => [key, 'now']))
  // 完全相同的上下文:一个字节都不再追加。
  assert.equal(renderIncrement(context(), seen).text, '')
  assert.deepEqual(renderIncrement(context(), seen).fingerprints, [])
})

test('a changed item is re-delivered while its unchanged neighbours are not', () => {
  const first = renderIncrement(context(), {})
  const seen = Object.fromEntries(first.fingerprints.map(key => [key, 'now']))
  // 只改一条规则的做法:同一条 teaching 被重写,应该只重发这一条。
  const changed = context()
  changed.working_summary = structuredClone(changed.working_summary)
  changed.working_summary.sections.growth.items[0].text = '晚上十点后就别再催睡觉'
  const next = renderIncrement(changed, seen)
  assert.match(next.text, /晚上十点后就别再催睡觉/)
  assert.ok(!next.text.includes('喜欢红茶'), 'unchanged facts stay silent')
  assert.ok(!next.text.includes('准备面试'), 'unchanged threads stay silent')
  assert.equal(next.fingerprints.length, 1, 'exactly the changed rule is fingerprinted again')
})

test('an unrelated new topic never drags old items back in', () => {
  // 第一轮把材料交付过;主人随后换了个无关话题。
  const first = renderIncrement(context(), {})
  const seen = Object.fromEntries(first.fingerprints.map(key => [key, 'now']))
  const unrelated = context({
    context: { block: '' },
    recent_turns: [],
  })
  // 服务端在新话题下不再给出旧的未完话题与经历(它自己判定 not_continuation),
  // 这里模拟"同一份旧摘要还在返回"的最坏情况:去重仍然让它保持沉默。
  const quiet = renderIncrement(unrelated, seen)
  assert.equal(quiet.text, '', 'nothing old is injected into an unrelated turn')
  assert.deepEqual(quiet.fingerprints, [])
})

test('a fresh open thread still gets delivered once, then never again', () => {
  const first = renderIncrement(context(), {})
  const seen = Object.fromEntries(first.fingerprints.map(key => [key, 'now']))
  // 新的未完话题(真的新增):交付一次。
  const added = context()
  added.working_summary = structuredClone(added.working_summary)
  added.working_summary.sections.open_threads.items.push({
    kind: 'thread', thread_id: 'th2', state: 'waiting', text: '等快递', next_step: '周三看物流',
  })
  const once = renderIncrement(added, seen)
  assert.match(once.text, /等快递/)
  const seen2 = { ...seen, ...Object.fromEntries(once.fingerprints.map(key => [key, 'now'])) }
  assert.equal(renderIncrement(added, seen2).text, '')
})

test('a service that only has the old fields renders exactly as before', () => {
  // M5 之前的服务:没有 working_summary / state / episode,只有原来那三样。
  const { text, fingerprints } = renderIncrement({
    corrections: { block: '不要叫我小潮' },
    context: { block: '- 用户喜欢红茶' },
    recent_turns: [{ type: 'human', data: { content: '在吗' } }],
  })
  const headings = [...text.matchAll(/^\[(.+)\]$/gm)].map(match => match[1])
  assert.deepEqual(headings, ['必须遵守的更正', '可能相关的记忆', '近期对话'])
  assert.equal(fingerprints.length, 3)
})

test('mood intensity decay does not make an old state look new', () => {
  const first = renderIncrement(context(), {})
  const seen = Object.fromEntries(first.fingerprints.map(key => [key, 'now']))
  // 同一份心情,半小时后强度衰减了:正文与指纹都不跟踪强度,所以不重贴。
  const decayed = context()
  decayed.state = structuredClone(decayed.state)
  decayed.state.state.moods[0].effective_intensity = 0.11
  decayed.state.state.moods[0].intensity = 0.8
  assert.equal(renderIncrement(decayed, seen).text, '')
})

test('the legacy growth block is used only when the summary is absent', () => {
  const legacy = renderIncrement({
    growth: { block: '相处与成长\n- 认识：喜欢安静地陪着', version: 2 },
  }, {})
  assert.match(legacy.text, /\[相处与成长\]/)
  assert.match(legacy.text, /喜欢安静地陪着/)
  // 同时有两份来源时只认 working_summary,避免同一批认识交付两次。
  const both = renderIncrement(context({
    growth: { block: '相处与成长\n- 认识：喜欢安静地陪着', version: 2 },
  }), {})
  assert.ok(!both.text.includes('喜欢安静地陪着'), 'the summary wins over the legacy block')
})

// -- G20:真实走进模型输入 ----------------------------------------------------

/** 一个假的记忆客户端:只实现 ensureTurn 用到的那几个方法。 */
function fakeClient(contextPayload) {
  const requests = []
  const client = {
    state: {
      pending: {}, generated: {}, sessions: {}, references: {}, injected: {},
      accepted: {}, sent: {}, recentTurns: {}, retiredSessions: [], cleanup: {}, status: {},
    },
    isRetired: () => false,
    scope: sessionId => ({ character_id: 'companion', subject: 'private', session_id: sessionId, scene: 'plugin:dsh_memory' }),
    serial: action => Promise.resolve(action()),
    save: async () => {},
    now: () => '2026-10-27T12:00:00.000Z',
    async request(path) {
      requests.push(path)
      if (path === '/v1/context') return contextPayload
      return { status: 'reserved', durable: true }
    },
  }
  return { client, requests }
}

function runtimeWith(contextPayload) {
  const { client, requests } = fakeClient(contextPayload)
  const ctx = { profileContext: { home: process.cwd() }, get: () => undefined, on: () => () => {} }
  const config = normalizeConfig({ stateDirectory: process.cwd(), sessionsDirectory: process.cwd() })
  const runtime = new MemoryRuntime(ctx, config, client, { info() {}, warn() {}, error() {} })
  runtime.bridge = { binding: sessionId => ({ sessionId, owner: true, scope: 'private', input: '' }) }
  return { runtime, requests }
}

const userMessage = (id, text) => ({
  id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
})

test('G20: state / episode / growth fragments really land in the final message list', async () => {
  const { runtime, requests } = runtimeWith(context())
  const agent = {
    session: { id: 'qq-g20', header: {} },
    options: { provider: 'test', model: 'model' },
    followup() {},
  }
  const payload = { turn: 1, step: 1, messages: [userMessage('m1', '今天面试怎么样')] }
  const decision = await runtime.preStep(agent, payload, async () => ({
    kind: 'enter', messages: [...payload.messages],
  }))
  assert.ok(requests.includes('/v1/context'))
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, 'rin-memory', 'the material is a marked source, not a user message')
  const text = injected.content[0].text
  // 三层都必须真的在这条消息里 —— 不是只渲染出来又被丢掉。
  assert.match(text, /\[相处与成长\]/, 'growth reaches the model')
  assert.match(text, /约好：晚上不催睡觉/)
  assert.match(text, /\[当前状态\]/, 'state reaches the model')
  assert.match(text, /她今天有点累/)
  assert.match(text, /\[这段经历\]/, 'the episode reaches the model')
  assert.match(text, /约好周日下午模拟/)
  // 指纹确实被登记:下一轮不会重贴。
  const scope = Object.keys(runtime.client.state.injected)[0]
  assert.ok(scope, 'the injected index was written')
  assert.equal(Object.keys(runtime.client.state.injected[scope]).length, 9)
})

test('G20: a turn with nothing new adds no message at all', async () => {
  const { runtime } = runtimeWith(context())
  const agent = { session: { id: 'qq-g20b', header: {} }, options: {}, followup() {} }
  const first = await runtime.preStep(
    agent, { turn: 1, step: 1, messages: [userMessage('m1', '你好')] },
    async () => ({ kind: 'enter', messages: [userMessage('m1', '你好')] }),
  )
  assert.equal(first.messages.length, 2)
  // 第二轮:同一份材料,已经交付过 → 不追加任何消息。
  const second = await runtime.preStep(
    agent, { turn: 2, step: 1, messages: [userMessage('m2', '换个话题')] },
    async () => ({ kind: 'enter', messages: [userMessage('m2', '换个话题')] }),
  )
  assert.equal(second.messages.length, 1, 'no placeholder and no re-posted material')
})
