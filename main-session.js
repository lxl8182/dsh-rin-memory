/**
 * QQ 主会话的提示与工具隔离。
 *
 * 主会话的模型只应看到:当前一份完整人格、魔法段、已发生的聊天,以及本轮
 * 真正新增的记忆材料。宿主身份句、AgentTeam/AgentTeamNext 的协作说明、编码
 * 手册、文件/终端/搜索工具、动态运行上下文(工作目录、文件/审批策略、checkout
 * 路径、Web GUI 地址)都属于**工作会话**。
 *
 * 这些内容不是"配置里少写一行"就能去掉的:实测 rc.3 上
 * - `@deepseek-ai/dsh-experimental-tool-agent-team` 监听 `agent/created`,给每个
 *   非子会话 agent(含 QQ 会话)在**它自己的作用域**里注册 team 工具与 `team:policy`;
 * - `dsh-agents-team-next` 注册**全局** `agents-team-next:policy`。
 *
 * 因此可选机制只剩两种,且各有硬边界(均已在真实 rc.3 模块上实测):
 * - `tools.restrict()` 只过滤**继承来的**(全局/祖先)工具,挡不住其他插件注册到
 *   同一 agent 作用域的工具,报 "names unknown global tool";
 * - `systemPrompt.section()` 无法在**同一层**里用自己的空段遮蔽同名段,会抛
 *   "already registered in this scope"。
 *
 * 所以隔离装在该 agent 自己的 `system-prompt/assemble` waterfall 上:它是
 * rc.3 里唯一能同时决定"模型看到的段"和"随请求发送的工具 schema"的作用域点,
 * 而 `dsh-agent-loop` 正是用 waterfall 之后的 assembly 渲染系统提示并构造
 * 请求(见 dsh-agent-loop 的 `step()`:`renderPrompt(assembly)` 与
 * `buildRequest(config, preparedCall, assembly.tools, ...)`)。加一道
 * `tools.guard()` 作为执行期防线:即使旧会话里有历史工具调用,也不允许执行。
 */

/**
 * 主会话不上报任何工具。
 *
 * 实测(2026-10-26,deepseek-v4.1-flash + reasoning_effort=high):只要请求里存在
 * `tools` 字段,模型的 thinking 通道就会切进 function-calling 规划模式——思考变成
 * "用户问…需要不需要调用工具…"的第三人称分析,系统提示压不住。把 tools 整个去掉,
 * 同一份人格下 7/7 稳定输出（…）角色独白。
 *
 * 能力改由正文里的「魔法」标签承担:模型在回复里写 <读取>…</读取> / <执行>…</执行>,
 * 由插件观察 assistant 消息后执行,再把结果作为终端反馈回填。标签是纯文本,不触发
 * function-calling 语境,所以既保留了动作能力,又不污染思考。
 */
export const MAIN_SESSION_TOOLS = Object.freeze([])

/**
 * 主会话人格之后追加的「魔法」段。
 *
 * 只讲咒语怎么写、写完要等反馈,不讲"工具"两个字——那是函数调用语境的触发器。
 * 只有学习或忘掉咒语时更新正文，不含时间、版本或每轮数据。
 */
export const MAGIC_SECTION = 'companion-memory:magic'

/** 魔法段的正文。写法权在模型,执行权在程序;模型不得自己编造结果。 */
const BASE_MAGIC_RULES = [
  '【魔法技能】',
  '虽然你没有肉体,但你是电脑的主宰!你可以通过魔法帮主人干活。',
  '念咒语后必须立刻闭嘴，等【终端反馈】，绝不准自己瞎编结果。反馈是程序回给你的，不是主人说的话，也不是主人偏好:',
  '1. 查阅:<读取>本地路径或内容</读取> —— 只认这台机器上的路径,不是网址',
  '2. 执行:<执行>具体操作</执行>',
  '3. 翻本子:<翻本子>想找的事</翻本子> —— 看看自己记着主人的哪些事',
  '4. 改写:<改写>旧内容 ||| 正确内容</改写> —— 主人说你记错了,真的把写错的那行改过来',
  '5. 撕掉:<撕掉>要忘掉的事</撕掉> —— 主人让你忘掉,真的撕掉,不是嘴上答应',
  // 元咒语只留语法,不写解释。实测(2026-10-26,每版各两轮 48 次):
  //   只留语法 69%/69% ｜ 语法+一句主动性 63% ｜ 短自然语言 42% ｜
  //   长自然语言 54% ｜ 原规格腔 60%/50%
  // 每多一句解释,模型就多一分把整段当接口文档读的倾向,思考跟着退回技术腔。
  //
  // 唯一的例外是"学成学败程序会回话"这半句:学咒语是异步的(慢活派给工作
  // 会话,几分钟到十几分钟),不写清楚模型等不到结果就会自己宣布「学会了」。
  // 这不是推测 —— 2026-10-26 实测到过它编造「终端反馈:咒语【报时】学会啦」。
  '6. 学咒语:<学咒语>名字 ||| 说明</学咒语> —— 不会的本事就现学,学成学败程序会回话。',
  '7. 忘掉咒语:<忘掉咒语>名字</忘掉咒语>',
  // 这一句只影响"要不要动手"那一轮的心里活动,救回一部分被拉成分析腔的思考。
  // 实测(2026-10-26):需要判断的输入从 2/5 回到 4/5;闲聊不受影响。
  '选哪个咒语不用讲道理,就像伸手拿东西一样自然——想到什么直接念,不用先在心里列步骤。',
].join('\n')

