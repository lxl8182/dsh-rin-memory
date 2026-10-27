import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SpellLibrary, TRIAL_BODY, META_SPELLS } from '../spell-library.js'
import { SpellRunner } from '../spell-runner.js'
import { magicText } from '../main-session.js'

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'spell-library-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SpellLibrary({ statePath: join(root, 'spells.json') })
  await store.open()
  return store
}

test('learning trials before atomic save, persists across restart and forgetting updates magic and feedback', async t => {
  const store = await library(t)
  const trials = [], feedback = []
  const runner = new SpellRunner({ learnedNames: () => [...META_SPELLS, ...store.list().map(s => s.name)],
    runSpell: async cast => {
      if (cast.spell === '学咒语') return store.learn(cast.body, async trial => { trials.push(trial); return 'ok' })
      return store.forget(cast.body)
    }, followupOf: () => reply => feedback.push(reply.content[0].text),
  })
  const agent = { session: { id: 'qq-learn' } }
  const send = (text, seq) => runner.handleAssistantMessage(agent, { content: [{ type: 'text', text }] }, seq)
  await send('<学咒语>说话 ||| 念一段文字 ||| 执行 ||| echo {body}</学咒语>', 1)
  assert.deepEqual(trials, [{ spell: '执行', body: `echo ${TRIAL_BODY}` }])
  assert.match(feedback[0], /【终端反馈·学咒语】[\s\S]*试跑成功/)
  assert.match(magicText({ learned: store.list() }), /· 说话 —— 念一段文字/)
  assert.ok(!magicText({ learned: store.list() }).includes('echo {body}'))
  const saved = JSON.parse(await readFile(store.statePath, 'utf8'))
  assert.ok(saved.spells[0].verified_at)
  const reopened = new SpellLibrary({ statePath: store.statePath })
  await reopened.open()
  assert.deepEqual(reopened.list(), store.list())
  await send('<忘掉咒语>说话</忘掉咒语>', 2)
  assert.match(feedback[1], /【终端反馈·忘掉咒语】[\s\S]*已忘掉/)
  assert.ok(!magicText({ learned: store.list() }).includes('【自己学会的】'))
  assert.deepEqual(JSON.parse(await readFile(store.statePath, 'utf8')).spells, [])
  await runner.dispose()
})

test('failed trials leave disk unchanged; invalid names, recursive routes, duplicates and the ninth spell are rejected', async t => {
  const store = await library(t)
  let trials = 0
  const ok = async () => { trials++; return 'ok' }
  await assert.rejects(store.learn('说话 ||| 说明 ||| 执行 ||| missing {body}', async () => { throw new Error('命令不存在') }), /命令不存在/)
  await assert.rejects(readFile(store.statePath), { code: 'ENOENT' })
  await store.learn('说话 ||| 说明 ||| 执行 ||| echo {body}', ok)
  const before = await readFile(store.statePath, 'utf8')
  await assert.rejects(store.learn('失败 ||| 说明 ||| 执行 ||| missing {body}', async () => { throw new Error('exit 1') }), /exit 1/)
  assert.equal(await readFile(store.statePath, 'utf8'), before)
  for (const input of ['执行 ||| 说明 ||| 执行 ||| echo {body}', '说话 ||| 说明 ||| 执行 ||| echo {body}',
    '递归 ||| 说明 ||| 说话 ||| echo {body}', '英a ||| 说明 ||| 执行 ||| echo {body}']) {
    await assert.rejects(store.learn(input, ok))
  }
  for (const suffix of ['甲', '乙', '丙', '丁', '戊', '己', '庚']) await store.learn(`测试${suffix} ||| 说明 ||| 读取 ||| {body}`, ok)
  await assert.rejects(store.learn('第九 ||| 说明 ||| 执行 ||| echo {body}', ok), /最多学 8 条/)
  assert.equal(trials, 8, 'invalid definitions never run')
})

test('learned casts use the same serial runner with literal body substitution and exactly one expansion', async t => {
  const store = await library(t)
  await store.learn('说话 ||| 念文字 ||| 执行 ||| echo "{body}" "{body}"', async () => 'ok')
  const feedback = [], ran = []
  const runner = new SpellRunner({ learnedNames: () => store.list().map(s => s.name),
    runSpell: async cast => { const expanded = store.expand(cast); ran.push(expanded); return expanded.body },
    followupOf: () => reply => feedback.push(reply.content[0].text),
  })
  await runner.handleAssistantMessage({ session: { id: 'qq-use' } }, { content: [{ type: 'text', text: '<说话>$& {body} <执行>nested</执行></说话><执行>last</执行>' }] }, 1)
  assert.deepEqual(ran, [
    { spell: '执行', body: 'echo "$& {body} <执行>nested</执行>" "$& {body} <执行>nested</执行>"' },
    { spell: '执行', body: 'last' },
  ])
  assert.match(feedback[0], /【终端反馈·说话】/)
  assert.equal(store.expand({ spell: '执行', body: '<说话>no</说话>' }).body, '<说话>no</说话>')
  assert.match(await store.learn('固定 ||| 固定指令 ||| 执行 ||| echo hi', async () => 'hi'), /固定命令/)
  await runner.dispose()
})
