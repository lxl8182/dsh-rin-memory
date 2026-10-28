import { randomUUID } from 'node:crypto'
import { parseSpells } from './magic.js'

export const PROACTIVE_SOURCE = 'companion-proactive'

export class ProactiveRuntime {
  constructor(runtime) {
    this.runtime = runtime
    this.active = new Map()
    this.busy = new Set()
    this.tail = Promise.resolve()
    this.retryAt = 0
  }

  async observe(input) {
    if (!this.runtime.config.proactiveEnabled || !this.runtime.bridge?.deliverOutput) return
    try {
      await this.runtime.client.request('/v1/proactive/observe', {
        ...this.runtime.client.scope(input.sessionId), text: input.input,
        request_id: 'inbound:' + String(input.messageId ?? randomUUID()),
      })
    } catch (error) {
      this.retryAt = Date.now() + 60000
      this.runtime.logger.warn?.('[dsh-rin-memory] 主动状态同步暂缓：' + (error.code ?? error.message))
    }
  }

  event(session, event) {
    if (event.type === 'turn/start') this.busy.add(session.id)
    if (event.type !== 'turn/end') return
    this.busy.delete(session.id)
    const run = this.active.get(session.id)
    if (!run || run.turn !== event.data?.turn) return
    const finish = async () => {
      try { await this.finish(session, event, run) }
      catch (error) { this.runtime.logger.warn?.('[dsh-rin-memory] 主动输出待恢复：' + error.message) }
      finally {
        run.finishOutput?.()
        if (this.active.get(session.id) === run) this.active.delete(session.id)
      }
    }
    this.tail = this.tail.then(finish)
  }

  async prepare(agent, payload) {
    const run = this.active.get(agent.session.id)
    if (!run) return undefined
    run.turn = payload.turn
    await this.runtime.client.request('/v1/proactive/use', {
      ...this.runtime.client.scope(agent.session.id), candidate_id: run.candidate_id,
      lease_id: run.lease_id, context_receipt_id: run.context.context_receipt_id,
      consumer_refs: { plugin_id: this.runtime.config.pluginId,
        memory_ids: run.context.context?.memory_ids ?? [],
        source_ids: run.context.context?.source_ids ?? [],
        context_generation: String(run.context.persona_version ?? '') },
    })
    const scopeId = this.runtime.client.scope(agent.session.id).session_id
    await this.runtime.client.serial(async () => {
      const state = this.runtime.client.state
      state.sessions[scopeId] = agent.session.id
      const prior = state.references[scopeId] ?? { ids: [], sources: [], versions: [] }
      state.references[scopeId] = {
        ids: [...new Set([...prior.ids, ...(run.context.context?.memory_ids ?? []), ...(run.context.context?.source_ids ?? [])])],
        sources: [...new Set([...prior.sources, ...(run.context.recent_turns ?? []).flatMap(row => {
          const meta = row?.data?.metadata ?? row?.metadata ?? {}
          return [...(meta.source_event_keys ?? []), ...(meta.source_key ? [meta.source_key] : [])]
        })])],
        versions: [...new Set([...prior.versions, ...(run.context.persona_version ? [run.context.persona_version] : [])])],
      }
      await this.runtime.client.save()
    })
    const rendered = await this.runtime.renderBackground(agent.session.id, run.context)
    const prepared = { background: rendered.text, fingerprints: rendered.fingerprints,
      requestId: run.request_id, personaVersion: run.context.persona_version }
    this.runtime.turns.set(agent, {
      turn: payload.turn, requestId: run.request_id, prepared, injected: false, proactive: true,
    })
    return prepared
  }

  async tick() {
    const runtime = this.runtime
    if (runtime.stopped || !runtime.config.proactiveEnabled || !runtime.bridge?.deliverOutput || Date.now() < this.retryAt) return
    try {
      await this.resume()
      if (this.active.size || Object.keys(runtime.client.state.proactiveOutputs).length) return
      for (const agent of runtime.attached.keys()) {
        const sessionId = agent.session.id
        if (!runtime.isTrusted(agent) || this.busy.has(sessionId) || runtime.client.isRetired(sessionId)) continue
        const request_id = 'proactive:' + randomUUID()
        const result = await runtime.client.request('/v1/proactive/poll', {
          ...runtime.client.scope(sessionId), request_id,
        })
        if (result.status !== 'ready') continue
        const { candidate, context } = result
        const run = { ...candidate, context, request_id, sessionId, finishOutput: runtime.bridge.beginOutput(sessionId) }
        runtime.personas.set(sessionId, context.persona)
        this.active.set(sessionId, run)
        try { agent.followup({
          id: request_id, role: 'user', source: { kind: PROACTIVE_SOURCE },
          content: [{ type: 'text', text:
            '这是一条后台送来的主动搭话机会，不是主人新发言。结合当前人格和交流背景，自然地找主人聊。\n'
            + '想聊的内容：' + candidate.text + '\n缘由：' + (candidate.why ?? '')
            + '\n如果眼下不值得说就只回复 [PASS]。否则只写准备发给主人的话，本轮不念魔法。' }],
        }) } catch (error) {
          run.finishOutput()
          this.active.delete(sessionId)
          throw error
        }
        break
      }
    } catch (error) {
      this.retryAt = Date.now() + 60000
      runtime.logger.warn?.('[dsh-rin-memory] 主动交流暂缓，普通聊天继续：' + (error.code ?? error.message))
    }
  }

