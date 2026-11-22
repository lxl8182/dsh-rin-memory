<p align="center">
  <img src="icon.svg" width="96" alt="铃芽 RIN">
</p>

<h1 align="center">dsh-rin-memory</h1>

<p align="center">
  <strong>把铃芽 RIN 的人格、长期记忆与主动陪伴，干净地接进 DeepSeek Harness。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.3-2563eb?style=flat-square" alt="DSH 0.2.1-rc.3">
  <img src="https://img.shields.io/badge/License-Apache--2.0-555?style=flat-square" alt="Apache-2.0">
</p>

---

`dsh-rin-memory` 是 [铃芽 RIN (`rin-memory`)](https://github.com/lxl8182/rin-memory) 的 DeepSeek Harness（DSH）插件。它让角色在 QQ 与 DSH 中拥有**始终一致的已发布人格、按需浮现的长期记忆、有分寸的主动联系，以及不破坏人设语气的工具委托能力**。

整个链路分工清晰：

```text
QQ ──► dsh-qq-bridge（身份鉴权 · 分气泡持久投递）
          ↕
       DSH + dsh-rin-memory（零工具角色主会话 · 动态记忆 · 跨段续聊 · 咒语 · 主动交流）
          ↕  HTTP /v1/*
       rin-memory（权威人格 · 长期事实 · 遗忘屏障 · 回执）
```

## 核心特性

- **零工具角色主会话**：角色主会话不暴露杂乱的工程工具列表，保持自然对话语感；查资料、读文件、执行任务通过轻量“咒语”转交独立工作会话完成，结果带出处回填。
- **每轮动态记忆投影**：每轮直接依据 RIN 签发的 `context.selection` 渲染当轮背景（最多 3 条、合计 600 tokens），旧背景自动退出活动输入，压缩时跳过动态背景。在 RIN 管理台删掉一条误提事实后，下一轮立刻消失，不靠删聊天记录“硬抹”。
- **无感跨段续聊**：结合上一轮 token 用量、图文大小与空闲时长自动开启新 DSH 会话段，只带回真正送达且与当下话题相关的原话，既守住上下文窗口，又不打断连续聊天的感觉。
- **主人与好友硬隔离**：主人私聊使用私有发布人格与完整记忆；好友私聊默认纯聊天，仅在 Bridge 开启开关且 RIN 服务端逐个授权 `qq-friend:<QQ号>` 后，才按独立主体共享记忆、换段与低频话题跟进；群聊严格不接记忆。
- **有节制的主动交流**：基于真实约定、未完事项、任务结果与铃芽自己的兴趣生成主动消息，带静默时段、冷却、日限额与随机等待；正文先经 RIN 持久化固定分段，再交给 Bridge 续投，失败自动退避不刷屏。

## 快速开始

### 1. 在 `rin-memory` 授权客户端

先启动 [rin-memory](https://github.com/lxl8182/rin-memory) 并在管理台发布初始人格，再在 `stack.toml` 中配置 DSH 客户端权限：

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

### 2. 打包并安装插件

在仓库根目录执行 `npm pack`，通过 DSH 插件管理安装生成的 `.tgz` 包（升级时直接替换安装，沿用原有 `pluginId` 与来源身份）。

### 3. 启用配置

插件安装后默认关闭，启用时在 DSH 配置中填入与核心匹配的身份与服务地址，并在 [dsh-qq-bridge](https://github.com/lxl8182/dsh-qq-bridge) 中配置主人、白名单与会话绑定：

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

> 令牌可从 DSH 进程环境变量读取，也可通过 `tokenFile` 指向 RIN 运行根的 `state/client_tokens.json` 读取 `tokenEnv` 对应项。需要跨机连接时，请通过受控 SSH 隧道暴露本地回环端口。

## 关键机制

### 记忆采用与跨段续聊

每次收发走完四步闭环：**核验身份与记忆就绪 → 请求 `/v1/context` 并预约本轮选择 → 渲染当轮背景生成回复 → 收到实际可见文本后持久补交 `/v1/turns` 与平台送达分段**。

私聊上下文默认软上限 **128K**、硬上限 **160K**（小窗口模型按比例收紧），触发换段时按场景带回实际已送达的原话：

| 换段触发场景 | 新段带入原话上限 |
|---|---|
| 连续长聊触及上下文预算 | 最近 5 轮完整原话（≤ 8,000 tokens） |
| 默认空闲 24 小时或段龄到期，继续同一话题 | 同话题原话，最多 12 轮（≤ 4,000 tokens） |
| 明确追问之前的细节 | 同话题原话，最多 20 轮（≤ 6,000 tokens） |
| 问候或开启全新话题 | 0 轮（后续明确追问仍可在本段按需取回旧话） |

按事实 ID 删除在 RIN 本地即时完成；显式删除整段原话或经历时，插件依据消费引用清理对应会话与补交副本。

### 咒语与工作会话

角色主会话保持空工具列表，需要外部信息或执行动作时使用独立一行的中文咒语（引用、代码块内按纯文本显示，不会误触发）：

| 咒语 | 适用范围 | 用途 |
|---|---|---|
| `<查资料>查询词或网址</查资料>` | 主人 / 好友私聊 | 调用 AnySearch（需配置 `ANYSEARCH_API_KEY`）检索或抓取公开网页，按原问题筛选并最多补查一次、保留至多 3 条来源，单次回填后由主会话给出完整回答 |
| `<学到>…</学到>` | 主人 | 提交带原话来源的明确教导，经 RIN 写入可撤销表达规则 |
| `<读取>` / `<执行>` | 主人 | 读取指定内容，或交由独立标准 Agent 工作会话完成操作并回填结果 |

> QQ 私聊系统提示附带本地日期（同日稳定，便于判断近况年月）；主人聊天的详细时间锚点按每段首次、跨日或间隔 4 小时刷新。

### 主动交流与失败退避

开启 `proactiveEnabled` 后，插件综合明确约定、未完事项、工作任务结果与可分享兴趣安排主动联系：

- **默认节律**：主人普通搭话每日最多 2 次，距最近真实收发或主动发信至少冷却 90 分钟，并在允许联系后附加 15–120 分钟的持久化随机等待；配置时区 `00:00–09:00` 静默。明确约定与任务结果单独判时。
- **好友低频跟进**：已开启并获授权的好友私聊仅跟进近 7 天内对方明确愿意继续的话题，间隔至少 24 小时，每个话题仅跟进一次，之后须等对方重新来信。
- **单次生成与持久化投递**：生成前先准备回忆与候选，单轮决定发送正文或 `[PASS]`，并用 `<下次联系>` 记录下一次打算；正文与固定分段先经 `POST /v1/outputs` 落盘，再由 Bridge 按稳定 `outputId` 分段投递、跨重启续发。
- **失败退避保护**：主动生成失败按联系对象分别等待 **5 分钟、15 分钟** 重试，连续 3 轮失败后暂停自动生成，收到该对象新消息后自动恢复；手动取消也会暂停自动重试，状态跨重启保留。

## 开发与验证

```bash
npm run check           # 逐文件语法检查
npm test                # 运行全部 15 个单测文件（node --test）
npm pack --dry-run      # 预检发布包内容
```

核心源码分工：

| 文件 | 职责 |
|---|---|
| `index.js` | 插件主接线、DSH 生命周期钩子、每轮背景注入与跨段调度 |
| `memory-client.js` | RIN HTTP 客户端、预约/补交队列与删除清理消费 |
| `proactive.js` · `contact.js` · `discovery.js` | 主动交流调度、失败退避、联系人节奏与素材筛选 |
| `spell-runner.js` · `spell-library.js` · `anysearch.js` | 咒语解析、独立工作会话执行与 AnySearch 查资料 |
| `session-store.js` · `main-session.js` · `task-store.js` | 会话状态持久化、主会话组装与委托任务记录 |

延伸文档：[RIN 完整记忆流程](https://github.com/lxl8182/rin-memory/blob/main/docs/memory-flow.md) · [RIN 维护台账](https://github.com/lxl8182/rin-memory/blob/main/docs/roadmap.md) · [主会话历史决策](PLAN.md) · [咒语历史决策](SPELL-PLAN.md)。

## 许可

采用 [Apache-2.0](LICENSE) 许可发布。
