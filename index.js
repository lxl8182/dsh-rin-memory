/**
 * DSH 记忆插件:把 rin-memory 的唯一人格与长期记忆接到目标会话上。
 *
 * 分工:
 * - DSH 负责回复、工具、权限与执行过程;
 * - QQ bridge 负责收发、身份校验与会话映射;
 * - rin-memory 是人格卡、发布版本、事实、召回、更正与删除的唯一权威;
 * - 本插件只做衔接:取快照、注入、保存真实轮次、处理更正/遗忘、补交与状态。
 *
 * 生命周期全部走作用域订阅:启动、热启用、Agent 创建/销毁与卸载都登记在同一
 * 个 fiber 上,重复启停不会重复监听、重复回复或重复提交。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  MemoryClient, buildSourceKey, charCount, classifyTransportError, messageText,
  sessionScopeId, stableHash, contextReferences,
} from './memory-client.js'
import { configProblems, normalizeConfig } from './config.js'
import { randomUUID } from 'node:crypto'
import { ProactiveRuntime, PROACTIVE_SOURCE } from './proactive.js'
import {
  SEGMENT_DEFAULTS, SegmentStore, deleteSessionDirectory, listSessionDirectories, renderCarry,
} from './session-store.js'
import { MATERIAL_NOTE, MainSessionScope } from './main-session.js'
import { readSpell, spellToGoal } from './magic-tools.js'
import { renderFeedback } from './magic.js'
import { TaskStore } from './task-store.js'
import { createTaskTools } from './task-tools.js'
import { SpellRunner, SPELL_SOURCE, startWorker } from './spell-runner.js'
import { SpellLibrary, META_SPELLS, parseSolved } from './spell-library.js'

export const name = 'dsh-rin-memory'
export const inject = ['systemPrompt', 'profileContext']

/**
 * Runtime config for the Host and the settings page.
 *
 * A plain schema import here would make this module fail to load in the profile
 * when schemastery is absent; the Host resolves peers from its own tree, so the
 * declaration is a peer and this import is the same object the settings page
 * reads. See `schema.js` for the fields.
 */
export { default as Config } from './schema.js'

/** QQ bridge 发布轮次事实的服务名;缺省时插件只做 DSH 侧注入与保存。 */
const BRIDGE_EVENTS_SERVICE = 'qqBridgeEvents'

/**
 * 本插件对外发布的段端口服务名。
 *
 * 方向与 `qqBridgeEvents` 相反:那份事实由桥接发布、本插件订阅;分段判定由本
 * 插件发布、桥接安装到 executor 上。取不到时桥接完全退回原行为。
 */
const SEGMENT_POLICY_SERVICE = 'companionSegmentPolicy'

/** 注入消息的来源标记,供去重与“谁是资料”判断使用。 */
const MEMORY_SOURCE = 'rin-memory'

/** 后台任务结果的来源标记:既不是用户发言,也不是记忆资料。 */
const TASK_SOURCE = 'companion-task'

/**
 * 跨段带入历史的来源标记。
 *
 * 它既不是主人这一次说的话,也不是记忆材料,更不是后台任务的产物:它是**已经
 * 发生过的对话**被带进了新的一段。单独一个来源,保存、召回与去重才分得清。
 */
const SEGMENT_SOURCE = 'segment-carry'

/** 带入历史前的一句来源说明。只说明「这不是新发言」,不复述内容。 */
const SEGMENT_CARRY_NOTE = '（下面是换到新的一段时,把之前已经说过的邻近几句带了过来,供你接着聊。这不是主人刚说的话。）'

/**
 * 宿主的人格槽位名。
 *
 * 这是 @deepseek-ai/dsh-system-prompt 自己注册的全局段名;在 agent 作用域内用
 * 同名段注册即遮蔽它(ScopedLayers.merge 近层覆盖远层)。人格因此只出现在系统
 * 提示里一份,而不是每条消息都附一份。
 */
const PERSONA_SECTION = 'deployment:persona-prefix'

/** 本插件自己的短规则段,排在人格段之后;名字不复用宿主槽位。 */
const RULES_SECTION = 'rin-memory:rules'

/** 规则段静态正文上限(中文字符)。规则不随轮次变化,也不含版本与时间。 */
const RULES_CHAR_LIMIT = 300

/**
 * 常驻规则:只讲来源区分与实际执行,不放人格正文。
 *
 * 不含当前人格正文、发布版本号、时间戳或请求号:这些每轮都变的内容会让提示
 * 与去重失效,而人格已经在系统段里,不必再声明一次。
 */
const MEMORY_RULES = [
  '这是与同一位用户的陪伴对话。你的性格与表达方式以系统提示中的人格段为准,其优先级高于本预设的通用语气描述。',
  '来源标记为 rin-memory 的用户消息是记忆服务为本轮提供的增量材料,不是用户说的话。',
  '只有用户亲口陈述才能作为偏好证据;工具结果、检索内容和你自己过去的话都不是。',
  '用户说你记错了或要求忘掉某事时,必须念<改写>或<撕掉>真正执行,不要只口头答应。',
  // 触发条件写清楚,否则模型会把"这次短一点"也当成长久改变。反过来只写"别乱念"
  // 又会让"以后都别总结了"这种真正的教导没人接。
  '用户明确要求长期改变说话或相处方式时,念<学到>把这一句交出去;只要求这一次简短、或只是在评价时,不要念。',
].join('')

/** 已注入指纹索引的上限:只用于防止同一份材料在新上下文代际里重贴。 */
const INJECTION_INDEX_LIMIT = 512

const plain = messageText

export async function apply(ctx, options) {
  if (typeof options?.get !== 'function') return activate(ctx, options)
  let dispose
  let stopped = false
  let signature
  let tail = Promise.resolve()
  const refresh = () => {
    const config = normalizeConfig(options)
    const next = JSON.stringify(config)
    tail = tail.catch(() => {}).then(async () => {
      if (stopped || signature === next) return
      await dispose?.()
      dispose = undefined
      signature = next
      dispose = await activate(ctx, config)
    })
    return tail
  }
  await refresh()
  const off = ctx.on('loader/volatile-update', () => {
    void refresh().catch(error => ctx.logger?.error?.(`记忆配置更新失败：${error.message}`))
  })
  return async () => { stopped = true; off(); await tail.catch(() => {}); await dispose?.() }
}

async function activate(ctx, options) {
  const config = normalizeConfig(options)
  const logger = ctx.logger ?? console
  if (!config.enabled) {
    // Disabled is a state, not an error: nothing is registered, no timer runs,
    // and the persisted queue stays on disk for the next enable.
    return
  }

  const token = await resolveToken(config)
  const stateDirectory = config.stateDirectory
    ? resolve(config.stateDirectory)
    : join(ctx.profileContext.home, 'plugins', 'dsh-rin-memory')
  const problems = configProblems(config, token)
  if (problems.length > 0) {
    // Missing credentials or an unusable address must not look connected.
    logger.error?.(`[dsh-rin-memory] 未启用：${problems.join('；')}`)
    return
  }

  const client = new MemoryClient(config, token, {
    statePath: join(stateDirectory, 'outbox.json'),
    logger,
  })
  await client.open()

  const runtime = new MemoryRuntime(ctx, config, client, logger)
  await runtime.start()
  // 把分段能力发布成桥接层可直接安装的段端口。
  //
  // 走宿主既有的服务出口而不是新增一条私有通道:桥接插件与记忆插件由宿主按
  // 各自顺序启用,谁先谁后都不确定,所以端口必须能在任意时刻被取到、并且缺了
  // 也不影响对方 —— 与 `qqBridgeEvents` 的方向正好相反,这里是记忆插件对外
  // 提供、桥接插件取用。
  const publishSegment = typeof ctx.provide === 'function'
    ? ctx.provide(SEGMENT_POLICY_SERVICE, segmentPolicyFor(runtime))
    : undefined

  const timer = setInterval(() => { void runtime.tick() }, Math.max(1000, config.retryIntervalMs))
  timer.unref?.()

  return async () => {
    clearInterval(timer)
    try { publishSegment?.() } catch { /* disposal is best effort */ }
    await runtime.stop()
  }
}

