/**
 * companion_task 的工具面:start / status / cancel。
 *
 * 这里刻意很薄:本文件不实现调度、不轮询、不重放。派发交给 DSH 原生后台
 * 子会话(subagents.startActivation),完成事件由 subagent/end 送回,主会话的
 * 通知由接线方用 store.pendingNotifications() 决定何时、以什么形式注入。
 *
 * 几条硬约束:
 * - 先落盘再派发:reserve 成功之后才调执行端,crash 时台账里至少有这条任务;
 * - 幂等键 = sha256(owner|qqSessionId|源轮次|工具调用 ID):同一次重放返回原
 *   任务且不重复派发,同一句话在不同轮次仍是新任务;
 * - 归属在工具执行边界复核:status/cancel 只认当前调用者自己 owner 的任务;
 * - 执行端不可用时明确报错,不抛异常打断聊天;
 * - 取消只报执行端确认过的状态,不臆测"已经停了"。
 */
import { createHash } from 'node:crypto'
import { TERMINAL } from './task-store.js'

/** 与 memory-client 同口径的稳定短哈希。 */
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 40)

/** 原生 stopReason → 任务终态。 */
const STOP_STATUS = {
  completed: 'completed',
  aborted: 'cancelled',
  'max-tokens': 'failed',
  error: 'failed',
  refusal: 'failed',
}

/** 子会话仍在此状态集合里,才算"还在跑"。 */
const RUNNING_STATES = new Set(['running', 'queued', 'queued-activation', 'starting', 'active', 'pending'])

