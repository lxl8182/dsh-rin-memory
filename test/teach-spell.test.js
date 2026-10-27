/**
 * M6 交付 B:QQ 教导走咒语通道。
 *
 * 核心安全主张只有一句:**客户端只传 source_key,规则由服务端派生**。所以这
 * 里的每条断言都盯着请求体:它必须只有来源与 CAS,绝不含任何规则文本、也不含
 * 主人那句话的原文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRuntime, MEMORY_RULES } from '../index.js'
import { normalizeConfig } from '../config.js'
import { MemoryClient } from '../memory-client.js'
import { parseSpells, SPELLS } from '../magic.js'

/**
 * 用**真的** MemoryClient 配一个假 fetch。
 *
 * 断言必须打在真实客户端序列化出来的请求体上:如果这里换成一个手写的替身,
 * "只传 source_key"就只是在断言替身,而不是断言真正会发出去的那个字节流。
 */
function fixture() {
  const requests = []
  const feedback = []
  const responders = new Map()
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body) : {}
    requests.push({ path, body })
    const responder = responders.get(path)
    if (responder) {
      const result = await responder(body)
      const status = result?.__status ?? 200
      return {
        ok: status < 400,
        status,
        async json() { return result?.__body ?? result },
      }
    }
    if (path === '/v1/context') {
      return { ok: true, status: 200, async json() { return {
        persona: '温柔而直白。', persona_version: 'pub-7', card_revision: 3,
        context_receipt_id: 'ctx-1', corrections: { block: '' },
        context: { block: '' }, recent_turns: [],
      } } }
    }
    return { ok: true, status: 200, async json() { return { status: 'reserved', durable: true } } }
  }
  const config = normalizeConfig({
    url: 'http://127.0.0.1:1', tokenEnv: 'TEST_TOKEN',
    stateDirectory: process.cwd(), sessionsDirectory: process.cwd(),
  })
  const client = new MemoryClient(config, 'test-token', { fetchImpl, now: () => '2026-10-27T12:00:00.000Z' })
  const ctx = { profileContext: { home: process.cwd() }, get: () => undefined, on: () => () => {} }
  const runtime = new MemoryRuntime(ctx, config, client, { info() {}, warn() {}, error() {} })
  const sessionId = 'qq-owner'
  runtime.bridge = {
    binding: id => ({ sessionId: id, owner: true, scope: 'private', input: '' }),
    pushPrivate: async text => { feedback.push({ pushed: text }) },
  }
  const agent = {
    session: { id: sessionId, header: {} },
    options: { provider: 'test', model: 'model' },
    followup: message => feedback.push(message),
  }
  runtime.spellScopes.set(agent, { dispose() {} })
  return { runtime, agent, client, requests, feedback, responders }
}

