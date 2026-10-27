import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SpellLibrary } from '../spell-library.js'

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'spell-async-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SpellLibrary({ statePath: join(root, 'spells.json') })
  await store.open()
  return store
}

test('check rejects a bad name immediately, without touching the worker', async t => {
  const store = await library(t)
  let calls = 0
  // check 是同步的:学咒语改成异步之后,名字写错不该让主人等几分钟。
  assert.throws(() => store.check('英a ||| 说明'), /2–8 个中文字符/)
  assert.throws(() => store.check('执行 ||| 说明'), /重名/)
  assert.throws(() => store.check('报时 ||| '), /说明须为/)
  assert.equal(calls, 0)
  const spell = store.check('报时 ||| 报现在几点')
  assert.deepEqual({ name: spell.name, via: spell.via, template: spell.template },
    { name: '报时', via: '', template: '' })
})

test('finish does the slow half and saves only a verified recipe', async t => {
  const store = await library(t)
  const spell = store.check('报时 ||| 报现在几点')
  const trials = []
  const message = await store.finish(spell, async cast => { trials.push(cast); return 'ok' }, undefined,
    async () => ({ via: '执行', template: 'powershell -NoProfile -Command "Get-Date -Format HH:mm"' }))
  assert.match(message, /工作会话做通了/)
  assert.equal(trials.length, 1)
  assert.match(trials[0].body, /Get-Date/)
  assert.equal(store.list()[0].name, '报时')
})

test('a duplicate is refused at check time, so the worker never starts', async t => {
  const store = await library(t)
  await store.finish(store.check('报时 ||| 报时'), async () => 'ok', undefined,
    async () => ({ via: '执行', template: 'echo hi' }))
  assert.throws(() => store.check('报时 ||| 再说一遍'), /已经学过这个名字/)
})