/** 把 lastAssistantMessage 收敛成一段纯文本。 */
function textOf(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content ?? message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

/** 取原生执行端服务;没有就说没有,不猜路径。 */
function subagentsOf(agent) {
  const ctx = agent?.ctx
  if (!ctx) return undefined
  return typeof ctx.get === 'function' ? ctx.get('subagents') : ctx.subagents
}

/** 对外只暴露这几个字段:任务 id、状态、结果摘要、原生子会话 id、更新时间。 */
const describe = task => ({
  task_id: task.taskId,
  status: task.status,
  resultSummary: task.resultSummary ?? '',
  childSessionId: task.childSessionId ?? '',
  updatedAt: task.updatedAt ?? '',
  lastStopReason: task.lastStopReason ?? '',
  notified: task.notified === true,
})

/**
 * @param {object} options
 * @param {import('./task-store.js').TaskStore} options.store
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @param {(execution: object) => object|undefined} [options.provideAgent]
 *        exec 里没有精确 live agent 时的兜底(接线方提供)。
 * @param {(agent: object, exec: object) => any} [options.config.ownerOf]   任务主人标识
 * @param {(agent: object, exec: object) => any} [options.config.qqSessionOf] QQ 会话标识
 * @param {(agent: object, exec: object) => any} [options.config.turnIdOf]  源轮次 requestId
 * @param {(goal: string, task: object) => string} [options.config.buildPrompt]
 * @param {string} [options.config.provider]    原生子会话 provider,默认 'spawn'
 * @param {string} [options.config.label]       派发标签
 * @param {string} [options.config.agentPreset] 工作预设(可选)
 * @param {string} [options.config.cwd]         工作目录(可选)
 * @param {string} [options.config.owner]       固定 owner(测试或多主人接入时用)
 */
export function createTaskTools({ store, config = {}, logger = console, provideAgent } = {}) {
  if (!store) throw new Error('createTaskTools 需要 store')

  /** 解析本次调用的 live agent 与原生执行端。 */
  function resolve(exec) {
    const agent = exec?.agent ?? provideAgent?.(exec)
    return { agent, subagents: subagentsOf(agent) }
  }

  async function ownerOf(agent, exec) {
    if (typeof config.ownerOf === 'function') return String((await config.ownerOf(agent, exec)) ?? '')
    if (config.owner) return String(config.owner)
    return String(agent?.session?.id ?? '')
  }

  async function qqSessionOf(agent, exec) {
    if (typeof config.qqSessionOf === 'function') return String((await config.qqSessionOf(agent, exec)) ?? '')
    return String(agent?.session?.id ?? '')
  }

  async function turnIdOf(agent, exec) {
    if (typeof config.turnIdOf === 'function') return String((await config.turnIdOf(agent, exec)) ?? '')
    return String(exec?.rootCallId ?? '')
  }

  /** 派发正文:只带任务、必要背景与工作目录,不复制整个陪伴聊天。 */
  function buildPrompt(goal, task) {
    if (typeof config.buildPrompt === 'function') return config.buildPrompt(goal, task)
    const lines = [
      '这是一次独立的后台工作会话,只为完成下面这一项任务。',
      '任务:' + goal,
    ]
    if (task.cwd) lines.push('工作目录:' + task.cwd)
    lines.push('不要复述陪伴聊天内容,也不要读写主人的记忆。完成后用一段话给出结果。')
    return lines.join('\n')
  }

  /** 原生子会话的当前状态;查不到返回 undefined,不臆测。 */
  async function childState(subagents, task, signal) {
    if (typeof subagents?.listChildren !== 'function' || !task.parentSessionId) return undefined
    let children
    try {
      children = await subagents.listChildren(task.parentSessionId, signal)
    } catch (error) {
      logger.warn?.('[dsh-companion-memory] 任务子会话列表读取失败:' + error.message)
      return undefined
    }
    const child = (Array.isArray(children) ? children : [])
      .find(item => item?.id === task.childSessionId || item?.childId === task.childSessionId)
    if (!child) return 'gone'
    const state = String(child.status ?? child.state ?? '')
    if (!state) return undefined
    return RUNNING_STATES.has(state) ? 'running' : 'stopped'
  }

  // -- 操作 ------------------------------------------------------------

  async function start(args, exec) {
    const goal = String(args?.goal ?? '').trim()
    if (!goal) {
      return { status: 'invalid', error: 'missing_goal', message: 'start 需要 goal(要做的任务)。' }
    }
    const { agent, subagents } = resolve(exec)
    if (!agent?.session?.id) {
      return { status: 'denied', error: 'no_agent', message: '无法确定调用任务的会话。' }
    }
    if (typeof subagents?.startActivation !== 'function') {
      return {
        status: 'unavailable',
        error: 'execution_unavailable',
        message: '后台执行端(subagents)当前不可用,任务没有创建;普通聊天不受影响。',
      }
    }
    const owner = await ownerOf(agent, exec)
    const qqSessionId = await qqSessionOf(agent, exec)
    const sourceTurnRequestId = await turnIdOf(agent, exec)
    const callId = String(exec?.callId ?? exec?.rootCallId ?? '')
    const key = hash([owner, qqSessionId, sourceTurnRequestId, callId].join('|'))

    // 先落盘:派发中途崩溃时,这条任务仍然查得到。
    const { task, replay } = await store.reserve(key, {
      owner,
      qqSessionId,
      sourceTurnRequestId,
      parentSessionId: agent.session.id,
      cwd: String(config.cwd ?? ''),
    })
    if (replay) {
      // 同一次调用的重放:原样返回原任务,绝不二次派发。
      return { ...describe(task), replay: true }
    }

    const prompt = buildPrompt(goal, task)
    let childId
    try {
      const activation = await subagents.startActivation({
        provider: config.provider ?? 'spawn',
        label: config.label ?? 'companion-task',
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
        },
        signal: exec?.signal,
        delivery: 'parent',
      })
      childId = activation?.childId ?? activation?.id
    } catch (error) {
      const message = error?.message ?? String(error)
      logger.warn?.('[dsh-companion-memory] 任务派发失败 ' + task.taskId + ':' + message)
      const failed = await store.markStatus(task.taskId, 'failed', {
        stopReason: 'dispatch-error',
        summary: '派发失败:' + message,
      })
      return { ...describe(failed ?? task), error: 'dispatch_failed', message: '任务未能派发:' + message }
    }
    if (!childId) {
      const failed = await store.markStatus(task.taskId, 'unknown', {
        stopReason: 'no-child-id',
        summary: '派发返回中没有子会话 id。',
      })
      return { ...describe(failed ?? task), error: 'dispatch_failed', message: '派发返回中没有子会话 id。' }
    }
    const running = await store.markRunning(task.taskId, {
      childSessionId: String(childId),
      cwd: String(config.cwd ?? ''),
    })
    return { ...describe(running ?? task), replay: false }
  }

  async function statusOf(args, exec) {
    const { agent } = resolve(exec)
    if (!agent?.session?.id) {
      return { status: 'denied', error: 'no_agent', message: '无法确定调用任务的会话。' }
    }
    const owner = await ownerOf(agent, exec)
    if (args?.task_id) {
      const task = store.get(String(args.task_id))
      if (!task || task.owner !== owner) {
        // 不区分"不存在"与"不是你的",避免用 task_id 探测别人的任务。
        return { status: 'denied', error: 'not_found', message: '没有属于当前会话的该任务。' }
      }
      return describe(task)
    }
    return {
      status: 'ok',
      tasks: store.listForOwner(owner).slice(0, 10).map(describe),
    }
  }

  async function cancel(args, exec) {
    const taskId = String(args?.task_id ?? '').trim()
    if (!taskId) {
      return { status: 'invalid', error: 'missing_task_id', message: 'cancel 需要 task_id。' }
    }
    const { agent, subagents } = resolve(exec)
    if (!agent?.session?.id) {
      return { status: 'denied', error: 'no_agent', message: '无法确定调用任务的会话。' }
    }
    const owner = await ownerOf(agent, exec)
    const task = store.get(taskId)
    if (!task || task.owner !== owner) {
      return { status: 'denied', error: 'not_found', message: '没有属于当前会话的该任务。' }
    }
    if (TERMINAL.has(task.status)) {
      // 已经结束:如实回报,不谎报"已取消"。
      return { ...describe(task), cancelled: false, message: '任务已经结束(' + task.status + '),没有可停止的执行。' }
    }
    if (!task.childSessionId) {
      return { ...describe(task), cancelled: false, message: '任务还没有派发出子会话,无法取消。' }
    }
    if (typeof subagents?.interrupt !== 'function') {
      return {
        ...describe(task),
        cancelled: false,
        error: 'execution_unavailable',
        message: '执行端当前不可用,未能发出取消;任务状态未变。',
      }
    }
    try {
      // fire-and-return:interrupt 只表示"请求已发出",停了没有要再核对。
      await subagents.interrupt(task.childSessionId, agent)
    } catch (error) {
      return {
        ...describe(task),
        cancelled: false,
        error: 'interrupt_failed',
        message: '取消失败:' + (error?.message ?? String(error)),
      }
    }
    const state = await childState(subagents, task, exec?.signal)
    if (state === 'stopped' || state === 'gone') {
      const settled = await store.markSettled(task.childSessionId, {
        status: 'cancelled',
        stopReason: 'user-cancel',
      })
      return { ...describe(settled ?? task), cancelled: true, message: '任务已停止。' }
    }
    // 核对不到确认:保留真实状态,让下一次 status 再看。
    return {
      ...describe(task),
      cancelled: false,
      message: state === 'running'
        ? '取消已发出,执行端尚未确认停止;稍后用 status 核对。'
        : '取消已发出,但执行端没有提供可核对的子会话状态;稍后用 status 核对。',
    }
  }

  // -- 工具定义 --------------------------------------------------------

  const definitions = [{
    name: 'companion_task',
    description: [
      '在独立后台工作会话里开始/查询/取消一项任务。',
      '只有当用户明确要你做一件需要动手的事(改文件、跑命令、查资料等)时才用 action=start,并把它转成一句具体的 goal;',
      '普通闲聊、问候、情绪回应不要创建任务。',
      'start 返回 task_id 与状态后,本轮可以先回复用户,长任务在后台继续;用 action=status 查询。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'cancel'], description: '要执行的任务操作。' },
        goal: { type: 'string', description: 'start 必填:要完成的任务,一句话说清目标与范围。' },
        task_id: { type: 'string', description: 'status/cancel 指定的任务 id;省略 status 时列出最近任务。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      try {
        if (args?.action === 'start') return await start(args, exec)
        if (args?.action === 'status') return await statusOf(args, exec)
        if (args?.action === 'cancel') return await cancel(args, exec)
        return { status: 'invalid', error: 'unknown_action', message: 'action 只能是 start/status/cancel。' }
      } catch (error) {
        // 任务入口的失败不能让聊天中断。
        logger.warn?.('[dsh-companion-memory] companion_task 失败:' + (error?.message ?? error))
        return { status: 'failed', error: error?.code ?? 'error', message: error?.message ?? String(error) }
      }
    },
    isConcurrencySafe: () => false,
  }]

  // -- 事件 ------------------------------------------------------------

  /**
   * 原生子会话结束:写回终态并排进待通知队列。
   *
   * NOT 在这里注入主会话 —— 接线方用 store.pendingNotifications() 决定注入
   * 时机与形式(有任务来源的外部事件),这样已退役的 Agent 不会被唤醒。
   */
  async function onSubagentEnd(payload, parent) {
    const childId = String(payload?.id ?? payload?.childId ?? '')
    if (!childId) return undefined
    const task = store.findByChild(childId)
    if (!task) return undefined
    if (TERMINAL.has(task.status)) return task
    const status = STOP_STATUS[payload?.stopReason] ?? 'unknown'
    const summary = textOf(payload?.lastAssistantMessage).trim()
    const settled = await store.markSettled(childId, {
      status,
      stopReason: String(payload?.stopReason ?? ''),
      summary: summary.slice(0, 2000),
      resultRef: childId,
    })
    if (settled) {
      logger.info?.('[dsh-companion-memory] 任务 ' + settled.taskId + ' 结束:' + settled.status)
    }
    return settled
  }

  /**
   * 主会话 Agent 销毁。
   *
   * 任务本身不因父会话销毁而终止(执行端还在跑),这里只记下"这个父会话已经
   * 不在了",并返回该会话名下仍未通知的任务,让接线方决定投递给哪个当前有效
   * 会话,而不是唤醒已退役的 Agent。
   */
  const disposedSessions = new Set()
  function onAgentDisposed(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId) return []
    disposedSessions.add(sessionId)
    return store.pendingNotifications().filter(task => task.parentSessionId === sessionId)
  }

  function status() {
    const tasks = Object.values(store.state?.tasks ?? {})
    const counts = {}
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
    return {
      total: tasks.length,
      by_status: counts,
      pending_notifications: store.pendingNotifications().length,
      open_error: store.openError ?? null,
      disposed_sessions: disposedSessions.size,
    }
  }

  return { definitions, onSubagentEnd, onAgentDisposed, status }
}

export { TERMINAL, STOP_STATUS }
