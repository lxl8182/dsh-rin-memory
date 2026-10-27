import { randomUUID } from 'node:crypto'
import { messageText } from './memory-client.js'
import { parseSpells, renderFeedback } from './magic.js'

export const SPELL_SOURCE = 'companion-spell'

export function spellMessage(text) {
  return { id: randomUUID(), role: 'user', source: { kind: SPELL_SOURCE }, content: [{ type: 'text', text }] }
}

export function extractFinalText(session) {
  const events = session.snapshotEvents()
  const end = events.findLast(event => event.type === 'turn/end')
  if (end?.data.reason.kind !== 'completed') {
    const error = events.findLast(event => event.type === 'agent/error')
    throw new Error(error?.data.error?.message ?? end?.data.reason.error?.message ?? `工作会话未完成（${end?.data.reason?.kind ?? '没有结束记录'}）`)
  }
  const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
  const text = messageText(message?.data.message).trim()
  if (!text) throw new Error('工作会话没有返回最终文字。')
  return text
}

function workerResult(text) {
  const raw = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1').trim()
  let result
  try { result = JSON.parse(raw) }
  catch (error) { throw new Error('工作会话没有返回约定的执行结果 JSON。', { cause: error }) }
  if (typeof result?.ok !== 'boolean' || typeof result.text !== 'string') throw new Error('工作会话执行结果需要 ok 和 text 字段。')
  if (!result.ok) throw new Error(result.text || '工作会话报告任务失败。')
  return result.text
}

/**
 * 工作会话不需要、也不允许调用的工具。
 *
 * `working_directory` 是实测出来的事故源(2026-10-26): worker 想"确认自己在哪",
 * 反复调用它,每次 cd 都产生一条目录变化通知加一条运行时上下文,通知又让它想再
 * 确认一次 —— 355 次调用、346 次通知、零次 pwsh,二十分钟耗尽才自动超时。
 *
 * 摘掉它能力一点不损失:文件工具接受绝对路径,`pwsh` 有单次调用的 workdir 参数,
 * 都不依赖会话当前目录。
 */
export const WORKER_DENIED_TOOLS = Object.freeze(['working_directory'])

/** 工作会话默认使用的 preset。它带着 pwsh / fs / glob / grep 这一整套干活工具。 */
export const WORKER_PRESET = 'standard'

/** 没有这些工具就不该开始干活:连命令都跑不了,只会白等二十分钟。 */
const EXECUTION_TOOLS = ['pwsh', 'bash']

/**
 * 给刚创建的工作会话装上真正能干活的工具。
 *
 * 工具来自 preset,不是宿主全局层 —— 实测(2026-10-26):不挂 preset 的工作会话
 * 只有 load_workspace_dependencies / session_* / working_directory,它自己最后
 * 如实报告"本会话没有执行或写入工具"。挂上 standard 之后 pwsh、fs、glob、grep
 * 全都在,而 standard 本来就不含 working_directory,那条死循环也一并消失。
 *
 * 挂完必须确认执行工具真的到位:拿不到就立刻失败,不要让它在空环境里空转。
 */
export async function mountWorkerTools(ctx, agent, preset = WORKER_PRESET, deny = WORKER_DENIED_TOOLS) {
  const presets = ctx.get?.('agentPresets')
  if (!presets?.mount) throw new Error('工作会话拿不到 preset 注册表,无法装工具。')
  await presets.mount(agent.ctx, preset)
  if (deny.length) {
    try { agent.ctx.tools.restrict({ deny }) } catch { /* 少一道限制不影响干活 */ }
  }
  const tools = ctx.get?.('tools')
  const names = tools?.view ? [...tools.view(agent).visible.keys()] : []
  if (names.length && !EXECUTION_TOOLS.some(name => names.includes(name))) {
    throw new Error(`工作会话没有拿到执行工具（只有 ${names.join(", ")}）。`)
  }
  return names
}

/** 独立标准 agent；在插件作用域创建，不继承 QQ 主会话的隔离或人格。 */
/**
 * @param {object} options
 * @param {number} [options.timeoutMs] 单个工作会话的上限。装包、编译这类活儿
 *   五分钟不够用,默认给到二十分钟;调用方要更短就自己传。
 * @param {string} [options.preset] 工作会话使用的 preset,默认 WORKER_PRESET。
 * @param {string[]} [options.deny] 要摘掉的工具名,默认 WORKER_DENIED_TOOLS。
 */
