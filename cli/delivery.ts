import { setTimeout as delay } from 'node:timers/promises'
import { recordId } from './agent-records.ts'
import type { ResearchStore } from '../server/db.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { ResearchRun } from '../shared/research-run.ts'

/** One message Kraflr pushes into an agent's prompt: a verification grant, a teammate's reply, a handoff. */
export interface Delivery {
  panelId: string
  scopeVersion: number
  /** The receiving agent. */
  to: string
  /** Stable seed for the saved record, so asking twice for the same delivery does nothing. */
  key: string
  /** Who the message is from, as shown in the saved record. */
  from: string
  objective: string
  /** What the receiver is asked to do, for the record. */
  task: string
  waiting: string
  done: string
  failed: string
  doneResult: string
  /** The message text delivered to the agent. */
  text: string
  /** Saved with the record so the researcher can read exactly what was sent. */
  saved?: string
  /** Handed the receiver's reply once it answers. */
  onReply?: (reply: string) => void
}

const giveUpAfter = 60 * 60_000

/**
 * Delivers messages to agents one at a time per receiver. A receiver that is busy, still choosing a model or inside a team run is waited for,
 * so a message is neither lost nor pasted over somebody's unsent input. Every delivery leaves a saved record, even when it fails.
 */
export function createDelivery(store: ResearchStore, terminals: Pick<AgentTerminals, 'list' | 'researchTurn'>) {
  const lifetime = new AbortController()
  const active = new Map<string, { panelId: string; stop: AbortController; done: Promise<void> }>()
  const queues = new Map<string, Promise<void>>()

  function send(request: Delivery) {
    if (lifetime.signal.aborted) return
    const receiver = terminals.list().find((agent) => agent.id === request.to && agent.panelId === request.panelId && agent.chat && agent.state === 'running' && agent.scopeVersion === request.scopeVersion)
    if (!receiver) return
    const id = recordId('delivery:' + request.key)
    if (store.hasAgentRecord(request.panelId, id)) return
    const run: ResearchRun = {
      id, panelId: request.panelId, parentId: receiver.id, parentName: request.from, scopeVersion: request.scopeVersion, purpose: 'collaboration',
      objective: request.objective, status: 'running', phase: request.waiting, startedAt: new Date().toISOString(), endedAt: null,
      summary: request.objective, fullReply: request.saved ?? request.text, leads: [], deadEnds: [], nextSteps: [],
      tasks: [{ sessionId: receiver.id, agent: receiver.label, objective: request.task, status: 'assigned', result: '' }],
    }
    // A scope change between the request and the record means the message is stale; nothing is delivered.
    try { store.saveAgentRecord(run) } catch { return }
    const stop = new AbortController(), signal = AbortSignal.any([stop.signal, lifetime.signal])
    const earlier = (queues.get(receiver.id) ?? Promise.resolve()).catch(() => {})
    const done = earlier.then(async () => {
      try {
        const deadline = Date.now() + giveUpAfter
        for (;;) {
          signal.throwIfAborted()
          store.readSourceScope(request.panelId, request.scopeVersion)
          const current = terminals.list().find((agent) => agent.id === receiver.id && agent.state === 'running')
          if (!current) throw Error('The receiving agent is no longer available')
          // Wait only if this receiver is busy inside a run (as its Parent or as an assigned worker). Other agents of the panel keep working in parallel.
          const inRun = store.activeResearch().some((item) => item.panelId === request.panelId && (item.parentId === receiver.id || item.assignments.some((task) => task.sessionId === receiver.id)))
          if (current.promptReady !== false && !current.modelSelectionRequired && !inRun) break
          if (Date.now() > deadline) throw Error('The receiving agent stayed busy')
          await delay(150, undefined, { signal })
        }
        const reply = await terminals.researchTurn(request.panelId, receiver.id, request.text, request.scopeVersion, signal)
        run.tasks[0]!.fullReply = reply
        run.tasks[0]!.result = request.doneResult
        run.tasks[0]!.status = 'completed'; run.status = 'completed'; run.phase = request.done
        request.onReply?.(reply)
      } catch {
        run.status = signal.aborted ? 'interrupted' : 'failed'; run.tasks[0]!.status = signal.aborted ? 'interrupted' : 'failed'
        run.phase = request.failed
      } finally { run.endedAt = new Date().toISOString(); store.saveAgentRecord(run) }
    }).finally(() => { active.delete(id); if (queues.get(receiver.id) === done) queues.delete(receiver.id) })
    queues.set(receiver.id, done)
    active.set(id, { panelId: request.panelId, stop, done })
  }

  return {
    send,
    has: (id: string) => active.has(id),
    cancel(panelId: string, id: string) {
      const job = active.get(id)
      if (!job || job.panelId !== panelId) throw Error('Delivery not found')
      job.stop.abort()
      return store.readResearchRun(panelId, id)
    },
    async close() { lifetime.abort(); await Promise.allSettled([...active.values()].map((job) => job.done)) },
  }
}

export type DeliveryQueue = ReturnType<typeof createDelivery>
