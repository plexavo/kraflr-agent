import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { emptyScope } from '../shared/research.ts'
import { isAgentExecutor, isAgentPlan, isFullEnvironment, isProjectPlan, verificationVariants } from '../shared/verification.ts'
import type { FixtureObservation, ProjectObservation, ProjectVerificationInput, VerificationAvailability, VerificationExecutor, VerificationPlan, VerificationRecord, VerificationVariant } from '../shared/verification.ts'
import { evidenceIdPattern } from '../shared/evidence.ts'
import { isOpenLead } from '../shared/evidence.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import { CleanupError, VerificationExecutionError, fixturePlan, fixtureSource, fixtureVersion, readProjectObservation, verificationHash } from './verification-runner.ts'
import { latestPreparedLab } from './prepared-verification.ts'
import type { VerificationRunner } from './verification-runner.ts'
import { projectPlan, projectPlanProperties, projectPlanRequired } from './project-verification-plan.ts'

const uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const panelParams = { type: 'object', required: ['id'], properties: { id: uuid } }
const runParams = { type: 'object', required: ['id', 'runId'], properties: { id: uuid, runId: uuid } }
const changeBody = {
  type: 'object', additionalProperties: false, required: ['planHash', 'choice', 'note'],
  properties: {
    planHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    choice: { type: 'string', enum: ['approve', 'deny', 'cancel'] },
    note: { type: 'string', maxLength: 1200 },
    saveFindingOnSuccess: { type: 'boolean' },
    executor: { type: 'string', enum: ['kraflr', 'parent', 'child'] },
    agentId: uuid,
  },
}
const failureBody = {
  type: 'object', additionalProperties: false, required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 1200, pattern: '\\S' },
    stage: { type: 'string', maxLength: 60 },
    output: { type: 'string', maxLength: 3000 },
    exitCode: { type: 'integer', minimum: 0, maximum: 255 },
  },
}
const reportBody = {
  type: 'object', additionalProperties: false, required: ['observation'],
  properties: {
    image: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    observation: { type: 'object' },
    command: { type: 'string', maxLength: 2000 },
    exitCode: { type: 'integer', minimum: 0, maximum: 255 },
  },
}

interface PanelParams { id: string }
interface RunParams extends PanelParams { runId: string }
interface Decision { planHash: string; choice: 'approve' | 'deny' | 'cancel'; note: string; saveFindingOnSuccess?: boolean; executor?: VerificationExecutor; agentId?: string }
interface Report { image?: string; observation: unknown; command?: string; exitCode?: number }
interface Failure { message: string; stage?: string; output?: string; exitCode?: number }

/** A running test: either Kraflr's self-test runner mid-flight, or the lease an agent holds while it runs the container itself. */
interface Job { panelId: string; scopeVersion: number; controller: AbortController; done: Promise<void>; finish: () => void }
class LeaseExpired extends Error {}

/** How the verification routes learn about the live agents that may be asked to run a test. */
export interface VerificationAgents {
  /** The live agent that should run a test: the panel's Parent, or a Child (the named one, or the only one). Undefined when none can. */
  resolve(panelId: string, scopeVersion: number, executor: 'parent' | 'child', agentId?: string): { id: string; label: string } | undefined
  onGrant?(record: VerificationRecord): void
  /** How long an approved test stays open for its agent to run and report. */
  leaseMs?: number
}

const defaultLeaseMs = 30 * 60_000
const cleanupMessage = 'Container cleanup is unconfirmed. Kraflr retried it and Docker still did not confirm removal. Start Docker, then try again.'