  async release(run, reason = '') {
    return this.runtime.client.request('/v1/proactive/release', {
      ...this.runtime.client.scope(run.sessionId), candidate_id: run.candidate_id, lease_id: run.lease_id,
      reason,
    })
  }

  async finish(session, event, run) {
    const runtime = this.runtime
    if (runtime.stopped) return
    if (event.data?.reason?.kind !== 'completed') {
      this.retryAt = Date.now() + 60000
      await this.release(run)
      return
    }
    const events = session.snapshotEvents?.() ?? session.events ?? []
    const start = events.findIndex(row => row.type === 'turn/start' && row.data?.turn === event.data.turn)
    const end = events.findIndex((row, index) => index > start
      && row.type === 'turn/end' && row.data?.turn === event.data.turn)
    const messages = start < 0 ? [] : events.slice(start, end < 0 ? undefined : end + 1)
      .filter(row => row.type === 'assistant/message' && !row.data?.interrupted)
    let text = runtime.bridge.assistantText(messages).trim()
    const parsed = parseSpells(text)
    if (!text || text === '[PASS]' || parsed.casts.length) {
      await this.release(run, 'model_pass')
      return
    }
    const plan = runtime.bridge.planOutput(text)
    text = plan.text
    if (!text.trim()) { await this.release(run, 'model_pass'); return }
    const scope = runtime.client.scope(session.id)
    const body = { ...scope, candidate_id: run.candidate_id, lease_id: run.lease_id,
      context_receipt_id: run.context.context_receipt_id, text, part_sizes: plan.part_sizes }
    // Persist before the completion POST: a lost response replays the same body.
    await runtime.client.serial(async () => {
      runtime.client.state.proactiveOutputs[run.request_id] = { scope, sessionId: session.id, body }
      await runtime.client.save()
    })
    await this.deliver(run.request_id)
  }

  async remove(id) {
    await this.runtime.client.serial(async () => {
      delete this.runtime.client.state.proactiveOutputs[id]
      await this.runtime.client.save()
    })
  }

  async resume() {
    for (const id of Object.keys(this.runtime.client.state.proactiveOutputs)) await this.deliver(id)
  }

  async deliver(id) {
    const runtime = this.runtime
    const pending = runtime.client.state.proactiveOutputs[id]
    if (!pending) return
    if (runtime.client.isRetired(pending.sessionId)) { await this.remove(id); return }
    const binding = runtime.bridge?.binding(pending.sessionId)
    if (!binding?.owner || binding.scope !== 'private') return
    if (!pending.output_id) {
      let completed
      try { completed = await runtime.client.request('/v1/proactive/complete', pending.body) }
      catch (error) {
        if (error.kind === 'stale' || error.kind === 'gone' || error.code === 'forbidden') {
          await this.remove(id)
          return
        }
        throw error
      }
      if (!completed.ok) {
        await this.remove(id)
        return
      }
      pending.output_id = completed.output_id
      await runtime.client.save()
    }
    const output = await runtime.client.request('/v1/outputs', {
      ...pending.scope, output_id: pending.output_id,
    }, 'GET')
    const record = output.output ?? output.record ?? output
    const parts = record.pending_parts ?? []
    if (!parts.length) { await this.remove(id); return }
    const delivered = await runtime.bridge.deliverOutput(pending.sessionId, pending.output_id, parts, async () => {
      const verdict = await runtime.client.request('/v1/proactive/check', pending.body)
      return verdict.ok === true
    })
    if (!delivered) throw new Error('QQ durable output transport is unavailable')
    const accepted = delivered.parts.filter(part => part.ok)
    if (accepted.length) await runtime.client.request('/v1/outputs/deliver', {
      ...pending.scope, output_id: pending.output_id, kind: 'sent',
      parts: accepted.map(part => ({ index: part.index, platform_id: part.platformId })),
    })
    if (delivered.status === 'cancelled') await runtime.client.request('/v1/outputs/deliver', {
      ...pending.scope, output_id: pending.output_id, kind: 'interrupted', parts: [], reason: 'output_no_longer_valid',
    })
    if (delivered.status === 'completed' || delivered.status === 'cancelled') await this.remove(id)
  }
}
