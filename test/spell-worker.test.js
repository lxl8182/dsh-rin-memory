import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SpellLibrary, TRIAL_BODY, parseSolved } from '../spell-library.js'

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'spell-worker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SpellLibrary({ statePath: join(root, 'spells.json') })
  await store.open()
  return store
}

test('a worker solves what the model could not, and only the verified recipe is saved', async t => {
  const store = await library(t)
  let asked = null, trials = []
  const workOut = async (wanted, trialError) => {
    asked = { wanted, trialError: trialError?.message }
    return { via: '执行', template: 'powershell -Command "say {body}"' }
  }
  const runSpell = async cast => { trials.push(cast); return 'ok' }
  const message = await store.learn('说话 ||| 把文字念出来 |||  ||| ', runSpell, undefined, workOut)
  assert.match(message, /工作会话做通了/)
  assert.deepEqual(asked.wanted, { name: '说话', note: '把文字念出来' })
  assert.deepEqual(trials, [{ spell: '执行', body: 'powershell -Command "say 咒语试跑"' }])
  assert.deepEqual(store.list().map(s => [s.name, s.via, s.template]),
    [['说话', '执行', 'powershell -Command "say {body}"']])
})

test('a broken hand-written template is handed to the worker instead of being saved', async t => {
  const store = await library(t)
  const seen = []
  const message = await store.learn('报时 ||| 报时间 ||| 执行 ||| date +%H:%M', async cast => {
    seen.push(cast.body)
    if (seen.length === 1) throw new Error('date 不是内部或外部命令')
    return 'ok'
  }, undefined, async (_w, trialError) => {
    assert.match(trialError.message, /date/)
    return { via: '执行', template: 'powershell -NoProfile -Command "Get-Date -Format HH:mm"' }
  })
  assert.match(message, /工作会话做通了/)
  assert.equal(store.list()[0].template, 'powershell -NoProfile -Command "Get-Date -Format HH:mm"')
  assert.equal(seen.length, 2)
})

test('nothing is saved when the worker reports it cannot be done', async t => {
  const store = await library(t)
  await assert.rejects(
    store.learn('飞天 ||| 飞起来 |||  ||| ', async () => 'ok', undefined, async () => undefined),
    /没能把这件本事做通/)
  await assert.rejects(readFile(store.statePath), { code: 'ENOENT' })
  await assert.rejects(
    store.learn('潜水 ||| 潜下去 |||  ||| ', async () => 'ok', undefined, () => undefined),
    /没能把这件本事做通/)
  assert.deepEqual(store.list(), [])
})

test('parseSolved takes the last marker and ignores a recipe that names no real spell', () => {
  assert.deepEqual(parseSolved('试了一堆\n【咒语】执行 ||| echo hi'), { via: '执行', template: 'echo hi' })
  assert.deepEqual(parseSolved('【咒语】读取 ||| a{b}ody\n中间\n【咒语】执行 ||| echo {body}'),
    { via: '执行', template: 'echo {body}' })
  assert.equal(parseSolved('没有标记'), undefined)
  assert.equal(parseSolved('【咒语】执行'), undefined)
  assert.equal(parseSolved('【咒语】乱写 ||| x'), undefined)
})

test('a damaged ledger loads what it can instead of taking the plugin down', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spell-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  const statePath = join(root, 'spells.json')
  const good = { name: '说话', note: '念字', via: '执行', template: 'echo {body}', verified_at: new Date().toISOString() }
  const broken = { name: '坏', note: 'x', via: '不存在', template: '', verified_at: 'nope' }
  await writeFile(statePath, JSON.stringify({ schema_version: 1, spells: [good, broken] }))
  const store = new SpellLibrary({ statePath })
  await store.open()
  assert.deepEqual(store.list().map(s => s.name), ['说话'])
  await writeFile(statePath, '{ 这不是 JSON')
  const second = new SpellLibrary({ statePath })
  await second.open()
  assert.deepEqual(second.list(), [])
  assert.match(second.openError, /无法解析/)
})
