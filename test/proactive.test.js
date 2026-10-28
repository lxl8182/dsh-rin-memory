import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProactiveRuntime } from '../proactive.js'

function harness() {
  const calls = [], sent = []
  const state = { proactiveOutputs: {} }
  let checks = true, first = true
  const runtime = {
    config: { proactiveEnabled: true }, stopped: false, logger: console,
    attached: new Map(), personas: new Map(), turns: new Map(),
    isTrusted: () => true,
    client: { state, scope: session_id => ({ subject: 'private', session_id, client_id: 'qq' }),
      isRetired: () => false, serial: fn => fn(), save: async () => {},
      async request(path, body) {
        calls.push({ path, body })
        if (path.endsWith('/complete')) return { ok: true, output_id: 'out-1' }
        if (path.endsWith('/check')) return { ok: checks }
        if (path === '/v1/outputs') return { pending_parts: [{ index: 0, text: '你好' }, { index: 1, text: '面试怎么样了' }] }
        return { ok: true }
      } },
    bridge: { binding: () => ({ owner: true, scope: 'private' }),
      assistantText(events) {
        return events.map(row => (row.data?.message?.content ?? []).filter(block => block.type === 'text')
          .map(block => block.text).join('')).join('\n')
      },
      planOutput(text) {
        const body = text.trim()
        return { text: body, part_sizes: body.match(/[^\n]+\n?/g).map(part => Array.from(part).length) }
      },
      async deliverOutput(session, output, parts, canSend) {
        if (!await canSend()) return { status: 'cancelled', parts: [] }
        sent.push({ session, output })
        const result = { status: first ? 'failed' : 'completed',
          parts: parts.map(part => ({ index: part.index, ok: !first || part.index === 0, platformId: 'qq-' + part.index })) }
        first = false
        return result
      } },
  }
  return { runtime, calls, sent, setChecks: value => { checks = value } }
}

test('completion survives restart; only successful platform parts enter memory', async () => {
  const { runtime, calls, sent } = harness()
  const p = new ProactiveRuntime(runtime)
  const run = { candidate_id: 'c1', lease_id: 'l1', context: { context_receipt_id: 'ctx' }, request_id: 'r1' }
  const session = { id: 'qq-test', snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '你好' }] } } },
    { type: 'assistant/message', data: { message: { id: 'a2', content: [{ type: 'text', text: '🐈面试怎么样了' }] } } },
    { type: 'turn/end', data: { turn: 2 } },
  ] }
  await p.finish(session, { data: { turn: 2, reason: { kind: 'completed' } } }, run)
  assert.equal(calls.filter(c => c.path.endsWith('/complete')).length, 1)
  assert.equal(calls.find(c => c.path.endsWith('/complete')).body.text, '你好\n🐈面试怎么样了')
  assert.deepEqual(calls.find(c => c.path.endsWith('/complete')).body.part_sizes, [3, 7])
  assert.deepEqual(calls.find(c => c.path.endsWith('/deliver')).body.parts, [{ index: 0, platform_id: 'qq-0' }])
  assert.equal(runtime.client.state.proactiveOutputs.r1.output_id, 'out-1')
  await new ProactiveRuntime(runtime).resume()
  assert.equal(calls.filter(c => c.path.endsWith('/complete')).length, 1)
  assert.equal(sent[1].output, sent[0].output)
  assert.deepEqual(runtime.client.state.proactiveOutputs, {})
  await p.finish({ id: 'qq-test', snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[PASS]' }] } } },
    { type: 'turn/end', data: { turn: 3 } },
  ] }, { data: { turn: 3, reason: { kind: 'completed' } } }, { ...run, cancelled: false })
  assert.equal(calls.filter(call => call.path.endsWith('/release')).at(-1).body.reason, 'model_pass')
})

test('human input keeps the proactive turn; invalid sources still stop persisted output', async () => {
  const { runtime, calls, sent, setChecks } = harness()
  const p = new ProactiveRuntime(runtime)
  const run = { candidate_id: 'c', lease_id: 'l', request_id: 'r', context: { context_receipt_id: 'ctx' } }
  p.active.set('qq-test', run)
  await p.observe({ sessionId: 'qq-test', messageId: 'human-2', input: '先聊点别的' })
  await p.finish({ id: 'qq-test', snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我把这句说完' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ] }, { data: { turn: 1, reason: { kind: 'completed' } } }, run)
  assert.ok(calls.some(c => c.path.endsWith('/complete')))
  assert.equal(sent.length, 1)
  p.active.clear()
  runtime.client.state.proactiveOutputs.r = { sessionId: 'qq-test', scope: {}, body: {}, output_id: 'out' }
  setChecks(false)
  await p.resume()
  assert.equal(sent.length, 1)
  assert.deepEqual(runtime.client.state.proactiveOutputs, {})
})
