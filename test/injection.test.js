import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRuntime, renderIncrement } from '../index.js'

test('minimal image context keeps corrections without unrelated facts, history or episodes', () => {
  const { text } = renderIncrement({ material_policy: { minimal: true },
    corrections: { block: '不要再称呼主人为先生' },
    context: { block: '主人给了我服务器' },
    recent_turns: [{ type: 'human', data: { content: '服务器部署好了' } }],
    working_summary: { sections: { important_facts: { items: [{ id: 's', text: '主人给了我服务器' }] },
      open_threads: { items: [{ thread_id: 't', text: '服务器升级' }] } } } })
  assert.match(text, /先生/)
  assert.doesNotMatch(text, /服务器/)
})

test('about_owner and visible dialogue already supply facts; only new relevant facts are added', () => {
  const { text } = renderIncrement({ persona: '关于主人\n主人喜欢胶片摄影',
    context: { block: '主人喜欢胶片摄影' }, working_summary: { sections: {
      important_facts: { items: [{ id: '1', text: '主人喜欢胶片摄影' },
        { id: '2', text: '主人保存有助手的照片' }, { id: '3', text: '主人有一台服务器' }] } } } }, {},
    { representedText: '主人有一台服务器' })
  assert.doesNotMatch(text, /胶片|服务器/)
  assert.match(text, /主人保存有我的照片/)
})

test('prepared turn is reused; background precedes the unchanged current user and image', async () => {
  const user = { role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: '服务器怎么部署' }, { type: 'image', image: { id: 'img-1' } }] }
  const prepared = { requestId: 'r', background: '【我的记事】主人给了我服务器', fingerprints: ['f'] }
  const agent = { session: { id: 'qq-test' } }
  const turn = { requestId: 'r', injected: false }
  const runtime = { currentAgent: null, turns: new Map([[agent, turn]]),
    sessionKeyOfAgent: () => undefined,
    ensureTurn: async () => prepared, pendingTaskNotices: () => [], markInjected: async () => {} }
  const first = await MemoryRuntime.prototype.preStep.call(runtime, agent, { step: 1 },
    async () => ({ kind: 'enter', messages: [user] }))
  assert.equal(first.messages.at(-1), user)
  assert.equal(first.messages[0].content[0].text, prepared.background)
  const second = await MemoryRuntime.prototype.preStep.call(runtime, agent, { step: 2 },
    async () => ({ kind: 'enter', messages: [user] }))
  assert.deepEqual(second.messages, [user])
})