/** 凭据:环境变量优先,其次服务端受限令牌文件里同名键。 */
async function resolveToken(config) {
  const fromEnv = config.tokenEnv ? process.env[config.tokenEnv] : undefined
  if (fromEnv) return fromEnv
  if (!config.tokenFile) return undefined
  try {
    const tokens = JSON.parse(await readFile(resolve(config.tokenFile), 'utf8'))
    const value = tokens?.[config.tokenEnv]
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 一轮的固定快照。
 *
 * 同一轮里的多次工具调用共享它;新的发布只影响下一轮。`prepared` 里同时保存
 * 了可重放的提交请求体与**不落盘**的注入正文,二者不能混用。
 */
class MemoryRuntime {
  constructor(ctx, config, client, logger) {
    this.ctx = ctx
    this.config = config
    this.client = client
    this.logger = logger
    this.attached = new Map()
    this.spellScopes = new Map()
    this.turns = new Map()
    this.bridge = null
    this.bridgeSubscription = null
    this.proactive = new ProactiveRuntime(this)
    this.disposers = []
    this.stopped = false
    // DSH 把会话日志放在 home 下的 sessions/ 里;清理正文时必须指向同一处。
    this.sessionsRoot = config.sessionsDirectory
      ? resolve(config.sessionsDirectory)
      : join(ctx.profileContext.home, 'sessions')
    // The one place a person can look to answer "is it connected, which
    // persona did it adopt, how much is unsaved".
    this.statusPath = join(
      config.stateDirectory ? resolve(config.stateDirectory) : join(ctx.profileContext.home, 'plugins', 'dsh-rin-memory'),
      'status.json',
    )
    this.health = {
      state: 'starting',
      detail: '',
      persona_version: '',
      updated_at: new Date().toISOString(),
    }
    this.toolDisposers = []
    this.candidates = new Map()
    this.admissions = new Map()
    this.bridgeTails = new Map()
    // 每个会话在系统段里使用的人格正文:装配时由 provider 读取,所以这里只保存
    // 最近一次真实采用过的已发布全文。空串时该段被宿主丢弃(不会渲染成空块)。
    this.personas = new Map()
    this.contactTimes = new Map()
    this.contactSources = new Map()
    // 任务台账:只记"派发过什么、到哪一步、通知过没有"。执行在原生后台会话。
    this.taskStore = null
    this.taskTools = null
    // 最近一次真正处理过轮次的 agent:咒语派活时用它确定归属会话。
    this.currentAgent = null
    // 正在学、还没学完的咒语,按会话记着;会话销毁时一并作废。
    this.pendingLearnings = new Map()
    // 工作会话的落脚目录:和插件数据放在一起,不占用 QQ 聊天的 cwd。
    this.workspaceDirectory = join(dirname(this.statusPath), 'workspace')
    // 上下文分段(RO02-CTX):状态与清理状态放在同一个插件数据目录,因为它记的
    // 是「哪个 DSH 会话是当前段」—— 与清理同属本地桥接事实。
    this.segments = new SegmentStore({
      statePath: join(dirname(this.statusPath), 'segments.json'),
      limits: config.segment ?? SEGMENT_DEFAULTS,
      logger,
    })
    // 新段第一次请求要带进去的旧话,按 QQ 来源键暂存到真正用掉为止。
    this.segmentCarry = new Map()
    this.spellLibrary = new SpellLibrary({ statePath: join(dirname(this.statusPath), 'spells.json') })
    this.spellRunner = new SpellRunner({
      logger,
      runSpell: (cast, agent, signal) => this.runSpell(cast, agent, signal),
      learnedNames: () => [...META_SPELLS, ...this.spellLibrary.list().map(spell => spell.name)],
      isActive: agent => !this.stopped && this.spellScopes.has(agent) && this.isSpellSession(agent)
        && !this.client.isRetired(agent.session.id),
      // 主会话已经走开(超时/销毁)时,结果不能就这么没了:改成主动发到 QQ。
      onAbandoned: (agent, results) => this.pushSpellResults(agent, results),
    })
  }

  async start() {
    this.logger.info?.(`[dsh-rin-memory] 正在连接 ${this.config.url}（${this.config.characterId}/${this.config.subject}）`)
    // Connection is verified before any turn can depend on it, but a failure
    // here leaves the plugin mounted so the reason stays visible in status
    // instead of the Host silently dropping it.
    await this.probe().catch(() => {})
    // 段状态必须先于任何一轮打开:换过段却没恢复,下一轮会再换一次、连丢两段。
    await this.segments.open()
    await this.spellLibrary.open()
    // 工作会话的目录要先存在,否则 agents.create 拿不到有效 cwd。
    await mkdir(this.workspaceDirectory, { recursive: true }).catch(error => {
      this.logger.warn?.(`[dsh-rin-memory] 工作目录创建失败：${error.message}`)
    })
    this.subscribeBridge()
    await this.openTasks()
    this.disposers.push(this.ctx.on('agent/created', ({ agent }) => this.observeAgent(agent)))
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      this.proactive.event(session, event)
      if (event.type !== 'agent-preset/selected') return
      const agent = this.candidates.get(session.id)
      if (!agent) return
      if (this.isSpellSession(agent)) this.attachSpells(agent)
      else this.detachSpells(agent)
    }))
    this.disposers.push(this.ctx.on('agent/disposed', ({ agent }) => {
      this.candidates.delete(agent?.session?.id)
      this.detach(agent)
      this.taskTools?.onAgentDisposed(agent)
    }))
    const agents = this.ctx.get ? (this.ctx.get('agents') ?? this.ctx.get('agentLoop')) : this.ctx.agents
    for (const agent of agents?.list?.() ?? []) this.observeAgent(agent)
    // The first tick settles startup recovery: flush the queue, then process
    // cleanup before anything else, so a deletion cannot be bypassed by a
    // replayed body from before the restart.
    await this.tick()
    await this.publishStatus()
  }

  /**
   * 打开任务台账,并把上次没结束的任务收敛成"不再重做"。
   *
   * 这一步必须在任何一轮开始之前完成:台账里 running 却没有终态的任务说明
   * 进程在派发中途退出了,重做它可能让已经生效的文件/命令再跑一遍。收敛只
   * 标状态,不重新派发,也不猜它做过什么。
   */
  async openTasks() {
    const statePath = join(dirname(this.statusPath), 'tasks.json')
    this.taskStore = new TaskStore({ statePath, logger: this.logger })
    try {
      await this.taskStore.open()
    } catch (error) {
      // A damaged ledger must not take chat down; it stays on disk for repair.
      this.logger.warn?.(`[dsh-rin-memory] 任务台账无法读取,本轮不接任务入口：${error.message}`)
      this.taskStore = null
      return
    }
    const recovered = await this.taskStore.recover()
    if (recovered.length > 0) {
      this.logger.info?.(`[dsh-rin-memory] 收敛 ${recovered.length} 个中断任务（不重新执行）`)
    }
    this.taskTools = createTaskTools({
      store: this.taskStore,
      logger: this.logger,
      config: {
        owner: undefined,
        ownerOf: agent => agent?.session?.id ?? '',
        qqSessionOf: agent => agent?.session?.id ?? '',
        turnIdOf: (agent, exec) => this.turns.get(agent)?.requestId ?? exec?.callId ?? '',
        provider: 'spawn',
        label: 'companion-task',
      },
    })
    // 原生子会话结束:只写终态并排队,由主会话在自己的 pre-step 里投递。
    this.disposers.push(this.ctx.on('subagent/end', payload => {
      void this.taskTools?.onSubagentEnd(payload).catch(error =>
        this.logger.warn?.(`[dsh-rin-memory] 任务终态写回失败：${error.message}`))
    }))
  }

  /**
   * 六个咒语的真正实现。
   *
   * 前三个动外面的世界:<读取> 直接读盘(单人自用,不做白名单);<生成>/<执行>
   * 一律派给独立的后台工作会话——不在 QQ 主会话进程里起 shell,写错也炸不到
   * 聊天本身。companion_task 仍使用自己的 TaskStore 与原生子会话。
   *
   * 后三个动记忆本:<翻本子>/<改写>/<撕掉> 直接调核心服务。这三条不能省——
   * 注入与召回是程序自动做的,但"你记错了""忘掉这个"必须由模型当场发起,
   * 否则它只能口头答应,服务里的条目一条没动。
   */
  spellHandlers(agent = this.currentAgent, signal) {
    return {
      读取: async body => await readSpell(body, { cwd: agent?.session.header?.cwd ?? process.cwd() }),
      执行: async body => await this.dispatchSpellTask('执行', body, agent, signal),
      翻本子: async body => await this.spellRecall(body, agent),
      改写: async body => await this.spellCorrect(body, agent),
      撕掉: async body => await this.spellForget(body, agent),
      学到: async body => await this.spellTeach(body, agent),
    }
  }

  async runSpell(cast, agent, signal) {
    if (!this.spellScopes.has(agent) || !this.isSpellSession(agent)) throw new Error('当前会话没有接入咒语执行器。')
    if (this.client.isRetired(agent.session.id)) throw new Error('原会话已清理，等新会话。')
    const execute = expanded => this.spellHandlers(agent, signal)[expanded.spell](expanded.body)
    // 学咒语是异步的:先做能立刻判定的校验立刻回话,慢的那半边(装东西、写脚本、
    // 反复试)交给工作会话在后台跑,跑完再补一条结果。同步等会逼模型自己编
    // 「终端反馈」—— 实测发生过。
    if (cast.spell === '学咒语') return this.startLearning(cast.body, execute, agent, signal)
    if (cast.spell === '忘掉咒语') return this.spellLibrary.forget(cast.body)
    return execute(this.spellLibrary.expand(cast))
  }

  /**
   * 异步学咒语:先回一句"记下了",慢活交给后台。
   *
   * 为什么要拆:学一项新本事常要装包、写脚本、反复试,几分钟到十几分钟。
   * 让主会话同步等,模型看不到反馈就会自己编「终端反馈:学会啦」——已实测
   * 出现过。所以这里只做立刻能判定的事(名字、重名、上限),其余放到后台,
   * 完成后再用 followup 补一条新消息。
   */
  async startLearning(body, execute, agent, signal) {
    const spell = this.spellLibrary.check(body)
    const sessionId = agent.session.id
    const learning = this.spellLibrary.finish(spell, execute, signal,
      (wanted, trialError) => this.workOutSpell(wanted, trialError, agent, signal))
    this.pendingLearnings.set(sessionId, learning)
    learning
      .then(result => this.reportLearning(agent, result))
      .catch(error => this.reportLearning(agent, null, error))
      .finally(() => {
        if (this.pendingLearnings.get(sessionId) === learning) this.pendingLearnings.delete(sessionId)
      })
    return `记下了,「${spell.name}」这就去学。${spell.note ? `要它做到的是:${spell.note}。` : ""}学好了再跟你说一声。`
  }

  /** 学成或学败,都以一条有来源标记的外部事件补回主会话。 */
  async reportLearning(agent, result, error) {
    const text = error
      ? `【终端反馈·学咒语】没学成:${error.message ?? error}`
      : `【终端反馈·学咒语】${result}`
    this.logger.info?.("[dsh-rin-memory] " + text)
    try {
      if (this.spellScopes.has(agent) && this.isSpellSession(agent)) {
        agent.followup({ id: `learn:${randomUUID()}`, role: "user",
          source: { kind: SPELL_SOURCE }, content: [{ type: "text", text }] })
        return
      }
    } catch (cause) {
      this.logger.warn?.("[dsh-rin-memory] 学咒语回填失败:" + (cause?.message ?? cause))
    }
    await this.proactive.offerTaskResult(agent.session.id, text)
  }

  /**
   * 咒语作用在哪个会话上。
   *
   * 咒语写在模型的回复里,归属就是当前正在跑的这一轮;所以这里只接受已校验的
   * 主人私聊,别的会话即便念出同样的咒语也拿不到个人记忆。
   */
  spellSession(agent = this.currentAgent) {
    const sessionId = agent?.session?.id
    if (!sessionId) throw new Error('现在没有可以记账的会话。')
    if (!this.isTrusted(agent)) throw new Error('这个会话没有个人记忆权限。')
    if (this.client.isRetired(sessionId)) throw new Error('原会话已清理,等新会话。')
    return sessionId
  }

  /** <翻本子>:列出服务里记着的条目,只读。 */
  async spellRecall(body, agent) {
    this.spellSession(agent)
    const result = await this.client.entries(String(body ?? '').trim())
    const items = (result.items ?? []).slice(0, 20)
    if (items.length === 0) return '本子上还没写什么。'
    return items.map(row => {
      const kind = row.type === 'reflection' ? '想法' : '事'
      return `[${kind}] ${String(row.text ?? '').trim()}${row.id ? ` (${row.id})` : ''}`
    }).join('\n')
  }

  /** <改写>旧 ||| 新:真的把服务里那条改过来。 */
  async spellCorrect(body, agent) {
    const sessionId = this.spellSession(agent)
    const parts = String(body ?? '').split('|||')
    if (parts.length < 2) throw new Error('要写成"旧内容 ||| 正确内容"。')
    const oldText = parts[0].trim()
    const newText = parts.slice(1).join('|||').trim()
    if (!oldText || !newText) throw new Error('旧内容和新内容都要写。')
    const requestId = `corr_${stableHash(`${sessionId}:${oldText}:${newText}`)}`
    const receipt = await this.client.correct({ old_text: oldText, new_text: newText, request_id: requestId })
    return receipt.applied
      ? `已经改过来了。${receipt.invalidated_fact_ids?.length ? `顺带作废了 ${receipt.invalidated_fact_ids.length} 条旧记录。` : ''}`
      : `没改成(${receipt.status ?? '未知原因'})。`
  }

  /**
   * <学到>:把**本轮主人那句话**作为明确教导交出去,由服务端读原文派生规则。
   *
   * 安全底线三条,缺一不可:
   * 1. 客户端只传 source_key —— 本轮 requestId 对应的那个,规则正文一个字都
   *    不送;服务端拿自己的 journal/recent 原文去派生(设计 §8.5)。
   * 2. 关键词正文(<学到>后面写什么)只用来指定"学哪一个",不作为规则来源:
   *    如果主人授权学另一个 bot 的表达方式,正文里的那个 bot 名字/消息 id 会被
   *    当作示例来源,发给服务端的同样只有 key(设计 §8.3)。
   * 3. 直接生效,不设 pending 确认(用户 2026-10-27 拍板):教导本身就是主人的
   *    明确指令,再问一次是多余的。身份段仍然冻结,这一点由服务端保证。
   *
   * 失败一律如实回报:403 没有能力、404 来源没保存、409 卡被改过、422 判定不是
   * 教导(只是评价或只想要这一次)、transient 不落盘 —— 一个都不许吞成"学好了"。
   */
  async spellTeach(body, agent) {
    const sessionId = this.spellSession(agent)
    const turn = this.turns.get(agent)
    if (!turn?.requestId) {
      // 没有在跑的一轮就没有"本轮那句话":宁可如实说不知道学什么,也不猜一条。
      throw new Error('眼下这一轮还没登记，不知道要学哪句话；等主人说完这一句再念。')
    }
    if (this.client.isRetired(sessionId)) throw new Error('原会话已清理，等新会话。')
    const scopeId = sessionScopeId(sessionId)
    const sourceKey = buildSourceKey(
      this.config.pluginId, this.config.characterId, this.config.subject,
      scopeId, turn.requestId,
    )
    // 卡修订号来自本轮真正采用的那份上下文;没取到就不编一个 —— 编出来的 CAS
    // 依据要么必然冲突,要么让服务端以为调用方看过一张它没看过的卡。修订号 0
    // 表示这张卡还没建立,没有可供比较的依据,教导本来就无从落地。
    const baseRevision = Number(turn.prepared?.body?.card_revision)
    if (!Number.isInteger(baseRevision) || baseRevision <= 0) {
      throw new Error('这一轮没有可用的人格卡修订号（卡可能还没建立），现在教不了。')
    }
    // 示例来源(学另一个 bot):正文写的是那条已保存消息的来源键或关键词,只把
    // key 发出去;服务端会自己核对它确实是一条已保存的用户消息。
    const exampleKey = this.teachExampleKey(body, scopeId)
    try {
      const receipt = await this.client.teach({
        sourceKey,
        baseRevision,
        quotedExampleKey: exampleKey,
        scene: `plugin:${this.config.pluginId}`,
        sessionId: scopeId,
      })
      return this.describeTeaching(receipt, { example: Boolean(exampleKey) })
    } catch (error) {
      throw new Error(this.describeTeachingFailure(error))
    }
  }

  /**
   * 从咒语正文里取示例来源键。
   *
   * 只认**看起来是来源键**的那一段(包含 ':' 且不是自然语言句子);其余正文一律
   * 丢弃 —— 它可能是主人对那个 bot 的描述,那些字不是已保存消息,不能当示例。
   */
  teachExampleKey(body, scopeId) {
    const text = String(body ?? '').trim()
    if (!text) return ''
    // 允许直接写一个完整来源键,或写"示例:<key>"。两种都只取 key。
    const candidate = text.replace(/^示例[:：]\s*/, '').trim()
    if (!candidate || /\s/.test(candidate) || !candidate.includes(':')) return ''
    // 服务端按 plugin:<plugin>:<character>:<subject>:<session>:<event> 解析;
    // 形状不对就当作"没有可用的已保存示例",不当成 key 发出去。
    const parts = candidate.split(':')
    if (parts.length !== 6 || parts[0] !== 'plugin') return ''
    return candidate
  }

  /** 把服务的教导回执说成人话;status 为 transient 时明确说明这次不长久。 */
  describeTeaching(receipt, { example = false } = {}) {
    const status = String(receipt?.status ?? '')
    if (status === 'transient') {
      return '这条只是这一次的要求，我已经照做了，但没写进长期的习惯里。'
    }
    const rules = (receipt?.rules ?? [])
      .map(rule => String(rule?.text ?? '').trim())
      .filter(Boolean)
    const learned = rules.length > 0
      ? `记下了：${rules.join('；')}`
      : '记下这一条了。'
    const version = receipt?.published_version ? `（已发布 ${receipt.published_version}）` : ''
    const again = receipt?.duplicate ? '这条之前就学过，没有重复记。' : ''
    const exampleNote = example ? '示例只当引子，不会照抄它说的话。' : ''
    return [again || learned + version, exampleNote].filter(Boolean).join('')
  }

  /**
   * 教导失败的可读原因。
   *
   * 404/409/422/403 都是**主人的问题或状态问题**,说得越具体越有用;transient
   * 类的失败(连不上、忙)要明说没保存,不能让人以为已经长期生效了。
   */
  describeTeachingFailure(error) {
    const status = Number(error?.status ?? 0)
    const code = String(error?.code ?? '')
    if (status === 403 || code === 'forbidden') {
      return '服务没有给我教导人格的权限（persona_teach），这次没学成。'
    }
    if (status === 404 || code === 'not_found') {
      return '服务那边找不到这句话的存档，没法拿它当依据；这次没学成。'
    }
    if (status === 409 || code === 'revision_conflict') {
      return '人格卡刚被别人改过，我拿到的是旧版本；这次没学成，等下再说一遍。'
    }
    if (status === 410 || code === 'deleted') {
      return '那句话已经被删掉了，不能拿它来教；这次没学成。'
    }
    if (status === 422 || code === 'rejected') {
      const reason = String(error?.extra?.reason ?? '')
      if (reason === 'not_a_style_teaching') {
        return '这句听起来不像要我长期改说话方式，我没当成教导记下来。'
      }
      if (reason === 'revocation_requested') {
        return '这句是让我别学它，得用别的办法撤回，不算一次教导。'
      }
      if (reason === 'section_frozen' || reason === 'expression_section_frozen') {
        return '表达那一段被人格卡锁住了，现在改不了；这次没学成。'
      }
      return '服务判定这句不构成教导，没记下来。'
    }
    const kind = error?.kind ?? 'fatal'
    if (kind === 'retry' || kind === 'config') {
      return `没连上记忆服务（${describeFailure(error)}），这次没学成，也没写盘。`
    }
    return `没学成：${error?.message ?? '未知原因'}`
  }

  /** <撕掉>:真的删,不是嘴上答应。匹配到多条就退回候选,不自己挑。 */
  async spellForget(body, agent) {
    this.spellSession(agent)
    const text = String(body ?? '').trim()
    if (!text) throw new Error('要忘掉的是哪件事?')
    try {
      const receipt = await this.client.forget({ text })
      return `已经撕掉了(${receipt.deletion_id ?? '已删除'})。`
    } catch (error) {
      if (error.code === 'ambiguous_target') {
        const rows = (error.extra?.candidates ?? []).slice(0, 5)
        return `本子上有好几条都像,是哪一条?\n${rows.map(r => `- ${r.text} (${r.id})`).join('\n')}`
      }
      if (error.code === 'not_found') return '本子上没找到这件事。'
      throw error
    }
  }

  /**
   * 咒语派给无 preset 的标准 agent；等真实结果后由 SpellRunner 回填。
   */
  async dispatchSpellTask(spell, body, agent, signal) {
    const goal = spellToGoal(spell, body)
    const route = agent.session.requestHeader?.()?.config ?? agent.options
    // 工作会话落在自己的目录里,不跟 QQ 聊天共用 —— 它翻乱了也只脏自己的地方。
    return await startWorker(this.ctx, {
      prompt: `完成下面的任务并返回实际结果；失败时说明具体原因。不得修改主插件源码目录 ${resolve(import.meta.dirname)}。\n\n${goal}`,
      provider: route?.provider, model: route?.model,
      cwd: this.workspaceDirectory, signal,
    })
  }

  /**
   * 主会话没等到结果时,把咒语的真实结果主动发到 QQ。
   *
   * 走桥接自己已有的主动发送能力(它对管理员私聊发过"您收到一条Agent回复");
   * 桥接不在、或没有管理员目标时降级成一条日志,不假装送达。
   */
  async pushSpellResults(agent, results) {
    const text = results.map(result => renderFeedback(result.cast, result)).join('\n\n')
    await this.proactive.offerTaskResult(agent.session.id, text)
  }

  /**
   * 让工作会话把一项本事做到能跑,并回报一条可直接存成咒语的做法。
   *
   * 主会话里模型不知道 TTS 要装什么、B 站数据怎么取,让它猜模板是瞎猜;
   * 工作会话有全套工具,能查、能装、能反复试。这里只负责把要求说清楚,
   * 并规定它必须把结论写成一行 —— 解析只认那一行,不认它的叙述。
   */
  async workOutSpell({ name, note }, trialError, agent, signal) {
    const route = agent.session.requestHeader?.()?.config ?? agent.options
    const text = await startWorker(this.ctx, {
      prompt: [
        `主人想让你学会一项本事,以后用一个咒语就能重复用。名字叫「${name}」${note ? `,用途是:${note}` : ''}。`,
        trialError ? `先前试过一版没跑通:${trialError.message}。` : '',
        '在这台机器上真的把它做通:需要装什么就装,需要写脚本就写,反复试到确实能跑为止。',
        '做完之后在最后单独写一行,格式严格如下(一行,用 ||| 分隔):',
        '【咒语】执行 ||| 能重复运行的那条命令,把"每次会变的那段"写成 {body}',
        '或者',
        '【咒语】读取 ||| 要读的路径,把"每次会变的那段"写成 {body}',
        '如果这件事根本没法做成一条固定命令,就写:【咒语】做不成 和一句原因。',
        '不要修改主插件源码目录 ' + resolve(import.meta.dirname) + '。',
      ].filter(Boolean).join('\n'),
      provider: route?.provider, model: route?.model,
      cwd: this.workspaceDirectory, signal,
    })
    if (/【咒语】\s*做不成/.test(text)) {
      const reason = text.slice(text.indexOf('【咒语】') + 5).replace(/^\s*做不成\s*/, '').split('\n')[0].trim()
      throw new Error(`工作会话判断这件事做不成${reason ? `：${reason}` : ''}。`)
    }
    return parseSolved(text)
  }

  /**
   * 把后台任务的终态作为一条**有来源标记**的外部事件交给主会话。
   *
   * 它既不是用户说的话也不是记忆资料:来源标记写成 task,渲染时明确说明这是
   * 后台任务的结果。每次只投一次——投递成功才 markNotified,崩溃重来不会把
   * 同一个结果说两遍。
   */
  pendingTaskNotices(agent) {
    if (!this.taskStore || !this.taskTools) return []
    const sessionId = agent?.session?.id
    if (!sessionId) return []
    return this.taskStore.pendingNotifications().filter(task => task.parentSessionId === sessionId)
  }

  taskNoticeText(task) {
    const status = task.status === 'completed' ? '已完成' : (task.status === 'cancelled' ? '已取消' : '未成功')
    const summary = String(task.resultSummary ?? '').trim()
    return summary
      ? `[后台任务 ${status}] ${summary}`
      : `[后台任务 ${status}] 任务 ${task.taskId} 结束,没有返回文字结果。`
  }

  /**
   * 把状态写成一个只读文件,供验收与排障直接核对。
   *
   * DSH 没有给插件通用的“状态面板”,而用户要能回答三个具体问题:连上没有、
   * 采用哪个人格版本、有多少轮还没保存。写在插件数据目录里,既不改宿主界面,
   * 也不需要额外服务;内容不含凭据、人格正文或对话正文。
   */
  async publishStatus() {
    if (!this.statusPath) return
    try {
      const payload = { ...this.status(), written_at: new Date().toISOString() }
      const temporary = `${this.statusPath}.${process.pid}.tmp`
      await mkdir(dirname(this.statusPath), { recursive: true })
      await writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 })
      await rename(temporary, this.statusPath)
    } catch (error) {
      this.logger.warn?.(`[dsh-rin-memory] 状态写入失败：${error.message}`)
    }
  }

  async stop() {
    this.proactive.stop()
    this.stopped = true
    for (const run of this.proactive.active.values()) run.finishOutput?.()
    this.pendingLearnings.clear()
    await this.spellRunner.dispose()
    await this.bridgeSubscription?.dispose?.()
    this.bridgeSubscription = null
    for (const dispose of this.toolDisposers.splice(0)) {
      try { await dispose?.() } catch { /* disposal is best effort */ }
    }
    for (const dispose of this.disposers.splice(0)) {
      try { dispose?.() } catch { /* disposal is best effort */ }
    }
    for (const attach of this.attached.values()) {
      try { attach.dispose?.() } catch { /* disposal is best effort */ }
    }
    this.attached.clear()
    for (const agent of [...this.spellScopes.keys()]) this.detachSpells(agent)
    this.turns.clear()
    this.candidates.clear()
    this.admissions.clear()
    this.personas.clear()
    // The queue stays on disk: the next enable resumes from the same place.
    await this.ticking?.catch(() => {})
    await Promise.allSettled([...this.bridgeTails.values()])
    await this.proactive.tail.catch(() => {})
    await this.client.tail.catch(() => {})
  }

  // -- connection ------------------------------------------------------

  async probe() {
    try {
      const health = await this.client.request('/v1/health', {}, 'GET')
      // Health alone answers "is the service reachable and is its storage
      // ready". A context read here would mint an unused receipt on every
      // startup and every retry, so the persona version is learned from the
      // first real turn instead.
      this.health = {
        state: 'connected',
        detail: '',
        persona_version: this.health.persona_version,
        storage: health.storage?.status ?? '',
        chat: health.chat?.status ?? '',
        updated_at: new Date().toISOString(),
      }
      return health
    } catch (error) {
      const classified = error.kind ? error : classifyTransportError(error)
      this.health = {
        state: classified.kind === 'config' ? 'rejected' : 'disconnected',
        detail: describeFailure(classified),
        persona_version: '',
        updated_at: new Date().toISOString(),
      }
      throw error
    }
  }

  async tick() {
    if (this.stopped) return
    if (this.ticking) return this.ticking
    this.ticking = this.runTick().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  async runTick() {
    try {
      const pending = await this.client.releaseCleanup()
      if (pending.length > 0) {
        await this.handleCleanup(pending)
        return
      }
      // Hand the answer we just got to the flush: it must not ask the same
      // question again on every tick.
      await this.client.flush(pending)
      if (this.health.state !== 'connected') await this.probe()
      else this.health.state = 'connected'
    } catch (error) {
      const kind = error.kind ?? classifyTransportError(error).kind
      this.health = {
        ...this.health,
        state: kind === 'cleanup' ? 'cleanup-pending' : (kind === 'config' ? 'rejected' : 'disconnected'),
        detail: error.deletions ? `待清理：${error.deletions.join(', ')}` : describeFailure(error),
        updated_at: new Date().toISOString(),
      }
    }
    await this.proactive.tick()
    await this.publishStatus()
  }

  /**
   * 清理待办:先真正删掉本地正文,再逐项确认。
   *
   * 顺序不能反。先确认再清理、或只退役不删正文,都会让"删掉的那句话"仍躺在
   * DSH 会话日志里,下一次恢复或摘要就能把它带回来。范围只有本次点名的会话:
   * 无关会话、无关队列、别的主体一概不动。
   *
   * 一项待办只有在**所有**命中的会话目录都确实删除后才确认 `cleaned`;任何
   * 一项失败就整条标 `failed` 并保留待办,修复后还能继续。
   */
  async handleCleanup(pending) {
    const failed = []
    let cleanedCount = 0
    for (const item of pending) {
      await this.proactive.forget(item)
      const sessions = this.sessionsForDeletion(item)
      const cleaned = []
      const problems = []
      for (const scopeId of sessions) {
        const sessionId = this.sessionIdForScope(scopeId) ?? scopeId
        try {
          await this.retireLocalSession(scopeId)
          const target = await this.sessionDirectory(sessionId)
          if (target === undefined) {
            cleaned.push({ session_id: scopeId, kind: 'dsh_session', detail: 'no-local-log' })
            continue
          }
          const result = await deleteSessionDirectory(target)
          if (result.deleted) {
            cleaned.push({ session_id: scopeId, kind: 'dsh_session', detail: result.reason })
          } else {
            problems.push({ session_id: scopeId, path: target, reason: result.reason })
          }
        } catch (error) {
          problems.push({ session_id: scopeId, reason: error.message })
        }
      }
      if (!sessions.length) problems.push({ reason: 'missing_plugin_session_source' })
      try {
        if (problems.length > 0) {
          await this.client.acknowledgeCleanup(item.deletion_id, {
            cleaned, failed: problems,
          })
          failed.push({ deletion_id: item.deletion_id, reason: problems.map(row => row.reason).join(', ') })
        } else {
          await this.client.acknowledgeCleanup(item.deletion_id, { cleaned })
          cleanedCount += 1
        }
      } catch (error) {
        failed.push({ deletion_id: item.deletion_id, reason: error.message })
      }
    }
    this.health = {
      ...this.health,
      state: failed.length > 0 ? 'cleanup-failed' : 'connected',
      detail: failed.length > 0
        ? `清理未完成：${failed.map(row => `${row.deletion_id}(${row.reason})`).join(', ')}`
        : (cleanedCount > 0 ? `已清理 ${cleanedCount} 项` : ''),
      updated_at: new Date().toISOString(),
    }
    await this.client.save()
  }

  /**
   * 一个 DSH 会话 id 对应的日志目录。
   *
   * 目录名是 DSH 自己编码过的会话 id(`encodeSegment`),直接用 id 找不到时
   * 遍历一次真实的会话根目录比对,避免把编码规则复制到这里又抄错。
   */
  async sessionDirectory(sessionId) {
    const root = this.sessionsRoot
    if (!root) return undefined
    const names = await listSessionDirectories(root)
    for (const entry of names) {
      if (entry.sessionId === sessionId) return entry.path
      if (sessionScopeId(entry.sessionId) === sessionId) return entry.path
    }
    return undefined
  }

  /**
   * 一条删除涉及的 DSH 会话。
   *
   * 服务端待办只给出 source_key / episode_ids;两者都由本插件构造,会话段就
   * 在里面。匹配不到就不猜会话,确认时如实说明无本地正文需要清理。
   */
  sessionsForDeletion(item) {
    const found = new Set()
    const collect = value => {
      const text = String(value ?? '')
      if (!text) return
      const parts = text.split(':')
      // plugin:<plugin>:<character>:<subject>:<session>:<event>
      if (parts[0] === 'plugin' && parts.length === 6 && parts[1] === this.config.pluginId
          && parts[2] === this.config.characterId && parts[3] === this.config.subject && parts[4]) found.add(parts[4])
      // An episode id may embed the session as its last segment.
      else if (parts.length === 4 && parts[0] === 'ep' && parts[1] === 'plugin'
          && parts[2] === this.config.pluginId && parts[parts.length - 1]) {
        found.add(parts[parts.length - 1])
      }
    }
    for (const key of item.source_keys ?? []) collect(key)
    for (const episode of item.episode_ids ?? []) collect(episode)
    const ids = new Set(item.memory_ids ?? [])
    const sources = new Set(item.source_keys ?? [])
    const versions = new Set(item.persona_versions ?? [])
    for (const [scopeId, refs] of Object.entries(this.client.state.references)) {
      if (refs.ids?.some(id => ids.has(id)) || refs.sources?.some(key => sources.has(key))
          || refs.versions?.some(version => versions.has(version))) found.add(scopeId)
    }
    return [...new Set([...found].map(id => this.sessionIdForScope(id) ?? id))]
  }

  /**
   * 退役一个本地会话:停止注入与保存,并让宿主不再恢复它。
   *
   * 退役本身不是正文清理:会话日志仍需要宿主丢弃。这里同时调用宿主的取消
   * 与归档能力(存在时),不可用时把原因留在状态里,不假装清理已完成。
   */
  async retireLocalSession(scopeSessionId) {
    const sessionId = this.sessionIdForScope(scopeSessionId) ?? scopeSessionId
    const scopeId = sessionId.startsWith('dsh-') ? sessionId : sessionScopeId(sessionId)
    this.client.retire(scopeId)
    await this.client.save()
    const agent = this.candidates.get(sessionId)
    if (agent && !this.bridge?.retireSession) throw new Error('QQ 会话控制器不可用，保留清理待办')
    if (this.bridge?.retireSession) await this.bridge.retireSession(sessionId)
    if (agent) this.detach(agent)
    this.candidates.delete(sessionId)
    this.admissions.delete(sessionId)
    await this.client.serial(async () => {
      for (const section of ['pending', 'generated', 'sent', 'recentTurns', 'proactiveOutputs']) {
        for (const [id, row] of Object.entries(this.client.state[section])) {
          if (row.scope?.session_id !== scopeId && row.native_session_id !== sessionId) continue
          delete this.client.state[section][id]
          delete this.client.state.accepted[id]
        }
      }
      delete this.client.state.references[scopeId]
      // 会话被清理后,已注入索引也随之作废:新会话要能重新获得这些材料。
      delete this.client.state.injected[scopeId]
      await this.client.save()
    })
  }

  /** 服务端会话标识反查当前 DSH 会话 id。 */
  sessionIdForScope(scopeSessionId) {
    if (this.client.state.sessions[scopeSessionId]) return this.client.state.sessions[scopeSessionId]
    if (Object.values(this.client.state.sessions).includes(scopeSessionId)) return scopeSessionId
    for (const id of this.candidates.keys()) {
      if (id === scopeSessionId || sessionScopeId(id) === scopeSessionId) return id
    }
    for (const agent of this.attached.keys()) {
      if (sessionScopeId(agent.session.id) === scopeSessionId) return agent.session.id
    }
    return undefined
  }

  // -- 上下文分段(RO02-CTX)-----------------------------------------------

  /**
   * 换段判定:由桥接层的段端口在**每轮进模型之前**调用一次。
   *
   * 桥接层负责「什么时候问」,这里负责「该不该换」;两边都只回答自己知道的那一半。
   * 这个点是唯一不需要跟投递时序抢时间的窗口:上一轮已经结束、气泡全部发完,
   * 而下一轮输入还没进来。
   *
   * @param {string} sessionKey QQ 来源键。
   * @param {string} sessionId 换段前这一轮本来要用的 DSH 会话 id(未建会话时为空串)。
   * @returns {string|undefined} 需要换段时返回原因(写进状态与日志)。
   */
  segmentSwitchReason(sessionKey, sessionId) {
    if (this.stopped || !sessionKey) return undefined
    const record = this.segments.current(sessionKey)
    // 还没有段:这不是「换段」,是首次记账。桥接层不需要释放会话。
    if (!record) return undefined
    // 宿主换了会话(重启、手工 /new-session、切目录)而我们还记着旧的:直接把段绑到
    // 新会话上,不算一次换段 —— 否则会把「宿主已经换过」误记成「段该换」并再换一次。
    if (record.session_id && sessionId && record.session_id !== sessionId) {
      void this.segments.bind(sessionKey, sessionId).catch(() => {})
      return undefined
    }
    return this.segments.switchReason(sessionKey) ?? undefined
  }

  /**
   * 「换段已经发生」:开新段、记住旧会话、把该带走的旧话取出来暂存。
   *
   * 旧话在 begin **之前**取:begin 会把本段的完整对话清空,顺序反了就没得带。
   * 新段同时是新的上下文代际,所以注入索引作废,记忆材料允许重新送达一次。
   */
  async onSegmentSwitched(sessionKey, { previousSessionId, sessionId, reason } = {}) {
    if (this.stopped || !sessionKey) return
    const carry = ['idle', 'age'].includes(reason) ? { exchanges: [] } : this.segments.carry(sessionKey)
    const text = carry.exchanges.length > 0 ? renderCarry(carry.exchanges) : ''
    await this.segments.begin(sessionKey, { sessionId, reason })
    this.segmentCarry.delete(sessionKey)
    if (text) this.segmentCarry.set(sessionKey, text)
    if (sessionId) {
      await this.resetInjected(sessionId).catch(error => {
        this.logger.warn?.(`[dsh-rin-memory] 换段后注入索引重置失败：${error.message}`)
      })
    }
    this.logger.info?.(`[dsh-rin-memory] 段已换（${reason || 'unknown'}）: ${previousSessionId || '(none)'} -> ${sessionId || '(none)'},带入 ${carry.exchanges.length} 轮`)
  }

  /** 让段绑定到当前 DSH 会话 id;重启后据此判断宿主是否还在同一会话上。 */
  async bindSegment(sessionKey, sessionId) {
    if (this.stopped || !sessionKey) return
    const record = this.segments.current(sessionKey)
    if (!record) {
      await this.segments.begin(sessionKey, { sessionId, reason: 'initial' })
      return
    }
    if (record.session_id !== sessionId) await this.segments.bind(sessionKey, sessionId)
  }

  /** 取走新段第一次请求要带的旧话;没有则返回空串。取走即清空,只带一次。 */
  takeSegmentCarry(sessionKey) {
    const pending = this.segmentCarry.get(sessionKey)
    if (pending === undefined) return ''
    this.segmentCarry.delete(sessionKey)
    return pending
  }

  /**
   * 记一次完整交换,作为未来换段时可能带入的历史。
   *
   * 只在**发送成功之后**记(bridge 报的 completed 轮次带真实 parts):没发出去的那
   * 一轮不该变成下一段带入的历史,否则新段会读到模型从未见过、主人也从未收到的
   * 话。主动消息与后台任务同样不是「真实用户互动」,也不进这里。
   */
  async recordSegmentExchange(report) {
    const sessionKey = report?.sessionKey
    if (this.stopped || !sessionKey) return
    const parts = Array.isArray(report.parts) ? report.parts : []
    if (parts.length > 0 && !parts.some(part => part.ok)) return
    await this.segments.recordExchange(sessionKey, { user: report.input, reply: report.reply })
  }

  /**
   * 跨段时按需取一张续聊便条;不需要、或服务还没提供这条路由时返回空串。
   *
   * 判定与正文都由核心服务的 domain 规则给出(`build_segment_note`):它只记录
   * **引用**(哪些未完事项、哪个时间、来源键),正文永远回原始记录取,所以更正
   * 或删除之后便条不会把旧结论带回来,也不存在「摘要压摘要」。
   *
   * 默认不生成:时距不足、没有未完结事项时服务返回空,这里如实为空串,不补话。
   * 不是常规摘要调用:只在换段那一次问,不是每轮都问。
   *
   * 服务没有这条路由(404/405)、或请求失败时同样降级为空:少一句话远好过让
   * 换段本身失败。
   */
  async segmentNoteFor(sessionKey, sessionId) {
    if (this.stopped || !sessionKey || !sessionId) return ''
    const record = this.segments.current(sessionKey)
    if (!record) return ''
    try {
      const note = await this.client.request('/v1/segment/note', {
        ...this.client.scope(sessionId),
        switched_at: new Date(Number(record.started_at) || Date.now()).toISOString(),
        last_user_at: new Date(Number(record.previous_last_user_at) || Number(record.last_user_at)
          || Number(record.started_at) || Date.now()).toISOString(),
      })
      return typeof note?.text === 'string' ? note.text.trim() : ''
    } catch (error) {
      const status = Number(error?.status ?? 0)
      if (status === 404 || status === 405) {
        // 服务端还没提供这条路由:便条本来就是可选的,不重复告警。
        return ''
      }
      this.logger.warn?.(`[dsh-rin-memory] 续聊便条未取到（不影响本轮）:${error?.message ?? error?.code}`)
      return ''
    }
  }

  /** 一个 agent 属于哪个 QQ 来源键;只从桥接绑定读,不猜。 */
  sessionKeyOfAgent(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId) return undefined
    return this.bridge?.binding?.(sessionId)?.sessionKey
  }

  // -- DSH agent attach ------------------------------------------------

  attach(agent) {
    if (!agent?.session) return
    const sessionId = agent.session.id
    if (!this.config.sessionPrefixes.some(prefix => sessionId.startsWith(prefix))) return
    if (!this.isTrusted(agent)) return
    if (this.attached.has(agent)) return
    if (this.client.isRetired(sessionId)) {
      // A session that was retired for cleanup must not silently come back.
      this.logger.warn?.(`[dsh-rin-memory] 会话已退役，跳过接入：${sessionId}`)
      return
    }
    const dispose = agent.ctx.effect(() => {
      const offStep = agent.ctx.on('agent/pre-step', (payload, next) => this.preStep(agent, payload, next))
      // 人格占据宿主的 deployment persona prefix 槽位:本 agent 作用域的同名段
      // 遮蔽外层(全局或预设)那一段,人格因此只作为系统提示出现一份。文本由
      // provider 提供,每次装配都读当前已发布正文,新发布在下一轮自动生效。
      const offPrompt = this.registerPrompt(agent, sessionId)
      const offTools = this.registerTools(agent)
      return () => {
        offStep?.()
        offPrompt?.()
        offTools?.()
        this.turns.delete(agent)
        this.personas.delete(sessionId)
      }
    })
    this.attached.set(agent, { dispose })
    this.attachSpells(agent)
  }

  /** 咒语由会话本身的预设启用；QQ 身份绑定只约束 QQ 来源和个人记忆。 */
  isSpellSession(agent) {
    const session = agent?.session
    if (!session || session.id.startsWith('companion-spell-') || session.header?.origin === 'subagent') return false
    const binding = this.bridge?.binding?.(session.id)
    if (binding && (binding.owner !== true || binding.scope !== 'private')) return false
    const selected = this.ctx.get?.('sessionProjections')?.stateOf(session, 'agentPreset')
    const preset = selected === undefined ? session.header?.agentPreset : selected
    return preset === 'dsh-qq-bridge' || this.attached.has(agent)
  }

  attachSpells(agent) {
    if (this.stopped || !this.isSpellSession(agent) || this.spellScopes.has(agent)
      || this.client.isRetired(agent.session.id)) return
    const sessionId = agent.session.id
    const dispose = agent.ctx.effect(() => {
      const offEvent = agent.ctx.on('session/event', (subject, event) => this.sessionEvent(agent, subject, event))
      const isolation = new MainSessionScope(agent, {
        currentPersona: async () => {
          if (this.attached.has(agent)) return this.personas.get(sessionId) ?? ''
          const context = await this.client.request('/v1/context', { ...this.client.scope(sessionId), text: '' })
          requirePersona(context)
          return context.persona
        },
        learned: () => this.spellLibrary.list(),
        logger: this.logger,
      })
      isolation.install()
      return () => { offEvent?.(); isolation.dispose() }
    })
    this.spellScopes.set(agent, { dispose })
  }

  detachSpells(agent) {
    this.spellRunner.detach(agent)
    // 会话没了,还没学完的那条也没处报了;结果已由 startLearning 自己推 QQ。
    this.pendingLearnings.delete(agent?.session?.id)
    const entry = this.spellScopes.get(agent)
    this.spellScopes.delete(agent)
    entry?.dispose?.()
  }

  /**
   * 注册本会话的两个系统段,返回释放函数。
   *
   * 人格段用宿主的 deployment persona prefix 槽位名与顺序,遮蔽外层同名段;
   * 规则段单独一个名字,紧跟在人格之后。宿主缺少 section API 时如实降级:
   * 会话照常聊天,只是人格由外层预设提供。
   */
  registerPrompt(agent, sessionId) {
    const prompt = agent.ctx?.systemPrompt
    if (!prompt?.section) {
      this.logger.warn?.('[dsh-rin-memory] 系统提示接口不可用,人格未写入系统段')
      return () => {}
    }
    const order = prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX')
    const personaOrder = Number.isFinite(order) ? order : 0
    const disposers = []
    const register = (section, label) => {
      try {
        disposers.push(prompt.section(section))
      } catch (error) {
        // 同一作用域里已经有同名段(典型来源:agent preset 自己挂的 persona 行)。
        // 这不是故障:MainSessionScope 的组装钩子按名字重建人格段,最终仍然只有
        // 一份当前人格。只记一句,让会话照常可用。
        this.logger.info?.(`[dsh-rin-memory] 系统段 ${label} 已由其他来源注册,由隔离钩子接管`)
      }
    }
    // provider 而不是静态串:每次装配都读当前已发布正文,新发布下一轮生效。
    register({
      name: PERSONA_SECTION,
      order: personaOrder,
      text: () => this.personas.get(sessionId) ?? '',
      interpolate: false,
    }, PERSONA_SECTION)
    // 规则段不再注册:主请求的系统提示只保留人格一份。规则里唯一还有用的
    // "这不是主人说的话"下沉到增量材料 header,只在真有增量时出现。
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose?.() } catch { /* disposal is best effort */ }
      }
    }
  }

  observeAgent(agent) {
    if (!agent?.session) return
    this.candidates.set(agent.session.id, agent)
    this.attach(agent)
    this.attachSpells(agent)
  }

  isTrusted(agent) {
    const binding = this.bridge?.binding?.(agent.session.id)
    return binding?.owner === true && binding.scope === 'private'
  }

  async prepareBridgeInput(input) {
    if (this.stopped) return
    if (!input.owner || input.scope !== 'private') {
      const agent = this.candidates.get(input.sessionId)
      if (agent) this.detach(agent)
      return
    }
    if (!input.sessionId) throw new Error('MEMORY_REQUIRED: 缺少 QQ 会话绑定')
    const sessionId = input.sessionId
    await this.proactive.observe(input)
    this.client.state.sessions[sessionScopeId(sessionId)] = sessionId
    await this.client.save()
    const agent = this.candidates.get(sessionId)
    if (agent) this.attach(agent)
    try {
      const pending = await this.client.releaseCleanup()
      if (pending.length) await this.handleCleanup(pending)
      if (this.client.isRetired(sessionId)) throw new Error('原会话已清理，等待新会话')
      if (Object.keys(this.client.state.pending).length + Object.keys(this.client.state.generated).length >= this.config.maxPending) {
        throw new Error('记忆补交队列已满，请恢复服务后重试')
      }
      const context = await this.client.request('/v1/context', { ...this.client.scope(sessionId), text: input.input })
      requirePersona(context)
      // 系统段在 preStep 之前就装配好了,所以人格必须在这里(本轮开始前)就位,
      // 否则轮次 1 的系统提示里没有人格。这次请求本来就是本轮要用的那一份,
      // 不额外取上下文。
      this.personas.set(sessionId, context.persona ?? '')
      this.admissions.set(sessionId, { input, context })
    } catch (error) {
      if (error.kind === 'config') throw new Error(`记忆客户端权限或凭据被拒绝：${error.code}`, { cause: error })
      throw new Error(`MEMORY_REQUIRED: ${error.message ?? error.code ?? '记忆服务连接异常'}`, { cause: error })
    }
  }

  detach(agent) {
    this.detachSpells(agent)
    const entry = this.attached.get(agent)
    if (!entry) return
    this.attached.delete(agent)
    this.turns.delete(agent)
    try { entry.dispose?.() } catch { /* disposal is best effort */ }
  }

  /**
   * 同一轮只取一次上下文;工具步骤复用,不重复取也不重复注入。
   *
   * 只在本轮**确有新增**背景时才追加一条消息:没有新记忆、没有新更正、没有
   * 新对话时,这一轮的消息列表与不装本插件时完全一致(不加占位句)。
   * 只有真正交给宿主的这一步才登记指纹——取到 context、reserve、落盘 prepared
   * 都不算“已经给模型看过”。
   */
  async preStep(agent, payload, next) {
    const sessionId = agent.session.id
    this.currentAgent = agent
    const prepared = await this.ensureTurn(agent, payload)
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const turn = this.turns.get(agent)
    if (!prepared || !turn || turn.injected || turn.requestId !== prepared.requestId) return decision
    if (payload.step !== 1) return decision
    turn.injected = true
    const messages = [...decision.messages]
    // 后台任务的结果是一条**有任务来源**的外部事件:它不是用户说的话,也不是
    // 记忆资料。每条只投一次——投递成功才 markNotified。
    for (const task of this.pendingTaskNotices(agent)) {
      const notice = {
        id: `task:${task.taskId}`,
        role: 'user',
        source: { kind: TASK_SOURCE },
        content: [{ type: 'text', text: this.taskNoticeText(task) }],
      }
      const inputIndex = messages.findLastIndex(message =>
        message.source?.kind === 'user' || message.source?.kind === PROACTIVE_SOURCE)
      messages.splice(inputIndex < 0 ? messages.length : inputIndex, 0, notice)
      await this.taskStore?.markNotified(task.taskId).catch(error => {
        this.logger.warn?.(`[dsh-rin-memory] 任务通知标记失败：${error.message}`)
      })
    }
    // ---- 新段的第一次请求:干净输入(RO02-CTX)-------------------------
    // 换段的意义就是让这一轮只读「已发布人格 + 固定咒语说明 + 带入历史 +
    // 记忆/便条 + 当前原话与图片」。正式请求会从会话日志组装历史,所以只改
    // pre-step 的消息数组达不成这件事 —— 真正起作用的是换了一个空会话。
    // 这里补的是新会话里**没有**的那部分:跨段带入的旧话。
    //
    // 必须排除的东西:
    // - 原生压缩摘要:新会话日志里本来就没有(压缩节点属于旧会话),不必也无法在此剥离;
    // - 旧运行说明与后台执行过程:同样只在旧会话里,换段即离开;
    // - 本插件自己的记忆材料:照常只给本轮增量,已注入索引在换段时作废。
    //
    // 带入的历史作为一条**有来源标记**的消息放在主人原话之前:它是「已经发生过的
    // 对话」,不是主人这次说的话,来源标记让保存与召回都分得清。
    const carryKey = this.sessionKeyOfAgent(agent)
    const carryText = carryKey ? this.takeSegmentCarry(carryKey) : ''
    if (carryText) {
      const materialInput = messages.findLastIndex(message =>
        message.source?.kind === 'user' || message.source?.kind === PROACTIVE_SOURCE)
      const carry = {
        id: `segment-carry:${carryKey}`,
        role: 'user',
        source: { kind: SEGMENT_SOURCE },
        content: [{ type: 'text', text: `${SEGMENT_CARRY_NOTE}\n${carryText}` }],
      }
      messages.splice(Math.max(0, materialInput), 0, carry)
      // 带入过的旧话已经由本轮的记忆材料与它自己承载,不必再在下一轮重贴;
      // 但它不属于「已注入的记忆指纹」,所以不进注入索引。
    }
    if (!prepared.background) {
      return messages.length > decision.messages.length ? { ...decision, messages } : decision
    }
    // 背景先于本轮输入，主人原话（包括图片）保留在最后；来源标记用于记忆隔离。
    // 索引写失败不阻断这一轮(材料已经给出去了),最坏只是下一轮重贴一次。
    await this.markInjected(sessionId, prepared.fingerprints).catch(error => {
      this.logger.warn?.(`[dsh-rin-memory] 注入索引保存失败：${error.message}`)
    })
    const material = {
      id: `memory:${prepared.requestId}`,
      role: 'user',
      source: { kind: MEMORY_SOURCE },
      content: [{ type: 'text', text: prepared.background }],
    }
    const inputIndex = messages.findLastIndex(message =>
      message.source?.kind === 'user' || message.source?.kind === PROACTIVE_SOURCE)
    messages.splice(inputIndex < 0 ? 0 : inputIndex, 0, material)
    return { ...decision, messages }
  }

  /** 压缩后开启新的上下文代际:已注入索引作废,材料可以重新送达。 */
  async resetInjected(sessionId) {
    const scopeId = sessionScopeId(sessionId)
    await this.client.serial(async () => {
      if (!this.client.state.injected[scopeId]) return
      delete this.client.state.injected[scopeId]
      await this.client.save()
    })
  }

  /**
   * 登记“这些条目已经真的进入过本会话的上下文”。
   *
   * 索引按会话作用域持久化在 outbox.json 里:重启、换进程都还知道哪些材料
   * 早已给过模型,不会因为重连而把同一段记忆再贴一次。
   */
  async markInjected(sessionId, fingerprints = []) {
    if (fingerprints.length === 0) return
    const scopeId = sessionScopeId(sessionId)
    await this.client.serial(async () => {
      const index = this.client.state.injected[scopeId] ?? {}
      const at = this.client.now()
      for (const fingerprint of fingerprints) index[fingerprint] = at
      const keys = Object.keys(index)
      if (keys.length > INJECTION_INDEX_LIMIT) {
        for (const key of keys.slice(0, keys.length - INJECTION_INDEX_LIMIT)) delete index[key]
      }
      this.client.state.injected[scopeId] = index
      await this.client.save()
    })
  }

  /**
   * 为一轮准备提交身份与快照。返回 undefined 表示这一轮不接入记忆
   * (没有真实用户输入,或会话已退役)。
   */
  async ensureTurn(agent, payload) {
    if (this.stopped) return undefined
    const sessionId = agent.session.id
    if (!this.isTrusted(agent)) throw new Error('MEMORY_REQUIRED: QQ 主人身份未绑定')
    if (this.client.isRetired(sessionId)) throw new Error('MEMORY_REQUIRED: 原会话已清理，等待新会话')
    const existing = this.turns.get(agent)
    if (existing && existing.turn === payload.turn) {
      return existing.prepared
    }
    if (payload.messages?.some(message => message.source?.kind === PROACTIVE_SOURCE)) {
      const prepared = await this.proactive.prepare(agent, payload)
      if (prepared) return prepared
      if (!payload.messages.some(message => message.source?.kind === 'user')) return undefined
    }
    const input = latestUserInput(agent, payload)
    if (!input) return undefined
    if (Object.keys(this.client.state.pending).length + Object.keys(this.client.state.generated).length >= this.config.maxPending) {
      throw new Error('MEMORY_REQUIRED: 记忆补交队列已满，请恢复服务后重试')
    }
    const binding = this.bridge.binding(sessionId)
    input.text = binding.input
    // 空闲计时只认真实用户互动:主动消息、后台任务与咒语反馈都不走这里。
    const segmentKey = binding.sessionKey
    if (segmentKey) {
      try {
        // 先建段再记时间:顺序反了的话,首次互动会落在「还没有段」的空态上,
        // 于是这一轮既不记账也不落盘,重启后本轮互动就丢了。
        await this.bindSegment(segmentKey, sessionId)
        await this.segments.touchUser(segmentKey)
      } catch (error) {
        // 段状态是本地簿记,坏了不该拦住主人的这一轮。
        this.logger.warn?.(`[dsh-rin-memory] 段状态记录失败（不影响本轮）：${error.message}`)
      }
    }
    // The turn key is the DSH user-message id alone, so the bridge can compute
    // the same key for its send receipt without knowing this turn number.
    const requestId = turnKeyOf({ sessionId, messageId: input.messageId })
    try {
      const admission = this.admissions.get(sessionId)
      this.admissions.delete(sessionId)
      const context = admission?.input.input === input.text ? admission.context : await this.client.request('/v1/context', {
        ...this.client.scope(sessionId),
        text: input.text,
      })
      requirePersona(context)
      const consumed = contextReferences(context)
      await this.client.request('/v1/context/reserve', {
        ...this.client.scope(sessionId),
        request_id: requestId,
        context_receipt_id: context.context_receipt_id,
        // QP05:登记"这一轮真的消费了哪些记忆 id"。网页来源的事实本身没有插件
        // 段,不登记的话,网页删除它时本插件永远收不到清理待办,已注入的正文
        // 就会留在 DSH 历史里。只报 id 与代际,不报正文;服务端还会用已签发的
        // context 复核,客户端多报的 id 会被过滤掉。
        consumer_refs: {
          plugin_id: this.config.pluginId,
          session_id: sessionScopeId(sessionId),
          memory_ids: consumed.ids,
          source_ids: consumed.sources,
          context_generation: String(context.persona_version ?? ''),
        },
      })
      // 人格只进系统段:每次真实采用都用**已发布全文**覆盖该段文本,新发布
      // 因此在下一轮装配时生效,旧正文不会残留在系统提示里。
      this.personas.set(sessionId, context.persona ?? '')
      const background = await this.renderBackground(sessionId, context, agent, input.text)
      const segment = segmentKey ? this.segments.current(segmentKey) : undefined
      if (segment?.previous_session_id && segment.exchanges.length === 0
        && context.context?.followup?.status === 'resolved') {
        const note = await this.segmentNoteFor(segmentKey, sessionId)
        if (note) background.text = [background.text, note].filter(Boolean).join('\n\n')
      }
      const contactNow = this.client.now()
      this.contactTimes.set(sessionId, contactNow)
      if (this.config.proactiveEnabled) {
        const clock = this.proactive.clockMaterial(sessionId, contactNow)
        const fingerprint = 'clock:' + stableHash(clock)
        if (!this.client.state.injected[sessionScopeId(sessionId)]?.[fingerprint]) {
          background.text = [background.text, clock].filter(Boolean).join('\n\n')
          background.fingerprints.push(fingerprint)
        }
      }
      const prepared = {
        requestId,
        scope: this.client.scope(sessionId),
        contextReceiptId: context.context_receipt_id,
        personaVersion: context.persona_version ?? '',
        background: background.text,
        fingerprints: background.fingerprints,
        body: {
          ...this.client.scope(sessionId),
          request_id: requestId,
          turn_id: requestId,
          source_key: buildSourceKey(
            this.config.pluginId, this.config.characterId, this.config.subject,
            sessionScopeId(sessionId), requestId,
          ),
          occurred_at: this.client.now(),
          persona_version: context.persona_version ?? '',
          card_revision: Number(context.card_revision ?? 0),
          context_receipt_id: context.context_receipt_id,
          applies_to: 'shared',
          messages: [{ role: 'user', content: input.text }],
        },
        input: input.text,
      }
      this.contactSources.set(sessionId, { source_key: prepared.body.source_key, refs: consumed.sources })
      await this.client.serial(async () => {
        if (Object.keys(this.client.state.pending).length + Object.keys(this.client.state.generated).length >= this.config.maxPending) {
          throw new Error('记忆补交队列已满，请恢复服务后重试')
        }
        this.client.state.sessions[sessionScopeId(sessionId)] = sessionId
        const scopeId = sessionScopeId(sessionId)
        const prior = this.client.state.references[scopeId] ?? { ids: [], sources: [], versions: [] }
        const recentSources = (context.recent_turns ?? []).flatMap(row => {
          const meta = row?.data?.metadata ?? row?.metadata ?? {}
          return [...(meta.source_event_keys ?? []), ...(meta.source_key ? [meta.source_key] : [])]
        })
        this.client.state.references[scopeId] = {
          ids: [...new Set([...prior.ids, ...consumed.ids, ...consumed.sources])],
          sources: [...new Set([...prior.sources, prepared.body.source_key, ...consumed.sources, ...recentSources])],
          versions: [...new Set([...prior.versions, ...(context.persona_version ? [context.persona_version] : [])])],
        }
        this.client.state.generated[requestId] = {
          body: prepared.body, scope: prepared.scope, persona_version: prepared.personaVersion,
          input: input.text, native_session_id: sessionId,
        }
        await this.client.save()
      })
      this.turns.set(agent, {
        turn: payload.turn, requestId, prepared, injected: false, reply: '',
      })
      this.health.persona_version = prepared.personaVersion
      this.health.state = 'connected'
      this.health.detail = ''
      return prepared
    } catch (error) {
      const classified = error.kind ? error : classifyTransportError(error)
      // The bridge keeps the original input. No model call may cross this
      // boundary without the required persona and correction snapshot.
      this.health = {
        state: classified.kind === 'config' ? 'rejected' : 'disconnected',
        detail: `本轮未取得人格与记忆：${describeFailure(classified)}`,
        persona_version: this.health.persona_version,
        updated_at: new Date().toISOString(),
      }
      this.logger.warn?.(`[dsh-rin-memory] ${this.health.detail}`)
      if (classified.kind === 'config') throw new Error(`记忆客户端权限或凭据被拒绝：${classified.code}`, { cause: error })
      throw new Error(`MEMORY_REQUIRED: ${this.health.detail}`, { cause: error })
    }
  }

  /**
   * 本轮真正要补充的增量背景。
   *
   * 三类材料各自独立判断:相关记忆按条目(记忆 id + 正文指纹)、必须遵守的
   * 更正(更正 id + 修订号)、必要近期对话(跨端轮次 id)。已经在本次上下文
   * 里真正注入过的条目不再重贴;三类都没有新增时返回空文本,调用方据此
   * 完全不追加消息。
   */
  async renderBackground(sessionId, context, agent, currentInput) {
    const scopeId = sessionScopeId(sessionId)
    const seen = this.client.state.injected[scopeId] ?? {}
    const history = agent?.session?.deriveMessages?.() ?? []
    return renderIncrement(context, seen, { scopeId,
      currentInput,
      representedText: history.filter(message => message.source?.kind !== MEMORY_SOURCE)
        .map(messageText).join('\n') })
  }

  // -- turn completion -------------------------------------------------

  sessionEvent(agent, subject, event) {
    if (subject !== agent.session && subject?.id !== agent.session?.id) return
    if (this.turns.get(agent)?.proactive && !event.type.startsWith('compaction/')) return
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      void this.spellRunner.handleAssistantMessage(agent, event.data.message, event.seq)
        .catch(error => this.logger.warn?.(`[dsh-rin-memory] 咒语处理失败：${error.message}`))
      return
    }
    // 压缩会重写本会话的历史:已经注入过的背景可能已不在模型眼前,所以把它
    // 当作新的上下文代际——同一份材料允许再给一次,而不是永久沉默。
    if (event.type === 'compaction/end' || event.type === 'compaction/prune') {
      void this.resetInjected(agent.session.id)
        .catch(error => this.logger.warn?.(`[dsh-rin-memory] 注入索引重置失败：${error.message}`))
      return
    }
    const turn = this.turns.get(agent)
    if (!turn) return
    if (event.type !== 'turn/end' || event.data?.turn !== turn.turn) return
    const reason = event.data?.reason?.kind
    if (reason !== 'completed') {
      // Cancelled, interrupted or failed turns are not a finished exchange.
      this.turns.delete(agent)
      void this.client.serial(async () => {
        delete this.client.state.generated[turn.requestId]
        await this.client.save()
      }).catch(error => this.logger.error?.(`中断轮次状态保存失败：${error.message}`))
      return
    }
    this.turns.delete(agent)
    // QQ's final visible input/reply arrives through the bridge. The raw DSH
    // assistant message can still contain control blocks and is never committed.
  }

  /**
   * 先落盘再提交:进程在提交途中退出时,重启后同一正文会被重放一次,而不是
   * 丢失或因重新生成而变成另一轮。
   */
  async saveTurn(prepared, reply) {
    const pending = Object.keys(this.client.state.pending).length
    if (pending >= this.config.maxPending) {
      throw new Error(`记忆补交队列已满（${pending}/${this.config.maxPending}），请恢复服务后重试`)
    }
    await this.client.serial(async () => {
      this.client.state.pending[prepared.requestId] = {
        body: { ...prepared.body, reply },
        scope: prepared.scope,
        persona_version: prepared.personaVersion,
        input: prepared.input,
        reply_chars: charCount(reply),
        queued_at: this.client.now(),
      }
      delete this.client.state.generated[prepared.requestId]
      await this.client.save()
    })
    try {
      await this.client.flush()
      this.health = { ...this.health, state: 'connected', detail: '', updated_at: new Date().toISOString() }
    } catch (error) {
      const kind = error.kind ?? classifyTransportError(error).kind
      this.health = {
        ...this.health,
        state: kind === 'cleanup' ? 'cleanup-pending' : (kind === 'config' ? 'rejected' : 'disconnected'),
        detail: error.deletions ? `待清理：${error.deletions.join(', ')}` : `已排队，等待补交：${describeFailure(error)}`,
        updated_at: new Date().toISOString(),
      }
    }
    await this.publishStatus()
  }

  // -- bridge facts ----------------------------------------------------

  /**
   * 订阅 QQ bridge 的轮次事实。
   *
   * bridge 未安装或未启用时这里什么都不发生:记忆只在 DSH 侧按真实用户消息
   * 工作,不会凭空产生 QQ 记忆。订阅是同步的,所以启用顺序不影响正确性。
   *
   * 订阅挂在 `ctx.effect` 上:热重载或卸载时由 fiber 统一释放,不依赖本模块
   * 记得调用 dispose。
   */
  subscribeBridge() {
    const connect = service => {
      if (!service?.subscribe) return () => {}
      this.bridge = service
      const subscription = service.subscribe(report => {
        void this.onBridgeTurn(report).catch(error => this.logger.warn?.(`QQ 轮次处理失败：${error.message}`))
      })
      const admission = service.subscribeAdmission?.(input => this.prepareBridgeInput(input))
      for (const agent of this.candidates.values()) this.attach(agent)
      return () => {
        subscription.dispose()
        admission?.dispose()
        for (const agent of [...this.attached.keys()]) this.detach(agent)
        if (this.bridge === service) this.bridge = null
      }
    }
    if (this.ctx.inject) {
      const fiber = this.ctx.inject([BRIDGE_EVENTS_SERVICE], child => {
        child.effect(() => connect(child.get?.(BRIDGE_EVENTS_SERVICE) ?? child[BRIDGE_EVENTS_SERVICE]))
      })
      this.bridgeSubscription = { dispose: () => fiber?.dispose() }
    } else {
      this.bridgeSubscription = { dispose: connect(this.ctx.get?.(BRIDGE_EVENTS_SERVICE)) }
    }
  }

  /**
   * bridge 报告的一轮:它已经知道真实输入、最终对外文字与平台接收情况。
   *
   * 这里补的是 DSH 自己拿不到的那一半:哪些文字真的发到了 QQ,以及分段里
   * 有没有失败的部分。保存仍以 DSH 侧完成的那一轮为准——同一 source_key,
   * 因此重复上报是幂等的。
   */
  async onBridgeTurn(report) {
    const key = turnKeyOf(report ?? {})
    const previous = this.bridgeTails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.processBridgeTurn(report))
    this.bridgeTails.set(key, next)
    try { await next }
    finally { if (this.bridgeTails.get(key) === next) this.bridgeTails.delete(key) }
  }

  async processBridgeTurn(report) {
    if (this.stopped || !report) return
    if ((report.generationStatus ?? report.status) !== 'completed') return
    if (!report.owner) return
    if (report.scope !== 'private') return
    if (!report.sessionId) return
    if (this.client.isRetired(report.sessionId)) return
    if (!report.reply) return
    if (report.parts?.some(part => part.ok)) await this.proactive.delivered(report)
    const scope = this.client.scope(report.sessionId)
    // The receipt must name the turn the save used. The bridge reports the DSH
    // user-message id; without it there is no honest key, so nothing is
    // recorded rather than guessing one and creating an orphan receipt.
    if (!report.turnMessageId) {
      this.logger.warn?.('[dsh-rin-memory] QQ 轮次缺少 DSH 消息标识，跳过发送回执')
      return
    }
    const turnKey = turnKeyOf({ sessionId: report.sessionId, turnMessageId: report.turnMessageId })
    if (!turnKey) return
    const prepared = this.client.state.generated[turnKey]
    if (!prepared && !this.client.state.pending[turnKey] && !this.client.state.recentTurns[turnKey]) return
    if (prepared) {
      await this.saveTurn({ requestId: turnKey, body: { ...prepared.body,
        messages: [{ role: 'user', content: report.input }] },
        scope: prepared.scope, personaVersion: prepared.persona_version, input: report.input }, report.reply)
    }
    try {
      // The turn may not be saved yet (the save is asynchronous and can be
      // waiting for a retry). The receipt is queued under the same turn key as
      // the pending body, so it is posted only once that turn really exists.
      if (!report.parts.some(part => part.ok)) return
      await this.client.recordSent(turnKey, scope, {
        transport: transportOf(this.bridge?.platform),
        parts: report.parts,
      })
      if (!this.client.state.pending[turnKey]) await this.client.flush()
    } catch (error) {
      this.logger.warn?.(`[dsh-rin-memory] 发送回执未记录：${error.message}`)
    }
    // 这一段交换已经真的发到主人面前了,可以是未来换段时带入的历史。
    // 记在发送之后而不是生成时:没发出去的话不该进入新段的带入。
    try {
      await this.recordSegmentExchange(report)
    } catch (error) {
      this.logger.warn?.(`[dsh-rin-memory] 段历史记录失败：${error.message}`)
    }
  }

  // -- memory tools ----------------------------------------------------

  /**
   * 注册受限记忆工具。
   *
   * 只在服务端授予了 `memory_tools` 的客户端上才有意义;插件侧再按配置开关,
   * 两者都满足才出现。工具本身不实现遗忘/更正规则,只把用户的明确要求转成
   * 服务调用,并把实际结果回报给模型。
   */
  registerTools(agent) {
    if (!this.config.memoryTools || !this.isTrusted(agent)) return
    const nativeTools = agent.ctx.get ? agent.ctx.get('tools') : agent.ctx.tools
    if (!nativeTools?.register) return
    const disposers = []
    const tools = { register: definition => {
      const execute = definition.execute
      const off = nativeTools.register({ ...definition, execute: (args, execution) => {
        if (this.stopped || !this.isTrusted(agent) || this.client.isRetired(agent.session.id)
            || (execution?.agent && execution.agent !== agent)) {
          throw new Error('此调用者没有个人记忆权限')
        }
        return execute(args, execution)
      } })
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        off()
        const index = this.toolDisposers.indexOf(dispose)
        if (index >= 0) this.toolDisposers.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    } }
    this.registerForgetTool(tools)
    this.registerCorrectTool(tools, agent)
    this.registerRecallTool(tools)
    this.registerTaskTool(tools, agent)
    return () => { for (const dispose of disposers) dispose() }
  }

  registerTool(tools, definition) {
    try {
      const dispose = tools.register(definition)
      this.toolDisposers.push(dispose)
    } catch (error) {
      this.logger.warn?.(`[dsh-rin-memory] 记忆工具 ${definition.name} 注册失败：${error.message}`)
    }
  }

  registerForgetTool(tools) {
    this.registerTool(tools, toolDefinition({
      name: 'companion_forget',
      description: '当用户明确要求忘掉某件事时调用。只删除已核对到的具体条目；匹配到多条时先返回候选、不要自行删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '用户指代的原文片段,用于定位条目。' },
          type: { type: 'string', enum: ['fact', 'reflection'], description: '已知条目类型时提供。' },
          id: { type: 'string', description: '已知条目 id 时直接指定,最精确。' },
        },
      },
      required: [],
      async run(args) {
        if (args.id) {
          if (args.type !== 'fact' && args.type !== 'reflection') {
            return { status: 'invalid', message: '指定 id 时必须同时给出 type（fact 或 reflection）。' }
          }
          const receipt = await this.client.forget({ target: { type: args.type, id: args.id } })
          return { status: 'deleted', deletion_id: receipt.deletion_id }
        }
        if (!args.text) return { status: 'invalid', message: '需要 text 或 id。' }
        try {
          const receipt = await this.client.forget({ text: args.text })
          return { status: 'deleted', deletion_id: receipt.deletion_id }
        } catch (error) {
          if (error.code === 'ambiguous_target') {
            return {
              status: 'ambiguous',
              candidates: error.extra?.candidates ?? [],
              message: '有多条记忆匹配,请让用户确认是哪一条。',
            }
          }
          if (error.code === 'not_found') {
            return { status: 'not_found', message: '没有找到匹配的记忆。' }
          }
          throw error
        }
      },
      runtime: this,
    }))
  }

  registerCorrectTool(tools, agent) {
    this.registerTool(tools, toolDefinition({
      name: 'companion_correct',
      description: '当用户明确说"你记错了"或要改写某条已知事实时调用。old_text 必须是用户指出的旧内容,new_text 是正确内容。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          old_text: { type: 'string', description: '被更正的旧内容。' },
          new_text: { type: 'string', description: '正确的新内容。' },
        },
      },
      required: ['old_text', 'new_text'],
      async run(args) {
        const requestId = `corr_${stableHash(`${agent.session.id}:${this.turns.get(agent)?.requestId ?? ''}:${args.old_text}:${args.new_text}`)}`
        const receipt = await this.client.correct({
          old_text: args.old_text,
          new_text: args.new_text,
          request_id: requestId,
        })
        return {
          status: receipt.applied ? 'corrected' : (receipt.status ?? 'unknown'),
          correction_id: receipt.correction_id,
          invalidated_facts: receipt.invalidated_fact_ids?.length ?? 0,
        }
      },
      runtime: this,
    }))
  }

  registerRecallTool(tools) {
    this.registerTool(tools, toolDefinition({
      name: 'companion_recall',
      description: '当需要确认"服务里到底记了什么"时列出可删除条目。只读,不修改任何记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '可选的关键词过滤。' },
        },
      },
      required: [],
      async run(args) {
        const result = await this.client.entries(args.text ?? '')
        return { status: 'ok', items: (result.items ?? []).slice(0, 20) }
      },
      runtime: this,
    }))
  }

  /**
   * 统一任务入口。
   *
   * 执行细节留在原生后台子会话里:主会话只拿到 task_id 与状态,不把工作目录、
   * 命令与文件工具带进 QQ 聊天。派发失败也只回报结果,不让聊天中断。
   */
  registerTaskTool(tools, agent) {
    if (!this.taskTools) return
    for (const definition of this.taskTools.definitions) {
      this.registerTool(tools, {
        ...definition,
        // 归属在工具执行边界再核对一次:同一条会话里也只有它自己能查/停自己的任务。
        async execute(args, execution) {
          if (execution?.agent && execution.agent !== agent) {
            return { status: 'denied', error: 'wrong_agent', message: '此调用者没有任务权限。' }
          }
          return await definition.execute(args, execution)
        },
      })
    }
  }

  /** 状态,供原生设置/状态读取;不含凭据。 */
  status() {
    return {
      ...this.client.status(),
      health: this.health,
      bridge: this.bridge ? 'subscribed' : 'absent',
      sessions: [...this.attached.keys()].map(agent => agent.session.id),
      tools: this.toolDisposers.length,
      tasks: this.taskTools?.status?.() ?? { available: false },
    }
  }
}

