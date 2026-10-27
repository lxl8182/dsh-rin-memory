/**
 * DSH 本地会话正文的清理。
 *
 * 清理是删除闭环里唯一不能只靠“退役”完成的一步:退役只是让旧会话不再被采用,
 * 正文仍躺在磁盘上,下一次恢复、摘要或搜索仍可能把它带回来。所以这里直接对
 * 会话日志文件动手,并且**先删除正文、后向服务确认**。
 *
 * 几条硬约束:
 * - 只碰点名会话:<root>/<projectKey>/<sessionId>/ 这一个目录。
 * - 不猜结构:文件名与目录布局来自 `dsh-session-persistence-jsonl` 的现有约定
 *   (`session.v<N>.jsonl[.zstd]`),不匹配就不删,并如实报告原因。
 * - 压缩格式按魔数判断,不按扩展名猜;解压失败同样不删。
 * - 删除后核对目录确实消失(Windows 上句柄未释放会失败),失败即报 failed。
 * - 不触碰 `.lock` 以外的其它文件:目录整体移除,不留半截正文。
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 会话日志文件名:session.v<version>.jsonl 或 .jsonl.zstd。 */
const LOG_NAME = /^session\.v\d+\.jsonl(\.zstd)?$/

/**
 * 枚举一个会话根下所有会话目录。
 *
 * 布局是 `<root>/<projectKey>/<sessionId>/`。`_no-cwd` 也是合法项目目录。
 * 这里只读目录名,不读内容,便于在删除前确认目标存在。
 */
export async function listSessionDirectories(root, signal) {
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return found
    throw error
  }
  for (const project of projects) {
    if (signal?.aborted) return found
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let sessions
    try {
      sessions = await readdir(projectPath, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      found.push({ project: project.name, sessionId: session.name, path: join(projectPath, session.name) })
    }
  }
  return found
}

/**
 * 读取一个会话目录里的正文,用于核对“里面确实有目标内容”。
 *
 * 返回解压后的文本行;文件不存在或格式不认识时返回空。这个函数**不**修改
 * 任何东西,删除前的核对与删除后的复核都用它。
 */
export async function readSessionText(directory, signal) {
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return ''
  }
  let text = ''
  for (const name of entries) {
    if (signal?.aborted) break
    if (!LOG_NAME.test(name)) continue
    const buffer = await readFile(join(directory, name))
    text += `${decodeLog(buffer)}\n`
  }
  return text
}

/** 按魔数解压:zstd 帧以 0x28 B5 2F FD 开头,否则视为明文。 */
export function decodeLog(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5
      && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    return zstdDecompressSync(buffer).toString('utf8')
  }
  return buffer.toString('utf8')
}

/**
 * 删除一个会话目录,并确认它真的消失。
 *
 * 返回 `{ deleted, reason }`:只有目录在删除后确实不存在才算 `deleted`。
 * 句柄未释放(Windows 常见)会报原因,让调用方把清理标为 failed 并保留待办,
 * 而不是谎报已清理。
 */
export async function deleteSessionDirectory(directory) {
  let before
  try {
    before = await stat(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already-absent' }
    return { deleted: false, reason: error.code ?? 'stat-failed' }
  }
  if (!before.isDirectory()) return { deleted: false, reason: 'not-a-directory' }
  try {
    await rm(directory, { recursive: true, force: false, maxRetries: 3 })
  } catch (error) {
    return { deleted: false, reason: error.code ?? error.message ?? 'remove-failed' }
  }
  try {
    await stat(directory)
    return { deleted: false, reason: 'still-present' }
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'removed' }
    return { deleted: false, reason: error.code ?? 'verify-failed' }
  }
}
