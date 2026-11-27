import type { FixtureRun, OpenCodeConnection } from '../shared/opencode.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import type { OpenCode } from './opencode.ts'

export function createFixtureRuns(store: ResearchStore, openCode: OpenCode | null) {
  let active: { run: FixtureRun; stop: AbortController; done: Promise<void> } | undefined
  let closing = false

  async function execute(client: OpenCode, run: FixtureRun, stop: AbortSignal) {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(70_000)])
    let sessionId: string | undefined
    try {
      sessionId = await client.createSession(signal)
      store.recordFixtureSession(run.id, sessionId)
      signal.throwIfAborted()
      const result = await client.review(sessionId, signal)
      signal.throwIfAborted()
      store.finishFixtureRun(run.id, 'completed', 'Fixture review completed.', result.lead, result.tokens)
    } catch (error) {
      const stopped = sessionId ? await client.abort(sessionId) : true
      if (stop.aborted && stopped) {
        store.finishFixtureRun(run.id, 'cancelled', 'The fixture review was stopped.')
      } else if (!stopped) {
        store.finishFixtureRun(run.id, 'interrupted', 'Kraflr could not confirm that OpenCode stopped the session.')
      } else {
        const detail = signal.aborted ? 'The fixture review timed out.'
          : error instanceof StoreError ? error.message : 'OpenCode could not complete the fixture review.'
        store.finishFixtureRun(run.id, 'failed', detail)
      }
    }
  }

  return {
    check: async (): Promise<OpenCodeConnection> => openCode ? openCode.check() : { status: 'unconfigured' },
    async start(panelId: string) {
      if (closing) throw new StoreError(503, 'Kraflr is shutting down.')
      if (!openCode) throw new StoreError(409, 'Configure a local OpenCode server and a model first.')
      const connection = await openCode.check()
      if (connection.status !== 'connected') {
        throw new StoreError(502, 'Kraflr could not connect to the supported OpenCode version.')
      }
      if (closing || active) throw new StoreError(409, 'Another fixture review is already running.')
      const run = store.createFixtureRun(panelId, openCode.model)
      const stop = new AbortController()
      const done = execute(openCode, run, stop.signal).catch(() => {
        console.error('Could not persist the OpenCode fixture review state.')
      }).finally(() => { active = undefined })
      active = { run, stop, done }
      return run
    },
    cancel(panelId: string, runId: string) {
      if (active?.run.panelId !== panelId || active.run.id !== runId) {
        throw new StoreError(409, 'This fixture review is no longer managed by this server.')
      }
      active.stop.abort()
    },
    async close() {
      closing = true
      active?.stop.abort()
      await active?.done
    },
  }
}
