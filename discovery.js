/** Small public source adapters; fetching and ranking never send messages. */
import { createHash } from 'node:crypto'

export const fingerprint = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
const plain = value => String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()
const element = (value, tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(value)?.[1] ?? ''

export function normalizeMaterial(raw, source, now) {
  const url = new URL(raw.url)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('素材链接协议无效')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|spm_|vd_source)/u.test(key)) url.searchParams.delete(key)
  const title = plain(raw.title).slice(0, 240)
  if (!title) throw new Error('素材缺少标题')
  const description = plain(raw.description).slice(0, 1000)
  const published = Date.parse(raw.published_at)
  const material_id = 'material_' + fingerprint(url.href)
  return { material_id, url: url.href, source, title, description,
    published_at: Number.isFinite(published) ? new Date(published).toISOString() : null,
    fetched_at: new Date(now).toISOString(), read_scope: description ? '简介' : '标题',
    keywords: raw.keywords ?? [], fingerprint: fingerprint(`${url.href}\n${title}\n${description}`) }
}

export function parseFeed(text, source, now) {
  if (source.includes('api.bilibili.com/')) {
    const data = JSON.parse(text)
    if (data.code !== 0) throw new Error(`素材源返回 ${data.code}`)
    return (data.data?.list ?? []).slice(0, 8).map(row => normalizeMaterial({
      title: row.title, description: row.desc, url: row.short_link_v2 || `https://www.bilibili.com/video/${row.bvid}`,
      published_at: new Date(row.pubdate * 1000).toISOString(), keywords: [row.tname].filter(Boolean),
    }, source, now))
  }
  const entries = [...text.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0, 12)
  return entries.flatMap(([, body]) => {
    const link = plain(element(body, 'link')) || /<link\b[^>]*href=["']([^"']+)/i.exec(body)?.[1]
    if (!link) return []
    return [normalizeMaterial({ title: element(body, 'title'), url: link,
      description: element(body, 'description') || element(body, 'summary'),
      published_at: plain(element(body, 'pubDate') || element(body, 'published') || element(body, 'updated')),
    }, source, now)]
  })
}

export async function collectMaterials(sources, { now, fetchImpl = globalThis.fetch }) {
  const results = await Promise.allSettled(sources.map(async source => {
    const response = await fetchImpl(source, { signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'RIN-Memory/0.3 (personal companion; public feed reader)' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 1000000) throw new Error('素材列表过大')
    return parseFeed(text, source, now)
  }))
  return { materials: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    errors: results.flatMap((result, index) => result.status === 'rejected'
      ? [{ source: sources[index], error: String(result.reason?.message ?? result.reason) }] : []) }
}

export function rankMaterials(materials, { seeds = [], avoid = [], used = {}, now }) {
  const words = seeds.map(seed => String(seed).toLowerCase()).filter(Boolean)
  return materials.filter(row => !used[row.material_id] && !used[row.fingerprint]
    && new Date(now) - new Date(row.published_at ?? row.fetched_at) < 7 * 86400000
    && !avoid.some(topic => `${row.title} ${row.description}`.includes(topic)))
    .map(row => ({ ...row, score: words.reduce((score, word) => score +
      (`${row.title} ${row.description} ${row.keywords.join(' ')}`.toLowerCase().includes(word) ? 3 : 0), 0) }))
    .sort((a, b) => b.score - a.score || String(b.published_at ?? b.fetched_at).localeCompare(a.published_at ?? a.fetched_at))
    .slice(0, 6)
}
