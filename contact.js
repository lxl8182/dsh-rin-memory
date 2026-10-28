/** Private contact metadata. It is never a spell, spoken text or user evidence. */
export function contactControls(value) {
  let contact, choice, malformed = false
  const text = String(value ?? '').replace(/<(下次联系|选题)>([\s\S]*?)<\/\1>/gu, (_all, tag, body) => {
    if (tag === '下次联系') contact = body.trim()
    else choice = body.trim()
    return ''
  }).replace(/<(?:下次联系|选题)>[\s\S]*$/u, () => { malformed = true; return '' }).trim()
  return { text: text === '[PASS]' ? '' : text, contact, choice, malformed }
}

export function localClock(now, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return { ...values, date: `${values.year}-${values.month}-${values.day}`,
    display: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}` }
}

function zonedTime(date, hour, minute, timezone) {
  const target = Date.parse(`${date}T${hour}:${minute}:00Z`)
  let value = target
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localClock(value, timezone)
    const projected = Date.parse(`${p.date}T${p.hour}:${p.minute}:${p.second}Z`)
    value += target - projected
  }
  const p = localClock(value, timezone)
  if (p.date !== date || Number(p.hour) !== Number(hour) || Number(p.minute) !== Number(minute)) {
    throw new Error('该时区中不存在这个时间')
  }
  return value
}

export function parseContact(body, { now, timezone }) {
  const [when, ...words] = String(body).split('｜')
  const time = when.trim(), intent = words.join('｜').trim().slice(0, 500)
  if (time === '暂停') return { mode: 'paused', next_contact_at: null, intent, timezone }
  if (time === '等新进展') return { mode: 'on_event', next_contact_at: null, intent, timezone }
  let instant
  const relative = /^(今天|明天)\s*(\d{1,2}):(\d{2})$/u.exec(time)
  if (relative) {
    const p = localClock(now, timezone)
    const date = new Date(`${p.date}T12:00:00Z`)
    if (relative[1] === '明天') date.setUTCDate(date.getUTCDate() + 1)
    if (Number(relative[2]) > 23 || Number(relative[3]) > 59) throw new Error('联系时间超出时钟范围')
    instant = zonedTime(date.toISOString().slice(0, 10), relative[2].padStart(2, '0'), relative[3], timezone)
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/u.test(time)) {
    instant = Date.parse(time)
    const zone = /(Z|([+-])(\d{2}):(\d{2}))$/u.exec(time)
    const offset = zone[1] === 'Z' ? 0 : (zone[2] === '+' ? 1 : -1)
      * (Number(zone[3]) * 60 + Number(zone[4])) * 60000
    const written = time.slice(0, -zone[1].length).replace(' ', 'T')
    if (Number.isFinite(instant) && new Date(instant + offset).toISOString().slice(0, written.length) !== written) {
      throw new Error('联系日期或时间不存在')
    }
  } else throw new Error('联系时间需要今天/明天时分、带时区的日期，或等新进展/暂停')
  if (!Number.isFinite(instant) || instant <= new Date(now).getTime()) throw new Error('联系时间必须晚于本轮时间')
  return { mode: 'at', next_contact_at: new Date(instant).toISOString(), intent, timezone }
}

export const CONTACT_DEFAULTS = Object.freeze({ timezone: 'Asia/Shanghai', dailyLimit: 2,
  minGapMinutes: 90, quietStart: 0, quietEnd: 9, followupHours: 12,
  materialRefreshMinutes: 180,
  sources: ['https://api.bilibili.com/x/web-interface/popular?ps=8&pn=1', 'https://www.gcores.com/rss'] })

export function normalizeContact(raw = {}) {
  const config = { ...CONTACT_DEFAULTS }
  if (typeof raw.timezone === 'string') {
    localClock(Date.now(), raw.timezone)
    config.timezone = raw.timezone
  }
  for (const key of ['dailyLimit', 'minGapMinutes', 'followupHours', 'materialRefreshMinutes']) {
    if (Number.isFinite(raw[key]) && raw[key] > 0) config[key] = raw[key]
  }
  for (const key of ['quietStart', 'quietEnd']) {
    if (Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] < 24) config[key] = raw[key]
  }
  if (Array.isArray(raw.sources)) config.sources = raw.sources.filter(url => {
    try { return new URL(url).protocol === 'https:' } catch { return false }
  })
  return config
}
