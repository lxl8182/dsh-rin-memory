# 咒语执行链开发计划（脱离 bridge · 标准 agent · followup 回填 · 模板库）

> 执行方案 A：标准模式 agent（无 preset，全套工具）。实际进度统一见 roadmap §2.5。
> 目标：插件 `dsh-rin-memory` 0.2.3；执行/回填完全归插件，QQ 侧标签剥离归 bridge。2026-10-26 用户明确：网页 QQ 预设无 bridge 也能执行，网页可以显示标签；bridge 仅做最小剥离调整，不承担执行或等待回填。

---

## 0. 核心设计（一句话）

**主会话 0 工具、只念咒语；插件解析咒语，派标准 agent 干活，用 `followup()` 把结果回填。学到的咒语是"带占位符的命令模板"，存台账，展开后仍走同一个执行链。**

为什么是模板而不是"真 tool"：一旦主会话里出现任何 tool schema，`deepseek-v4.1-flash` 的 thinking 就会退回第三人称分析腔（实测：有 tools 时 0/7，无 tools 时 7/7）。模板是纯文本，不污染思考，却保住了"学新技能"的能力。

---

## 1. 目标与验收

| # | 判据 | 验证 |
|---|---|---|
| A1 | 主会话仍为 0 tools、段=人格+魔法 | `.scratch/verify-integration.mjs` |
| A2 | `<执行>…</执行>` 真的派标准 agent 执行并回填 | 真实 rc.3 模块 + 假服务 |
| A3 | 同一条 assistant 消息只执行一次 | 单测：同 seq 连发两次 |
| A4 | 回填消息带来源标记，不被当成用户发言 | 断言 `source.kind` |
| A5 | 失败如实回报（`【终端反馈·X】失败：…`） | 单测 |
| A6 | 一条消息多个咒语按顺序执行 | 单测 |
| A7 | 主会话已销毁时不 followup、不报错 | 单测 |
| A8 | 咒语链不依赖 bridge，网页 QQ 预设无需 QQ 绑定 | 真实 rc.3 无 bridge 服务/绑定的完整执行；runner 不引用 `qqBridgeEvents` |
| A9 | 现有 37 条测试全绿 | `npm test` |
| **A10** | **`<学咒语>` 保存前试跑，失败不落盘** | 单测 |
| **A11** | **模板展开后走同一执行链，且只展开一层** | 单测 |
| **A12** | **魔法段动态列出学到的咒语，上限 8 条** | 单测 + 真实模块 |
| **A13** | **`<忘掉咒语>` 能真的删掉并回填确认** | 单测 |

---

## 2. 阶段一：前置验证（必须先做，约 30–40 分钟）

**确认 rc.3 真实 API，避免按文档写出一堆跑不通的代码。四个都通过才进入阶段二。**

| 验证 | 内容 | 产出 |
|---|---|---|
| **V1** | `createAgent(ctx, options)` 签名：`agentOptions`、`meta`、返回值是否含 `agent`/`dispose` | `.scratch/probe-create-agent.mjs` |
| **V2** | `agent.followup(message)` 的 `UserMessage` 形状，**能否带 `source` 标记** | 决定 A4 实现方式 |
| **V3** | `whenIdle()` 跑完一轮是否 resolve、有没有超时、无工具时会不会立刻返回 | 决定等待策略 |
| **V4** | 从标准 agent 的 session 取最终文字（对比 bridge 的 `extractLastAssistantText`） | 决定回填内容来源 |

**任何一个不通过 → 回到这里改设计，不要带着假设往下写。**

---

## 3. 阶段二：执行链（约 1 小时，~160 行）

### 3.1 `spell-runner.js`（新文件，~110 行）

```js
export class SpellRunner {
  constructor({ ctx, logger, runSpell, followupOf, startWorker, maxConcurrent = 1 })

  // assistant 消息落地时调用；返回本次执行摘要（供测试断言）
  async handleAssistantMessage(agent, message, seq)

  // 去重：(sessionId, seq) 只跑一次
  // 串行：多次念咒不开多个 agent 并发
  // 每个咒语：runSpell(cast) → 结果 → followup 回填
  // 失败也回填（如实报错），不静默
}
```

