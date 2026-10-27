/**
 * rin-memory 的客户端协议。
 *
 * 这里只做三件事:按合同发请求、把失败分类成可恢复/不可恢复、把尚未确认的
 * 轮次原子落盘。领域规则(事实、更正、遗忘、人格发布)全在服务里,本文件不
 * 复制一份。
 *
 * 关键约束:
 * - 同一轮重放必须逐字节相同:请求体在第一次尝试时固定,重试只重发它;
 * - 删除待办优先于任何补交:屏障未确认前不重放旧正文;
 * - `sent`(平台接收)与 `delivered`(用户看到)是两种事实,不混用;
 * - 凭据只在请求头里出现,不进日志、错误消息或持久文件。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 服务返回的结构化错误;`kind` 决定调用方能不能重试。 */
export class MemoryHttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || `记忆服务请求失败 (${status}, ${code})`)
    this.name = 'MemoryHttpError'
    this.status = status
    this.code = code
    this.extra = extra
    this.kind = classifyHttpError(status, code)
  }
}

/**
 * 把一次失败收敛成五种处理方式。
 *
 * - `retry`:网络、超时、503、429、5xx —— 同一正文稍后重发;
 * - `stale`:409 context_stale —— 依据变了,必须重新取上下文,不能原样重试;
 * - `gone`:410 —— 内容已被删除,终止重放,不再无限重试;
 * - `config`:401/403 —— 身份或凭据问题,停下等用户修配置;
 * - `conflict`:其他 409 —— 同键异内容,保留具体错误,人工核对;
 * - `fatal`:4xx 语义错误 —— 请求本身有问题。
 */
export function classifyHttpError(status, code) {
  if (status === 410 || code === 'deleted') return 'gone'
  if (status === 429 || status >= 500 || status === 408) return 'retry'
  if (code === 'context_stale' || code === 'needs_reissue') return 'stale'
  if (status === 401 || status === 403) return 'config'
  if (status === 409) return 'conflict'
  return 'fatal'
}

/** 网络层失败(连接被拒、DNS、超时中止)统一按可重试处理。 */
export function classifyTransportError(error) {
  if (error && typeof error === 'object' && 'kind' in error) return error
  const name = error?.name || ''
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'retry', status: 0, code: 'timeout' }
  return { kind: 'retry', status: 0, code: 'transport' }
}

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 40)

/** 纯文本化一条消息的 text 块(忽略 think/tool 块)。 */
export function messageText(message) {
  const content = message?.content ?? []
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

/** 清洗一个 source_key 组件:与核心的 `sanitize_component` 同规则。 */
export function cleanComponent(value, limit = 200) {
  const text = String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[:：]/g, '_')
  return Array.from(text).slice(0, limit).join('')
}

/** 与核心一致:`plugin:<plugin>:<character>:<subject>:<session>:<event>`。 */
export function buildSourceKey(pluginId, character, subject, sessionId, eventId) {
  return [
    'plugin',
    cleanComponent(pluginId, 64),
    cleanComponent(character, 120),
    cleanComponent(subject, 256),
    cleanComponent(sessionId, 64),
    cleanComponent(eventId, 200),
  ].join(':')
}

/** Unicode 字符数(emoji 记 1),与核心的显示回执计数口径一致。 */
export function charCount(text) {
  return Array.from(String(text ?? '')).length
}

/** 插件自己的稳定会话标识;DSH session id 会随重建/清理变化,不能当身份。 */
export function sessionScopeId(sessionId) {
  return `dsh-${hash(String(sessionId ?? ''))}`
}

export class MemoryClient {
  /**
   * @param {object} config 已归一化的插件配置
   * @param {string} token 客户端令牌
   * @param {object} [options]
   */
  constructor(config, token, {
    fetchImpl = globalThis.fetch,
    statePath,
    now = () => new Date().toISOString(),
    logger = console,
    maxPending = config.maxPending ?? 256,
  } = {}) {
    this.config = config
    this.token = token
    this.fetch = fetchImpl
    this.statePath = statePath
    this.now = now
    this.logger = logger
    this.maxPending = maxPending
    const url = new URL(config.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
      throw new Error('本机接入仅允许无内嵌凭据的 http://127.0.0.1 地址')
    }
    this.state = emptyState()
    this.tail = Promise.resolve()
    this.lastError = null
  }

  // -- persistence -----------------------------------------------------