export async function startWorker(ctx, { prompt, provider, model, cwd, timeoutMs = 1200000, signal,
  preset = WORKER_PRESET, deny = WORKER_DENIED_TOOLS }) {
  const agents = ctx.get('agents')
  if (!agents?.create) throw new Error('DSH 标准执行器尚未就绪。')
  const deadline = AbortSignal.timeout(timeoutMs)
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline
  let handle
  let onAbort
  try {
    handle = await agents.create({
      sessionId: `companion-spell-${randomUUID()}`,
      agentOptions: { provider, model }, meta: { cwd }, signal: cancellation,
    })
    await mountWorkerTools(ctx, handle.agent, preset, deny)
    cancellation.throwIfAborted()
    const aborted = new Promise((_, reject) => {
      onAbort = () => { handle.agent.cancel({ kind: 'user' }); reject(cancellation.reason) }
      cancellation.addEventListener('abort', onAbort, { once: true })
    })
    handle.agent.followup(spellMessage(`${prompt}\n\n最终只返回 JSON：{"ok":true,"text":"实际完成结果"}。任务未完成或命令失败时，ok 必须为 false，text 写具体错误。`))
    await Promise.race([handle.agent.whenIdle(), aborted])
    cancellation.throwIfAborted()
    return workerResult(extractFinalText(handle.agent.session))
  } catch (error) {
    if (deadline.aborted) throw new Error(`工作会话超时（${timeoutMs} ms）。`, { cause: error })
    throw error
  } finally {
    cancellation.removeEventListener('abort', onAbort)
    await handle?.dispose()
  }
}

/** 同一 session/seq 去重；所有消息共用串行队列，整批结束后一次回填。 */
export class SpellRunner {
  constructor({ runSpell, followupOf = agent => message => agent.followup(message), isActive = () => true,
    learnedNames = () => [], logger = console, now = Date.now, maxAgeMs = 1800000,
    onAbandoned = () => {} }) {
    Object.assign(this, { runSpell, followupOf, isActive, learnedNames, logger, now, maxAgeMs, onAbandoned })
    this.seen = new Map()
    this.jobs = new Map()
    this.tail = Promise.resolve()
    this.stopped = false
  }

  handleAssistantMessage(agent, message, seq) {
    const parsed = parseSpells(messageText(message), this.learnedNames())
    const casts = parsed.casts
    // 念了还没学会的名字:不执行,但必须回话。静默等于告诉模型"成功了"。
    const unknown = parsed.unknown.map(cast => ({
      cast, ok: false,
      text: `「${cast.spell}」还没学成。念它什么也不会发生,先别用它。`,
    }))
    if ((!casts.length && !unknown.length) || this.stopped || !this.isActive(agent)) return Promise.resolve([])
    const sessionId = agent.session.id
    const seen = this.seen.get(sessionId) ?? new Set()
    if (seen.has(seq)) return Promise.resolve([])
    seen.add(seq)
    this.seen.set(sessionId, seen)
    const controller = new AbortController()
    this.jobs.set(controller, agent)
    const at = this.now()
    const active = () => !this.stopped && !controller.signal.aborted && this.isActive(agent) && this.now() - at < this.maxAgeMs
    const job = this.tail.then(async () => {
      // 未学会的名字不需要执行,也排在最前面:模型念错时先纠正,再谈别的。
      const results = [...unknown]
      for (const cast of casts) {
        if (!active()) break
        let outcome
        try {
          const value = await this.runSpell(cast, agent, controller.signal)
          outcome = { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value ?? '') }
        } catch (error) {
          outcome = { ok: false, text: error.message ?? String(error) }
        }
        results.push({ cast, ...outcome })
      }
      // 三十分钟是"还值得叫醒主会话"的上限:装包、编译这类活儿经常超过五分钟,
      // 而只要主会话还在,回填就是一条普通消息。超过上限或会话已销毁时不回填,
      // 但**绝不静默丢弃**——把结果交出去,由上层决定补投到哪里。
      if (results.length && active()) {
        await this.followupOf(agent)(spellMessage(results.map(result => renderFeedback(result.cast, result)).join('\n\n')))
      } else if (results.length) {
        try { await this.onAbandoned(agent, results) } catch (error) {
          this.logger.warn?.(`[dsh-companion-memory] 咒语结果补投失败：${error?.message ?? error}`)
        }
      }
      return results
    }).finally(() => this.jobs.delete(controller))
    this.tail = job.catch(error => this.logger.warn?.(`[dsh-companion-memory] 咒语回填失败：${error.message}`))
    return job
  }

  detach(agent) {
    for (const [controller, owner] of this.jobs) if (owner === agent) controller.abort(new Error('主会话已销毁。'))
  }

  async dispose() {
    this.stopped = true
    for (const controller of this.jobs.keys()) controller.abort(new Error('咒语执行器已停用。'))
    await this.tail
    this.seen.clear()
  }
}
