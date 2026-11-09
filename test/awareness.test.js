import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MainSessionScope } from '../main-session.js'
import { MemoryRuntime } from '../index.js'

test('final assembly keeps one current awareness and honors legacy and chat-only contexts', async () => {
  let awareness = '我的记忆与认识会随着相处逐渐更新。当前人格沿用已发布版本。'
  const scope = new MainSessionScope({}, { currentPersona: () => '我叫铃芽。', currentAwareness: () => awareness })
  const next = async () => ({ sections: [{ name: 'old', text: '旧说明' }, { name: 'rin-memory:awareness', text: '过期能力' }],
    tools: [{ name: 'unrelated' }], contexts: ['old'] })
  let result = await scope.shapeAssembly({}, next)
  assert.equal(result.sections.filter(section => section.name === 'rin-memory:awareness').length, 1)
  assert.equal(result.sections.find(section => section.name === 'rin-memory:awareness').text, awareness)
  assert.deepEqual(result.tools, [])
  awareness = '满足采用条件的变化会融入我的兴趣与判断。'
  result = await scope.shapeAssembly({}, next)
  assert.equal(result.sections.find(section => section.name === 'rin-memory:awareness').text, awareness)
  assert.ok(!JSON.stringify(result).includes('当前人格沿用已发布版本'))
  awareness = ''
  assert.ok(!(await scope.shapeAssembly({}, next)).sections.some(section => section.name === 'rin-memory:awareness'))
  const chatOnly = new MainSessionScope({}, { chatOnly: true, currentAwareness: () => '个人记忆' })
  assert.ok(!(await chatOnly.shapeAssembly({}, next)).sections.some(section => section.name === 'rin-memory:awareness'))
  awareness = { text: '内部的原始说明', capabilities: { read: true, correction: true, teaching: false } }
  result = await scope.shapeAssembly({}, next)
  const text = result.sections.find(section => section.name === 'rin-memory:awareness').text
  assert.match(text, /再改本子/)
  assert.doesNotMatch(text, /内部的原始说明|教导/)
})

test('later turns retain only research titles and links in their session surface', () => {
  const old = { id: 'research:1', role: 'user', source: { kind: 'companion-research',
    history: '1. 试玩\nhttps://example.com/demo' }, content: [{ type: 'text', text: '本轮摘录' }] }
  const raw = { type: 'user/message', data: old }
  const events = new Map([[4, raw]])
  const session = { surface: { nodes: [4] }, eventAt: seq => events.get(seq),
    append(type, data, options) {
      assert.deepEqual(options, { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] })
      events.set(8, { type, data })
      this.surface.nodes = [8]
    },
  }
  MemoryRuntime.prototype.trimResearchHistory(session)
  MemoryRuntime.prototype.trimResearchHistory(session)
  assert.equal(events.get(4), raw)
  assert.deepEqual(events.get(8).data.content, [{ type: 'text', text: '【查过的来源】\n1. 试玩\nhttps://example.com/demo' }])
})
