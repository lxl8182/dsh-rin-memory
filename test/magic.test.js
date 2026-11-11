import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpells, renderFeedback, runSpells } from '../magic.js'
import { readSpell, spellToGoal } from '../magic-tools.js'
import { researchWeb } from '../anysearch.js'

test('查资料 recognizes the spell and uses the appropriate AnySearch HTTP request', async () => {
  const [{ body }] = parseSpells('<查资料>最近的独立游戏试玩</查资料>').casts
  const requests = []
  const fetcher = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    assert.equal(init.headers.Authorization, 'Bearer mock-key')
    const row = { url: 'https://example.com/demo', title: '试玩介绍', content: '一段正文' }
    return Response.json({ code: 0, data: url.endsWith('/extract')
      ? { ...row, content: '网页导航\n'.repeat(200) + '试玩时间是周五。' }
      : { results: [row, { ...row, url: row.url + '#same-page' }] } })
  }
  const options = { key: 'mock-key', fetcher }
  const result = await researchWeb(body, options)
  assert.match(result.text, /试玩介绍\nhttps:\/\/example\.com\/demo/)
  assert.equal(result.text.match(/example\.com\/demo/g).length, 1)
  assert.equal(result.history, '1. 试玩介绍\nhttps://example.com/demo')
  const page = await researchWeb('https://example.com/demo', { ...options, question: '试玩时间是什么' })
  assert.match(page.text, /试玩时间是周五/)
  assert.doesNotMatch(page.text, /网页导航/)
  assert.deepEqual(requests, [
    ['https://api.anysearch.com/v1/search', { query: body, max_results: 5 }],
    ['https://api.anysearch.com/v1/extract', { url: 'https://example.com/demo' }],
  ])
})

test('AnySearch error bodies stay out of spell feedback', async () => {
  await assert.rejects(researchWeb('query', { key: 'mock-key', fetcher: async () =>
    new Response('private upstream details', { status: 402 }) }), { message: 'AnySearch 额度不足（HTTP 402）。' })
})

test('search retries once with the exact name and specification from the original question', async () => {
  const requests = []
  const question = '帮我查一下阿玛尼赤裸玫瑰50ml最低价格'
  const query = '阿玛尼 高定私藏 赤裸玫瑰 最低价格'
  const result = await researchWeb(query, { key: 'mock-key', question,
    fetcher: async (_url, init) => {
      requests.push(JSON.parse(init.body).query)
      return Response.json({ code: 0, data: { results: [
        { title: '刑事判决书', url: 'https://example.com/judgment' },
        { title: '阿玛尼米兰玫瑰 100ml', url: 'https://example.com/other-rose' },
        ...(requests.length === 2 ? [{ title: '赤裸玫瑰香水 50ml', url: 'https://example.com/product' }] : []),
      ] } })
    } })
  assert.deepEqual(requests, [query, '"赤裸玫瑰" 50ml 价格'])
  assert.match(result.history, /^1\. 赤裸玫瑰香水 50ml/)
  assert.doesNotMatch(result.text, /判决书|米兰玫瑰/)
})

test('spells are lifted out of the visible text, never shown to the owner', () => {
  const parsed = parseSpells('小铃去看看。\n\n<执行>df -h</执行>')
  assert.equal(parsed.visible, '小铃去看看。')
  assert.deepEqual(parsed.casts, [{ spell: '执行', body: 'df -h' }])
})

test('several spells run in the order they were written', () => {
  const parsed = parseSpells('先看\n<读取>C:\\x</读取>\n再跑\n<执行>跑测试</执行>')
  assert.deepEqual(parsed.casts.map(s => s.spell), ['读取', '执行'])
  assert.equal(parsed.visible, '先看\n再跑')
})

test('quoted and fenced examples remain chat text, while a standalone spell is recognized', () => {
  const quoted = ['    <执行>缩进示例</执行>', '用法是 `<执行>示例</执行>`', '> 查资料:<查资料>引用</查资料>', '```xml', '查资料：<查资料>代码</查资料>', '```'].join('\n')
  const parsed = parseSpells(quoted + '\n查资料：<查资料>近期试玩</查资料>')
  assert.equal(parsed.visible, quoted.trim())
  assert.deepEqual(parsed.casts, [{ spell: '查资料', body: '近期试玩' }])
})

test('an unclosed tag is not executed, it stays visible', () => {
  const parsed = parseSpells('<执行>没写完')
  assert.equal(parsed.casts.length, 0)
  assert.equal(parsed.visible, '<执行>没写完')
})

test('feedback never pretends success', () => {
  assert.match(renderFeedback({ spell: '读取' }, { ok: true, text: 'ok' }), /【终端反馈·读取】/)
  assert.match(renderFeedback({ spell: '读取' }, { ok: false, text: 'boom' }), /失败/)
  assert.match(renderFeedback({ spell: '执行' }, { ok: true, text: '' }), /没有输出/)
})

test('an unregistered spell reports honestly instead of staying silent', async () => {
  const handlers = { '读取': async () => 'content' }
  const [ok] = await runSpells([{ spell: '读取', body: 'x' }], handlers)
  assert.deepEqual({ ok: ok.ok, text: ok.text }, { ok: true, text: 'content' })
  const [missing] = await runSpells([{ spell: '执行', body: 'x' }], handlers)
  assert.equal(missing.ok, false)
  assert.match(missing.text, /还没有接上/)
})

test('reading a directory lists entries; reading a file returns its text', async () => {
  const dir = await readSpell(process.cwd())
  assert.match(dir, /magic-tools\.js/)
  const file = await readSpell('magic-tools.js')
  assert.match(file, /spellToGoal/)
})

test('task spells become one concrete goal', () => {
  assert.equal(spellToGoal('执行', '跑测试'), '跑测试')
  assert.throws(() => spellToGoal('执行', '   '), /说具体一点/)
})
test('the memory spells are parsed like the others', () => {
  const parsed = parseSpells('我记着呢。\n<翻本子>游戏</翻本子>')
  assert.equal(parsed.visible, '我记着呢。')
  assert.deepEqual(parsed.casts, [{ spell: '翻本子', body: '游戏' }])

  const both = parseSpells('<改写>旧 ||| 新</改写>\n<撕掉>那句话</撕掉>')
  assert.deepEqual(both.casts.map(c => c.spell), ['改写', '撕掉'])
  assert.equal(both.casts[0].body, '旧 ||| 新')
})

test('a failing memory spell reports the real reason, never a fake success', async () => {
  const [miss] = await runSpells([{ spell: '撕掉', body: 'x' }], {
    '撕掉': async () => { throw new Error('本子上没找到这件事。') },
  })
  assert.equal(miss.ok, false)
  assert.match(renderFeedback(miss.cast, miss), /失败/)
})