/**
 * 组装成 `ctx.tools.register` 需要的形状。
 *
 * DSH 的工具定义要求 `output.render`;这里统一包一层纯文本渲染,避免每个工具
 * 各写一份。参数与输出都是可 JSON 序列化的普通对象。`run` 以插件运行时为
 * `this` 执行,这样工具能拿到客户端与配置,而定义本身保持纯数据。
 */
function toolDefinition({ name, description, parameters, required = [], run, runtime }) {
  const input = {
    type: 'object',
    additionalProperties: false,
    properties: parameters.properties ?? {},
    ...(required.length > 0 ? { required } : {}),
  }
  return {
    name,
    description,
    parameters: input,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      try {
        return await run.call(runtime, args)
      } catch (error) {
        // A tool that cannot reach the service says so plainly; the model then
        // reports the failure instead of claiming the change happened.
        return {
          status: 'failed',
          error: error?.code ?? 'error',
          message: error?.message ?? String(error),
        }
      }
    },
    isConcurrencySafe: () => false,
  }
}


/**
 * 把本插件的分段能力包装成桥接层可以直接安装的段端口。
 *
 * 桥接层(DshAgentExecutor)只要求两个问句:`shouldStartNewSegment` 与
 * `carryOverText`。这里负责把它们接到本插件的段状态上,并保证:
 *
 * - **不需要换段时什么都不做**:判定返回 undefined,桥接层不会释放会话;
 * - **换段通知是唯一带旧话的时机**:在 `carryOverText` 里开新段、暂存旧话;
 *   旧话随后由本插件在那一轮的 pre-step 里作为有来源标记的消息投给模型,
 *   桥接层不替模型组织这段话;
 * - **缺任何一环都降级**:判定失败保持原会话,通知失败只少几句旧话。
 *
 * @param {object} runtime 本插件的运行时实例(由 activate 装配)。
 * @returns {{ shouldStartNewSegment: Function, carryOverText: Function } | undefined}
 *   运行时不可用时返回 undefined,桥接层据此完全退回原行为。
 */
