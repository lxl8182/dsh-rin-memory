# DSH 记忆插件（Windows 本机）

**这是什么**：DeepSeek-Harness（DSH）的记忆插件。它把 DSH 的会话接到独立的 companion-memory 记忆服务上——人格卡与长期记忆由 companion-memory 独家持有，DSH 负责回复与工具，QQ 收发由 dsh-qq-bridge 承担。

**仓库关系**（三件套，各自独立仓库）：

| 仓库 | 角色 |
|---|---|
| [companion-memory](https://github.com/lxl8182/companion-memory) | 记忆与人格核心：唯一人格卡、发布版本、事实、召回、更正与删除规则，以及服务端 HTTP 合同 |
| **dsh-companion-memory**（本仓库） | DSH 接入端：插件包，注入人格与记忆、保存轮次、执行咒语并回填 |
| [dsh-qq-bridge](https://github.com/lxl8182/dsh-qq-bridge) | QQ 桥：登录、主人身份校验、消息收发、出站标签剥离 |

本包是本地插件（`private: true`，不发 npm）、零运行时依赖、无需构建；许可为 [Apache-2.0](LICENSE)。

**接手开发先读 [PLAN.md](PLAN.md)**：统一人格、记忆、保存、更正删除和恢复在本插件实现，与 QQ bridge 共存，目标版本 DSH `0.2.1-rc.3`。状态只在 [统一开发台账 §2.4](https://github.com/lxl8182/companion-memory/blob/main/docs/roadmap.md) 维护。

本批执行入口为 [SPELL-PLAN.md](SPELL-PLAN.md)：咒语由本插件解析、执行和回填，bridge 只处理 QQ 标签展示。五类进度维护在[统一台账 §2.5](https://github.com/lxl8182/companion-memory/blob/main/docs/roadmap.md)。

边界上，本插件只做接入：**人格与长期记忆的权威判定在 companion-memory，DSH 负责回复与工具，QQ 登录与身份校验在 bridge**；插件本地只保留补交队列、插件配置与咒语台账。

当前版本为 `0.2.3`，配套 QQ bridge `1.0.6-neko.3`。通过插件管理更新本地包后重启 DSH 加载新代码；原账号、白名单与模型配置继续使用。

## 启用后得到什么

- QQ 私聊使用管理台当前**已发布**的人格；网页与 QQ 的个人记忆按现有范围规则共享。
- **系统提示为完整人格 + 魔法段，主会话 0 tools**。人格使用宿主的 `deployment:persona-prefix` 槽位，正文由核心提供；魔法段列出内置咒语与学到的名字、说明。
- **主会话屏蔽运行上下文**：可选上下文由 `suppressRuntimeContext()` 抑制；`required` 的工作目录由会话内同名空文本注册覆盖，发请求前刷新时也保持为空。没有其他必需上下文时，新会话不生成 `Current runtime context…` 英文前缀或目录快照；实际 cwd 和标准 worker 保持正常。首次加载这项修复需要完全退出并重启 DSH，再新建 QQ 会话，避开旧轨迹中的快照。`team:identity` 若仍启用，按其独立注册处理。
- 用户消息只包含用户原话：人格卡不再作为每条消息的快照重复注入。
- 每轮仍先取一次上下文并登记依据（context → 必需人格/更正校验 → reserve → 生成 → turns/used/sent），本轮多次工具调用复用同一份依据；但**只有本轮确有新增背景时**才追加一条来源标记为 `companion-memory` 的消息：开头一句"这是记忆服务补充的材料，不是主人说的话"，之后只含相关记忆条目、必须遵守的更正与必要的跨端近期对话；没有新增就完全不注入，也没有占位句或版本号。
- 每条增量按稳定指纹（记忆 id + 正文、更正 id + 修订、跨端轮次 id）去重，索引持久化在 `outbox.json` 的 `injected` 里；只有**真的交给模型**的条目才登记，取上下文、reserve 或落盘待提交都不算。原生压缩后开启新的上下文代际，允许重新送达。
- 每轮自动保存真实用户发言与**最终对外文字**——不是最后一条原始 assistant 消息，而是 bridge 解析控制块后真正发出去的那段。
- 用户明确说“你记错了”“把这条忘掉”时，模型念 `<改写>旧 ||| 新</改写>` / `<撕掉>那件事</撕掉>`，由程序真的改、真的删（失败如实回报，匹配到多条就退回候选让你确认）；管理台的更正与删除同样影响 QQ 后续回答。
- 断线后补交、重启后恢复；重复消息不重复保存；删除后旧历史、补交与重启都不会把内容带回来。
- **主会话不上报任何工具，动作改由正文里的「魔法」咒语表达**：`<读取>` / `<生成>` / `<执行>` 动外面的世界，`<翻本子>` / `<改写>` / `<撕掉>` 动记忆本。这是实测结论而非风格偏好：只要请求里存在 `tools` 字段，`deepseek-v4.1-flash` 的 thinking 就会被拉进 function-calling 规划模式，角色独白退化成“用户问…需不需要调用工具…”的第三人称分析，系统提示压不住；把 `tools` 整个去掉后，同一份人格下 **7/7 稳定输出（…）角色独白**。咒语是纯文本，不触发该语境，能力却保住了。
- **执行独立于 bridge**：本插件监听已落地的 `assistant/message`，解析标签；`<读取>` 直接读盘，`<生成>`/`<执行>` 创建无 preset 的标准 agent，使用原生工具，结束后以 `source.kind=companion-spell` 的 `followup()` 回填。消息按 session/seq 去重，咒语串行执行；worker 默认 120 秒超时，主会话销毁或超过 5 分钟不再回填。网页保留原始标签与反馈，QQ 出站由 bridge 剥离标签。
- 在 DSH 网页或桌面直接选择 **QQ 会话预设（`dsh-qq-bridge`）** 即接入咒语链路，无需 bridge 服务或 QQ 绑定。普通工作会话和 worker 不接入。个人记忆的翻本子、更正、删除继续使用原有主人授权，通用咒语不检查 QQ 记忆绑定。
- `<学咒语>名字 ||| 说明 ||| 读取/生成/执行 ||| 模板</学咒语>` 保存前用“咒语试跑”替换 `{body}` 真实试跑；失败不保存。模板落在插件状态目录 `spells.json`，最多 8 条、名字 2–8 个中文字符，展开一层后进入同一个执行链。无占位符时明确作为固定命令保存；`<忘掉咒语>名字</忘掉咒语>` 删除模板并回填确认。
- 既有 `companion_task` 保留 TaskStore 与 `subagents.startActivation` 路径；其任务幂等、终态通知与重启收敛继续生效。
- 已安装的 DSH 工具继续按现有设置使用（在工作会话里）。工具结果按外部来源处理，不会变成用户偏好。

## 一次性配置

### 1. 服务端授权（`companion-runtime/config/stack.toml`）

```toml
[clients.dsh-desktop]
token_env = 'COMPANION_DSH_TOKEN'
subjects = ['private']
plugin_id = 'dsh_memory'
memory_tools = true      # 允许对话内更正/遗忘；关闭则只能用管理台
```

`memory_tools` 与 `host_persona` 是两个独立授权：前者只能动本人的事实，后者只能改人格卡。**本插件不读取管理台凭据，也不给模型管理台权限。**

### 2. 令牌

`COMPANION_DSH_TOKEN` 的值在服务首次启动时生成到新运行根的 `state/client_tokens.json`。把它设进 DSH 进程环境，或让插件读该文件：

```yaml
tokenEnv: COMPANION_DSH_TOKEN
tokenFile: F:\game\projectNEKO\companion-runtime\state\client_tokens.json
```

`tokenFile` 只读取 `tokenEnv` 指向的那一个键。凭据不进配置、提示词、日志或源码。

### 3. 安装与启用

通过 DSH 插件管理安装本目录（桌面版使用 desktop profile）。安装包默认 `enabled: false`，**安装不等于接管人格**；在设置里打开 `enabled` 后才连接。

配置字段见 `cordis.patch.yml`。QQ 账号、Admin OpenID、白名单与工具设置仍由 QQ bridge 管理，本插件只读取 bridge **校验过**的结果。

## 与 QQ bridge 的边界

| 部分 | 职责 |
|---|---|
| QQ bridge | QQ 登录、主人身份校验、消息收发、控制指令、会话映射、出站标签剥离 |
| 本插件 | 咒语监听/解析、标准 agent 执行、followup 回填、模板台账，以及原有记忆接入 |
| DSH | 模型调用、原生会话、已安装工具与工具权限 |
| companion-memory | 唯一人格卡、发布版本、事实、召回、更正与删除规则 |

bridge 通过 `qqBridgeEvents` 在生成前提供已校验的主人/会话绑定，在生成后发布真实输入、最终可见文字、分段接收结果和稳定消息 id；该服务还提供清理时所需的会话交接。本插件只给绑定的主人私聊注入人格和注册记忆工具，普通 DSH 会话、群聊与非主人不获得个人记忆权限。

本插件据此记录 `sent`（平台接收）。QQ 的个人记忆仍等待主人绑定；网页 QQ 预设的通用咒语独立工作。

## 主会话隔离机制

QQ 主会话的请求合同由 [`main-session.js`](main-session.js) 实施，用的是 rc.3 原生作用域能力，不伪造宿主行为：

| 目标 | 机制 | 为什么是这个 |
|---|---|---|
| 人格只一份 | 在 agent 作用域注册同名 `deployment:persona-prefix` 段，并在 `system-prompt/assemble` 里按名字重建 | 同作用域同名段无法用空段覆盖（会报 already registered），组装钩子是唯一能定稿的地方 |
| 去掉团队/编码段 | 组装钩子只保留完整人格与魔法段 | 按固定段重建，保持顺序和正文来源稳定 |
| 主会话 0 tools | 组装钩子输出空工具集，`tools.guard()` 拒绝历史工具调用 | 实际操作由独立标准 agent 承担 |
| 前缀稳定 | 段与工具都按固定名字顺序重建 | 顺序或空白漂移会让缓存前缀整体失效 |

隔离接入网页 QQ 预设与已校验主人私聊；普通工作会话、群聊与非主人不接入。`.scratch/verify-integration.mjs` 使用桌面包内真实 rc.3 模块，在没有 bridge 服务和绑定的环境验证标准 worker、来源回填、模板学习/失败/忘掉，以及卸载后原提示和工具恢复。

## 状态与失败

| 状态 | 含义与下一步 |
|---|---|
| `connected` | 已连接，人格与保存正常 |
| `disconnected` | 服务不可达或忙，轮次进持久队列，自动重试 |
| `rejected` | 身份/凭据被拒，停下等配置修正（不会盲目重试） |
| `cleanup-pending` | 有删除待办，补交暂停直到清理确认 |
| `cleanup-failed` | 本地正文删除失败（常见于文件被占用），待办保留，修复后继续 |

队列有界（`maxPending`），满时明确报错并保留输入，不静默丢弃。停用会停止注入、提交与重试，**保留持久队列**；下次启用按原顺序恢复。

必需人格或更正不可用时，bridge 持久保留输入并阻止模型调用；连接恢复后再处理。生成完成后即使 QQ 部分发送失败，也使用 bridge 的最终可见文字保存；补发只处理失败分段，不重做模型或工具。进程中断的生成和无法判定是否被平台接收的分段保留为 `unknown`，不自动重复执行。发送状态在 DSH home 的 `plugins/dsh-qq-bridge/<账号命名空间>/delivery.json` 中核对。

## 清理

删除待办先停止并释放旧 Agent、清除对应 bridge 队列正文，再删除 `<DSH home>/sessions/<project>/<sessionId>/`（含 `.jsonl` 与 `.jsonl.zstd`），复核后才确认。来源会话及已登记相关记忆/人格版本引用的会话一起清理，后续输入通过 bridge 切到新会话。任何一步失败都保留清理待办。

无关会话、无关队列与别的主体不受影响。

## 开发与验证

包本身零运行时依赖、无需构建；开发只需 Node.js（`engines.node >= 22`），宿主依赖由 DSH 提供（见 `peerDependencies`）。

```bash
git clone https://github.com/lxl8182/dsh-companion-memory.git
cd dsh-companion-memory

npm run check          # 对 11 个源文件逐个 node --check（语法/模块自检）
npm test               # node --test test/*.test.js，57 个用例
npm pack --dry-run     # 核对发布内容，包内只有 package.json 的 "files" 白名单
```

安装到本机 DSH：在插件管理里指向本目录（桌面版使用 desktop profile），包内默认 `enabled: false`，装完不会自动接管人格。

契约级检查在 `.scratch/`（本地验证脚本，已在 `.gitignore` 中，不随仓库与包发布）：

```powershell
# 使用桌面原生 Cordis 和工具注册表，临时服务与合成数据，不发送 QQ 消息
$memoryCheckElectronMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE='1'
  & 'E:\dsh\desktop\DeepSeek Harness.exe' .scratch/check-fixed-native.cjs
} finally {
  $env:ELECTRON_RUN_AS_NODE = $memoryCheckElectronMode
}
```

隔离联调使用临时核心根与替身 QQ 发送器；桌面加载验收使用实际 rc.3 模块。修改仅限本包与授权 QQ bridge 接入点，安装/更新走 DSH 插件管理，保持静音，不触发真实服务器操作或替换原角色数据。

陪伴/执行角色分工属于后续 Q03，不阻塞本次记忆闭环。
