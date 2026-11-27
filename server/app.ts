import Fastify from 'fastify'
import { accessModes, emptyScope, repositoryModes, scopeFields } from '../shared/research.ts'
import type { CreatePanelInput, SaveScopeInput, ScopeInput, ScopeTextField } from '../shared/research.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import { createFixtureRuns } from './fixture-runs.ts'
import type { OpenCode } from './opencode.ts'
import { registerAgentRoutes } from './agent-routes.ts'
import type { AgentTerminals } from './agent-terminals.ts'
import { createResearchTeam } from './research-team.ts'
import { modelRef } from '../shared/source-review.ts'
import type { SourceSelection } from '../shared/source-review.ts'
import { createSourceReviews } from './source-reviews.ts'
import { openCodeSourceEngine } from './source-review-engine.ts'
import type { SourceReviewEngine } from './source-review-engine.ts'
import { evidenceIdPattern, evidenceTags, leadStatuses } from '../shared/evidence.ts'
import type { EvidenceTag, SaveLeadReview } from '../shared/evidence.ts'
import { registerVerification } from './verification.ts'
import { dockerVerificationRunner } from './verification-runner.ts'
import type { VerificationRunner } from './verification-runner.ts'
import { researchBrief } from './research-brief.ts'
import { exportResearchBrief } from './research-team.ts'
import { createRepositoryCheckouts } from './repository-checkout.ts'
import { registerLabPreparations } from './lab-preparation.ts'

const panelParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
}

const createPanelBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    type: { type: 'string', enum: ['source', 'web'] },
  },
}

const saveScopeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'scope'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['repository', 'webTargets', 'labTargets', 'restrictions', 'notes'],
      properties: {
        ...Object.fromEntries(Object.entries(scopeFields).map(([field, maxLength]) => [
          field, { type: 'string', maxLength },
        ])),
        repositoryMode: { type: 'string', enum: repositoryModes },
        accessMode: { type: 'string', enum: accessModes },
      },
    },
  },
}

interface PanelParams { id: string }
interface EvidenceParams extends PanelParams { leadId: string }
const evidenceParams = {
  type: 'object', required: ['id', 'leadId'],
  properties: { ...panelParams.properties, leadId: { type: 'string', pattern: evidenceIdPattern } },
}
type OptionalScopeFields = 'labPath' | 'repositoryDiscovery' | 'repositoryMode' | 'accessMode' |
  'targetName' | 'workspacePath' | 'allowedActions' | 'revision' | 'roeReference'
type SaveScopeBody = Omit<SaveScopeInput, 'scope'> & {
  scope: Omit<ScopeInput, OptionalScopeFields> & Partial<Pick<ScopeInput, OptionalScopeFields>>
}

interface AppOptions {
  onVerificationResult?:(record:import('../shared/verification.ts').VerificationRecord)=>void
  onVerificationGrant?:(record:import('../shared/verification.ts').VerificationRecord)=>void
  verificationLeaseMs?:number
  onResearchTeam?:(team:ReturnType<typeof createResearchTeam>)=>void
  /** Opt in to turning a direct Parent conversation into a coordinated run with child tasks. Off by default: a Parent works like a plain session. */
  coordinateDirectTurns?:boolean
  openCode?: OpenCode | null
  terminals?: AgentTerminals
  sourceReviewEngine?: SourceReviewEngine
  verificationRunner?: VerificationRunner
}

const emptyBody = { type: 'object', additionalProperties: false }
const sourceLine = { type: 'integer', minimum: 1, maximum: 300_000 }
const reviewIdBody = {
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: panelParams.properties.id },
}