/** 跑一轮真实 preStep,让 turns 里有一份 prepared(带上 card_revision)。 */
async function runTurn(runtime, agent, { turn = 1, id = 'm1', text = '以后别每次都总结了，像朋友一样接着聊。' } = {}) {
  const message = { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
  await runtime.preStep(agent, { turn, step: 1, messages: [message] },
    async () => ({ kind: 'enter', messages: [message] }))
  return message
}

test('学到 is an built-in spell, parsed like the other memory spells', () => {
  assert.ok(SPELLS.includes('学到'))
  const parsed = parseSpells('好呀，我记住了。\n<学到>这一句</学到>')
  assert.equal(parsed.visible, '好呀，我记住了。')
  assert.deepEqual(parsed.casts, [{ spell: '学到', body: '这一句' }])
  // 内置咒语不能被「学咒语」重名占用(spell-library 的校验依赖 SPELLS)。
  assert.equal(new Set(SPELLS).size, SPELLS.length)
})

test('the teaching request carries a source_key and a CAS revision — never rule text', async () => {
  const f = fixture()
  f.responders.set('/v1/persona/teach', async () => ({
    status: 'applied', action: 'teach', teaching_id: 't-1', intent: 'persistent',
    revision: 4, base_revision: 3, published_version: 'pub-8', target: 'next_turn',
    rules: [{ rule_id: 't-1:r1', text: '不要每轮都用条目总结或结论式收尾' }],
    duplicate: false, conflict: false,
  }))
  const said = '以后别每次都总结了，像朋友一样接着聊。'
  await runTurn(f.runtime, f.agent, { text: said })
  const turn = f.runtime.turns.get(f.agent)

  const text = await f.runtime.spellHandlers(f.agent)['学到']('这一句')
  assert.match(text, /记下了/)
  assert.match(text, /不要每轮都用条目总结/)

  const sent = f.requests.find(row => row.path === '/v1/persona/teach')
  assert.ok(sent, 'the service endpoint was called')
  // 安全底线:请求体只允许这几个键,一个都不能多。
  assert.deepEqual(
    Object.keys(sent.body).sort(),
    ['base_revision', 'scene', 'session_id', 'source_key', 'subject', 'target'],
  )
  assert.equal(sent.body.target, 'next_turn')
  assert.equal(sent.body.base_revision, 3, 'the CAS revision is the one this turn actually used')
  assert.equal(sent.body.subject, 'private')
  // source_key 必须是这一轮的那一个,不是随便一个。
  assert.match(sent.body.source_key, /^plugin:dsh_memory:companion:private:dsh-[0-9a-f]+:/)
  assert.ok(sent.body.source_key.endsWith(turn.requestId.replace(/[:：]/g, '_')),
    'the source key names this turn')
  // 绝不能把规则文本或主人原话塞进请求。
  const serialized = JSON.stringify(sent.body)
  assert.ok(!serialized.includes(said), 'the user text is not sent back')
  assert.ok(!serialized.includes('不要每轮都用条目总结'), 'no rule text is sent')
  assert.ok(!/rules?/.test(serialized), 'no rules field at all')
})

test('teaching a bot\'s way of talking cites a saved message by key, still without text', async () => {
  const f = fixture()
  f.responders.set('/v1/persona/teach', async () => ({
    status: 'applied', teaching_id: 't-2', revision: 4, base_revision: 3,
    published_version: 'pub-8', target: 'next_turn',
    rules: [{ rule_id: 't-2:r1', text: '先接情绪，不急着解释' }],
  }))
  await runTurn(f.runtime, f.agent, { text: '你看这个 bot 的接话，以后我希望你这么接' })
  const exampleKey = 'plugin:dsh_memory:companion:private:dsh-abc123:dsh_example1'
  const text = await f.runtime.spellHandlers(f.agent)['学到'](exampleKey)
  assert.match(text, /示例只当引子/)
  const sent = f.requests.find(row => row.path === '/v1/persona/teach')
  // 示例同样只传 key:不带示例正文,也不带对那个 bot 的描述。
  assert.deepEqual(sent.body.quoted_example, { source_key: exampleKey })
  assert.ok(!JSON.stringify(sent.body).includes('我希望你这么接'))
})

test('a free-form example description is not smuggled into the request', async () => {
  const f = fixture()
  f.responders.set('/v1/persona/teach', async () => ({ status: 'applied', revision: 4, rules: [] }))
  await runTurn(f.runtime, f.agent)
  // 正文是自然语言描述而非来源键:不当作示例来源发出去。
  await f.runtime.spellHandlers(f.agent)['学到']('那个 bot 说话很轻，学它的感觉')
  const sent = f.requests.find(row => row.path === '/v1/persona/teach')
  assert.equal(sent.body.quoted_example, undefined)
  assert.ok(!JSON.stringify(sent.body).includes('那个 bot 说话很轻'))
})

test('every failure mode reports a readable reason and never claims success', async () => {
  const cases = [
    {
      name: 'no capability',
      error: Object.assign(new Error('this identity has no persona teaching capability'),
        { status: 403, code: 'forbidden', kind: 'config' }),
      expect: /persona_teach/,
    },
    {
      name: 'source not saved',
      error: Object.assign(new Error('no saved user message with that source_key'),
        { status: 404, code: 'not_found', kind: 'fatal' }),
      expect: /找不到这句话的存档/,
    },
    {
      name: 'revision conflict',
      error: Object.assign(new Error('base_revision changed'),
        { status: 409, code: 'revision_conflict', kind: 'conflict' }),
      expect: /人格卡刚被别人改过/,
    },
    {
      name: 'source deleted',
      error: Object.assign(new Error('this source message was deleted'),
        { status: 410, code: 'deleted', kind: 'gone' }),
      expect: /已经被删掉/,
    },
    {
      name: 'not a style teaching',
      error: Object.assign(new Error('teaching rejected'),
        { status: 422, code: 'rejected', kind: 'fatal', extra: { reason: 'not_a_style_teaching' } }),
      expect: /不像要我长期改说话方式/,
    },
    {
      name: 'transient service failure',
      error: { kind: 'retry', status: 0, code: 'transport' },
      expect: /没连上记忆服务.*没写盘/,
    },
  ]
  for (const item of cases) {
    const f = fixture()
    f.responders.set('/v1/persona/teach', async () => { throw item.error })
    await runTurn(f.runtime, f.agent)
    await assert.rejects(
      f.runtime.spellHandlers(f.agent)['学到']('这一句'),
      error => {
        assert.match(error.message, item.expect, `${item.name}: ${error.message}`)
        assert.ok(!/学好了|已经记下|生效了/.test(error.message), `${item.name}: no fake success`)
        return true
      },
    )
  }
})

test('transient intent is reported as this-time-only, not as a stored rule', async () => {
  const f = fixture()
  f.responders.set('/v1/persona/teach', async () => ({
    status: 'transient', action: 'teach', intent: 'transient', revision: 3,
    base_revision: 3, target: 'next_turn', rules: [],
  }))
  await runTurn(f.runtime, f.agent, { text: '这次短一点' })
  const text = await f.runtime.spellHandlers(f.agent)['学到']('这次')
  assert.match(text, /只是这一次/)
  assert.ok(!/记下了/.test(text), 'a transient constraint is not announced as learned')
})

test('a duplicate teaching says so instead of pretending to learn it again', async () => {
  const f = fixture()
  f.responders.set('/v1/persona/teach', async () => ({
    status: 'applied', teaching_id: 't-1', revision: 4, base_revision: 3,
    published_version: 'pub-8', duplicate: true,
    rules: [{ rule_id: 't-1:r1', text: '不要每轮都用条目总结或结论式收尾' }],
  }))
  await runTurn(f.runtime, f.agent)
  const text = await f.runtime.spellHandlers(f.agent)['学到']('这一句')
  assert.match(text, /之前就学过/)
})

test('without a registered turn there is no saved message to teach from', async () => {
  const f = fixture()
  // 没有跑过 preStep:turns 里没有本轮登记。
  await assert.rejects(f.runtime.spellHandlers(f.agent)['学到']('这一句'), /还没登记|不知道要学哪句话/)
  assert.equal(f.requests.filter(row => row.path === '/v1/persona/teach').length, 0,
    'no request is sent when the source is unknown')
})

test('a turn without a card revision refuses instead of inventing a CAS basis', async () => {
  const f = fixture()
  f.responders.set('/v1/context', async () => ({
    persona: '温柔而直白。', persona_version: 'pub-7', card_revision: null,
    context_receipt_id: 'ctx-1', corrections: { block: '' }, context: { block: '' }, recent_turns: [],
  }))
  await runTurn(f.runtime, f.agent)
  await assert.rejects(f.runtime.spellHandlers(f.agent)['学到']('这一句'), /没有可用的人格卡修订号/)
  assert.equal(f.requests.filter(row => row.path === '/v1/persona/teach').length, 0)
})

test('teaching is refused for a session without personal memory rights', async () => {
  const f = fixture()
  f.runtime.bridge.binding = () => ({ owner: false, scope: 'private' })
  await runTurn(f.runtime, f.agent).catch(() => {})
  await assert.rejects(f.runtime.spellHandlers(f.agent)['学到']('这一句'), /没有个人记忆权限/)
  assert.equal(f.requests.filter(row => row.path === '/v1/persona/teach').length, 0)
})

test('MEMORY_RULES tells the model when to teach and when not to', () => {
  // 触发条件必须在:明确要求长期改变 → 念;只要这一次/只是评价 → 别念。
  assert.match(MEMORY_RULES, /长期改变说话或相处方式/)
  assert.match(MEMORY_RULES, /<学到>/)
  assert.match(MEMORY_RULES, /只要求这一次简短、或只是在评价时,不要念/)
  // 规则段仍然有界、不含每轮变化的数据。
  assert.ok(Array.from(MEMORY_RULES).length <= 300)
  assert.ok(!/pub-7|\d{4}-\d{2}-\d{2}/.test(MEMORY_RULES))
})

test('the magic section tells the model 学到 exists, in the same shape as its neighbours', async () => {
  const { magicText } = await import('../main-session.js')
  const text = magicText()
  assert.match(text, /<学到>/, 'the model must know the spell exists, or it is unreachable')
  // 格式与 3/4/5 完全一致:序号. 名字:<名字>参数</名字> —— 一句话说明。
  const line = text.split('\n').find(row => row.includes('<学到>'))
  assert.match(line, /^\d+\. 学到:<学到>.+<\/学到> —— .+/, 'same one-line shape as the neighbours')
  // 说明只讲"什么情况下用",不讲实现(实测:多一句解释就会退回技术腔)。
  for (const banned of ['持久', '规则', '人格卡', '服务', 'source_key', '接口']) {
    assert.ok(!line.includes(banned), 'the 学到 line must not explain ' + banned)
  }
  // 元咒语说明原样保留(「学成学败程序会回话」是实测救回来的)。
  assert.match(text, /学成学败程序会回话/)
  assert.match(text, /7\. 学咒语:/)
  assert.match(text, /8\. 忘掉咒语:/)
  // 序号仍是 1..N 连续,顺序即协议顺序。
  const numbers = [...text.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1]))
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8])
})
test('the main session still reports no tools after adding the spell route', async () => {
  // 咒语走正文解析,不经工具注册表:这是主会话 0 tools 不被破坏的直接证据。
  const f = fixture()
  assert.equal(f.runtime.toolDisposers.length, 0, 'the spell route registers no tool')
  const { MAIN_SESSION_TOOLS } = await import('../main-session.js')
  assert.deepEqual([...MAIN_SESSION_TOOLS], [])
})
