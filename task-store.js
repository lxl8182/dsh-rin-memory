/**
 * companion_task 的任务台账。
 *
 * 这里只保存"派发过什么、现在到哪一步、通知过没有"这三件事。执行本身由
 * DSH 原生后台子会话完成,本文件不重放、不调度、不轮询。
 *
 * 几条硬约束:
 * - 派发前先落盘:crash 之后队列里能查到这条任务,而不是只在内存里存在过;
 * - 幂等键唯一:同一个 owner/QQ 会话/源轮次/工具调用重放返回原任务,不同轮次
 *   的同一句话是新任务;
 * - 重启收敛:running 且没有终态的一律收敛成 interrupted/unknown,**绝不**
 *   重新派发。文件操作与命令做过就可能有效果,重做比不做更危险;
 * - 写入与 memory-client.js 同风格:临时文件 + rename,先写后换。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 终态:这些状态的任务不再变化,也不再重放。 */
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown'])

/** 允许出现的状态集合。 */
export const STATUSES = new Set(['queued', 'running', ...TERMINAL])

const now = () => new Date().toISOString()

function emptyState() {
  return { version: 1, tasks: {} }
}

/**
 * 一条任务记录的字段。
 *
 * 只放"重启后还认得出这个任务"所需的元数据;正文、日志、工具输出都留在原生
 * 子会话轨迹里,用 resultRef 指过去,不复制一份到台账。
 */
function newRecord(fields) {
  const stamp = now()
  return {
    taskId: '',
    idempotencyKey: '',
    owner: '',
    qqSessionId: '',
    sourceTurnRequestId: '',
    parentSessionId: '',
    childSessionId: '',
    cwd: '',
    status: 'queued',
    resultSummary: '',
    resultRef: '',
    notified: false,
    createdAt: stamp,
    updatedAt: stamp,
    lastStopReason: '',
    ...fields,
  }
}

export class TaskStore {
  /**
   * @param {object} options
   * @param {string} [options.statePath] 台账路径;为空则只在内存里保存
   * @param {object} [options.logger]
   * @param {() => string} [options.clock]
   */
  constructor({ statePath, logger = console, clock = now } = {}) {
    this.statePath = statePath
    this.logger = logger
    this.clock = clock
    this.state = emptyState()
    this.tail = Promise.resolve()
    /** 上一次读盘失败的原因;失败即 fail closed 到空台账,但原因要留下。 */
    this.openError = null
    /** 所有任务 ID 由这里生成,重放任务沿用原 ID。 */
    this.lastReservation = null
  }

  // -- persistence -----------------------------------------------------

  async open() {
    if (!this.statePath) return
    let raw
    try {
      raw = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return
      // A damaged ledger is not silently replaced by a blank one: report it so
      // the operator can look, then fail closed and keep chating working.
      this.openError = `任务台账无法解析：${error.message}`
      this.logger.warn?.(`[dsh-rin-memory] ${this.openError}`)
      return
    }
    if (raw?.version !== 1 || typeof raw.tasks !== 'object' || raw.tasks === null || Array.isArray(raw.tasks)) {
      this.openError = '任务台账格式错误'
      this.logger.warn?.('[dsh-rin-memory] 任务台账格式错误，按空台账继续')
      return
    }
    this.state = { version: 1, tasks: raw.tasks }
  }

  async save() {
    if (!this.statePath) return
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
    await rename(temporary, this.statePath)
  }

  /** 串行化所有改动,避免并发保存互相覆盖。 */
  serial(action) {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }

  // -- queries ---------------------------------------------------------

  get(taskId) {
    return this.state.tasks[taskId]
  }

  findByChild(childId) {
    if (!childId) return undefined
    for (const record of Object.values(this.state.tasks)) {
      if (record.childSessionId === childId) return record
    }
    return undefined
  }

  /** 已经需要通知主会话、但还没通知过的任务。只返回终态。 */
  pendingNotifications() {
    return Object.values(this.state.tasks)
      .filter(record => TERMINAL.has(record.status) && record.notified !== true)
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  }