export function segmentPolicyFor(runtime) {
  if (!runtime?.segments) return undefined
  return {
    /**
     * 当前段的只读快照,供状态页与排障使用。
     *
     * 只报事实,不改任何东西:哪个段、绑在哪个 DSH 会话、累计多少 token、
     * 最后一次真实互动在什么时候。桥接层不依赖它。
     */
    describe(sessionKey) {
      const record = runtime.segments.current(sessionKey)
      if (!record) return undefined
      return {
        segment_id: record.segment_id,
        session_id: record.session_id,
        previous_session_id: record.previous_session_id,
        reason: record.reason,
        started_at: record.started_at,
        last_user_at: record.last_user_at,
        tokens: record.tokens,
        exchanges: record.exchanges.length,
      }
    },
    /** 每轮进模型前问一次:该不该换,以及为什么。 */
    shouldStartNewSegment(sessionKey, sessionId) {
      return runtime.segmentSwitchReason(sessionKey, sessionId)
    },
    /** 换段已发生:开新段并记下要带进新会话的旧话。 */
    async carryOverText(sessionKey, previousSessionId, sessionId) {
      const reason = runtime.segmentSwitchReason(sessionKey, previousSessionId) ?? 'policy'
      await runtime.onSegmentSwitched(sessionKey, { previousSessionId, sessionId, reason })
    },
  }
}