### 3.2 worker 创建（~50 行，同文件）

```js
// 方案 A：无 preset = DSH 标准模式，全套工具
async function startWorker(ctx, { prompt, provider, model, cwd, timeoutMs }) {
  const handle = await ctx.get('agents').create({
    sessionId: `companion-spell-${randomUUID()}`,
    agentOptions: { provider, model },
    meta: { cwd },                 // 不传 agentPreset
  })
  handle.agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'companion-spell' }, content: [{ type: 'text', text: prompt }] })
  await withTimeout(handle.agent.whenIdle(), timeoutMs)
  return extractFinalText(handle.agent.session)
}
```

rc.3 结果从 `session.snapshotEvents()` 提取。标准 worker 最终返回 `{ok,text}` JSON；`ok=false`、异常结束、空输出、格式错误或超时都作为失败回填，学咒语试跑失败不落盘。

**与现有 `subagents.startActivation` 并存**：`<生成>/<执行>` 走新路径，`companion_task` 保留旧路径。

### 3.3 接入 `index.js`（~40 行）

- `sessionEvent()` 加分支：`assistant/message` → `spellRunner.handleAssistantMessage(agent, event.data.message, event.seq)`
- `attachSpells()` 独立于记忆绑定：网页/桌面直接选择 QQ 预设即可接入；普通会话和 worker 排除。预设读取原生当前投影，切换/卸载时释放。
- 复用 `spellHandlers()`（六个咒语已实现，不动）
- 派发使用事件所属的 agent，不以全局 `currentAgent` 决定来源。通用咒语不检查 QQ 个人记忆绑定；记忆咒语保留原授权。

### 3.4 回填（~25 行）

```js
agent.followup({
  id: randomUUID(),
  role: 'user',
  source: { kind: 'companion-spell' },   // ← 视 V2，可能降级为文本约定
  content: [{ type: 'text', text: '【终端反馈·执行】\nD盘剩余 120GB' }],
})
```

---

## 4. 阶段三：模板库与学咒语（约 1 小时，~125 行）

### 4.1 台账 `spells.json`（~50 行）

```json
{
  "schema_version": 1,
  "spells": [
    {
      "name": "说话",
      "note": "念一段文字",
      "via": "执行",
      "template": "python C:\\scripts\\tts.py \"{body}\"",
      "verified_at": "2026-10-26T17:00:00Z"
    }
  ]
}
```

| 字段 | 约束 |
|---|---|
| `name` | 2–8 个中文字符，不与内置六个重名 |
| `via` | **只能是 `读取`/`生成`/`执行`**，指向另一个学来的咒语一律拒绝（防递归） |
| `template` | 必含 `{body}`，否则只能当死命令（明确告知） |
| `verified_at` | 保存前试跑成功才写 |
| 上限 | **8 条**，超出拒绝并说明 |

### 4.2 两个新元咒语（~50 行）

- `<学咒语>名字 ||| 说明 ||| via ||| 模板</学咒语>`
  **先试跑一次模板**（用一段样例 body），跑通才落盘，失败回报真实错误
- `<忘掉咒语>名字</忘掉咒语>`

### 4.3 魔法段动态化（~15 行）

`MAGIC_RULES` 常量 → `magicText({ learned })` 函数，追加：

```
【自己学会的】   （没有则不出现这一节）
· 说话 —— 念一段文字
```

- 每条只列名字 + 说明，**不列模板**（省 token，且模板不影响模型判断用哪条）
- 学到的咒语展开后仍走 `读取`/`生成`/`执行`，对模型表现为同一个咒语

### 4.4 展开（~10 行）

```
<说话>主人你好呀</说话>
  → via=执行, template 里 {body} 替换
  → <执行>python C:\scripts\tts.py "主人你好呀"</执行>
  → 交给 spell-runner 走同一执行链
```

---

## 5. 降级方案（V2 不通过时）

若 `followup` 不接受 `source`：

- 文本前缀写死 `【终端反馈·X】`（已有）
- 魔法段加一句「看到【终端反馈】是系统回给你的，不是主人说的」
- A4 改为「魔法段含该说明 + 回填文本以前缀开头」

---

