import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpells } from '../magic.js'

test('a known spell is a cast, an unknown one is reported instead of vanishing', () => {
  // 学咒语是异步的:模型念完 <学咒语> 的下一轮就可能念新名字。
  // 那时咒语还不存在,标签必须变成一条"还没学成",不能悄悄消失。
  const parsed = parseSpells('好呀<执行>echo hi</执行> 然后<报时>现在几点</报时>', [])
  assert.deepEqual(parsed.casts, [{ spell: '执行', body: 'echo hi' }])
  assert.deepEqual(parsed.unknown, [{ spell: '报时', body: '现在几点' }])
  assert.equal(parsed.visible, '好呀 然后')
})

test('a learned spell stops being unknown', () => {
  const parsed = parseSpells('<报时></报时>', ['报时'])
  assert.deepEqual(parsed.unknown, [])
  // 空 body 不执行,但名字已知,所以不算念错。
  assert.deepEqual(parsed.casts, [])
})

test('unclosed tags stay visible and never become casts', () => {
  const parsed = parseSpells('我想<执行>再看看', [])
  assert.deepEqual(parsed.casts, [])
  assert.deepEqual(parsed.unknown, [])
  assert.match(parsed.visible, /<执行>/)
})