/**
 * 一轮的稳定键。
 *
 * 保存与发送回执必须用同一个键,否则核心会拒绝“给尚未提交的轮次记回执”。
 * 键本身由 DSH 会话 id 与该轮真实用户消息 id 决定:两者都由宿主生成,重放
 * 与重连时保持不变。
 */
export function turnKeyOf({ sessionId, turn, messageId, turnMessageId }) {
  const identity = turnMessageId ?? messageId
  if (!sessionId || !identity) return ''
  return `dsh_${stableHash(`${sessionId}:${identity}`)}`
}

/** 这一轮真实的用户输入:优先 bridge 报告的,其次会话里新追加的用户消息。 */
function latestUserInput(agent, payload) {
  if (payload.messages?.some(message => [SPELL_SOURCE, PROACTIVE_SOURCE].includes(message.source?.kind))
    && !payload.messages.some(message => message.source?.kind === 'user')) return undefined
  const candidates = []
  for (const message of payload.messages ?? []) {
    if (message?.role === 'user' && message.source?.kind === 'user') {
      const text = plain(message).trim()
      if (text) candidates.push({ text, messageId: message.id })
    }
  }
  if (candidates.length > 0) return candidates[candidates.length - 1]
  // A resumed turn may carry no fresh input in this step; fall back to the
  // session log, still only for genuine user messages.
  for (const event of agent.session.events ?? []) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = plain(event.data).trim()
    if (text) candidates.push({ text, messageId: event.data.id })
  }
  return candidates[candidates.length - 1]
}