  async open() {
    if (!this.statePath) return
    let raw
    try {
      raw = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return
      // A damaged queue is never replaced with an empty one: the finished
      // turns it holds are the only copy of those exchanges.
      throw new Error(`记忆补交状态无法解析，保留原文件：${error.message}`)
    }
    if (raw?.schema !== 1 || typeof raw.pending !== 'object' || raw.pending === null) {
      throw new Error('记忆补交状态格式错误，保留原文件')
    }
    this.state = {
      schema: 1,
      pending: raw.pending,
      generated: raw.generated ?? {},
      sessions: raw.sessions ?? {},
      accepted: raw.accepted ?? {},
      references: raw.references ?? {},
      // Send receipts that arrived before their turn was saved. They are
      // attached to the turn when it is queued, so a crash in between loses
      // neither half.
      sent: raw.sent && typeof raw.sent === 'object' ? raw.sent : {},
      recentTurns: raw.recentTurns && typeof raw.recentTurns === 'object' ? raw.recentTurns : {},
      retiredSessions: Array.isArray(raw.retiredSessions) ? raw.retiredSessions : [],
      cleanup: raw.cleanup && typeof raw.cleanup === 'object' ? raw.cleanup : {},
      status: raw.status && typeof raw.status === 'object' ? raw.status : {},
      // Per-scope fingerprints of material that really reached the model.
      // Only an actual injection writes here, so a restarted process does
      // not re-post memories it already delivered in this context.
      injected: raw.injected && typeof raw.injected === 'object' ? raw.injected : {},
      proactiveOutputs: raw.proactiveOutputs ?? {},
    }
  }

  async save() {
    if (!this.statePath) return
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
    await rename(temporary, this.statePath)
  }

  /** 串行化所有状态改动,避免并发 flush 互相覆盖。 */
  serial(action) {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }

  // -- scope -----------------------------------------------------------

  scope(sessionId) {
    const c = this.config
    return {
      character_id: c.characterId,
      subject: c.subject,
      session_id: sessionScopeId(sessionId),
      scene: `plugin:${c.pluginId}`,
    }
  }

  isRetired(sessionId) {
    return this.state.retiredSessions.includes(sessionScopeId(sessionId))
  }

  // -- transport -------------------------------------------------------

