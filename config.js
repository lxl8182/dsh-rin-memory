/**
 * 记忆插件的配置。
 *
 * 这里只声明**插件自己**知道的事:连哪个服务、用哪个身份、绑定哪个会话。
 * QQ 账号、Admin OpenID、白名单与工具设置仍归 QQ bridge / DSH 设置,本插件
 * 只读取 bridge 校验过的结果,不重复声明也不必复制。
 *
 * 凭据只有变量名:`tokenEnv` 指向一个环境变量,`tokenFile` 可选指向服务端
 * 受限的 `client_tokens.json`。密钥本身不进配置、提示词、日志或源码。
 */

/**
 * @typedef {object} MemoryPluginConfig
 * @property {boolean} enabled 总开关。默认关闭:安装不等于启用。
 * @property {boolean} proactiveEnabled 是否消费服务的主动候选并唤醒主会话。
 * @property {string} url rin-memory 服务地址;只接受本机回环 HTTP。
 * @property {string} clientId 在服务端 stack.toml 里配置的客户端 id。
 * @property {string} characterId 读取记忆与人格的角色。
 * @property {string} subject 主体。个人记忆默认 `private`,群里不自动接入。
 * @property {string} pluginId 服务端绑定的插件 id,决定 source_key 与清理待办归属。
 * @property {string} tokenEnv 存放客户端令牌的环境变量**名**。
 * @property {string} tokenFile 可选:服务端受限令牌文件,只读取 `tokenEnv` 对应的值。
 * @property {number} timeoutMs 单次 HTTP 请求超时。
 * @property {string[]} sessionPrefixes 只有这些前缀的 DSH 会话才接入个人记忆。
 * @property {boolean} memoryTools 是否允许从对话里执行受限更正/遗忘。
 * @property {string} stateDirectory 持久队列落盘目录;留空表示使用 profile 插件数据目录。
 * @property {string} sessionsDirectory DSH 会话日志根;留空表示 `<profile home>/sessions`。
 * @property {number} maxPending 补交队列上限;满时明确报错而不是丢轮次。
 * @property {number} retryIntervalMs 后台补交与清理轮询间隔。
 * @property {boolean} retireSessionsOnCleanup 清理待办存在时是否退役旧 DSH 会话。
 */

/** @type {MemoryPluginConfig} */
export const DEFAULT_CONFIG = {
  enabled: false,
  url: 'http://127.0.0.1:48931',
  clientId: 'dsh-desktop',
  characterId: 'companion',
  subject: 'private',
  pluginId: 'dsh_memory',
  tokenEnv: 'COMPANION_DSH_TOKEN',
  tokenFile: '',
  timeoutMs: 10000,
  sessionPrefixes: ['qq-'],
  memoryTools: true,
  proactiveEnabled: true,
  stateDirectory: '',
  sessionsDirectory: '',
  maxPending: 256,
  retryIntervalMs: 15000,
  retireSessionsOnCleanup: true,
}

const BOOLEAN_FIELDS = ['enabled', 'memoryTools', 'retireSessionsOnCleanup', 'proactiveEnabled']
const NUMBER_FIELDS = ['timeoutMs', 'maxPending', 'retryIntervalMs']
const STRING_FIELDS = [
  'url', 'clientId', 'characterId', 'subject', 'pluginId',
  'tokenEnv', 'tokenFile', 'stateDirectory', 'sessionsDirectory',
]

/**
 * 把外部(设置页/组合配置)传来的值收敛成一份自洽配置。
 *
 * 越界的数字与空的关键字符串回落到默认值而不是让插件启动失败:配置错误应当
 * 表现为“连接状态里写着缺什么”,而不是整个 Host 装不上。允许的例外是明显的
 * 类型错误(数组不是数组),那属于组合写坏了。
 *
 * @param {unknown} options
 * @returns {MemoryPluginConfig}
 */
export function normalizeConfig(options) {
  const value = typeof options?.get === 'function' ? options.get() : options
  const raw = (typeof value === 'object' && value !== null ? value : {})
  const config = { ...DEFAULT_CONFIG }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof raw[field] === 'boolean') config[field] = raw[field]
  }
  for (const field of NUMBER_FIELDS) {
    const value = raw[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) config[field] = Math.floor(value)
  }
  for (const field of STRING_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string') config[field] = value.trim()
  }
  const prefixes = raw.sessionPrefixes
  if (Array.isArray(prefixes)) {
    config.sessionPrefixes = prefixes
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  } else if (prefixes !== undefined) {
    throw new TypeError('sessionPrefixes must be a list of session id prefixes')
  }
  if (!Array.isArray(config.sessionPrefixes) || config.sessionPrefixes.length === 0) {
    config.sessionPrefixes = [...DEFAULT_CONFIG.sessionPrefixes]
  }
  return config
}

/**
 * 明确的配置缺口。空数组表示可以尝试连接。
 *
 * “缺凭据”与“连不上”是两种不同的状态,不能都显示成未接通:前者要用户去补
 * 环境变量,后者要用户去看服务。
 *
 * @param {MemoryPluginConfig} config
 * @param {string | undefined} token
 * @returns {string[]}
 */
export function configProblems(config, token) {
  const problems = []
  if (!config.url) problems.push('缺少服务地址 url')
  else {
    try {
      const parsed = new URL(config.url)
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
        problems.push('只允许无内嵌凭据的 http://127.0.0.1 地址')
      }
    } catch {
      problems.push('服务地址不是合法 URL')
    }
  }
  if (!config.characterId) problems.push('缺少角色 characterId')
  if (!config.subject) problems.push('缺少主体 subject')
  if (!config.clientId) problems.push('缺少客户端身份 clientId')
  if (!config.pluginId) problems.push('缺少插件标识 pluginId')
  if (!config.tokenEnv) problems.push('缺少令牌变量名 tokenEnv')
  else if (!token) problems.push(`环境变量 ${config.tokenEnv} 中没有客户端令牌`)
  return problems
}
