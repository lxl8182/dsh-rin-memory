<p align="center"><img src="icon.svg" width="96" alt="铃芽 RIN"></p>

<h1 align="center">DSH RIN Memory</h1>
<p align="center"><strong>把铃芽 RIN 的人格、长期记忆与持续养成带进 DeepSeek Harness。</strong></p>
<p align="center"><em>风起时铃响，记忆落土发芽。</em></p>

**dsh-rin-memory** 是 [铃芽 RIN](https://github.com/lxl8182/rin-memory) 的 DSH 接入端。RIN 代表 **Recall · 记忆召回、Identity · 人格身份、Nurture · 养成培育**。它让 QQ 和 DSH 中的角色采用同一份已发布人设，记住相处的来往，学会你认真教过的表达方式，并在适合的时候主动来聊。

铃，是唤醒与回应；芽，是人格的萌芽与成长。

当前插件 `0.2.8` · 配套核心 `rin-memory 0.1.0.dev9` · DSH `0.2.1-rc.3` · Apache-2.0

## 相处时能感受到什么

- **记得之前，也接得上现在。** 获取与当前话题相关的记忆、经历、状态和工作摘要；新增背景按指纹增量传入，原生压缩后可以重新采用。
- **教一次，后面会沿用。** 你说“以后别每次都总结”，角色可以通过 `<学到>` 提交这一轮的原话来源，由核心形成可撤销的长期表达规则。
- **关心有后续。** 未完事项、约定回访和共同兴趣成为主动候选，由同一个人格生成要说的话；你插话或事情已结束时撤回过时候选。
- **角色主会话保持专注。** 系统提示由已发布人格和魔法段组成，主请求省略整个 `tools` 字段，保留第一人称角色扮演所用的上下文。操作任务交给独立标准 agent。
- **记忆采用角色视角展示。** 增量背景以“我的记事”呈现，保留原话引用、来源和底层事实，放在本轮主人原话之前；原始文本与图片附件不被记忆包装改写。
- **说过、做过、发出去，各有记录。** 保存真实用户原话与最终对外文字；QQ 分段回执决定哪些输出进入近期记忆。失败正文持久保存，补发复用稳定 output ID。
- **改错和忘记有实际动作。** `<改写>` 和 `<撕掉>` 调用核心的更正与删除链路，管理台的修改也会影响后续会话与待补交内容。

## 三个项目怎样配合

| 项目 | 职责 |
|---|---|
| [rin-memory](https://github.com/lxl8182/rin-memory) | 铃芽核心与管理台：人格、记忆、反思、成长、发布及更正删除 |
| **dsh-rin-memory** | DSH 接入：人格与记忆采用、教导咒语、工作会话、主动交流及保存回执 |
| [dsh-qq-bridge](https://github.com/lxl8182/dsh-qq-bridge) | QQ 通道：登录、主人校验、收发、会话绑定、出站标签剥离与持久投递 |

DSH 提供模型、原生会话、工具和权限。RIN 核心持有人格与长期记忆；插件本地保存配置、补交状态与咒语台账。QQ 个人记忆只接入 bridge 校验的主人私聊。

## 开始使用

先启动 [rin-memory](https://github.com/lxl8182/rin-memory)，创建角色并发布人设。

### 1. 授予接入能力

在核心的 `stack.toml` 为 DSH 客户端配置：

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

`memory_tools` 控制对话内更正与遗忘，`persona_teach` 控制明确教导，`memory_outputs` 控制主动输出与投递回执。`trusted_plugins` 必须与插件配置的 `pluginId` 一致。

### 2. 安装插件

```bash
git clone https://github.com/lxl8182/dsh-rin-memory.git
cd dsh-rin-memory
npm pack
```

通过 DSH 的插件管理安装本目录或 `local-dsh-rin-memory-0.2.8.tgz`。包默认 `enabled: false`，配置并启用后才连接。插件零运行时依赖、无需构建；宿主依赖由 DSH 提供。

### 3. 连接核心

在插件设置中填写：

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

令牌可由 DSH 进程环境提供，也可用 `tokenFile` 指向核心运行根的 `state/client_tokens.json`；只读取 `tokenEnv` 对应的键。角色标识要与核心配置一致。QQ 账号和白名单在 bridge 设置中维护。

更改后重启 DSH，在 QQ 发送一条消息即可建立主人会话绑定。也可以在 DSH 网页或桌面选择 `dsh-qq-bridge` 预设使用咒语链路；QQ 个人记忆权限仍由真实主人绑定决定。

## 角色说魔法，工作会话执行

| 咒语 | 用途 |
|---|---|
| `<翻本子>` | 查询记忆 |
| `<改写>` / `<撕掉>` | 更正或删除记忆 |
| `<学到>` | 提交用户明确的长期教导 |
| `<读取>` | 读取文件或目录 |
| `<生成>` / `<执行>` | 把操作交给独立标准 agent |
| `<学咒语>` / `<忘掉咒语>` | 学习或撤销可复用的咒语模板 |

工作会话使用宿主的原生工具与权限，结果以独立来源回填。网页保留原始咒语与反馈，QQ bridge 在出站时剥离完整咒语标签。长期人格规则由核心依据已保存原话派生，客户端提交来源引用。

## 有缘由地来找你

主动交流使用核心提供的候选与固定人格快照，经 `companion-proactive` 来源唤醒主会话，再交给 bridge 持久投递。普通主动消息默认每天最多 2 次、间隔至少 90 分钟，北京时间 00:00–09:00 静默；明确约定的回访按约定时间处理。

模型可用 `[PASS]` 暂缓候选。生成前后及每次分段投递前会复查来源、事项版本和用户插话；只有平台接受的分段进入近期记忆。关闭 `proactiveEnabled` 即可暂停该消费循环。

## 升级既有安装

仓库目录与 npm 包统一为 `dsh-rin-memory` / `@local/dsh-rin-memory`，配置行 id 与插件状态目录也使用 `dsh-rin-memory`。升级时通过插件管理替换旧包，并同步迁移配置与状态目录。

已有记忆来源 `pluginId: dsh_memory`、HTTP 合同与 QQ bridge 的 `qqBridgeEvents` 合同继续使用。

## 开发与文档

```bash
npm run check
npm test
npm pack --dry-run
```

Node.js 22+；当前 82 项测试。接入与缓存设计见 [PLAN.md](PLAN.md)，咒语执行设计见 [SPELL-PLAN.md](SPELL-PLAN.md)，养成设计与交付状态见核心的 [设计文档](https://github.com/lxl8182/rin-memory/blob/main/docs/companion-growth-design.md) 与 [统一台账](https://github.com/lxl8182/rin-memory/blob/main/docs/roadmap.md)。

## 许可

[Apache-2.0](LICENSE)。
