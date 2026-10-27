import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SPELLS } from './magic.js'

export const META_SPELLS = Object.freeze(['学咒语', '忘掉咒语'])
export const LEARNED_LIMIT = 8
export const TRIAL_BODY = '咒语试跑'
const VIA = new Set(['读取', '执行'])

/**
 * 从工作会话的最终文字里取出它验证过的做法。
 *
 * 工作会话是自由发挥的 agent：它会自己装东西、写脚本、反复试到跑通，最后按
 * 约定在末尾报一行。取**最后**一个标记，因为前面可能是它中途的尝试。
 * 拿不到就返回 undefined——让上层如实报错，而不是猜一条命令存进去。
 */
export function parseSolved(text) {
  const source = String(text ?? '')
  const marker = source.lastIndexOf('【咒语】')
  if (marker < 0) return undefined
  // 标记本身可能就在那一行的开头,所以先把标记本身摘掉,再逐行找。
  const lines = source.slice(marker + '【咒语】'.length).split('\n')
  for (const line of lines) {
    const [rawVia, ...rest] = line.split('|||')
    const via = (rawVia ?? '').trim()
    const template = rest.join('|||').trim()
    if (VIA.has(via) && template) return { via, template }
  }
  return undefined
}

function validate(spell) {
  if (!/^[\p{Script=Han}]{2,8}$/u.test(spell.name)) throw new Error('咒语名字必须是 2–8 个中文字符。')
  if ([...SPELLS, ...META_SPELLS].includes(spell.name)) throw new Error('不能与内置咒语重名。')
  if (!spell.note || spell.note.length > 120 || /[\r\n]/.test(spell.note)) throw new Error('说明须为 1–120 字的单行文字。')
  if (!VIA.has(spell.via)) throw new Error('via 只能是读取、生成或执行，不能指向学来的咒语。')
  if (!spell.template.trim()) throw new Error('模板不能为空。')
}

/** 只持久化已试跑成功的模板；展开后直接调用内置入口，不二次解析正文。 */
export class SpellLibrary {
  constructor({ statePath, now = () => new Date().toISOString() }) {
    this.statePath = statePath
    this.now = now
    this.spells = []
    this.openError = null
  }

  /**
   * 读取台账。
   *
   * 坏条目只跳过、不抛错:这份文件可能被工作会话直接改过,一条写歪就整个插件
   * 起不来是不划算的。整份读不动(JSON 语法错)也降级成空台账并记下原因,
   * 让「学咒语」还能工作——报错总比让 QQ 主会话完全连不上好。
   */
  async open() {
    this.openError = null
    let raw
    try { raw = await readFile(this.statePath, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    let data
    try { data = JSON.parse(raw) }
    catch (error) {
      this.openError = `spells.json 无法解析(${error.message}),已按空台账启动。`
      return
    }
    if (data?.schema_version !== 1 || !Array.isArray(data.spells)) {
      this.openError = 'spells.json 结构不对,已按空台账启动。'
      return
    }
    const names = new Set()
    const kept = []
    for (const spell of data.spells.slice(0, LEARNED_LIMIT)) {
      try {
        validate(spell)
        if (names.has(spell.name) || !Number.isFinite(Date.parse(spell.verified_at))) continue
        names.add(spell.name)
        kept.push(spell)
      } catch { /* 跳过坏条目 */ }
    }
    this.spells = kept
  }

  list() {
    return this.spells.map(spell => ({ ...spell }))
  }

  expand(cast) {
    const spell = this.spells.find(row => row.name === cast.spell)
    return spell ? { spell: spell.via, body: spell.template.replaceAll('{body}', () => cast.body) } : cast
  }

  async commit(spells) {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temp = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ schema_version: 1, spells }, null, 2), { mode: 0o600 })
    await rename(temp, this.statePath)
    this.spells = spells
  }

  /**
   * 立刻能判定的那部分:名字、说明、与已有咒语的关系。
   *
   * 学咒语是异步的(见 learn),所以校验必须能单独先跑一次 —— 名字写错这种
   * 事不该让主人等上几分钟才听到。
   */
  check(body) {
    const [name = '', note = '', via = '', ...template] = body.split('|||')
    const spell = { name: name.trim(), note: note.trim(), via: via.trim(), template: template.join('|||').trim() }
    const blank = { name: spell.name, note: spell.note }
    // 名字与说明必须总是合法的。
    if (!/^[\p{Script=Han}]{2,8}$/u.test(blank.name)) throw new Error('咒语名字必须是 2–8 个中文字符。')
    if ([...SPELLS, ...META_SPELLS].includes(blank.name)) throw new Error('不能与内置咒语重名。')
    if (!blank.note || blank.note.length > 120 || /[\r\n]/.test(blank.note)) throw new Error('说明须为 1–120 字的单行文字。')
    // 自己给了做法,就必须是能独立成立的一条:via 得是内置咒语。
    // 两样都不给才算"交给工作会话去定"。
    if (spell.template || spell.via) validate(spell)
    if (this.spells.some(row => row.name === spell.name)) throw new Error('已经学过这个名字；先忘掉再重新学。')
    if (this.spells.length >= LEARNED_LIMIT) throw new Error(`最多学 ${LEARNED_LIMIT} 条咒语；先忘掉一条。`)
    return spell
  }

  async learn(body, runSpell, signal, workOut) {
    const spell = this.check(body)
    return await this.finish(spell, runSpell, signal, workOut)
  }

  /** 校验通过之后真正的学习和试跑。慢的那一半,可以放到后台等。 */
  async finish(spell, runSpell, signal, workOut) {
    const blank = { name: spell.name, note: spell.note }

    // 模板齐全就先自己试;跑不通再交给工作会话,而不是直接把失败丢给主人。
    let trialError
    if (spell.template) {
      try {
        await runSpell({ spell: spell.via, body: spell.template.replaceAll('{body}', () => TRIAL_BODY) })
        signal?.throwIfAborted()
        return await this.save(spell, '试跑成功。')
      } catch (error) {
        trialError = error
      }
    }
    if (!workOut) {
      throw trialError ?? new Error('这条咒语还没写成能跑的样子，也没法交给工作会话去试。')
    }
    const solved = await workOut(blank, trialError)
    signal?.throwIfAborted()
    if (!solved?.template) {
      throw new Error(`没能把这件本事做通${trialError ? `（${trialError.message}）` : ''}。`)
    }
    spell.via = solved.via
    spell.template = solved.template
    validate(spell)
    await runSpell({ spell: spell.via, body: spell.template.replaceAll('{body}', () => TRIAL_BODY) })
    signal?.throwIfAborted()
    return await this.save(spell, '工作会话做通了，试跑也过了。')
  }

  async save(spell, detail) {
    spell.verified_at = this.now()
    await this.commit([...this.spells, spell])
    return `已学会「${spell.name}」，${detail}${spell.template.includes('{body}') ? '' : '这是固定命令，不使用咒语正文作为参数。'}`
  }

  async forget(name) {
    const target = name.trim()
    if (!this.spells.some(spell => spell.name === target)) throw new Error(`没有学过「${target}」。`)
    await this.commit(this.spells.filter(spell => spell.name !== target))
    return `已忘掉「${target}」。`
  }
}