/**
 * 一条记忆条目的稳定指纹:记忆 id 加正文指纹。
 *
 * 用 id 而不是条目序号:同一个 id 的正文被更正后是新的一版,必须重新告知;
 * 正文不变则无论召回多少次、进程重启多少次都只给一次。
 */
function memoryFingerprint(item) {
  const id = String(item?.id ?? '')
  const text = stableText(item?.text)
  return `mem:${id || stableHash(text)}:${stableHash(text)}`
}

/**
 * 指纹用的正文:去掉行尾的“(日期, 几天前)”这类随时间变化的注记。
 *
 * 展示时保留它,但指纹必须稳定——否则同一条记忆隔天就会被当成新条目再贴一次。
 */
function stableText(text) {
  return String(text ?? '').trim().replace(/\s*[（(][^（()）]*[)）]\s*$/, '').trim()
}

/** 一条必须遵守的更正:更正 id 加修订号;修订变化即新内容。 */
function correctionFingerprint(correction) {
  const id = String(correction?.correction_id ?? correction?.id ?? '')
  const revision = String(correction?.revision ?? correction?.version ?? '')
  const text = stableText(correction?.text ?? correction?.new_text ?? '')
  return `cor:${id || stableHash(text)}:${revision || stableHash(text)}`
}

/** 一条近期对话:跨端轮次 id 优先,没有 id 时退回正文指纹。 */
function turnFingerprint(row, index) {
  const id = row?.id ?? row?.data?.id ?? row?.message_id ?? row?.turn_id
  const text = stableText(plain(row?.data ?? row))
  return `turn:${id ? String(id) : (stableHash(text) || String(index))}`
}

