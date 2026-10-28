/**
 * 「魔法」标签的解析与执行。
 *
 * 主会话不上报任何工具(见 main-session.js 的实测说明),动作改由正文里的标签
 * 表达:<读取>…</读取> / <生成>…</生成> / <执行>…</执行>。标签是纯文本,不会
 * 把模型推进 function-calling 语境,所以思考仍是角色独白;真正干活的是这里。
 *
 * 三条硬原则:
 * 1. 模型念完咒语就必须闭嘴——解析出的标签不进正文可见部分,由程序执行后以
 *    「终端反馈」的形式回填给模型,模型不得自己编造结果。
 * 2. 一次回复里可以有多个标签,按出现顺序执行;执行失败如实回报,不吞掉。
 * 3. 标签内容只作为本次调用的入参,不落盘、不进记忆、不当作用户偏好证据。
 */

/**
 * 内置咒语;顺序即协议里书写的顺序。
 *
 * 前三个动外面的世界,后四个动自己的记忆本。记忆类咒语不能省:召回与注入是
 * 程序自动做的,但"你记错了""忘掉这个""以后都这么说"必须由模型当场发起——
 * 否则它只能口头答应,服务里的条目一条没动。
 *
 * <学到> 是唯一一条**不把正文当作入参**的咒语:它只把本轮用户消息的 source_key
 * 报给服务,规则由服务端从自己保存的原文确定性派生(设计 §8.3/§8.5)。标签里
 * 写什么都不会被当成规则文本发出去 —— 这是安全底线,不是实现细节。
 */
import { contactControls } from './contact.js'

export const SPELLS = Object.freeze(['读取', '执行', '翻本子', '改写', '撕掉', '学到'])

/**
 * 从一段回复里拆出可见正文与咒语。
 *
 * @param {string} text 模型回复的完整正文
 * @returns {{ visible: string, casts: Array<{ spell: string, body: string }> }}
 *   visible 是去掉标签后的可见正文(可能为空串),casts 按出现顺序排列。
 */
export function parseSpells(text, learnedNames = []) {
  const source = contactControls(text).text
  const casts = []
  const unknown = []
  if (!source) return { visible: '', casts, unknown }
  // 咒语名一律是 2–8 个汉字(内置的五条与学来的都满足),所以不必列举名字,
  // 按形状认就行。认得的才是咒语,不认识的是"念了一个还没学会的咒语"。
  const pattern = /<([\p{Script=Han}]{2,8})>([\s\S]*?)<\/\1>/gu
  const known = new Set([...SPELLS, ...learnedNames])
  let last = 0
  let visible = ''
  let match
  while ((match = pattern.exec(source)) !== null) {
    visible += source.slice(last, match.index)
    const body = match[2].trim()
    if (known.has(match[1])) {
      if (body) casts.push({ spell: match[1], body })
    } else {
      // 学咒语是异步的:模型刚念完 <学咒语>,下一轮就可能念新名字。这时咒语
      // 还不存在,必须回一句"还没学会",不能让标签悄悄消失 —— 它会把沉默
      // 当成成功,继续演下去。
      unknown.push({ spell: match[1], body })
    }
    last = match.index + match[0].length
  }
  visible += source.slice(last)
  // 未闭合的标签不能当咒语执行:多半是模型写了一半就停了,如实留给正文,
  // 让用户看见"它想做什么但没说完",而不是猜一个意思去跑。
  return { visible: visible.replace(/\n{3,}/g, '\n\n').trim(), casts, unknown }
}

/** 终端反馈的固定外形:回填给模型时标记来源,不冒充用户发言。 */
export function renderFeedback(cast, outcome) {
  const head = `【终端反馈·${cast.spell}】`
  const body = String(outcome?.text ?? '').trim()
  if (outcome?.ok === false) return `${head}失败：${body || '未知原因'}`
  return body ? `${head}\n${body}` : `${head}\n(没有输出)`
}

/**
 * 把一批咒语依次执行。
 *
 * @param {Array<{spell:string, body:string}>} casts 解析出的咒语
 * @param {object} handlers 每个咒语的执行函数:{ 读取, 生成, 执行 }
 * @returns {Promise<Array<{cast:object, ok:boolean, text:string}>>} 与 casts 一一对应
 */
export async function runSpells(casts, handlers) {
  const results = []
  for (const cast of casts) {
    const handler = handlers?.[cast.spell]
    if (typeof handler !== 'function') {
      results.push({ cast, ok: false, text: '这个咒语现在还没有接上。' })
      continue
    }
    try {
      const value = await handler(cast.body)
      results.push({ cast, ok: true, text: typeof value === 'string' ? value : JSON.stringify(value ?? '') })
    } catch (error) {
      results.push({ cast, ok: false, text: error?.message ?? String(error) })
    }
  }
  return results
}