  async request(path, body, method = 'POST', signal) {
    const url = new URL(path, this.config.url)
    const init = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Companion-Client': this.config.clientId,
        'X-Companion-Token': this.token,
      },
    }
    if (method === 'GET') {
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
    } else {
      init.body = JSON.stringify(body ?? {})
    }
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 10000)
    init.signal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await this.fetch(url, init)
    } catch (error) {
      const classified = classifyTransportError(error)
      this.lastError = classified
      throw classified
    }
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      // A non-JSON body is still a response; the status decides.
    }
    if (!response.ok) {
      const error = new MemoryHttpError(
        response.status,
        payload.code ?? 'http_error',
        payload.message,
        payload,
      )
      this.lastError = error
      throw error
    }
    this.lastError = null
    return payload
  }

  // -- failure policy --------------------------------------------------

  /**
   * 只重试可重试的失败;其余原样抛给调用方处理。
   *
   * 顺序是承诺的一部分:先处理清理待办,再按入队顺序补交。任何一项失败就停
   * 下整批,而不是跳过它继续发后面的轮次。
   *
   * @param cleanup 调用方已经查过的清理待办。传 `undefined` 表示这里自己查;
   *   后台 tick 会先查一次以决定要不要先删正文,再把它交进来,避免同一轮
   *   轮询向服务重复问同一个问题。
   */
  async flushPending(cleanup) {
    const pending = cleanup ?? await this.releaseCleanup()
    if (pending.length > 0) {
      // Nothing may be replayed while a deletion is outstanding: an old body
      // could reintroduce text the user just removed.
      throw Object.assign(new Error('存在待清理记忆：已暂停补交，等待清理确认'), {
        kind: 'cleanup',
        deletions: pending.map(item => item.deletion_id),
      })
    }
    for (const [requestId, row] of Object.entries(this.state.pending)) {
      try {
        await this.request('/v1/turns', row.body)
        await this.reportUsage(row)
        await this.flushSent(requestId, row)
        delete this.state.pending[requestId]
        this.state.recentTurns[requestId] = { scope: row.scope }
        this.state.status.lastSaved = { request_id: requestId, at: this.now() }
        await this.save()
      } catch (error) {
        const kind = error.kind ?? classifyTransportError(error).kind
        if (kind === 'gone') {
          // The content was deleted. Stop replaying it and retire the session
          // so the old text cannot return through a later turn.
          delete this.state.pending[requestId]
          this.retire(row.scope.session_id)
          await this.save()
          continue
        }
        if (kind === 'stale') {
          // The basis moved: this body may not be replayed as-is. Drop the
          // body (it is no longer trustworthy) and keep the fact visible.
          delete this.state.pending[requestId]
          this.state.status.lastFailure = {
            request_id: requestId, kind, at: this.now(), code: error.code,
          }
          await this.save()
          continue
        }
        this.state.status.lastFailure = {
          request_id: requestId, kind, at: this.now(), code: error.code,
        }
        await this.save()
        throw error
      }
    }
    // Held receipts whose turn was already saved (the QQ send finished after
    // the save) are posted here. They are not entries of `pending`, so leaving
    // them to the loop above would strand them forever.
    await this.flushHeldReceipts()
  }

  /**
   * 提交等待中的发送回执。
   *
   * 一份回执只有在它对应的轮次已经提交后才有意义;尚未提交的那一轮留在
   * `pending` 里,下一次 flush 会先保存它、再回到这里。冲突或已删除的回执
   * 直接丢弃(保留没有意义),其余失败保留待重试。
   */
  async flushHeldReceipts() {
    for (const turnKey of Object.keys(this.state.sent)) {
      const record = this.state.sent[turnKey]
      try {
        await this.request('/v1/receipts', {
          ...record.scope,
          request_id: turnKey,
          receipt_id: `sent:${record.transport}:${turnKey}:${hash(JSON.stringify(record.parts))}`,
          kind: 'sent',
          consumer: 'dsh_chat',
          transport: record.transport,
          parts: record.parts.map(({ platform_id, chars }) => ({ platform_id, chars })),
        })
        this.state.accepted[turnKey] = [...(this.state.accepted[turnKey] ?? []), ...record.parts.map(part => JSON.stringify(part))]
        delete this.state.sent[turnKey]
        await this.save()
      } catch (error) {
        const kind = error.kind ?? classifyTransportError(error).kind
        if (kind === 'conflict' || kind === 'gone') {
          delete this.state.sent[turnKey]
          await this.save()
          continue
        }
        // A turn that is still queued is expected to be unknown here; keep
        // the receipt until that turn lands.
        this.state.status.lastFailure = {
          request_id: turnKey, kind, at: this.now(), code: error.code, phase: 'sent_receipt',
        }
        await this.save()
        return
      }
    }
  }

  /**
   * @param cleanup 已查过的清理待办;省略时本方法自己查。
   */
  flush(cleanup) {
    return this.serial(() => this.flushPending(cleanup))
  }

  /** 使用回执:只标记“已采用这个人格版本”,不代表用户看到。 */
  async reportUsage(row) {
    await this.request('/v1/receipts', {
      ...row.scope,
      request_id: row.body.request_id,
      receipt_id: `used:${this.config.clientId}:${row.body.request_id}`,
      kind: 'used',
      consumer: 'dsh_chat',
    })
  }

  /**
   * 登记一次平台接收事实,但**不立即提交**。
   *
   * 核心要求 `sent` 回执对应的轮次已经提交;而保存是异步的、还可能正在等重试。
   * 直接把回执发出去只会在服务端变成“未知请求”。所以先按轮次记在本地,等那一
   * 轮保存成功后再一起上交:两边都成功,或者两边都留着等下次。
   *
   * `turnMessageId` 是 DSH 侧真实用户消息 id,与保存时用的键相同。
   */
  async recordSent(turnMessageId, scope, { transport, parts }) {
    const accepted = parts
      .filter(part => part.ok)
      .map(part => ({ platform_id: part.platformId ?? '', chars: part.chars, index: part.index }))
    if (accepted.length === 0) return
    await this.serial(async () => {
      const known = this.state.accepted[turnMessageId] ?? []
      const previous = this.state.sent[turnMessageId]?.parts ?? []
      const merged = new Map(previous.map(part => [JSON.stringify(part), part]))
      for (const part of accepted) if (!known.includes(JSON.stringify(part))) merged.set(JSON.stringify(part), part)
      if (merged.size) this.state.sent[turnMessageId] = { scope, transport, parts: [...merged.values()], at: this.now() }
      await this.save()
    })
  }

  /**
   * 把某个轮次已登记的发送回执交给服务。
   *
   * 查找键是**轮次键**(与 pending 相同),因为 bridge 与插件对同一轮用的就是
   * 它;登记时用它、提交时也用它,不会出现两套 id。
   */
  async flushSent(requestId, row) {
    const record = this.state.sent[requestId]
    if (!record) return
    await this.request('/v1/receipts', {
      ...(row?.scope ?? record.scope),
      request_id: requestId,
      receipt_id: `sent:${record.transport}:${requestId}:${hash(JSON.stringify(record.parts))}`,
      kind: 'sent',
      consumer: 'dsh_chat',
      transport: record.transport,
      parts: record.parts.map(({ platform_id, chars }) => ({ platform_id, chars })),
    })
    this.state.accepted[requestId] = [...(this.state.accepted[requestId] ?? []), ...record.parts.map(part => JSON.stringify(part))]
    delete this.state.sent[requestId]
  }

  // -- cleanup ---------------------------------------------------------

  retire(scopeSessionId) {
    const id = typeof scopeSessionId === 'string' && scopeSessionId.startsWith('dsh-')
      ? scopeSessionId
      : sessionScopeId(scopeSessionId)
    if (!this.state.retiredSessions.includes(id)) this.state.retiredSessions.push(id)
  }

  /**
   * 处理清理待办。
   *
   * 清理待办属于整个插件(按 `plugin_id` 归属),不属于某一轮:查询一次,
   * 只要还有未确认的待办就暂停**所有**补交,因为重放任何旧正文都可能把用户
   * 刚删除的内容带回来。确认清理后下一次 flush 自然放行,无需另设开关。
   */
  async releaseCleanup() {
    const pending = await this.cleanupPending()
    if (pending.length === 0) {
      delete this.state.cleanup.blocked
      return []
    }
    this.state.cleanup.blocked = {
      at: this.now(),
      deletions: pending.map(item => item.deletion_id),
    }
    await this.save()
    return pending
  }

  async cleanupPending() {
    // `plugin_id` is the whole identity this query needs; a session id would be
    // a lie (the plugin's work spans every session it ever wrote).
    const result = await this.request('/v1/cleanup/pending', {
      plugin_id: this.config.pluginId,
    }, 'GET')
    if (!Array.isArray(result.items)) throw new Error('记忆服务清理响应格式错误')
    return result.items
  }

  async acknowledgeCleanup(deletionId, { cleaned = [], failed = [] } = {}) {
    return await this.request(`/v1/cleanup/${encodeURIComponent(deletionId)}/ack`, {
      plugin_id: this.config.pluginId,
      status: failed.length > 0 ? 'failed' : 'cleaned',
      cleaned,
      failed,
    })
  }

  // -- memory tools ----------------------------------------------------

  async entries(text = '') {
    return await this.request('/v1/memory/entries', {
      subject: this.config.subject,
      text,
    }, 'GET')
  }

  async correct(body) {
    return await this.request('/v1/memory/correct', { subject: this.config.subject, ...body })
  }

  async forget(body) {
    return await this.request('/v1/memory/forget', { subject: this.config.subject, ...body })
  }

  /**
   * 明确教导:把**一条已保存的用户消息**报给服务,由服务端读原文派生规则。
   *
   * 请求体只有来源与 CAS 依据,没有规则正文:
   * - `source_key` 是本轮那条用户消息的来源键,服务端自己去 journal/recent 里
   *   取原文;客户端塞不进任何它想让人格学的话。
   * - `quoted_example.source_key` 是可选的授权示例(学另一个 bot 的表达方式),
   *   同样必须是已保存消息;只传 key,不传文本。
   * - `base_revision` 是调用方看到的卡修订号,冲突时服务端回 409 并附当前卡。
   *
   * 这里不做任何本地判定:拒绝原因(403 无能力 / 404 来源没保存 / 409 冲突 /
   * 422 被判定不是教导)全部由服务端给出,原样上抛给咒语层回报主人。
   */
  async teach({ sourceKey, baseRevision, quotedExampleKey = '', subject, scene, sessionId } = {}) {
    const body = {
      subject: subject ?? this.config.subject,
      source_key: sourceKey,
      base_revision: Number(baseRevision ?? 0),
      target: 'next_turn',
    }
    if (scene) body.scene = scene
    if (sessionId) body.session_id = sessionId
    if (quotedExampleKey) body.quoted_example = { source_key: quotedExampleKey }
    return await this.request('/v1/persona/teach', body)
  }


  // -- status ----------------------------------------------------------

  status() {
    const pending = Object.keys(this.state.pending).length
    const unsent = Object.keys(this.state.sent).length
    return {
      configured: true,
      url: this.config.url,
      character_id: this.config.characterId,
      subject: this.config.subject,
      pending,
      unsent_receipts: unsent,
      retired_sessions: this.state.retiredSessions.length,
      cleanup: this.state.cleanup.blocked ?? null,
      last_saved: this.state.status.lastSaved ?? null,
      last_failure: this.state.status.lastFailure ?? null,
      last_error: this.lastError
        ? { kind: this.lastError.kind, code: this.lastError.code, status: this.lastError.status }
        : null,
    }
  }
}

function emptyState() {
  return { schema: 1, pending: {}, generated: {}, sessions: {}, references: {}, accepted: {}, sent: {}, recentTurns: {}, retiredSessions: [], cleanup: {}, status: {}, injected: {}, proactiveOutputs: {} }
}

export { emptyState, hash as stableHash }
