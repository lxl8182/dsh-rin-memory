/**
 * DSH 本地会话正文的清理。
 *
 * 清理是删除闭环里唯一不能只靠“退役”完成的一步:退役只是让旧会话不再被采用,
 * 正文仍躺在磁盘上,下一次恢复、摘要或搜索仍可能把它带回来。所以这里直接对
 * 会话日志文件动手,并且**先删除正文、后向服务确认**。
 *
 * 几条硬约束:
 * - 只碰点名会话:<root>/<projectKey>/<sessionId>/ 这一个目录。
 * - 不猜结构:文件名与目录布局来自 `dsh-session-persistence-jsonl` 的现有约定
 *   (`session.v<N>.jsonl[.zstd]`),不匹配就不删,并如实报告原因。
 * - 压缩格式按魔数判断,不按扩展名猜;解压失败同样不删。
 * - 删除后核对目录确实消失(Windows 上句柄未释放会失败),失败即报 failed。
 * - 不触碰 `.lock` 以外的其它文件:目录整体移除,不留半截正文。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 会话日志文件名:session.v<version>.jsonl 或 .jsonl.zstd。 */
const LOG_NAME = /^session\.v\d+\.jsonl(\.zstd)?$/

/**
 * 枚举一个会话根下所有会话目录。
 *
 * 布局是 `<root>/<projectKey>/<sessionId>/`。`_no-cwd` 也是合法项目目录。
 * 这里只读目录名,不读内容,便于在删除前确认目标存在。
 */
export async function listSessionDirectories(root, signal) {
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return found
    throw error
  }
  for (const project of projects) {
    if (signal?.aborted) return found
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let sessions
    try {
      sessions = await readdir(projectPath, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      found.push({ project: project.name, sessionId: session.name, path: join(projectPath, session.name) })
    }
  }
  return found
}

/**
 * 读取一个会话目录里的正文,用于核对“里面确实有目标内容”。
 *
 * 返回解压后的文本行;文件不存在或格式不认识时返回空。这个函数**不**修改
 * 任何东西,删除前的核对与删除后的复核都用它。
 */
export async function readSessionText(directory, signal) {
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return ''
  }
  let text = ''
  for (const name of entries) {
    if (signal?.aborted) break
    if (!LOG_NAME.test(name)) continue
    const buffer = await readFile(join(directory, name))
    text += `${decodeLog(buffer)}\n`
  }
  return text
}

/** 按魔数解压:zstd 帧以 0x28 B5 2F FD 开头,否则视为明文。 */
export function decodeLog(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5
      && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    return zstdDecompressSync(buffer).toString('utf8')
  }
  return buffer.toString('utf8')
}

/**
 * 删除一个会话目录,并确认它真的消失。
 *
 * 返回 `{ deleted, reason }`:只有目录在删除后确实不存在才算 `deleted`。
 * 句柄未释放(Windows 常见)会报原因,让调用方把清理标为 failed 并保留待办,
 * 而不是谎报已清理。
 */
export async function deleteSessionDirectory(directory) {
  let before
  try {
    before = await stat(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already-absent' }
    return { deleted: false, reason: error.code ?? 'stat-failed' }
  }
  if (!before.isDirectory()) return { deleted: false, reason: 'not-a-directory' }
  try {
    await rm(directory, { recursive: true, force: false, maxRetries: 3 })
  } catch (error) {
    return { deleted: false, reason: error.code ?? error.message ?? 'remove-failed' }
  }
  try {
    await stat(directory)
    return { deleted: false, reason: 'still-present' }
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'removed' }
    return { deleted: false, reason: error.code ?? 'verify-failed' }
  }
}
// ---------------------------------------------------------------------------
// 上下文分段(RO02-CTX)
// ---------------------------------------------------------------------------
//
// 分段和下面的正文清理放在同一个模块里,因为它们管的是同一件事的另一半:清理
// 决定「哪个旧 DSH 会话必须被丢弃」,分段决定「当前这个 DSH 会话该不该被换掉」。
// 两者都以 DSH 会话为对象、都要持久化到插件数据目录,也都在宿主重启后必须恢复。
//
// 为什么要换段而不是压缩:DSH 原生压缩会把旧内容重写成摘要节点,摘要本身仍留在
// 会话里、并继续占上下文;而且压缩是不可逆的改写,原始聊天因此被降级。分段换的
// 是**会话**:旧会话整份留在磁盘上(原文永远完整),新会话从空日志开始,只带入
// 本卡允许的那一小段。于是每次模型请求的输入有界,而不是随聊天时长无限增长。

/**
 * 分段参数默认值。
 *
 * 与 `stack.toml` 的 `[segment]` 和插件 config 的同名字段一一对应;这里是插件
 * 侧的最后一道默认值,任何一处写坏都不会让插件启动失败。
 */