  /** 某个 owner 名下的任务,新的在前。 */
  listForOwner(owner) {
    if (!owner) return []
    return Object.values(this.state.tasks)
      .filter(record => record.owner === owner)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  // -- mutations -------------------------------------------------------

  /**
   * 幂等登记一个任务。
   *
   * 同一个键第二次进来时**不**新建记录,原样返回第一次那条并标记 replay,
   * 调用方据此跳过派发。不同轮次的同一句话键不同,所以是新任务。
   */
  async reserve(key, record = {}) {
    return await this.serial(async () => {
      const existing = Object.values(this.state.tasks).find(item => item.idempotencyKey === key)
      if (existing) {
        return { task: existing, replay: true }
      }
      const taskId = record.taskId || `task_${randomUUID()}`
      // The key and the id are this method's call, not the caller's: a record
      // that carries its own idempotencyKey must not break the uniqueness the
      // replay guard depends on.
      const task = newRecord({
        ...record,
        taskId,
        idempotencyKey: key,
        createdAt: this.clock(),
        updatedAt: this.clock(),
        status: 'queued',
        notified: false,
      })
      this.state.tasks[taskId] = task
      await this.save()
      return { task, replay: false }
    })
  }

  /** 派发成功:记下原生子会话 id 并进入 running。 */
  async markRunning(taskId, { childSessionId = '', cwd } = {}) {
    return await this.serial(async () => {
      const task = this.state.tasks[taskId]
      if (!task) return undefined
      if (TERMINAL.has(task.status)) return task
      task.status = 'running'
      if (childSessionId) task.childSessionId = childSessionId
      if (cwd) task.cwd = cwd
      task.updatedAt = this.clock()
      await this.save()
      return task
    })
  }

  /**
   * 收到终态事件后写回。
   *
   * 按 child 会话 id 定位;找不到就什么都不做,而不是新建一条来历不明的任务。
   * 已经终态的任务不覆盖:先到的那次结算才是真的。
   */
  async markSettled(childSessionId, { status, stopReason = '', summary = '', resultRef = '' } = {}) {
    return await this.serial(async () => {
      const task = this.findByChild(childSessionId)
      if (!task) return undefined
      if (TERMINAL.has(task.status)) return task
      task.status = STATUSES.has(status) ? status : 'unknown'
      task.lastStopReason = stopReason ?? ''
      if (summary) task.resultSummary = String(summary).slice(0, 2000)
      if (resultRef) task.resultRef = String(resultRef)
      task.updatedAt = this.clock()
      await this.save()
      return task
    })
  }

  /** 幂等写终态:手工取消/派发失败用。 */
  async markStatus(taskId, status, { stopReason = '', summary = '' } = {}) {
    return await this.serial(async () => {
      const task = this.state.tasks[taskId]
      if (!task) return undefined
      if (TERMINAL.has(task.status)) return task
      task.status = STATUSES.has(status) ? status : 'unknown'
      if (stopReason) task.lastStopReason = stopReason
      if (summary) task.resultSummary = String(summary).slice(0, 2000)
      task.updatedAt = this.clock()
      await this.save()
      return task
    })
  }

  /** 记下"这次结果已经交给主会话",保证默认只通知一次。 */
  async markNotified(taskId) {
    return await this.serial(async () => {
      const task = this.state.tasks[taskId]
      if (!task) return undefined
      task.notified = true
      task.updatedAt = this.clock()
      await this.save()
      return task
    })
  }

  /**
   * 重启核对。
   *
   * 台账里 queued/running 而宿主那边没有终态的任务,一律收敛成 interrupted;
   * 连子会话 id 都没有的(派发中途崩溃)记 unknown。**不重新派发**:这些任务
   * 可能已经碰过文件或命令,重做比不做更危险。
   */
  async recover() {
    return await this.serial(async () => {
      const touched = []
      for (const task of Object.values(this.state.tasks)) {
        if (TERMINAL.has(task.status)) continue
        const before = task.status
        task.status = task.childSessionId ? 'interrupted' : 'unknown'
        task.lastStopReason = 'recovered-on-startup'
        if (!task.resultSummary) {
          task.resultSummary = task.childSessionId
            ? '重启前任务未收到终态,已标记为 interrupted(未重做)。'
            : '重启前任务尚未派发完成,已标记为 unknown(未重做)。'
        }
        task.updatedAt = this.clock()
        touched.push({ taskId: task.taskId, from: before, to: task.status })
      }
      if (touched.length > 0) await this.save()
      return touched
    })
  }
}

export { emptyState }
