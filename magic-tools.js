/**
 * 三个「魔法」咒语的实现。
 *
 * 主会话不上报任何工具(见 main-session.js 的实测说明),模型改在正文里写
 * <读取>…</读取> / <生成>…</生成> / <执行>…</执行>;这里才是真正动手的地方。
 *
 * 边界(按用户当前要求:单人自用,不额外设防):
 * - 读取:直接把路径内容读出来,交给模型接着判断;
 * - 生成:交给后台工作会话落地;
 * - 执行:在独立的原生后台会话里跑,不在 QQ 主会话进程里直接起 shell。
 *   这样即便模型写错,也炸不到聊天本身。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** 一次读取最多回给模型多少字符:够判断内容,又不至于把整份日志塞进上下文。 */
const READ_CHAR_LIMIT = 6000

/** 一次目录列表最多列多少项。 */
const LIST_LIMIT = 200

/**
 * 把 <读取> 后面的正文解释成"读文件"或"列目录"。
 *
 * 支持两种写法:直接给路径;或者 "路径 | 关键词" 形式,只回包含关键词的行。
 * 不做路径白名单——当前是单人自用环境,灵活性比设防更重要。
 */
export async function readSpell(body, { cwd } = {}) {
  const [rawPath, ...rest] = String(body ?? '').split('|')
  const target = rawPath.trim().replace(/^["']|["']$/g, '')
  if (!target) throw new Error('要读哪个路径?')
  const absolute = isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target)
  const info = await stat(absolute)
  if (info.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true })
    const shown = entries.slice(0, LIST_LIMIT)
    const lines = shown.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    const more = entries.length > shown.length ? `\n…还有 ${entries.length - shown.length} 项` : ''
    return `${absolute}:\n${lines.join('\n')}${more}`
  }
  const text = await readFile(absolute, 'utf8')
  const filter = rest.join('|').trim()
  if (filter) {
    const hit = text.split('\n').filter(line => line.includes(filter))
    return hit.length > 0
      ? hit.slice(0, LIST_LIMIT).join('\n').slice(0, READ_CHAR_LIMIT)
      : `${absolute} 里没有包含「${filter}」的行。`
  }
  return text.length > READ_CHAR_LIMIT
    ? `${text.slice(0, READ_CHAR_LIMIT)}\n…(已截断,共 ${text.length} 字符)`
    : text
}

/**
 * <执行> 交给后台工作会话。
 *
 * 真正的隔离、超时、等待与回填由 SpellRunner 负责；这里只把咒语翻译成
 * 具体的 goal。旧的 <生成> 已并入 <执行> —— 实测模型要写东西时直接写正文,
 * 从不念 <生成>,留着只是多一行提示词。
 */
export function spellToGoal(_spell, body) {
  const task = String(body ?? '').trim()
  if (!task) throw new Error('要办的是哪件事?说具体一点。')
  return task
}