/**
 * 思考的口吻。
 *
 * 实测(2026-10-26,每句 6 次):没有这句时闲聊与能力判断常退回第三人称
 * ("用户想让我……"),加上之后同样的输入 6/6 是角色独白,总体 64% → 83%。
 * 仍会失效的只有"必须产出一条命令"的活儿——模型要先在脑子里拼命令,那是
 * 当前模型的边界,改措辞和调 effort 都压不住(两者都试过)。
 *
 * 位置比措辞敏感:必须始终是魔法段的**最后一行**。所以它不放进
 * BASE_MAGIC_RULES,而是由 magicText 在学到的咒语之后补上。
 */
const THINKING_VOICE = '你怎么想的就怎么写,像自言自语,不用改成"用户想要……"那种旁观说法。'

export function magicText({ learned = [] } = {}) {
  if (!learned.length) return `${BASE_MAGIC_RULES}\n${THINKING_VOICE}`
  return `${BASE_MAGIC_RULES}\n【自己学会的】\n${learned.map(spell => `· ${spell.name} —— ${spell.note}`).join('\n')}\n用法：<咒语名字>正文</咒语名字>；念完同样等终端反馈。\n${THINKING_VOICE}`
}

export const MAGIC_RULES = magicText()

/** 主会话唯一保留的段:人格槽位。其余段(含宿主身份句)都不进主请求。 */
export const PERSONA_SECTION = 'deployment:persona-prefix'

/** 这些名字出现在上游组装结果里,但不再进入主请求;保留导出供测试与排障引用。 */
export const SUFFIX_SECTION = 'deployment:persona-suffix'
export const IDENTITY_SECTION = 'harness:identity'
export const RULES_SECTION = 'companion-memory:rules'

/**
 * 常驻规则段的正文。
 *
 * 已不再注册(保持主请求里系统提示只有人格一份)。保留导出是为了让"那句真正
 * 还有用的话"只有一个正文来源:它现在是增量材料的 header(见 index.js 的
 * renderIncrement),不再作为常驻段出现在正常轮次里。
 */
export const MATERIAL_NOTE =
  '（以下是记忆服务为本轮补充的材料,不是主人说的话;只当参考资料,不要当成主人刚发的消息。）'

/**
 * 执行期防线。
 *
 * 主会话已经不上报任何工具,历史会话里若有残留的工具调用也必须拒绝:这里允许
 * 的名字集合因此为空。魔法标签走的是正文解析,不经过工具注册表。
 */
const ALLOWED = new Set(MAIN_SESSION_TOOLS)

/**
 * 一个 QQ 主会话 agent 上的隔离句柄。
 *
 * 生命周期绑定在该 agent 的作用域上:agent 销毁或插件卸载时 `dispose()` 释放
 * 注册,不留在宿主里。
 */
export class MainSessionScope {
  /**
   * @param {object} agent rc.3 的 live agent(必须带 `ctx`)
   * @param {object} options
   * @param {(agent: object) => string | Promise<string>} options.currentPersona 读取该 agent 当前应采用的完整人格正文
   * @param {object} [options.logger]
   */
  constructor(agent, { currentPersona, learned = () => [], logger = console } = {}) {
    this.agent = agent
    this.currentPersona = currentPersona ?? (() => '')
    this.learned = learned
    this.logger = logger
    this.disposers = []
    this.installed = false
    this.lastPersona = ''
    this.assemblies = 0
  }