export const SEGMENT_DEFAULTS = Object.freeze({
  budgetTokens: 128000,
  hardTokens: 160000,
  carryTurns: 30,
  carryTokens: 8000,
  idleHours: 24,
  minTurns: 6,
  maxAgeDays: 14,
})

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * 中日韩与全角字符的判定。
 *
 * 分词器差异不该出现在预算判断里,但**低估**输入会让上限失效:一个汉字在主流
 * 分词器上通常就是一个 token,按「4 字符 = 1 token」折算会把它低估成 0.25,
 * 128K 预算于是放进 50 万字。所以这里按字符类别折算,宁可高估。
 */
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

/**
 * 一份正文的 token 估算。
 *
 * 宽字符(中日韩、全角标点)按 1 个 token、其余按 4 字符 1 个 token 折算,向上取整。
 * 这不是分词器的替代品,只用来判断「这一轮还要不要继续往同一个会话里塞」;判断
 * 偏保守,宁可早一点换段,也不要冲破上限。
 *
 * @param {unknown} text 任意正文;非字符串按空串处理。
 * @returns {number} 估算 token 数(整数,≥0)。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (WIDE_CHAR.test(char)) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/** 一条消息本身的角色与分帧开销;与正文长度无关,按条计。 */
const MESSAGE_OVERHEAD = 4

/** 一次完整交换(主人一句 + 铃芽一句)的估算 token。 */
export function exchangeTokens(exchange) {
  if (!exchange) return 0
  return estimateTokens(exchange.user) + estimateTokens(exchange.reply) + MESSAGE_OVERHEAD * 2
}

/**
 * 换段判定。
 *
 * 只回答「现在该不该换、为什么」,不产生任何副作用,也不读时钟以外的状态,
 * 因此可以只用纯函数测试固定住行为。
 *
 * 触发顺序:
 * 1. `hard` —— 硬上限,绕开 `minTurns`,防止单条超长文本或大图把上限冲破;
 * 2. `budget` —— 软上限,本轮结束后换段,是正常长聊的主路径;
 * 3. `idle` —— 真实用户停手达到 `idleHours`,跨天不回放无关旧话;
 * 4. `age` —— 段龄达到 `maxAgeDays`。**仅空闲时生效**:判定只发生在
 *    「上一轮已结束、下一次进模型之前」这一个时刻,永远不会打断正在进行的回合。
 *
 * 第 2—4 条都要求本段已有 `minTurns` 次完整交换,否则一个刚开的段会被立刻
 * 再换一次(抖动),用户会看到上下句接不上。
 *
 * @param {object|null|undefined} record 段状态;缺失表示还没有段。
 * @param {object} options
 * @param {number} options.now 判定时刻(毫秒时间戳)。
 * @param {object} [options.limits] 参数覆盖;缺省用 {@link SEGMENT_DEFAULTS}。
 * @returns {null | 'hard' | 'budget' | 'idle' | 'age'} 换段原因;不换返回 null。
 */
export function segmentSwitchReason(record, { now, limits = SEGMENT_DEFAULTS } = {}) {
  if (!record) return null
  const tokens = Number(record.tokens ?? 0)
  const exchanges = Array.isArray(record.exchanges) ? record.exchanges.length : 0
  if (tokens >= limits.hardTokens) return 'hard'
  const lastUser = Number(record.last_user_at ?? 0)
  if (Number.isFinite(lastUser) && now - lastUser >= limits.idleHours * HOUR_MS) return 'idle'
  if (exchanges < limits.minTurns) return null
  if (tokens >= limits.budgetTokens) return 'budget'
  const started = Number(record.started_at ?? 0)
  if (Number.isFinite(started) && started > 0 && now - started >= limits.maxAgeDays * DAY_MS) return 'age'
  return null
}

/**
 * 从本段挑出要带进新段的完整交换。
 *
 * 两条硬约束:
 * - **永不拆半轮**:整交换地往前取,凑不够就整条放弃,不取半句;
 * - 两个上限取**先到**:轮数 `carryTurns`、正文 `carryTokens`。
 *
 * 返回顺序保持原时间顺序,新段读到的仍是「先发生先出现」,不是倒序回放。
 *
 * @param {object|null|undefined} record 段状态。
 * @param {object} [limits]
 * @returns {{ exchanges: Array<object>, tokens: number }} 带入的交换与其估算 token。
 */
export function selectCarry(record, limits = SEGMENT_DEFAULTS) {
  const all = Array.isArray(record?.exchanges) ? record.exchanges : []
  const picked = []
  let tokens = 0
  for (let index = all.length - 1; index >= 0; index--) {
    if (picked.length >= limits.carryTurns) break
    const exchange = all[index]
    const cost = exchangeTokens(exchange)
    if (tokens + cost > limits.carryTokens) break
    picked.unshift(exchange)
    tokens += cost
  }
  return { exchanges: picked, tokens }
}

/** 一段带入历史的可读正文;对话双方都用真实角色,不额外加说明段以外的装饰。 */
export function renderCarry(exchanges, { owner = '主人', self = '铃芽' } = {}) {
  return exchanges.map(exchange => [
    `${owner}: ${String(exchange.user ?? '').trim()}`,
    `${self}: ${String(exchange.reply ?? '').trim()}`,
  ].join('\n')).join('\n')
}