## 6. 测试（约 40 分钟）

### `test/spell-runner.test.js`

| 用例 | 断言 |
|---|---|
| 正常执行 | 回填含 `【终端反馈·执行】` + 真实输出 |
| 同 seq 重复 | 只执行一次 |
| 多咒语 | 按出现顺序执行 |
| 执行抛错 | 回填 `失败：`，不抛上层 |
| 主会话已销毁 | 不 followup、不抛错 |
| 无咒语 | 不创建 worker |
| 未闭合标签 | 不执行 |
| 不引 bridge | import 里无 `qqBridgeEvents` |

### `test/spell-library.test.js`

| 用例 | 断言 |
|---|---|
| 学一条并试跑通过 | 落盘，魔法段出现该名字 |
| **试跑失败** | **不落盘**，回报真实错误 |
| 展开 | `{body}` 正确替换，走同一条执行链 |
| 递归 | `via` 指向学来的咒语 → 拒绝 |
| 上限 | 第 9 条 → 拒绝并说明 |
| 重名 | 与内置六个重名 → 拒绝 |
| 忘掉 | 删除后魔法段不再出现 |

### 真实模块验证
扩展 `.scratch/verify-integration.mjs`：
- 模拟 assistant 消息含 `<执行>echo hi</执行>` → 断言 worker 被创建、回填出现
- 学一条咒语 → 断言魔法段长度变化且含该名字

---

## 7. 顺序与提交点

| 步骤 | 产出 | 检查点 |
|---|---|---|
| 1 | V1–V4 前置验证 | **四个都通才继续** |
| 2 | `spell-runner.js` + 单测 | `npm test` 全绿 |
| 3 | 接入 `index.js` | `npm run check` + 现有 37 条不回归 |
| 4 | 真实模块验证 A1/A2 | — |
| 5 | 模板库 + 元咒语 + 单测 | A10–A13 |
| 6 | 魔法段动态化 + A12 验证 | — |
| 7 | 文档（README / PLAN / roadmap §2.5 五类） | — |

**第 4 步是分水岭**：执行链在真实模块上跑通了，才开始做模板库。否则出新问题时分不清是执行链还是模板展开的锅。

---

## 8. 不做的事

- ❌ 不把执行或回填等待接回 bridge；QQ 侧只剥离内置、元咒语和学到的标签，不执行、不发旧终端反馈
- ❌ 不改已存 assistant 消息（rc.3 的 `session/event` 是纯观察，无写入前钩子，已查证）
- ❌ 不给主会话加任何真 tool（会毁掉角色独白思考）
- ❌ 不让标准 agent 改主插件源码（改坏会让小铃完全不能说话）
- ❌ 不替换 `companion_task` 的旧派发路径
- ❌ 不手改 profile、不发 QQ 消息

---

## 9. 已知风险

| 风险 | 缓解 |
|---|---|
| 标准 agent 慢（全套工具 + 模型调用） | 超时 + 如实回报 |
| followup 唤醒已走开的主会话 → 多烧 token | 只在 assistant 消息后 5 分钟内回填 |
| 一次念多个咒语 → 并发开多个 agent | 串行（maxConcurrent=1） |
| 标准 agent 输出被当用户发言 | §5 降级方案 |
| **模板含危险命令** | 学咒语前必须试跑一次；台账可手改；单人自用不做白名单 |
| **学太多导致提示变长** | 上限 8 条 + 只列名字说明 |
| **worker 输出里含标签 → 循环** | worker 用独立 ctx，不挂 spell-runner |

---

## 10. 为什么不用"注册真 tool"的方案（已论证）

标准 agent 确实能改插件源码加真 tool。不采用的原因：

1. **必须重启 DSH** 才生效
2. **主会话隔离钩子会把新 tool 挡掉**（`main-session.js` 明确清空 `tools`）
3. **改坏主插件 = 小铃完全不能说话**（人格、注入、隔离全在一个文件里）
4. **一旦有 tool，thinking 立刻退回分析腔**（这是整个设计的根本约束）

若将来确有"必须原生、必须常驻"的能力，再单独立一个 `dsh-user-spells` 插件承载，主插件只加一行放行白名单——那是独立议题。
