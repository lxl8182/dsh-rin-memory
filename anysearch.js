const API = 'https://api.anysearch.com/v1'

function publicUrl(value) {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Non-URL input is a search query. */ }
  return ''
}

function sourceText(source, maxChars) {
  const url = publicUrl(source?.url)
  if (!url) return ''
  const title = typeof source.title === 'string' ? source.title.trim().slice(0, 160) : ''
  const content = source.snippet || source.content
  return [title, url, typeof content === 'string' ? content.trim().slice(0, maxChars) : ''].filter(Boolean).join('\n')
}

export async function researchWeb(input, { key = process.env.ANYSEARCH_API_KEY, fetcher = fetch } = {}) {
  if (!key?.trim()) throw new Error('AnySearch 密钥尚未配置。')
  const query = input.trim()
  if (!query || query.length > 2000) throw new Error('查询词或链接长度无效。')
  const url = publicUrl(query)
  const response = await fetcher(`${API}/${url ? 'extract' : 'search'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(url ? { url } : { query, max_results: 4 }),
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
  const sources = url ? [sourceText({ ...data, url }, 3000)] : data.results.slice(0, 4).map(row => sourceText(row, 450))
  return sources.filter(Boolean).join('\n\n') || '这次搜索没有找到结果。'
}