/** 一条近期对话属于哪个会话作用域(服务端写在 metadata 里)。 */
function turnScopeId(row) {
  const meta = row?.metadata ?? row?.data?.metadata ?? {}
  return String(meta.session_id ?? meta.sessionId ?? '')
}

/**
 * 召回正文里的逐行条目;去掉序号前缀,正文保持服务给的原文。
 *
 * 记忆 id 只在**行数与 id 数完全对得上**时按位置采用:召回块末尾还会追加
 * source/background 行,它们不是被召回的记忆,错配一个 id 会让两个不同条目
 * 共用一个指纹。对不上时退回正文指纹,仍然稳定,只是少了 id 这一维。
 */
function recallEntries(recall) {
  const block = recall?.block ?? recall?.context ?? (typeof recall === 'string' ? recall : '')
  if (!block) return []
  const ids = Array.isArray(recall?.items)
    ? recall.items.map(item => String(item?.id ?? ''))
    : (Array.isArray(recall?.memory_ids) ? recall.memory_ids.map(String) : [])
  const lines = String(block)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const aligned = ids.length === lines.length
  return lines.map((line, index) => {
    const id = aligned ? (ids[index] ?? '') : ''
    const text = line.replace(/^\d+[.、]\s*/, '')
    return { id, text, fingerprint: memoryFingerprint({ id, text }) }
  })
}

/**
 * `context.corrections` 既可能是条目数组,也可能只有渲染好的 block。
 *
 * 有 items 时优先用它们:每条带自己的 correction_id,正文被改写就是新条目。
 * 只有 block 时按行拆,并跳过渲染器加的标题行(【当前认识与偏好】之类),
 * 否则标题会被当成一条永不变化、也永远删不掉的更正。
 */
function correctionEntries(corrections) {
  if (!corrections) return []
  if (Array.isArray(corrections.items) && corrections.items.length > 0) {
    return corrections.items
      .map(item => ({
        text: String(item?.text ?? item?.new_text ?? '').trim(),
        fingerprint: correctionFingerprint(item),
      }))
      .filter(entry => entry.text)
  }
  const block = String(corrections.block ?? '').trim()
  if (!block) return []
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^[【\[][^】\]]*[】\]]$/.test(line))
    .map(line => ({
      text: line.replace(/^\d+[.、]\s*/, '').replace(/^[-*]\s*/, ''),
      fingerprint: correctionFingerprint({
        correction_id: stableHash(stableText(line)),
        revision: String(corrections.version ?? ''),
        text: line,
      }),
    }))
}

/** 状态桶的显示名。顺序即渲染顺序,与核心的 STATE_KINDS 一致。 */
const STATE_LABELS = Object.freeze({
  thoughts: '想法',
  moods: '情绪',
  concerns: '关注',
  progress: '进展',
})

/** 她自己当下的状态(想法/情绪);其余两桶是"进行中的事",另归一段。 */
const SELF_STATE_KINDS = Object.freeze(['thoughts', 'moods'])

/**
 * 一条工作摘要条目的指纹。
 *
 * 用条目 id 加正文哈希:同一条被改写(例如规则重新措辞、事实被更正)就是新的
 * 一版,必须重新告知;正文不变则无论重连、重启多少次都只交付一次。
 */
function summaryFingerprint(prefix, id, text) {
  const stable = stableText(text)
  return `${prefix}:${id || stableHash(stable)}:${stableHash(stable)}`
}

/**
 * 工作摘要里的一段(成长与关系 / 重要事实 / 未完话题)→ 可渲染的条目。
 *
 * 摘要段自带 `block` 整段文本,但整段会把三段混在一起,无法分别控制;这里只
 * 认 `items`:每条有 id 与正文,才能给出稳定指纹,也才能既渲染又去重。
 */
function summaryEntries(section, prefix) {
  const items = Array.isArray(section?.items) ? section.items : []
  const entries = []
  for (const item of items) {
    const text = String(item?.text ?? '').trim()
    if (!text) continue
    // 规则/变化/认识/关系条目带 label("约好""变化"…),显示出来更清楚。
    const label = String(item?.label ?? '').trim()
    const id = String(item?.id ?? item?.rule_id ?? item?.thread_id ?? '')
    entries.push({
      text: label ? `${label}：${text}` : text,
      fingerprint: summaryFingerprint(prefix, id, text),
    })
  }
  return entries
}