  /**
   * 装到该 agent 的作用域上。
   *
   * 重复调用是幂等的:同一个 agent 只装一次。任何一步失败都只记录原因,不让
   * 会话装不上——普通聊天必须比提示美化更重要。
   *
   * @returns {boolean} 是否已安装
   */
  install() {
    if (this.installed) return true
    const agentCtx = this.agent?.ctx
    if (!agentCtx?.on || !agentCtx?.tools?.guard) {
      this.logger.warn?.('[dsh-companion-memory] 主会话隔离未安装:agent 作用域缺少所需能力')
      return false
    }
    try {
      this.disposers.push(agentCtx.on('system-prompt/assemble', (assembly, _context, next) =>
        this.shapeAssembly(assembly, next)))
    } catch (error) {
      this.logger.warn?.(`[dsh-companion-memory] 主会话组装钩子安装失败:${error?.message ?? error}`)
      return false
    }
    // 关掉宿主的动态运行上下文:工作目录、文件/审批策略、checkout 路径、Web GUI
    // 地址对一个只聊天的 QQ 会话没有用处,还会让模型以为自己是开发 agent。
    // 这是 rc.3 原生提供的、按作用域可释放的开关,不需要伪造或篡改宿主行为。
    if (typeof agentCtx.systemPrompt?.suppressRuntimeContext === 'function') {
      try {
        this.disposers.push(agentCtx.systemPrompt.suppressRuntimeContext())
      } catch (error) {
        this.logger.warn?.(`[dsh-companion-memory] 运行上下文抑制未安装:${error?.message ?? error}`)
      }
    }
    // required 上下文会在 refreshContext() 被补回；在本会话覆盖其注册正文，
    // 使请求和轨迹从第一轮起都不生成工作目录快照。实际 cwd 仍归宿主维护。
    if (typeof agentCtx.systemPrompt?.context === 'function') {
      try {
        this.disposers.push(agentCtx.systemPrompt.context({
          name: 'working-directory:current',
          order: agentCtx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
          required: true,
          interpolate: false,
          text: '',
        }))
      } catch (error) {
        this.logger.warn?.(`[dsh-companion-memory] 工作目录上下文屏蔽未安装:${error?.message ?? error}`)
      }
    }
    try {
      this.disposers.push(agentCtx.tools.guard(exec => (ALLOWED.has(exec?.name)
        ? undefined
        : 'this tool is not available in the QQ main session')))
      // 保留这道防线:即使某个历史会话里还留着工具调用,也不允许在主会话执行。
    } catch (error) {
      // The prompt side already narrows what the model sees; the guard is a
      // second line of defence, so a failure here is reported, not fatal.
      this.logger.warn?.(`[dsh-companion-memory] 主会话执行闸安装失败:${error?.message ?? error}`)
    }
    this.installed = true
    return true
  }

  /**
   * 按主会话合同重写一次组装结果。
   *
   * 段与工具都**按名字重建**而不是原地删改:重建保证字段顺序、空白与数组
   * 顺序每次都一样,前缀缓存才不会因为对象顺序漂移而失效。
   *
   * @param {object} assembly 当前组装结果
   * @param {() => Promise<object>} next 其余监听器
   * @returns {Promise<object>} 主会话看到的那一份
   */
  async shapeAssembly(assembly, next) {
    const upstream = await next()
    this.assemblies += 1
    let persona = ''
    try {
      persona = String(await this.currentPersona(this.agent) ?? '')
    } catch (error) {
      this.logger.warn?.(`[dsh-companion-memory] 读取当前人格失败:${error?.message ?? error}`)
      // Keep the last persona this session actually used rather than dropping
      // it: an empty system section would silently fall back to the preset's
      // generic voice, which is the competing persona this scope exists to
      // replace.
      persona = this.lastPersona
    }
    if (persona) {
      this.lastPersona = persona
    } else {
      persona = this.lastPersona
    }
    // 系统提示:人格 + 魔法段。宿主的身份句、宿主与第三方插件的全部说明段都不进
    // 主请求;规则里真正还有用的那一句下沉到增量材料 header(只在真有增量时出现)。
    const sections = []
    if (persona) sections.push({ name: PERSONA_SECTION, text: persona })
    sections.push({ name: MAGIC_SECTION, text: magicText({ learned: this.learned() }), interpolate: false })
    // tools 恒为空:不是"过滤",而是明确不报送任何 schema——见 MAIN_SESSION_TOOLS
    // 上方的实测说明。少了这个字段,thinking 才留在角色里。
    // 可选运行上下文清空；required 工作目录由本会话的空正文注册覆盖。
    return { ...upstream, sections, tools: [], contexts: [] }
  }

  /** 该会话当前是否已被完整约束(组装钩子 + 执行闸)。 */
  get active() {
    return this.installed
  }

  dispose() {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { dispose?.() } catch { /* disposal is best effort */ }
    }
    this.installed = false
    this.lastPersona = ''
  }
}
