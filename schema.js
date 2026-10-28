/**
 * 原生 Config:让插件出现在 DSH 设置页,而不是只能手改 profile 补丁。
 *
 * `@deepseek-ai/schemastery` 是 peer 依赖,由宿主的依赖树提供;本包声明同一版本
 * (3.18.5),不打包它的实现。
 *
 * 两件事必须分开:
 * - `Config` 是**完整**的运行时 schema,宿主据此校验并保存字段;
 * - `.volatile()` 标记后设置页才会显示可编辑字段。不加时设置页收到普通对象,
 *   保存不会作用到运行中的插件(QQ bridge 踩过同一个坑)。
 *
 * 凭据永远只有变量名或受限文件路径,不在这里出现值。
 */
import Schema from '@deepseek-ai/schemastery'
import { CONTACT_DEFAULTS } from './contact.js'

const secret = field => (typeof field.role === 'function' ? field.role('secret') : field)

const Config = Schema.object({
  contact: Schema.object({
    timezone: Schema.string().default(CONTACT_DEFAULTS.timezone),
    dailyLimit: Schema.number().default(CONTACT_DEFAULTS.dailyLimit),
    minGapMinutes: Schema.number().default(CONTACT_DEFAULTS.minGapMinutes),
    quietStart: Schema.number().default(CONTACT_DEFAULTS.quietStart),
    quietEnd: Schema.number().default(CONTACT_DEFAULTS.quietEnd),
    followupHours: Schema.number().default(CONTACT_DEFAULTS.followupHours),
    materialRefreshMinutes: Schema.number().default(CONTACT_DEFAULTS.materialRefreshMinutes),
    sources: Schema.array(Schema.string()).default([...CONTACT_DEFAULTS.sources]),
  }).default({ ...CONTACT_DEFAULTS }).description('主动交流的时区、频率上限和公开素材来源。'),
  enabled: Schema.boolean()
    .default(false)
    .description('启用后接入铃芽 RIN：采用已发布人格、读取记忆并保存真实轮次。默认关闭。'),
  url: Schema.string()
    .default('http://127.0.0.1:48931')
    .description('rin-memory 服务地址；只接受本机回环 HTTP。'),
  clientId: Schema.string()
    .default('dsh-desktop')
    .description('服务端 stack.toml 中配置的客户端 id。'),
  characterId: Schema.string()
    .default('companion')
    .description('读取人格与记忆的角色。'),
  subject: Schema.string()
    .default('private')
    .description('记忆主体。个人记忆默认 private。'),
  pluginId: Schema.string()
    .default('dsh_memory')
    .description('服务端绑定的插件 id，决定来源键与清理待办归属。'),
  tokenEnv: Schema.string()
    .default('COMPANION_DSH_TOKEN')
    .description('存放客户端令牌的环境变量名。'),
  tokenFile: secret(Schema.string())
    .default('')
    .description('可选：服务端受限令牌文件路径，只读取 tokenEnv 对应的那一个值。'),
  timeoutMs: Schema.number()
    .step(1)
    .min(1000)
    .default(10000)
    .description('单次 HTTP 请求超时（毫秒）。'),
  sessionPrefixes: Schema.array(Schema.string())
    .default(['qq-'])
    .description('只有这些前缀的 DSH 会话接入个人记忆；QQ bridge 生成 qq- 前缀。'),
  memoryTools: Schema.boolean()
    .default(true)
    .description('允许对话内更正/遗忘。仍需服务端为该客户端授予 memory_tools。'),
  proactiveEnabled: Schema.boolean()
    .default(true)
    .description('允许已绑定的主人私聊接收有来源的主动消息；服务端需授权 memory_outputs。'),
  stateDirectory: Schema.string()
    .default('')
    .description('补交队列与状态文件目录；留空表示使用 profile 插件数据目录。'),
  sessionsDirectory: Schema.string()
    .default('')
    .description('DSH 会话日志根；留空表示 <DSH home>/sessions。清理时按此定位正文。'),
  maxPending: Schema.number()
    .step(1)
    .min(1)
    .default(256)
    .description('补交队列上限；满时明确报错并保留输入，不静默丢弃。'),
  retryIntervalMs: Schema.number()
    .step(1)
    .min(1000)
    .default(15000)
    .description('后台补交与清理轮询间隔（毫秒）。'),
  retireSessionsOnCleanup: Schema.boolean()
    .default(true)
    .description('清理时退役命中的旧会话；正文删除仍会先执行。'),
  segment: Schema.object({
    budgetTokens: Schema.number().step(1).min(1000).default(128000)
      .description('软上限：本段累计输入达到它就在本轮结束后换段。'),
    hardTokens: Schema.number().step(1).min(1000).default(160000)
      .description('硬上限：防单条超长文本或大图冲破预算，绕开最少轮数。'),
    carryTurns: Schema.number().step(1).min(0).default(30)
      .description('新段带入的最近完整对话轮数。'),
    carryTokens: Schema.number().step(1).min(0).default(8000)
      .description('带入正文的上限，与轮数取先到。'),
    idleHours: Schema.number().step(1).min(1).default(24)
      .description('无真实用户互动满这么多小时就换段。'),
    minTurns: Schema.number().step(1).min(0).default(6)
      .description('少于此轮数不换段，防抖动。'),
    maxAgeDays: Schema.number().step(1).min(1).default(14)
      .description('段龄上限，仅在空闲时生效。'),
  }).description('上下文分段参数；换段即归档旧会话并开新会话，绕开原生压缩。'),
}).volatile()

export default Config
export { Config }