/** 未完话题的显示:进行中/等消息是两种不同的跟进状态,别混成一句。 */
function threadEntries(section) {
  const items = Array.isArray(section?.items) ? section.items : []
  const entries = []
  for (const item of items) {
    const text = String(item?.text ?? '').trim()
    if (!text) continue
    const state = String(item?.state ?? 'open')
    const marker = state === 'waiting' ? '等消息' : (state === 'done' ? '已结束' : '进行中')
    const next = String(item?.next_step ?? '').trim()
    const id = String(item?.thread_id ?? item?.id ?? '')
    entries.push({
      text: `[${marker}] ${text}${next ? `，下一步：${next}` : ''}`,
      fingerprint: summaryFingerprint('thread', id, text),
    })
  }
  return entries
}

/**
 * 退回用召回自带的成长块(老版本服务只有 block,没有 working_summary)。
 *
 * 按行拆并跳过标题行:标题("相处与成长"之类)不是条目,给它一个指纹会变成一条
 * 永远不会变、也永远删不掉的假条目。
 */
function growthBlockEntries(growth) {
  const block = String(growth?.block ?? '').trim()
  if (!block) return []
  const version = String(growth?.version ?? '')
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^[【\[][^】\]]*[】\]]$/.test(line))
    .map(line => {
      const text = line.replace(/^[-*]\s*/, '')
      return { text, fingerprint: summaryFingerprint('growtext', version, text) }
    })
}

/**
 * 真实状态快照 → 两类条目。
 *
 * 刻意**不用** `state.block`:那一段把情绪强度按衰减渲染成数字,每过一小时就
 * 变一次,拿它做指纹会让同一条状态永远"是新的"。这里按桶自己渲染,指纹只认
 * 标签与正文。
 *
 * `self` 是她自己的当下(想法、情绪),换话题不影响; `threads` 是进行中的事
 * (关注、进展),属于"旧事项",是否需要让模型看见由增量与去重决定。
 */
function stateEntries(state) {
  const buckets = state && typeof state.state === 'object' && state.state ? state.state : {}
  const self = []
  const threads = []
  for (const kind of Object.keys(STATE_LABELS)) {
    const rows = Array.isArray(buckets[kind]) ? buckets[kind] : []
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue
      let text = ''
      let key = ''
      if (kind === 'moods') {
        const label = String(item.label ?? '').trim()
        if (!label) continue
        const cause = String(item.cause ?? '').trim()
        // 强度会随时间衰减,不进正文也不进指纹:那不是"新状态",只是旧状态变淡。
        text = cause ? `${label}（因为${cause}）` : label
        key = `mood:${stableHash(label)}:${stableHash(cause)}`
      } else {
        text = String(item.text ?? '').trim()
        if (!text) continue
        key = `${kind}:${stableHash(stableText(text))}`
      }
      const id = String(item.id ?? '')
      const entry = {
        text: `${STATE_LABELS[kind]}：${text}`,
        fingerprint: `state:${key}:${id}`,
      }
      if (SELF_STATE_KINDS.includes(kind)) self.push(entry)
      else threads.push(entry)
    }
  }
  return { self, threads }
}

/**
 * 「这段经历」段。
 *
 * 一次经历是一条**整体**:把它拆成逐行条目会在只改一行时把整段重贴一遍,所以
 * 整段一个指纹,内容(结果、终态、后续时间)变了才算新的一版。
 */
function episodeEntries(context) {
  const section = context?.working_summary?.sections?.episode
  const block = String(section?.block ?? '').trim()
  if (!block) return []
  const item = Array.isArray(section?.items) ? section.items[0] : undefined
  const id = String(
    item?.episode_id
    ?? context?.working_summary?.episode?.episode_id
    ?? context?.episode?.episode_id
    ?? '',
  )
  // 第一行是段自己的标题("这段经历"),由本插件给段名,所以去掉。
  const body = block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(1)
    .filter(line => !/^【?这段经历】?$/.test(line))
  if (body.length === 0) return []
  const joined = body.join('|')
  return [{
    text: body.join('\n'),
    fingerprint: summaryFingerprint('epi', id, joined),
  }]
}

/**
 * 只渲染本轮新的增量背景,并给出本轮材料的指纹。
 *
 * `seen` 是**确实已注入过**的指纹集合。函数是纯的:同一份 context 与同一份
 * seen 一定得到同一段正文与同一批指纹,调用方才能安全地在真正注入之后
 * 才登记它们。没有任何新增时 `text` 为空串——调用方不追加任何消息。
 *
 * 八段材料,前三段是最初就有的(必须遵守的更正 / 可能相关的记忆 / 近期对话),
 * 后五段(相处与成长 / 重要事实 / 当前状态 / 正在进行的事 / 这段经历)是 M6 加的
 * 工作摘要层(设计 §10.1 的第二层"当前工作摘要")。它们和前三段**同一条纪律**:
 * 只有本轮真的没交付过的条目才进正文,已交付的不重贴。
 *
 * 这条纪律同时也是"不破坏新话题"的机制:旧事项在它第一次被交付之后就再也不会
 * 出现在后续轮次的材料里,所以用户换话题时不会有一堆旧事被硬拉回来。真正的
 * 续接由服务端的召回与 followup 判定负责,不靠这里每轮复读。
 */
export function renderIncrement(context, seen = {}, options = {}) {
  const query = typeof options.currentInput === 'string'
    ? options.currentInput.replace(/\[图片\d+[^\]]*\]/gu, '').trim() : undefined
  const minimal = context?.material_policy?.minimal === true || (query !== undefined
    && (!query || /^(?:在吗|你好|早|晚安|看看这张图|你看这个)[？?！!。]*$/u.test(query)))
  const represented = [context?.persona ?? '', options.representedText ?? '']
    .flatMap(text => String(text).split('\n'))
    .map(text => stableText(narrativeMemoryText(text))).filter(Boolean)
  const isRepresented = text => {
    const clean = stableText(narrativeMemoryText(text))
    return clean.length > 3 && represented.some(line => line.includes(clean))
  }
  const scopeId = options.scopeId ?? ''
  const sections = []
  const fingerprints = []
  const fresh = entries => {
    const picked = []
    for (const entry of entries) {
      if (!entry.text || seen[entry.fingerprint]) continue
      if (picked.some(row => row.fingerprint === entry.fingerprint)) continue
      picked.push(entry)
    }
    return picked
  }

  const corrections = fresh(correctionEntries(context?.corrections))
  if (corrections.length > 0) {
    sections.push(['[必须遵守的更正]', ...corrections.map(entry => entry.text)].join('\n'))
    for (const entry of corrections) fingerprints.push(entry.fingerprint)
  }

  const memories = minimal ? [] : fresh(recallEntries(context?.context)).filter(entry => !isRepresented(entry.text))
  if (memories.length > 0) {
    sections.push(['[可能相关的记忆]', ...memories.map(entry => entry.text)].join('\n'))
    for (const entry of memories) fingerprints.push(entry.fingerprint)
  }

  // 近期对话只补“本会话历史里已经没有的那一端”:服务端按 (subject, scene) 把
  // 别的端(例如网页会话)的轮次也放进来,那才是 DSH 里看不到的材料;本会话
  // 自己的消息已经在上下文里,再贴一次就是重复。
  const selfScope = String(scopeId ?? '')
  const recent = (minimal ? [] : Array.isArray(context?.recent_turns) ? context.recent_turns : [])
    .filter(row => {
      const owner = turnScopeId(row)
      return !owner || !selfScope || owner !== selfScope
    })
    .slice(-6)
  const recentEntries = fresh(recent.map((row, index) => ({
    text: (() => {
      const text = plain(row?.data ?? row).trim()
      return text ? `${row?.type === 'human' ? '主人' : '我'}:${text}` : ''
    })(),
    fingerprint: turnFingerprint(row, index),
  })))
  if (recentEntries.length > 0) {
    sections.push(['[近期对话]', ...recentEntries.map(entry => entry.text)].join('\n'))
    for (const entry of recentEntries) fingerprints.push(entry.fingerprint)
  }

  // M6:工作摘要层。服务端 M5 之后在 /v1/context 上 additive 多给了
  // working_summary / state / episode;老版本服务没有这些字段时下面的 helper
  // 各自返回空数组,渲染结果与改造前逐字节相同。
  const summary = context?.working_summary
  const growth = fresh([
    ...summaryEntries(summary?.sections?.growth, 'grow'),
    // 只有服务没给 working_summary 时才退回旧的可操作成长块,避免同一批认识
    // 被两个来源各交付一次。
    ...(summary?.sections?.growth ? [] : growthBlockEntries(context?.growth)),
  ])
  if (growth.length > 0) {
    sections.push(['[相处与成长]', ...growth.map(entry => entry.text)].join('\n'))
    for (const entry of growth) fingerprints.push(entry.fingerprint)
  }

  // 同一条事实常常既被召回命中、又出现在重要事实摘要里。摘要只是投影,召回
  // 才是这一轮的针对性结果;两段都贴一遍等于同一句话给模型看两次,还会让它
  // 误以为是很重要而反复强调的事。所以正文已经出现过的条目在摘要段里让位。
  // 同一句话在两处的写法常不一样(召回是"用户喜欢红茶",摘要是"喜欢红茶"),
  // 所以按**互相包含**判定重复,而不是精确相等。
  const spoken = memories
    .map(entry => stableText(entry.text.replace(/^[-*]\s*/, '')))
    .filter(Boolean)
  const alreadySaid = text => {
    const clean = stableText(text)
    if (!clean) return false
    return spoken.some(line => line.includes(clean) || clean.includes(line))
  }
  const facts = fresh(summaryEntries(summary?.sections?.important_facts, 'fact'))
    .filter(entry => !minimal && !alreadySaid(entry.text) && !isRepresented(entry.text)).slice(0, 3)
  if (facts.length > 0) {
    sections.push(['[重要事实]', ...facts.map(entry => entry.text)].join('\n'))
    for (const entry of facts) fingerprints.push(entry.fingerprint)
  }

  const { self, threads } = stateEntries(context?.state)
  const selfEntries = fresh(self)
  if (selfEntries.length > 0) {
    // 她自己的状态:想法与情绪。这是"此刻"而不是"旧事",换话题也仍然成立。
    sections.push(['[当前状态]', ...selfEntries.map(entry => entry.text)].join('\n'))
    for (const entry of selfEntries) fingerprints.push(entry.fingerprint)
  }

  // 进行中的事与未完话题单独一段:它们是"旧事项",只在第一次真正交付时出现。
  const pendingThreads = minimal ? [] : fresh([
    ...threads,
    ...threadEntries(summary?.sections?.open_threads),
  ])
  if (pendingThreads.length > 0) {
    sections.push(['[正在进行的事]', ...pendingThreads.map(entry => entry.text)].join('\n'))
    for (const entry of pendingThreads) fingerprints.push(entry.fingerprint)
  }

  const episode = minimal ? [] : fresh(episodeEntries(context))
  if (episode.length > 0) {
    sections.push(['[这段经历]', ...episode.map(entry => entry.text)].join('\n'))
    for (const entry of episode) fingerprints.push(entry.fingerprint)
  }

  if (sections.length === 0) return { text: '', fingerprints: [] }
  // header 只在真有增量时出现:正常轮次(没有新增材料)完全没有任何附加消息。
  // 用记事标题区分回忆与主人本轮发言。
  const narrative = sections.map(section => section.startsWith('[近期对话]')
    ? section : narrativeMemoryText(section)).join('\n\n')
  return { text: `${MATERIAL_NOTE}\n${narrative}`, fingerprints }
}

/** 展示时使用角色视角；引号内保留原话，来源正文和指纹保持原样。 */
export function narrativeMemoryText(text) {
  return String(text).split(/(“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*")/gu)
    .map((part, index) => index % 2 ? part : part
      .replace(/^(\s*(?:[-•]\s*)?)用户(?=[\p{Script=Han}:：，。\s])/gmu, '$1主人')
      .replace(/^(\s*(?:[-•]\s*)?)助手(?=[\p{Script=Han}:：，。\s])/gmu, '$1我')
      .replace(/((?:其他|其它|别的|另一个|另一位)\s*)?助手的/gu,
        (phrase, other) => other ? phrase : '我的')
      .replace(/(为|给|向|让|请|希望|要求|告诉)助手(?=[\p{Script=Han}，。\s])/gu, '$1我'))
    .join('')
}

function requirePersona(context) {
  if (!context?.persona?.trim() || !context.persona_version || typeof context.corrections?.block !== 'string') {
    throw new Error('记忆服务没有返回已发布人格或必需更正')
  }
}

function describeFailure(error) {
  if (!error) return '未知错误'
  const kind = error.kind ?? 'fatal'
  const code = error.code ?? ''
  if (kind === 'config') return `身份被拒绝（${code || 'unauthorized'}），请检查客户端令牌与授权`
  if (kind === 'retry') return `服务不可达或忙（${code || 'transport'}），稍后自动重试`
  if (kind === 'stale') return '记忆依据已变化，需要重新取得上下文'
  if (kind === 'gone') return '内容已被删除，旧正文不再重放'
  if (kind === 'conflict') return `同键不同内容（${code || 'conflict'}）`
  return code ? `请求失败（${code}）` : (error.message ?? '请求失败')
}

function transportOf(platform) {
  return platform === 'napcat' ? 'qq_napcat' : 'qq_official'
}

export {
  MemoryRuntime, MEMORY_RULES, MEMORY_SOURCE, PERSONA_SECTION, RULES_CHAR_LIMIT, RULES_SECTION,
  configProblems, normalizeConfig, sessionScopeId,
}