export function registerVerification(app: FastifyInstance, store: ResearchStore, runner: VerificationRunner,
  onResult?: (record: VerificationRecord) => void, agents?: VerificationAgents) {
  const root = '/api/panels/:id/verification'
  const leaseMs = agents?.leaseMs ?? defaultLeaseMs
  const active = new Map<string, Job>()
  const lifetime = new AbortController()
  const unsubscribeScope = store.onScopeChanged((panelId, version) => {
    for (const current of active.values()) {
      if (current.panelId === panelId && current.scopeVersion !== version) {
        current.controller.abort(new StoreError(409, 'The research scope changed. The test was stopped; request a new plan on the current revision.'))
      }
    }
  })
  let recovery: Promise<void> | undefined
  let cleanupBlocked = false, lastCleanupAttempt = 0

  // A container that could not be removed blocks new runs, but only until Docker confirms its removal. Waiting for a restart
  // would turn one transient Docker hiccup into a dead verification feature.
  async function reconcileCleanup() {
    lastCleanupAttempt = Date.now()
    for (const record of store.pendingVerificationCleanup()) {
      try {
        if (!runner.cleanup) throw new Error('Runner cleanup is unavailable.')
        await runner.cleanup(record.id)
        store.recordVerificationCleanup(record.panelId, record.id, true)
      } catch {
        store.recordVerificationCleanup(record.panelId, record.id, false)
      }
    }
    cleanupBlocked = store.pendingVerificationCleanup().length > 0
  }
  async function cleanupIsBlocked() {
    if (!cleanupBlocked) return false
    if (Date.now() - lastCleanupAttempt > 3000) { lastCleanupAttempt = Date.now(); await reconcileCleanup() }
    return cleanupBlocked
  }
  async function available(plan?: VerificationPlan): Promise<VerificationAvailability> {
    if (await cleanupIsBlocked()) return { ready: false, detail: cleanupMessage, image: plan?.image ?? '' }
    return runner.available(plan)
  }

  function validatePlan(record: VerificationRecord) {
    const current = store.readPanel(record.panelId)
    if (current.scopeVersion !== record.scopeVersion) throw new StoreError(409, 'The scope changed. Queue a new plan.')
    const expected = isProjectPlan(record.plan)
      ? projectPlan(record.plan, store.readSourceScope(record.panelId, record.scopeVersion))

      : fixturePlan(record.plan.variant)
    if (verificationHash(record.plan) !== record.planHash || verificationHash(expected) !== record.planHash) {
      throw new StoreError(409, 'The fixture plan changed. Queue a new plan.')
    }
    if (!isOpenLead(store.readEvidence(record.panelId, record.leadId))) {
      throw new StoreError(409, 'Verification can only run for an Open Lead. Review its tag in Evidence.')
    }
    if (Date.parse(record.expiresAt) <= Date.now()) throw new StoreError(409, 'The plan expired. Queue a new plan.')
  }

  function notify(record: VerificationRecord) {
    try { onResult?.(store.readTest(record.panelId, record.id)) } catch { console.error('The verification result was saved but its Parent notification could not be queued.') }
  }

  /** Turn an observation into the saved status. Both executors go through here so they classify identically. */
  function settle(record: VerificationRecord, observation: FixtureObservation | ProjectObservation) {
    record.observation = observation
    if ('kind' in observation && observation.kind === 'project') {
      const environment = observation.environment
      if (!observation.controlPassed) {
        record.status = 'inconclusive'
        record.detail = 'The control check failed. ' + observation.summary
      } else if (observation.outcome !== 'inconclusive' && !isFullEnvironment(environment)) {
        // A shimmed or partial environment says nothing reliable about the real project, in either direction: it can neither confirm a flaw nor rule it out.
        record.status = 'inconclusive'
        record.detail = 'Not a full end-to-end reproduction, so it can neither confirm nor kill the lead. '
          + (environment ? `The agent reported a ${environment.fidelity} environment${environment.substituted.length ? ' with substitutes: ' + environment.substituted.join(', ') : ''}. ` : 'The report did not state what the test ran against. ')
          + `It claimed “${observation.outcome}”: ${observation.summary}`
      } else {
        record.status = observation.outcome
        record.detail = observation.summary
      }
    } else if ('ownerStatus' in observation && (observation.ownerStatus !== 200 || !observation.ownerRecordReturned)) {
      record.status = 'inconclusive'
      record.detail = 'The owner control failed, so the probe could not establish the outcome.'
    } else if ('foreignStatus' in observation && observation.foreignStatus === 200 && observation.foreignRecordReturned) {
      record.status = 'reproduced'
      record.detail = 'Alice received Bob’s synthetic export.'
    } else if ('foreignStatus' in observation && observation.foreignStatus === 403 && !observation.foreignRecordReturned) {
      record.status = 'not_reproduced'
      record.detail = 'The fixture blocked the cross-account request with HTTP 403.'
    } else {
      record.status = 'inconclusive'
      record.detail = 'The cross-account response did not match either expected observation.'
    }
  }

  async function run(record: VerificationRecord, controller: AbortController, announce = true) {
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    try {
      const observation = await runner.run(record.plan, record.id, signal, () => {
        if (cleanupBlocked) throw new StoreError(503, cleanupMessage)
        if (store.readTest(record.panelId, record.id).status !== 'running') {
          throw new StoreError(409, 'This verification is no longer approved for dispatch.')
        }
        validatePlan(record)
      })
      signal.throwIfAborted()
      settle(record, observation)
    } catch (failure) {
      if (failure instanceof CleanupError) {
        record.status = 'error'
        record.detail = failure.message
        record.cleanupPending = true
        record.failure = failure.diagnostic
        cleanupBlocked = true
        // The runner has just tried and failed to remove the container; the next automatic retry waits a few seconds.
        lastCleanupAttempt = Date.now()
      } else if (lifetime.signal.aborted) {
        record.status = 'interrupted'
        record.detail = 'Kraflr shut down before the verification result was saved.'
      } else if (controller.signal.aborted) {
        record.status = controller.signal.reason instanceof StoreError ? 'stale' : 'cancelled'
        record.detail = controller.signal.reason instanceof StoreError ? controller.signal.reason.message : 'The verification was cancelled.'
      } else if (failure instanceof StoreError && failure.status === 409) {
        record.status = Date.parse(record.expiresAt) <= Date.now() ? 'expired' : 'stale'
        record.detail = failure.message
      } else if (failure instanceof StoreError) {
        record.status = 'error'
        record.detail = failure.message
        if (failure instanceof VerificationExecutionError) record.failure = failure.diagnostic
      } else {
        record.status = 'error'
        record.detail = 'Docker could not complete the test. Check the approved image, command, output format, and resource limits.'
      }
    } finally {
      record.finishedAt = new Date().toISOString()
      store.finishVerification(record)
      if (announce) notify(record)
    }
  }

  /** Track an agent-executed test so it can be cancelled, expires with its lease, and stops with a scope change or shutdown. */
  function startLease(record: VerificationRecord) {
    const controller = new AbortController()
    let release = () => {}
    const done = new Promise<void>((resolve) => { release = resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    const job: Job = { panelId: record.panelId, scopeVersion: record.scopeVersion, controller, done,
      finish() { clearTimeout(timer); active.delete(record.id); release() } }
    timer = setTimeout(() => controller.abort(new LeaseExpired()), Math.max(0, Date.parse(record.lease!.expiresAt) - Date.now()))
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    signal.addEventListener('abort', () => {
      const current = store.readTest(record.panelId, record.id)
      if (current.status === 'running') {
        const reason = controller.signal.reason
        if (lifetime.signal.aborted) { current.status = 'interrupted'; current.detail = 'Kraflr shut down before the agent reported a result.' }
        else if (reason instanceof LeaseExpired) { current.status = 'interrupted'; current.detail = `${current.lease?.agentLabel ?? 'The agent'} did not report a result within ${Math.max(1, Math.round(leaseMs / 60_000))} minute(s).` }
        else if (reason instanceof StoreError) { current.status = 'stale'; current.detail = reason.message }
        else { current.status = 'cancelled'; current.detail = 'The verification was cancelled.' }
        // Kraflr never created a container for an agent-run test. Without this flag an interrupted record reads as a legacy one that needs cleanup.
        current.cleanupPending = false
        current.finishedAt = new Date().toISOString()
        store.finishVerification(current)
        if (!lifetime.signal.aborted) notify(current)
      }
      job.finish()
    }, { once: true })
    active.set(record.id, job)
    return job
  }

  /** The record an agent may still act on: running, agent-owned, on the current scope and inside its lease. */
  function leasedRecord(panelId: string, id: string) {
    const record = store.readTest(panelId, id)
    if (record.status !== 'running' || !isAgentExecutor(record.executor) || !record.lease) throw new StoreError(409, 'This test is not waiting for an agent to run it.')
    if (store.readPanel(panelId).scopeVersion !== record.scopeVersion) throw new StoreError(409, 'The research scope changed. Request a new plan on the current revision.')
    if (Date.parse(record.lease.expiresAt) <= Date.now()) throw new StoreError(409, 'This test’s agent lease expired. Request a fresh approval.')
    if (!isAgentPlan(record.plan)) throw new StoreError(409, 'Only a researched lead’s test can be run by an agent.')
    return record
  }

  app.addHook('onReady', async () => {
    store.interruptVerification()
    recovery = reconcileCleanup()
    await recovery
  })
  app.addHook('preClose', async () => {
    unsubscribeScope()
    lifetime.abort()
    await Promise.allSettled([...active.values()].map((item) => item.done))
    await recovery
  })

  app.get('/api/verification/availability', async () => available())
  app.get<{ Querystring: { offset?: string } }>('/api/verification', { schema: {
    querystring: { type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^[0-9]{1,8}$' } } },
  } }, async ({ query }) => store.verificationQueue(Number(query.offset ?? 0)))
  app.post('/api/verification/fixture', { schema: { body: { type: 'object', additionalProperties: false } } }, async () =>
    store.setupVerificationFixture({
      ...emptyScope, targetName: 'Bundled export verification fixture', repository: fixtureSource, revision: fixtureVersion,
      labTargets: 'Kraflr’s bundled Linux Docker fixture and synthetic export records.',
      restrictions: 'Use only the bundled export probe inside the isolated container.',
    }, {
      title: 'Can one account retrieve another account’s export?',
      explanation: 'The bundled fixture simulates a missing ownership check. Test the vulnerable and patched variants separately.',
      path: 'server/fixtures/verification-export.mjs', startLine: 12, endLine: 18,
      kind: 'lead', security: {
        hypothesis: 'The synthetic export handler may omit an ownership check.',
        attackPath: 'An authenticated fixture account requests an export owned by the other fixture account.',
        impact: 'One fixture account could read the other account’s private export.',
      },
    }))
  app.get<{ Params: PanelParams; Querystring: { lead?: string } }>(root, { schema: { params: panelParams, querystring: {
    type: 'object', additionalProperties: false, properties: { lead: { type: 'string', pattern: evidenceIdPattern } },
  } } }, async ({ params, query }) => store.listVerification(params.id, query.lead))
  app.post<{ Params: PanelParams; Body: { id: string; leadId: string; scopeVersion: number; plan: ProjectVerificationInput } }>(
    `${root}/project`, { schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['id', 'leadId', 'scopeVersion', 'plan'],
      properties: {
        id: uuid, leadId: { type: 'string', pattern: evidenceIdPattern },
        scopeVersion: { type: 'integer', minimum: 1 },
        plan: { type: 'object', additionalProperties: false, required: projectPlanRequired, properties: projectPlanProperties },
      },
    } } }, async ({ params, body }, reply) => {
      const scope = store.readSourceScope(params.id, body.scopeVersion)
      const lead = store.readEvidence(params.id, body.leadId)
      if (!isOpenLead(lead)) throw new StoreError(409, 'Verification requests are only available for Open Leads.')
      const plan = projectPlan(body.plan, scope)
      try {
        const existing = store.readTest(params.id, body.id)
        if (existing.leadId !== lead.id || existing.scopeVersion !== scope.version || existing.planHash !== verificationHash(plan)) {
          throw new StoreError(409, 'This request ID belongs to another plan.')
        }
        return existing
      } catch (failure) {
        if (!(failure instanceof StoreError && failure.status === 404)) throw failure
      }
      const now = Date.now()
      if (lead.verificationProgress && !lead.verificationProgress.canVerify) throw new StoreError(409, 'This lead already has an active or verified test. Continue its saved verification instead of creating another request.')
      return reply.code(201).send(store.addVerification({
        id: body.id, panelId: params.id, leadId: lead.id, scopeVersion: scope.version, plan, planHash: verificationHash(plan),
        status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(),
      }))
    })
  app.get<{ Params: RunParams }>(`${root}/:runId/availability`, { schema: { params: runParams } },
    async ({ params }) => available(store.readTest(params.id, params.runId).plan))
  app.post<{ Params: RunParams }>(`${root}/:runId/retry`, { schema: { params: runParams, body: { type: 'object', additionalProperties: false } } }, async ({ params }, reply) => {
    const saved = store.readTest(params.id, params.runId)
    const previous = saved.status === 'pending' && Date.parse(saved.expiresAt) <= Date.now() ? { ...saved, status: 'expired' as const } : saved
    if (!['error', 'interrupted', 'cancelled', 'expired', 'denied', 'inconclusive', 'not_reproduced'].includes(previous.status)) throw new StoreError(409, 'Only a finished unsuccessful test can request a fresh approval.')
    store.readSourceScope(params.id, previous.scopeVersion)
    if (!isOpenLead(store.readEvidence(params.id, previous.leadId))) throw new StoreError(409, 'Reopen the lead before requesting another test.')
    // A failure that came from the lab itself (harness crash, bad output, timeout) repeats on the same image, so it never earns a plain retry.
    if (previous.failure?.retryable === false) throw new StoreError(409, previous.failure.hint + ' Repair the lab and recover it for a new approval; retrying the unchanged image cannot change the outcome.')
    if (previous.cleanupPending || await cleanupIsBlocked()) throw new StoreError(503, cleanupMessage)
    const prepared = await latestPreparedLab(store, params.id, previous.leadId)
    if (prepared && verificationHash(prepared.plan) !== previous.planHash) throw new StoreError(409, 'A repaired lab proposes a different image or test plan. Recover the repaired lab and approve its new plan; this button retries only the unchanged saved image.')
    // An agent-run test never needs Kraflr's engine, so a stopped Docker Desktop must not block its fresh approval.
    if (!isAgentExecutor(previous.executor) && !isAgentPlan(previous.plan)) { const engine = await available(previous.plan); if (!engine.ready) throw new StoreError(503, engine.detail) }
    store.readSourceScope(params.id, previous.scopeVersion)
    if (!isOpenLead(store.readEvidence(params.id, previous.leadId))) throw new StoreError(409, 'The lead changed while Docker was checked. Review it before retrying.')
    const current = store.listVerification(params.id, previous.leadId).records
    if (current.some(record => record.status === 'running')) throw new StoreError(409, 'This lead already has a running test.')
    const existing = current.find(record => record.status === 'pending' && record.planHash === previous.planHash)
    if (existing) return existing
    const now = Date.now()
    return reply.code(201).send(store.addVerification({ id: randomUUID(), panelId: params.id, leadId: store.readEvidence(params.id, previous.leadId).id, scopeVersion: previous.scopeVersion, plan: previous.plan, planHash: previous.planHash, status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() }))
  })
  app.post<{ Params: PanelParams; Body: { variant: VerificationVariant } }>(root, { schema: {
    params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['variant'],
      properties: { variant: { type: 'string', enum: verificationVariants } },
    },
  } }, async ({ params, body }, reply) => {
    const fixture = store.verificationFixture()
    if (fixture?.panelId !== params.id) throw new StoreError(409, 'Open the bundled verification fixture panel.')
    const panel = store.readPanel(params.id)
    const scope = store.readSourceScope(panel.id, panel.scopeVersion)
    if (scope.repository !== fixtureSource || scope.revision !== fixtureVersion || scope.repositoryMode !== 'known') {
      throw new StoreError(409, 'Restore the bundled fixture target and version in Research scope.')
    }
    if (!isOpenLead(store.readEvidence(panel.id, fixture.leadId))) {
      throw new StoreError(409, 'Verification requests are only available for Open Leads.')
    }
    const plan = fixturePlan(body.variant)
    const now = Date.now()
    return reply.code(201).send(store.addVerification({
      id: randomUUID(), panelId: panel.id, scopeVersion: scope.version, leadId: fixture.leadId,
      plan, planHash: verificationHash(plan), status: 'pending',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(),
    }))
  })
  app.post<{ Params: RunParams; Body: Decision }>(`${root}/:runId/decision`, { schema: {
    params: runParams, body: changeBody,
  } }, async ({ params, body }, reply) => {
    const record = store.readTest(params.id, params.runId)
    if (body.saveFindingOnSuccess && body.choice !== 'approve') throw new StoreError(400, 'Conditional Finding acceptance is available only when approving this exact test.')
    if (body.executor && body.choice !== 'approve') throw new StoreError(400, 'Who verifies is chosen only when approving this exact test.')
    if (body.planHash !== record.planHash) throw new StoreError(409, 'This plan changed. Reload it before deciding.')
    if (body.choice === 'cancel' && record.status === 'running') {
      const job = active.get(record.id)
      if (!job) throw new StoreError(409, 'This verification is no longer controlled by this process.')
      job.controller.abort()
      return reply.code(202).send(store.readTest(params.id, params.runId))
    }
    // After an error the researcher either informs the agent (a repair run, see lab preparation) or cancels. Cancelling closes the test, so the
    // agent has to ask for a fresh approval before it runs anything again.
    if (body.choice === 'cancel' && ['error', 'interrupted', 'inconclusive'].includes(record.status)) {
      return store.dismissVerification(params.id, params.runId, body.note.trim() || 'Cancelled by the researcher. The agent must ask for approval again before running another test.')
    }
    const note = body.note.trim()
    if (body.choice === 'deny' && !note) throw new StoreError(400, 'Record your reason for denying this plan.')
    if (body.choice !== 'approve') {
      return store.resolveVerification(params.id, params.runId, body.planHash, body.choice, note)
    }
    if (record.status !== 'pending') throw new StoreError(409, 'This plan was already decided.')
    validatePlan(record)
    const prepared = await latestPreparedLab(store, params.id, record.leadId)
    if (prepared && verificationHash(prepared.plan) !== record.planHash) throw new StoreError(409, 'A repaired lab has replaced this proposed image or command. Recover and review the repaired plan before approving a test.')
    // A researched lead is always verified by a live agent, which also marks the lead afterwards. Only the bundled self-test fixture runs in Kraflr.
    const executor = body.executor ?? (isAgentPlan(record.plan) ? undefined : 'kraflr')
    let assignment: { executor: 'parent' | 'child'; lease: { agentId: string; agentLabel: string; expiresAt: string } } | undefined
    if (isAgentPlan(record.plan)) {
      if (executor !== 'parent' && executor !== 'child') throw new StoreError(400, 'Choose who verifies this test: the Parent or a Child agent.')
      const chosen = agents?.resolve(record.panelId, record.scopeVersion, executor, body.agentId)
      if (!chosen) throw new StoreError(409, executor === 'parent'
        ? 'Start this panel’s Parent agent on the current scope so it can verify the test.'
        : 'Start a Child agent on the current scope, or choose the Parent to verify the test.')
      assignment = { executor, lease: { agentId: chosen.id, agentLabel: chosen.label, expiresAt: new Date(Date.now() + leaseMs).toISOString() } }
    } else {
      if (executor !== 'kraflr') throw new StoreError(409, 'The bundled fixture runs only in Kraflr’s own self-test runner.')
      const engine = await available(record.plan)
      if (!engine.ready) throw new StoreError(503, engine.detail)
    }
    if (lifetime.signal.aborted) throw new StoreError(503, 'Kraflr is shutting down.')
    validatePlan(record)
    if (!assignment && cleanupBlocked) throw new StoreError(503, cleanupMessage)
    // Approving an agent-run test also authorizes the agent to mark its outcome: a Finding when it reproduces with a passing control, a killed lead when it does not.
    const approved = store.resolveVerification(params.id, params.runId, body.planHash, 'approve', note, Boolean(assignment) || body.saveFindingOnSuccess === true, assignment)
    if (assignment) {
      startLease(approved)
      try { agents?.onGrant?.(approved) } catch { console.error('The test was approved but its agent could not be notified.') }
      return reply.code(202).send(approved)
    }
    const controller = new AbortController()
    const done = run({ ...approved }, controller)
      .catch(() => console.error('Kraflr could not save the verification result.'))
      .finally(() => active.delete(approved.id))
    active.set(approved.id, { panelId: approved.panelId, scopeVersion: approved.scopeVersion, controller, done, finish() {} })
    return reply.code(202).send(approved)
  })
  // The agent ran the approved container itself and reports what it observed.
  app.post<{ Params: RunParams; Body: Report }>(`${root}/:runId/report`, { schema: { params: runParams, body: reportBody } }, async ({ params, body }) => {
    const record = leasedRecord(params.id, params.runId)
    if (isProjectPlan(record.plan) && body.image !== record.plan.image) {
      throw new StoreError(409, 'The reported image is not the approved image. If you rebuilt the lab, recover it so the new image gets its own approval.')
    }
    let observation: ProjectObservation
    try { observation = readProjectObservation(body.observation) } catch (failure) { throw new StoreError(400, (failure as Error).message) }
    settle(record, observation)
    record.detail = `${record.lease!.agentLabel} ran the test: ${record.detail}`
    record.report = { reportedAt: new Date().toISOString(), via: 'agent-docker', ...(body.command ? { command: body.command } : {}), ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }) }
    record.finishedAt = new Date().toISOString()
    store.finishVerification(record)
    active.get(record.id)?.finish()
    // The Parent already knows what it reported itself; a Child's result has to be sent to it.
    if (record.executor === 'child') notify(record)
    return store.readTest(params.id, params.runId)
  })
  // The agent could not complete the approved test (a build or config problem, a crashed harness...). The researcher decides what happens next.
  app.post<{ Params: RunParams; Body: Failure }>(`${root}/:runId/failure`, { schema: { params: runParams, body: failureBody } }, async ({ params, body }) => {
    const record = leasedRecord(params.id, params.runId)
    const who = record.lease!.agentLabel
    record.status = 'error'
    record.detail = `${who} could not complete the test: ${body.message.trim()}`.slice(0, 1200)
    record.failure = {
      stage: body.stage?.trim() || 'running the test', code: 'agent_reported', retryable: false,
      hint: `${who} reported a problem. Inform the agent so it analyses and repairs the lab and asks for a new approval, or cancel this verification.`,
      ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }),
      ...(body.output?.trim() ? { output: body.output.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').slice(0, 3000) } : {}),
    }
    record.cleanupPending = false
    record.finishedAt = new Date().toISOString()
    store.finishVerification(record)
    active.get(record.id)?.finish()
    if (record.executor === 'child') notify(record)
    return store.readTest(params.id, params.runId)
  })
  app.post<{ Params: RunParams; Body: { note: string } }>(`${root}/:runId/finding`, { schema: {
    params: runParams, body: {
      type: 'object', additionalProperties: false, required: ['note'],
      properties: { note: { type: 'string', minLength: 1, maxLength: 1200, pattern: '\\S' } },
    },
  } }, async ({ params, body }) => store.acceptVerificationFinding(params.id, params.runId, body.note.trim()))
}
