<p align="center"><img src="icon.svg" width="96" alt="铃芽 RIN"></p>

<h1 align="center">DSH RIN Memory</h1>
<p align="center"><strong>把铃芽 RIN 的人格、记忆与成长带进 DeepSeek Harness。</strong></p>

[rin-memory](https://github.com/lxl8182/rin-memory) 持有人格与长期记忆。DSH 负责回复和工作会话，本插件负责记忆采用、持久补交、明确教导和主动联系。QQ 收发、身份和分段投递由 [dsh-qq-bridge](https://github.com/lxl8182/dsh-qq-bridge) 负责。

## 开始使用

先启动核心服务，在管理台创建角色并发布人格。插件包及 DSH 兼容范围见 [package.json](package.json)，实际发布记录见 [RIN 维护台账](https://github.com/lxl8182/rin-memory/blob/main/docs/roadmap.md)。

### 核心授权

```toml
[clients.dsh-desktop]
token_env = 'COMPANION_DSH_TOKEN'
subjects = ['private']
plugin_id = 'dsh_memory'
memory_tools = true
persona_teach = true
memory_outputs = true
trusted_plugins = ['dsh_memory']
```

按需要授权查询、更正和遗忘、明确教导、输出及回执。`trusted_plugins` 与插件身份一致。

### 插件安装与配置

在仓库目录执行 `npm pack`，用 DSH 插件管理安装生成的包。插件默认关闭。启用时填写以下配置，并在 QQ bridge 设置主人、白名单和会话绑定。

```yaml
enabled: true
url: http://127.0.0.1:48931
clientId: dsh-desktop
characterId: companion
subject: private
pluginId: dsh_memory
tokenEnv: COMPANION_DSH_TOKEN
proactiveEnabled: true
```

角色 ID 及客户端 ID 与核心配置匹配。令牌可从 DSH 环境读取，也可通过 `tokenFile` 指向核心运行根的 `state/client_tokens.json`，读取 `tokenEnv` 对应项。需要远程访问时由受控连接提供本地回环地址。

主人私聊使用发布人格和记忆。好友公开人设在人格卡页维护，留空采用 QQ 预设。新版 QQ Bridge 在设置里实时控制「好友记忆与续聊压缩」，旧版 Bridge 沿用 `friendMemoryEnabled`。RIN 逐个授权 `qq-friend:<QQ号>` 后，好友共用事实保存、召回和换段链路，按各自的主体存取记忆。关闭时，已接入记忆的会话从下一轮起换到纯聊天。群聊沿用预设。

好友授权在换段前确认。关闭、撤销授权或暂停记忆时，已采用记忆的会话换到纯聊天的新段。服务短时不可达时，已采用记忆的会话保留入站待重试，其余好友仍可纯聊天。

## 普通聊天怎么用记忆

1. 从 bridge 取得合法身份和真实用户原话。请求 `POST /v1/context`，复用已发布人格和必需约束。
2. 预约本轮上下文，按核心入选清单渲染，最多 3 条可选记忆、合计 600 tokens。预约引用跟随实际裁剪结果，正文以有来源的“我的记事”放在当前输入之前，保留原话和图片。
3. 材料进入会话后登记版本指纹和引用。仍在上下文中的同版本材料直接复用，压缩或换段移除后可以再补。
4. 从 bridge 收到最终可见回复后持久补交 `POST /v1/turns`，另报告平台接受的分段。清理待办按已登记引用定位会话与补交副本。

普通聊天的 HTTP 超时默认 10000ms。主人及启用记忆的好友私聊在上一轮气泡结束后，用上一请求的用量、这轮文字和图片及输出余量判断是否换段。默认软上限 128K、硬上限 160K，模型窗口更小时按比例收紧。

| 场景 | 新段带入 |
|---|---|
| 连续长聊到预算 | 最近 5 轮完整原话，最多 8000 tokens |
| 默认空闲 24 小时或段龄到期，继续聊同一话题 | 同话题原话，最多 12 轮、4000 tokens |
| 明确追问之前的细节 | 同话题原话，最多 20 轮、6000 tokens |
| 问候或新话题 | 0 轮。之后明确追问时可在本段继续取回旧话 |

只使用 QQ 实际接受的回复片段。跨段引用由 RIN 核对来源和更正、删除状态，进入 DSH 会话后才确认采用。当前轮的原话和图片随正常请求发送。旧格式段历史继续参与预算估算，有来源键的新交换用于跨段续聊。

## 咒语与工作会话

| 咒语 | 用途 |
|---|---|
| `<翻本子>` | 查询记忆 |
| `<查资料>查询词或网址</查资料>` | QQ 私聊使用 AnySearch 搜索或读取公开网页，好友各自每 10 分钟最多 3 次 |
| `<改写>`、`<撕掉>` | 更正与遗忘 |
| `<学到>` | 提交有原话来源的明确教导 |
| `<读取>`、`<生成>`、`<执行>` | 读取内容或交给独立标准 agent |
| `<学咒语>`、`<忘掉咒语>` | 保存或撤销可复用模板 |

角色主会话使用发布人格、记忆说明和魔法段，工具执行归工作会话，结果带来源回填。网页 QQ 预设可使用咒语执行链，个人记忆由真实主人绑定和服务权限决定。

`查资料` 由铃芽自己决定何时使用。为 DSH 进程配置 `ANYSEARCH_API_KEY` 后启用。动作咒语各占一行，引用和代码块按正文显示。插件把 AnySearch 结果去重后保留至多三条来源，网页正文按问题挑选摘录。QQ 等候正式回复，主会话两次模型请求均使用空工具列表。之后的上下文保留标题和链接。

好友只有两个只读咒语。`翻本子` 在对方明确问起以前聊过的事时查这位好友自己的记忆，需要 QQ Bridge 开关和 RIN 授权。普通聊天每段首次提供时间，跨日或与上次提供时间相隔 4 小时后按需刷新。

## 主动交流

`proactiveEnabled` 控制主动联系。候选来自明确约定、未完事项、任务结果和新素材，计划按会话持久保存。普通搭话默认每日最多 2 次，从最近真实收发或主动发信起等 90 分钟，在允许联系后另有一次持久化的 15–120 分钟随机等待。配置时区 00:00–09:00 静默。明确约定和任务结果单独判断是否到期，普通分享可来自铃芽自己的兴趣。

已开启且获授权的好友记忆同时接入主动联系，只跟进对方明确愿意继续的近期话题。距双方最近实际收发至少 24 小时，每位好友 7 天至多一次，每个话题只发一次。再次跟进前要收到好友的新消息。

到期后同一轮决定发送、延后、等待事件或暂停。正文与固定分段经 `POST /v1/outputs` 保存，bridge 按稳定 output ID 和分段索引投递，重启可续投未完成部分。

## 开发与兼容

```bash
npm run check
npm test
npm pack --dry-run
```

记忆接线在 `index.js`，传输与补交在 `memory-client.js`，主动联系在 `proactive.js` 和 `contact.js`，咒语执行在 `spell-runner.js`。升级时使用插件管理替换包，沿用 `pluginId: dsh_memory` 与现有来源身份。

[核心记忆流程](https://github.com/lxl8182/rin-memory/blob/main/docs/memory-flow.md) 说明跨端行为。[主会话历史决策](PLAN.md) 和 [咒语历史决策](SPELL-PLAN.md) 提供原稿入口。项目使用 [Apache-2.0](LICENSE)。
