import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MainSessionScope } from '../main-session.js'

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
})