/**
 * 段状态:哪一段、什么时候开始、累计多大、最后一次真实互动、绑定哪个 DSH 会话。
 *
 * 持久化在插件数据目录的 `segments.json` 里。**必须重启恢复**:段换了但插件
 * 以为还在旧段,下一轮就会重新判定一次、再换一次,用户会连丢两段上下文;
 * 反过来,插件以为换了但宿主仍在旧会话上,旧内容就会重新涨回上限。
 */
export class SegmentStore {
  /**
   * @param {object} options
   * @param {string} [options.statePath] 落盘路径;留空表示只在内存里工作。
   * @param {() => number} [options.now] 时钟,测试可替换。
   * @param {object} [options.limits] 参数覆盖。
   * @param {object} [options.logger]
   */
  constructor({ statePath = '', now = () => Date.now(), limits = SEGMENT_DEFAULTS, logger = console } = {}) {
    this.statePath = statePath
    this.now = now
    this.limits = { ...SEGMENT_DEFAULTS, ...limits }
    this.logger = logger
    this.segments = {}
    this.tail = Promise.resolve()
  }

  async open() {
    if (!this.statePath) return
    let raw
    try {
      raw = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      // 段状态损坏不该让聊天起不来;它只影响「要不要换段」的判断,而换错一次的
      // 代价远小于插件装不上。保留原文件供排查,从空状态重新开始。
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`[dsh-rin-memory] 段状态无法解析,从空状态继续：${error.message}`)
      }
      return
    }
    if (raw?.schema !== 1 || typeof raw.segments !== 'object' || raw.segments === null) {
      this.logger.warn?.('[dsh-rin-memory] 段状态格式不认识,从空状态继续')
      return
    }
    this.segments = raw.segments
  }

  async save() {
    if (!this.statePath) return
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ schema: 1, segments: this.segments }), { mode: 0o600 })
    await rename(temporary, this.statePath)
  }

  /** 串行化状态改动,避免并发读写互相覆盖。 */
  serial(action) {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }

  /** 某个 QQ 来源当前的段;没有则返回 undefined(下次 begin 会建一个)。 */
  current(sessionKey) {
    return this.segments[sessionKey]
  }

  /**
   * 记一次真实用户互动。
   *
   * **只有真实用户互动**才更新空闲计时:主动消息、后台任务、咒语反馈都不是
   * 主人在说话,拿它们续命会让一个实际已经隔了三天的会话永远不换段。
   */
  async touchUser(sessionKey, at = this.now()) {
    await this.serial(async () => {
      const record = this.segments[sessionKey]
      if (!record) return
      record.last_user_at = at
      await this.save()
    })
  }

  /**
   * 记一次完整交换。
   *
   * 只有「主人一句 + 铃芽实际发出去的一句」都确定时才记——半轮没有可带入的
   * 价值,记进去还会让 carry 的来源与真实发生过的话对不上。
   */
  async recordExchange(sessionKey, { user, reply, at = this.now(), turns }) {
    const text = String(user ?? '').trim()
    const answer = String(reply ?? '').trim()
    if (!text || !answer) return
    await this.serial(async () => {
      const record = this.segments[sessionKey] ?? this.blank(sessionKey, at)
      record.exchanges.push({ at, user: text, reply: answer })
      record.tokens = record.exchanges.reduce((sum, item) => sum + exchangeTokens(item), 0)
      record.last_user_at = at
      if (Number.isFinite(turns)) record.turns = turns
      this.segments[sessionKey] = record
      await this.save()
    })
  }

  /** 新开一段:换 id、重置计时与累计,并把 DSH 会话 id 换成新的那个。 */
  async begin(sessionKey, { sessionId, reason, at = this.now() } = {}) {
    let record
    await this.serial(async () => {
      const previous = this.segments[sessionKey]
      record = {
        ...this.blank(sessionKey, at),
        session_id: sessionId ?? '',
        previous_segment_id: previous?.segment_id ?? '',
        previous_session_id: previous?.session_id ?? '',
        previous_last_user_at: previous?.last_user_at ?? 0,
        reason: reason ?? '',
      }
      this.segments[sessionKey] = record
      await this.save()
    })
    return record
  }

  /** 把段绑定到当前 DSH 会话 id;重启后据此确认宿主是否还在同一会话上。 */
  async bind(sessionKey, sessionId) {
    await this.serial(async () => {
      const record = this.segments[sessionKey]
      if (!record) return
      if (record.session_id === sessionId) return
      record.session_id = sessionId
      await this.save()
    })
  }

  /** 判定当前是否该换段;返回原因或 null。 */
  switchReason(sessionKey, now = this.now()) {
    return segmentSwitchReason(this.segments[sessionKey], { now, limits: this.limits })
  }

  /** 按参数挑出要带进新段的交换。 */
  carry(sessionKey) {
    return selectCarry(this.segments[sessionKey], this.limits)
  }

  blank(sessionKey, at = this.now()) {
    return {
      segment_id: `seg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      session_key: sessionKey,
      session_id: '',
      started_at: at,
      last_user_at: at,
      turns: 0,
      tokens: 0,
      exchanges: [],
    }
  }
}
