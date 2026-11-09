const API = 'https://api.anysearch.com/v1'
const words = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const commonWords = new Set(['这个', '那个', '网页', '链接', '看看', '什么', '怎么', '介绍', '一下', 'the', 'and', 'for'])

function publicUrl(value) {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Non-URL input is a search query. */ }
  return ''
}

function excerpts(content, question) {
  const terms = [...new Set(Array.from(words.segment(question.slice(0, 600).toLowerCase().replace(/https?:\/\/\S+/gu, '')),
    ({ segment, isWordLike }) => isWordLike && segment.length >= 2 ? segment : '').filter(term => term && !commonWords.has(term)))].slice(0, 24)
  const passages = content.slice(0, 50000).split(/\n+|(?<=[。！？])|(?<=[.!?])\s+/u).map(line => line.trim()).filter(Boolean)
  const ranked = passages.map((text, index) => ({ text, index,
    score: terms.filter(term => text.toLowerCase().includes(term)).length }))
    .filter(row => row.score > 0).sort((left, right) => right.score - left.score || left.index - right.index)
  if (!ranked.length) return content.trim().slice(0, 1500)
  return ranked.slice(0, 3).sort((left, right) => left.index - right.index)
    .map(row => row.text.slice(0, 500)).join('\n')
}

function sourceCard(source, question) {
  const url = publicUrl(source?.url)
  if (!url) return
  const title = typeof source.title === 'string' ? source.title.trim().slice(0, 160) : ''
  const date = /^\d{4}-\d{2}-\d{2}/.exec(source.published_at ?? source.date ?? '')?.[0]
  const content = typeof source.snippet === 'string' && source.snippet.trim() ? source.snippet : source.content
  const summary = typeof content !== 'string' ? '' : question === undefined
    ? content.trim().slice(0, 350) : excerpts(content, question)
  return { url, title, date, summary }
}

export async function researchWeb(input, { key = process.env.ANYSEARCH_API_KEY, fetcher = fetch, question = '' } = {}) {
  if (!key?.trim()) throw new Error('AnySearch 密钥尚未配置。')
  const query = input.trim()
  if (!query || query.length > 2000) throw new Error('查询词或链接长度无效。')
  const url = publicUrl(query)
  const response = await fetcher(`${API}/${url ? 'extract' : 'search'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(url ? { url } : { query, max_results: 5 }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  }).catch(error => {
    throw new Error(error.name === 'TimeoutError' ? 'AnySearch 查询超时。' : '暂时连不上 AnySearch。', { cause: error })
  })
  if (!response.ok) {
    const reason = { 401: '密钥无效', 402: '额度不足', 403: '访问被拒绝', 422: '网页正文提取失败', 429: '查询太频繁' }[response.status]
    throw new Error(`AnySearch ${reason ?? '请求失败'}（HTTP ${response.status}）。`)
  }
  const { code, data } = await response.json().catch(error => {
    throw new Error('AnySearch 返回了无效数据。', { cause: error })
  }) ?? {}
  if (code !== 0 || (url ? typeof data?.content !== 'string' : !Array.isArray(data?.results))) {
    throw new Error('AnySearch 返回了无效结果。')
  }
  const cards = url ? [sourceCard({ ...data, url }, question)] : data.results.slice(0, 5).map(row => sourceCard(row))
  const distinct = new Map()
  for (const card of cards) {
    if (!card) continue
    const key = new URL(card.url)
    key.hash = ''
    if (!distinct.has(key.href)) distinct.set(key.href, card)
  }
  const sources = [...distinct.values()].slice(0, 3)
  const history = sources.map(({ title, url }, i) => [`${i + 1}. ${title || '来源'}`, url].join('\n')).join('\n')
  const text = sources.map(({ title, url, date, summary }, i) =>
    [`${i + 1}. ${title || '来源'}`, url, date, summary].filter(Boolean).join('\n')).join('\n\n')
  return { text: text || '这次没有找到可用资料。', history }
}