/** The loopback API the terminal runtime calls in-process. The terminal is the only client; nothing serves a page. */
export function buildApp(store: ResearchStore, port: number, options: AppOptions = {}) {
  const repositories = createRepositoryCheckouts(store)
  const fixtures = createFixtureRuns(store, options.openCode ?? null)
  const reviews = createSourceReviews(store, options.sourceReviewEngine ?? openCodeSourceEngine)
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })

    if (request.headers.host !== host) {
      return reply.code(403).send({ message: 'Untrusted host.' })
    }
    const suppliedOrigin = request.headers.origin
    if ((suppliedOrigin !== undefined && suppliedOrigin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ message: 'Untrusted origin.' })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (suppliedOrigin !== origin) {
        return reply.code(403).send({ message: 'A same-origin request is required.' })
      }
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return reply.code(415).send({ message: 'Use application/json for this request.' })
      }
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StoreError) return reply.code(error.status).send({ message: error.message })
    const httpError = error as { statusCode?: number; validation?: unknown }
    const status = httpError.statusCode
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        message: status === 413 ? 'Request is too large.' : 'The request contains invalid or unsupported values.',
      })
    }
    console.error('Kraflr request failed.', error instanceof Error ? error.name : 'Unknown error')
    return reply.code(500).send({ message: 'Kraflr could not complete this request.' })
  })

  app.get('/api/panels', async () => store.listPanels())
  app.get<{ Params: PanelParams }>('/api/panels/:id/research-brief', { schema: { params: panelParams } },
    async ({ params }) => researchBrief(store, params.id))
  app.post<{ Params: PanelParams }>('/api/panels/:id/research-brief/export', {
    schema: { params: panelParams, body: emptyBody },
  }, async ({ params }) => exportResearchBrief(store, params.id))
  const verificationRunner = options.verificationRunner ?? dockerVerificationRunner
  registerVerification(app, store, verificationRunner, options.onVerificationResult, {
    // Only a live, current-scope agent with a working chat may be asked to run an approved test; one that already stopped cannot.
    resolve: (panelId, scopeVersion, executor, agentId) => {
      const live = (options.terminals?.list() ?? []).filter((item) => item.panelId === panelId && item.chat && item.state === 'running' &&
        item.scopeVersion === scopeVersion && !item.modelSelectionRequired && !item.stoppage)
      if (executor === 'parent') return live.find((item) => item.parent)
      const children = live.filter((item) => !item.parent)
      if (agentId) return children.find((item) => item.id === agentId)
      if (children.length > 1) throw new StoreError(409, 'Choose which Child agent verifies this test.')
      return children[0]
    },
    onGrant: options.onVerificationGrant,
    leaseMs: options.verificationLeaseMs,
  })
  app.get('/api/investigation', async () => ({
    sessions: await options.terminals?.dashboardSessions() ?? [],
    counts: store.countLeads(), research: store.activeResearch(),
  }))
  app.get<{ Params: PanelParams }>('/api/panels/:id/repository-suggestion', { schema: { params: panelParams } },
    async ({ params }) => store.latestRepositorySuggestion(params.id))
  const team = options.terminals ? createResearchTeam(store, options.terminals, (plan) => verificationRunner.available(plan), options.coordinateDirectTurns) : null
  if(team)options.onResearchTeam?.(team)
  if (options.terminals && team) registerAgentRoutes(app, store, options.terminals, team, repositories)
  if (options.terminals && team) registerLabPreparations(app, store, options.terminals, team, repositories, (plan) => verificationRunner.available(plan))
  app.post<{ Params: PanelParams }>('/api/panels/:id/checkout', { schema: { params: panelParams, body: emptyBody } },
    async ({ params }) => repositories.prepare(params.id))
  app.addHook('preClose', async () => repositories.close())
  const evidence = '/api/panels/:id/evidence'
  app.get<{ Params: PanelParams; Querystring: { offset?: string; tag?: EvidenceTag } }>(evidence, { schema: {
    params: panelParams, querystring: {
      type: 'object', additionalProperties: false, properties: {
        offset: { type: 'string', pattern: '^[0-9]{1,8}$' }, tag: { type: 'string', enum: evidenceTags },
      },
    },
  } }, async ({ params, query }) => store.listEvidence(params.id, Number(query.offset ?? 0), query.tag))
  app.get<{ Params: EvidenceParams }>(`${evidence}/:leadId`, { schema: { params: evidenceParams } },
    async ({ params }) => store.readEvidence(params.id, params.leadId))
  app.put<{ Params: EvidenceParams; Body: SaveLeadReview }>(`${evidence}/:leadId`, { schema: {
    params: evidenceParams, body: {
      type: 'object', additionalProperties: false, required: ['expectedVersion', 'status', 'note', 'nextAction'],
      properties: {
        expectedVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
        status: { type: 'string', enum: leadStatuses },
        tag: { type: 'string', enum: evidenceTags },
        note: { type: 'string', maxLength: 2400 },
        nextAction: { type: 'string', maxLength: 1200 },
      },
    },
  } }, async ({ params, body }) => store.saveLeadReview(params.id, params.leadId, body))
  const reviewsPath = '/api/panels/:id/source-reviews'
  app.get<{ Params: PanelParams }>(reviewsPath, { schema: { params: panelParams } },
    async ({ params }) => reviews.list(params.id))
  app.post<{ Params: PanelParams; Body: SourceSelection }>(`${reviewsPath}/preview`, {
    schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['scopeVersion', 'path', 'startLine', 'objective', 'model'],
      properties: {
        scopeVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        path: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        startLine: sourceLine, endLine: sourceLine,
        objective: { type: 'string', minLength: 1, maxLength: 1200, pattern: '\\S' },
        model: { type: 'string', pattern: modelRef.source },
      },
    } },
  }, async ({ params, body }) => reviews.preview(params.id, { ...body, objective: body.objective.trim() }))
  app.post<{ Params: PanelParams; Body: { id: string } }>(reviewsPath, {
    schema: { params: panelParams, body: reviewIdBody },
  }, async ({ params, body }, reply) => reply.code(202).send(reviews.start(params.id, body.id)))
  app.post<{ Params: PanelParams; Body: { id: string } }>(`${reviewsPath}/cancel`, {
    schema: { params: panelParams, body: reviewIdBody },
  }, async ({ params, body }, reply) => {
    reviews.cancel(params.id, body.id)
    return reply.code(204).send()
  })
  app.get('/api/opencode', fixtures.check)
  app.get<{ Params: PanelParams }>('/api/panels/:id/fixture-run', { schema: { params: panelParams } },
    async ({ params }) => {
      store.readPanel(params.id)
      return { run: store.latestFixtureRun(params.id) }
    })
  app.post<{ Params: PanelParams }>('/api/panels/:id/fixture-run', {
    schema: { params: panelParams, body: emptyBody },
  }, async ({ params }, reply) => reply.code(202).send(await fixtures.start(params.id)))
  app.post<{ Params: PanelParams; Body: { runId: string } }>('/api/panels/:id/fixture-run/cancel', {
    schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['runId'],
      properties: { runId: panelParams.properties.id },
    } },
  }, async ({ params, body }, reply) => {
    fixtures.cancel(params.id, body.runId)
    return reply.code(202).send({ stopping: true })
  })
  app.post<{ Body: CreatePanelInput }>('/api/panels', { schema: { body: createPanelBody } },
    async (request, reply) => {
      const panel = store.createPanel({ ...request.body, name: request.body.name.trim() })
      return reply.code(201).header('Location', `/api/panels/${panel.id}`).send(panel)
    })
  app.get<{ Params: PanelParams }>('/api/panels/:id', { schema: { params: panelParams } },
    async ({ params }) => store.readPanel(params.id))
  app.put<{ Params: PanelParams; Body: SaveScopeBody }>('/api/panels/:id/scope', {
    schema: { params: panelParams, body: saveScopeBody },
  }, async ({ params, body }) => {
    const scope = { ...emptyScope, ...body.scope, accessMode: body.scope.accessMode ?? 'unspecified' }
    for (const field of Object.keys(scopeFields) as ScopeTextField[]) {
      scope[field] = scope[field].trim()
    }
    if (body.scope.targetName !== undefined && !scope.targetName) {
      throw new StoreError(400, 'Enter the name of the target under review.')
    }
    if (scope.repository && !scope.revision) scope.revision = 'HEAD'
    if (!scope.repository && scope.revision) throw new StoreError(400, 'Enter the repository for the recorded source version.')
    if (scope.repositoryMode === 'discover' && (!scope.repositoryDiscovery || scope.repository || scope.revision)) {
      throw new StoreError(400, 'Add a repository discovery note and leave the repository and revision blank.')
    }
    if (scope.accessMode === 'unspecified' && !scope.allowedActions) {
      throw new StoreError(400, 'Choose an access mode or describe the allowed actions.')
    }
    return store.saveScope(params.id, body.expectedVersion, scope)
  })

  app.addHook('preClose', async () => {
    await Promise.all([team?.close(), options.terminals?.close(), fixtures.close(), reviews.close()])
  })
  app.addHook('onClose', async () => store.close())
  return app
}
