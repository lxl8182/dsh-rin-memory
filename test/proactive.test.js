import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProactiveRuntime } from '../proactive.js'
import { contactControls, parseContact } from '../contact.js'
import { parseSpells } from '../magic.js'

function harness({ state = { proactiveOutputs: {} }, sessionId = 'qq-test', outputs = new Map(), partial = false } = {}) {
  let now = '2026-10-29T04:00:00Z', first = partial, valid = true, turn = 0
  const calls = [], sent = [], followups = [], barriers = new Set()
  const binding = { owner: true, scope: 'private', sessionKey: 'private:42', userId: 42, input: '你好' }
  const context = { persona: '自然陪主人聊天', persona_version: 'p1', basis: { deletion_version: 0, correction_version: 0 },
    interest_signals: { items: [], stable_interests: [], recent_interests: [], avoid_topics: [] },
    working_summary: { sections: { open_threads: { items: [] } } } }
  const session = { id: sessionId, events: [], snapshotEvents() { return this.events } }
  const agent = { session, followup: message => followups.push(message) }
  const runtime = { config: { proactiveEnabled: true, characterId: 'rin', subject: 'private',
    contact: { sources: ['https://feeds.example.test/rss'] } }, stopped: false,
    logger: { warn() {} }, attached: new Map([[agent, {}]]), candidates: new Map(),
    personas: new Map(), turns: new Map(), isTrusted: () => true,
    client: { state, now: () => now, serial: fn => fn(), save: async () => {},
      scope: id => ({ character_id: 'rin', subject: 'private', session_id: id, client_id: 'qq' }),
      isRetired: () => false,
      fetch: async () => ({ ok: true, text: async () => '<rss><channel><item><title>猫在纸箱里睡觉</title><link>https://example.test/cat</link><description>一段关于猫和纸箱的简介</description></item></channel></rss>' }),
      async request(path, body, method = 'POST') {
        calls.push({ path, body, method })
        if (path === '/v1/context') return { ...context, basis: { ...context.basis, correction_version: valid ? 0 : 1 } }
        if (path === '/v1/outputs' && method === 'POST') {
          let row = [...outputs.values()].find(row => row.request_id === body.request_id)
          if (!row) {
            row = { ...body, output_id: 'output-' + outputs.size, delivered: new Set(), status: 'pending' }
            outputs.set(row.output_id, row)
          }
          return { output_id: row.output_id }
        }
        const row = outputs.get(body.output_id)
        if (path === '/v1/outputs') {
          const chars = Array.from(row.text), parts = []; let at = 0
          row.part_sizes.forEach((size, index) => { parts.push({ index, text: chars.slice(at, at += size).join('') }) })
          return { ...row, pending_parts: parts.filter(part => !row.delivered.has(part.index)) }
        }
        if (path.endsWith('/deliver')) for (const part of body.parts) row.delivered.add(part.index)
        if (path.endsWith('/invalidate')) row.status = 'invalidated'
        return { ok: true }
      },
    },
    bridge: { binding: id => id === sessionId ? binding : undefined,
      bindingRecords: () => [binding], restoreBindings: () => ({ rejected: [], restored: 1 }),
      ensureSessions: async () => ({ bound: 1, failed: [] }),
      beginOutput(id) {
        assert.equal(barriers.has(id), false)
        barriers.add(id)
        return () => barriers.delete(id)
      },
      assistantText: events => events.flatMap(row => row.data?.message?.content ?? [])
        .filter(part => part.type === 'text').map(part => part.text).join('\n'),
      planOutput(text) {
        const body = text.trim()
        return { text: body, part_sizes: (body.match(/[^\n]+\n?/g) ?? []).map(part => Array.from(part).length) }
      },
      async deliverByIndex(request, canSend) {
        if (!await canSend()) return { status: 'cancelled', parts: [] }
        const parts = request.parts.map(part => {
          const ok = !first || part.index === 0
          if (ok) sent.push({ output: request.outputId, index: part.index, text: part.text })
          return { index: part.index, ok, platformId: 'qq-' + part.index }
        })
        const status = first ? 'failed' : 'completed'; first = false
        return { status, parts }
      },
      async deliverOutput() { throw new Error('the unified index delivery API should be used') },
    },
  }
  async function complete(p, text) {
    turn++
    const start = { type: 'turn/start', data: { turn } }
    const message = { type: 'assistant/message', data: { message: { id: 'a' + turn,
      content: [{ type: 'reasoning', text: 'not persisted by the test' }, { type: 'text', text }] } } }
    const end = { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
    session.events.push(start, message, end)
    p.event(session, start)
    await p.prepare(agent, { turn })
    p.event(session, message)
    p.event(session, end)
    await p.tail
  }
  return { runtime, context, agent, calls, sent, followups, outputs, barriers, complete,
    advance: ms => { now = new Date(Date.parse(now) + ms).toISOString() }, invalidate: () => { valid = false } }
}

test('contact tags are private, time-zone anchored, idempotent and never ordinary spells', async () => {
  assert.equal(parseContact('明天20:30｜面试', { now: '2026-10-29T23:00:00Z', timezone: 'Asia/Shanghai' })
    .next_contact_at, '2026-10-31T12:30:00.000Z')
  assert.throws(() => parseContact('今天25:00', { now: '2026-10-29T00:00Z', timezone: 'Asia/Shanghai' }))
  assert.throws(() => parseContact('2026-11-31T20:30+08:00', { now: '2026-10-29T00:00Z', timezone: 'Asia/Shanghai' }))
  assert.equal(contactControls('[PASS]<下次联系>等新进展</下次联系>').text, '')
  assert.deepEqual(parseSpells('好呀<下次联系>明天20:30｜面试</下次联系>').unknown, [])
  const h = harness(), p = new ProactiveRuntime(h.runtime)
  const message = { id: 'ordinary', content: [{ type: 'text', text: '好呀<下次联系>明天20:30｜面试</下次联系>' }] }
  await p.remember(h.agent.session.id, message)
  await p.remember(h.agent.session.id, message)
  assert.equal(p.state.plans['private:42'].revision, 1)
  await p.remember(h.agent.session.id, { id: 'no-tag', content: [{ type: 'text', text: '继续聊' }] })
  assert.equal(p.state.plans['private:42'].revision, 1)
  await p.remember(h.agent.session.id, { id: 'bad', content: [{ type: 'text', text: '<下次联系>随便什么时候</下次联系>' }] })
  assert.equal(p.state.plans['private:42'].revision, 1)
  assert.ok(p.state.status['private:42'].error)
  h.advance(12 * 3600000)
  assert.equal(p.allowed('private:42', h.runtime.client.now(), [{ agreed: true, kind: 'task_result', due_at: h.runtime.client.now() }]), false)
  assert.equal(p.allowed('private:42', h.runtime.client.now(), [{ agreed: true, explicit_time: true, kind: 'followup', due_at: h.runtime.client.now() }]), true)
  p.stop()
})

test('cold discovery and due PASS use one model call, consume once and stay consumed after restart', async () => {
  const h = harness(), p = new ProactiveRuntime(h.runtime)
  await p.observe({ ...h.runtime.bridge.binding(h.agent.session.id), sessionId: h.agent.session.id })
  await p.tick()
  assert.equal(h.followups.length, 1)
  assert.equal(p.active.get(h.agent.session.id).candidates[0].kind, 'discovery')
  await h.complete(p, '[PASS]<下次联系>明天20:30｜想聊聊猫</下次联系>')
  assert.equal(h.sent.length, 0)
  assert.equal(h.barriers.size, 0)
  h.advance(2 * 86400000)
  await p.tick()
  assert.equal(h.followups.length, 2)
  await h.complete(p, '[PASS]')
  assert.equal(p.state.plans['private:42'].status, 'consumed')
  assert.equal(p.state.plans['private:42'].mode, 'on_event')
  h.advance(3600000)
  await p.tick()
  assert.equal(h.followups.length, 2)
  p.stop()
  const restart = harness({ state: JSON.parse(JSON.stringify(h.runtime.client.state)), sessionId: 'qq-restored' })
  const restored = new ProactiveRuntime(restart.runtime)
  await restored.tick()
  assert.equal(restart.followups.length, 0)
  assert.deepEqual(restart.context.interest_signals.items, [])
  assert.ok([...h.calls, ...restart.calls].every(call => !call.path.startsWith('/v1/proactive/')))
  restart.context.working_summary.sections.open_threads.items = [{ thread_id: 't', text: '面试', next_step: '等结果' }]
  const binding = restart.runtime.bridge.binding('qq-restored')
  await restored.derive(binding, restart.context, 'qq-restored')
  const before = Object.values(restored.state.candidates).find(row => row.thread_id === 't')
  before.status = 'considered'
  restart.context.working_summary.sections.open_threads.items[0].next_step = '已经拿到录用通知'
  await restored.derive(binding, restart.context, 'qq-restored')
  assert.notEqual(restored.state.candidates[before.candidate_id].content_version, before.content_version)
  assert.equal(restored.state.candidates[before.candidate_id].status, 'pending')
  restored.stop()
})

test('a rejected followup restores the unaccepted opportunity for a later retry', async () => {
  const h = harness(), p = new ProactiveRuntime(h.runtime), followup = h.agent.followup
  h.agent.followup = () => { throw new Error('inbox unavailable') }
  await p.tick()
  assert.equal(p.active.size, 0)
  assert.equal(h.barriers.size, 0)
  assert.equal(p.state.initialized['private:42'], undefined)
  assert.ok(Object.values(p.state.candidates).every(row => row.status === 'pending'))
  h.agent.followup = followup
  h.advance(61000)
  await p.tick()
  assert.equal(h.followups.length, 1)
  p.stop()
})

test('partial output resumes the same indices; new input does not cancel it and invalid sources stop unsent parts', async () => {
  for (const invalidate of [false, true]) {
    const h = harness({ partial: true }), p = new ProactiveRuntime(h.runtime)
    if (invalidate) h.context.context = { source_ids: ['host:rin:private:cat'] }
    await p.tick()
    assert.equal(p.active.size, 1)
    await p.observe({ ...h.runtime.bridge.binding(h.agent.session.id), sessionId: h.agent.session.id })
    assert.equal(p.active.size, 1)
    const candidate = p.active.get(h.agent.session.id).candidates[0]
    await h.complete(p, `你好\n🐈纸箱里的猫<选题>${candidate.candidate_id}</选题><下次联系>等新进展</下次联系>`)
    assert.equal(h.sent.length, 1)
    assert.equal(h.barriers.size, 0)
    const body = h.calls.find(call => call.path === '/v1/outputs' && call.method === 'POST').body
    assert.equal(body.text, '你好\n🐈纸箱里的猫')
    assert.deepEqual(body.part_sizes, [3, 6])
    assert.equal(body.cause.candidate_id, candidate.candidate_id)
    const pending = Object.values(p.state.pending)[0]
    const id = pending.output_id
    if (invalidate) h.invalidate()
    await new ProactiveRuntime(h.runtime).resume()
    assert.equal(h.sent.length, invalidate ? 1 : 2)
    assert.equal(h.calls.filter(call => call.path === '/v1/outputs' && call.method === 'POST').length, 1)
    assert.equal(h.sent[0].output, id)
    assert.deepEqual(p.state.pending, {})
    assert.equal(p.state.activity['private:42'].count, 1)
    p.stop()
  }
})
