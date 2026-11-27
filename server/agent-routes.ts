import type { FastifyInstance } from 'fastify'
import { agentKinds } from '../shared/agent-terminal.ts'
import type { AgentPermissionDecision, LaunchTerminalInput, TerminalSize } from '../shared/agent-terminal.ts'
import type { AgentTerminals } from './agent-terminals.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import type { createResearchTeam } from './research-team.ts'
import { exportResearchRun } from './research-team.ts'
import { evidenceIdPattern } from '../shared/evidence.ts'
import type { createRepositoryCheckouts } from './repository-checkout.ts'

const uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const panelParams = { type: 'object', required: ['id'], properties: { id: uuid } }
const terminalParams = {
  type: 'object', required: ['id', 'terminalId'], properties: { id: uuid, terminalId: uuid },
}
const sizeBody = {
  type: 'object', additionalProperties: false, required: ['cols', 'rows'],
  properties: {
    cols: { type: 'integer', minimum: 10, maximum: 500 },
    rows: { type: 'integer', minimum: 4, maximum: 200 },
  },
}

interface PanelParams { id: string }
interface TerminalParams extends PanelParams { terminalId: string }

export function registerAgentRoutes(app: FastifyInstance, store: ResearchStore, terminals: AgentTerminals,
  research: ReturnType<typeof createResearchTeam>, repositories?: Pick<ReturnType<typeof createRepositoryCheckouts>, 'prepare'>) {
  const root = '/api/panels/:id/terminal'
  const session = `${root}/:terminalId`
  const runs = '/api/panels/:id/research-runs'
  const checkScope = (panelId: string) => (version: number | null) => {
    if (store.readPanel(panelId).scopeVersion !== (version ?? 0)) {
      throw new StoreError(409, 'The panel scope changed. Launch a new session with the current scope revision.')
    }
  }
  app.get('/api/agents', async () => terminals.installations())
  app.get('/api/agents/sessions', async () => terminals.list())
  app.get('/api/agents/attention', async () => terminals.attention())
  app.get<{ Params: PanelParams }>(runs, { schema: { params: panelParams } }, async ({ params }) => store.listResearchRuns(params.id))
  app.post<{ Params: PanelParams; Body: { id: string; objective: string; leadId?: string; prepareRepository?: boolean } }>(runs, {
    schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['id', 'objective'],
      properties: {
        id: uuid, objective: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' },
        leadId: { type: 'string', pattern: evidenceIdPattern },
        prepareRepository: { type: 'boolean' },
      },
    } },
  }, async ({ params, body }, reply) => {
    if (body.prepareRepository && repositories) { await repositories.prepare(params.id); await terminals.bindRepository(params.id) }
    return reply.code(202).send(research.start(params.id, body.objective.trim(), body.id, body.leadId))
  })
  app.post<{ Params: PanelParams; Body: { id: string } }>(`${runs}/cancel`, {
    schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid },
    } },
  }, async ({ params, body }, reply) => reply.code(202).send(research.cancel(params.id, body.id)))
  app.post<{ Params: PanelParams; Body: { id: string } }>(`${runs}/export`, {
    schema: { params: panelParams, body: {
      type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid },
    } },
  }, async ({ params, body }) => exportResearchRun(store, params.id, body.id))
  app.post<{ Params: PanelParams; Body: LaunchTerminalInput }>(root, {
    schema: { params: panelParams, body: {
      ...sizeBody, required: ['kind', ...sizeBody.required],
      properties: {
        ...sizeBody.properties, kind: { type: 'string', enum: agentKinds },
        mode: { type: 'string', enum: ['terminal', 'cline-worker'] },
        label: { type: 'string', maxLength: 80 },
        role: { type: 'string', enum: ['parent','child'] },
        prepareRepository: { type: 'boolean' },
      },
    } },
  }, async ({ params, body }, reply) => {
    if(body.role==='parent'&&store.listResearchRuns(params.id).some(run=>run.status==='running'))throw new StoreError(409,'Finish the current research or collaboration before replacing its parent.')
    const panel = body.prepareRepository && repositories ? await repositories.prepare(params.id) : store.readPanel(params.id)
    return reply.code(201).send(await terminals.start(panel, body))
  })
  app.get<{ Params: TerminalParams }>(`${session}/messages`, {
    schema: { params: terminalParams },
  }, async ({ params }) => terminals.messages(params.id, params.terminalId))
  app.get<{ Params: TerminalParams }>(`${session}/models`, {
    schema: { params: terminalParams },
  }, async ({ params }) => terminals.workerModels(params.id, params.terminalId))
  app.put<{ Params: TerminalParams; Body: { id: string } }>(`${session}/models`, {
    schema: { params: terminalParams, body: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 350 } },
    } },
  }, async ({ params, body }) => terminals.selectWorkerModel(params.id, params.terminalId, body.id))
  app.post<{ Params: TerminalParams; Body: TerminalSize }>(`${session}/resume`, {
    schema: { params: terminalParams, body: sizeBody },
  }, async ({ params, body }) => terminals.resume(store.readPanel(params.id), params.terminalId, body))
  app.post<{ Params: TerminalParams }>(`${session}/parent`, {
    schema: { params: terminalParams, body: { type: 'object', additionalProperties: false } },
  }, async ({ params }, reply) => {
    const session = terminals.list().find((item) => item.panelId === params.id && item.id === params.terminalId)
    if (!session?.chat || session.state !== 'running' || session.modelSelectionRequired) {
      throw new StoreError(409, 'Choose a running managed session with a confirmed model as the parent.')
    }
    if (store.listResearchRuns(params.id).some((run) => run.status === 'running')) {
      throw new StoreError(409, 'Finish or stop this panel’s research run before changing its parent.')
    }
    store.assignAgentParent(params.id, params.terminalId)
    return reply.code(204).send()
  })
  app.post<{ Params: TerminalParams; Body: { id: string; decision: AgentPermissionDecision; fingerprint: string } }>(`${session}/decision`, {
    schema: { params: terminalParams, body: {
      type: 'object', additionalProperties: false, required: ['id', 'decision', 'fingerprint'],
      properties: {
        id: { type: 'string', pattern: '^per_[a-zA-Z0-9_-]{1,100}$' },
        decision: { type: 'string', enum: ['once', 'reject'] },
        fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    } },
  }, async ({ params, body }, reply) => {
    await terminals.decide(params.id, params.terminalId, body.id, body.decision, body.fingerprint, checkScope(params.id))
    return reply.code(204).send()
  })
  app.get<{ Params: TerminalParams }>(`${session}/events`, {
    schema: { params: terminalParams },
  }, async ({ params }, reply) => {
    const stream = terminals.stream(params.id, params.terminalId)
    reply.raw.once('close', () => stream.destroy())
    return reply.type('text/event-stream; charset=utf-8').send(stream)
  })
  app.post<{ Params: TerminalParams; Body: { text: string } }>(`${session}/input`, {
    schema: { params: terminalParams, body: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 8192 } },
    } },
  }, async ({ params, body }, reply) => {
    terminals.input(params.id, params.terminalId, body.text)
    return reply.code(204).send()
  })
  app.post<{ Params: TerminalParams; Body: TerminalSize }>(`${session}/resize`, {
    schema: { params: terminalParams, body: sizeBody },
  }, async ({ params, body }, reply) => {
    terminals.resize(params.id, params.terminalId, body)
    return reply.code(204).send()
  })
  app.post<{ Params: TerminalParams }>(`${session}/stop`, {
    schema: { params: terminalParams, body: { type: 'object', additionalProperties: false } },
  }, async ({ params }) => terminals.stop(params.id, params.terminalId))
}
