import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AgentChatMessage, AgentPermission, AgentPermissionDecision, AgentTelemetry, WorkerModels } from '../shared/agent-terminal.ts'
import { StoreError } from './db.ts'
import { createPermissionGuard } from './agent-permissions.ts'
import { secretRedactor } from './secrets.ts'
import { clineFreeModels } from './cline-models.ts'

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const textLimit = 256_000

function toolDetails(tool: RequestPermissionRequest['toolCall']) {
  const locations = tool.locations?.map((location) => `${location.path}${location.line == null ? '' : `:${location.line}`}`) ?? []
  const input = tool.rawInput == null ? '' : JSON.stringify(tool.rawInput, null, 2) ?? ''
  const resources = [...(input && input !== '{}' ? [input] : []), ...locations]
  const complete = resources.length > 0 && resources.length <= 20 &&
    resources.every((resource) => resource.length > 0 && resource.length <= 10_000) &&
    (Boolean(input && input !== '{}') || tool.kind === 'read')
  return { resources: complete ? resources : [], complete }
}

function optionId(options: RequestPermissionRequest['options'], kind: 'allow_once' | 'reject_once') {
  const choices = options.filter((option) => option.kind === kind)
  return choices.length === 1 && choices[0]?.optionId ? choices[0].optionId : undefined
}

function configValue(options: SessionConfigOption[] | undefined | null, id: string) {
  const option = options?.find((item) => item.id === id)
  return option?.currentValue
}

function readModels(options: SessionConfigOption[]) {
  const option = options.find((item) => item.id === 'model')
  if (option?.type !== 'select') return { current: null, choices: [] }
  const models = option.options.flatMap((item) => 'options' in item ? item.options : [item])
  return {
    current: option.currentValue,
    choices: models.filter((item) => item.value.length > 0 && item.value.length <= 200)
      .map((item) => ({ id: item.value, name: item.name })),
  }
}

export async function openClineWorker(options: {
  executable: string
  cwd: string
  env: NodeJS.ProcessEnv
  nativeId?: string | null
  preferredModel?: string | null
  signal: AbortSignal
  onSaved: (nativeId: string) => void
  spawnProcess?: typeof spawn
  freeModels?: typeof clineFreeModels
}) {
  const { executable, cwd, env, nativeId, preferredModel, signal, onSaved } = options
  signal.throwIfAborted()
  const child = (options.spawnProcess ?? spawn)(executable, ['--acp', '--auto-approve', 'false'], {
    env, cwd, windowsHide: true, detached: process.platform === 'win32', stdio: ['pipe', 'pipe', 'ignore'],
  })
  const childClosed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
  const output: AgentChatMessage[] = []
  const guard = createPermissionGuard(nativeId ?? randomUUID(), [env.CLINE_API_KEY])
  const { redact } = secretRedactor([env.CLINE_API_KEY])
  const assistantRedactor = secretRedactor([env.CLINE_API_KEY])
  let sessionId = nativeId ?? ''
  let active: { text: string; messageId: string | null } | undefined
  let promptDone: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  let usage: AgentTelemetry['usage']
  const pending = new Map<string, {
    toolCallId: string
    permission: AgentPermission
    allow?: string
    reject?: string
    resolve: (outcome: RequestPermissionResponse) => void
  }>()

  function append(role: AgentChatMessage['role'], text: string) {
    const message = { id: randomUUID(), role, text: redact(text).slice(0, textLimit) }
    output.push(message)
    if (output.length > 40) output.shift()
    return message
  }

  function appendAssistant(text: string) {
    if (!text) return
    if (active) {
      active.text = (active.text + text).slice(0, textLimit)
      const message = output.find((item) => item.id === active?.messageId)
      if (message) message.text = active.text
      else active.messageId = append('assistant', active.text).id
    } else {
      const previous = output.at(-1)
      if (previous?.role === 'assistant') previous.text = (previous.text + text).slice(0, textLimit)
      else append('assistant', text)
    }
  }

  const connection = client({ name: 'kraflr' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      if (params.sessionId !== sessionId || !active || pending.size >= 12) return cancelled
      if (/^spawn_agent(?:\s|:|$)/i.test(params.toolCall.title ?? '')) {
        append('activity', 'Native agent spawning was blocked. Kraflr dispatches tasks to the existing team from the parent’s tasks report.')
        return cancelled
      }
      const { resources, complete } = toolDetails(params.toolCall)
      const allow = optionId(params.options, 'allow_once')
      const reject = optionId(params.options, 'reject_once')
      const permission = guard.snapshot({
        id: `per_${randomUUID()}`, action: params.toolCall.kind ?? 'Tool request',
        description: params.toolCall.title?.slice(0, 600), resources, canApprove: complete && Boolean(allow) && allow !== reject,
      })
      append('activity', `Waiting for approval: ${permission.description ?? permission.action}`)
      return new Promise<RequestPermissionResponse>((resolve) => {
        pending.set(permission.id, { toolCallId: params.toolCall.toolCallId, permission, allow, reject, resolve })
      })
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (params.sessionId !== sessionId) return
      const update = params.update
      if (update.sessionUpdate === 'tool_call_update' && ['rawInput', 'locations', 'title', 'kind'].some((key) => key in update)) {
        for (const [id, request] of pending) {
          if (request.toolCallId === update.toolCallId) {
            request.resolve(cancelled)
            pending.delete(id)
            append('activity', 'Permission details changed. The previous request was cancelled.')
          }
        }
      }
      if (update.sessionUpdate === 'usage_update' && Number.isSafeInteger(update.used) && update.used >= 0) {
        usage = { tokens: update.used, kind: 'context' }
      } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        appendAssistant(assistantRedactor.write(update.content.text))
      } else if (update.sessionUpdate === 'user_message_chunk' && !active && output.at(-1)?.role !== 'user') {
        append('user', 'Earlier assignment from the parent')
      } else if (update.sessionUpdate === 'tool_call') {
        append('activity', update.title)
      }
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, { maxMessageBytes: 2 * 1024 * 1024 }))
  child.on('error', (error) => connection.close(error))

  function clearPermissions() {
    for (const request of pending.values()) request.resolve(cancelled)
    pending.clear()
  }

  function close() {
    closing ??= (async () => {
      if (promptDone && !connection.signal.aborted) {
        const settle = promptDone.catch(() => {})
        await connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {})
        clearPermissions()
        const timeout = new AbortController()
        try {
          await Promise.race([settle, delay(4000, undefined, { signal: timeout.signal })])
        } finally {
          timeout.abort()
        }
      }
      clearPermissions()
      connection.close()
      child.kill()
      await childClosed
    })()
    return closing
  }
  connection.signal.addEventListener('abort', () => {
    clearPermissions()
    child.kill()
  }, { once: true })
  const startup = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
  const abortStartup = () => { void close() }
  startup.addEventListener('abort', abortStartup, { once: true })
  let models: WorkerModels = { current: null, choices: [] }
  let promotions: WorkerModels['choices'] = []
  let modelSelectionRequired = false
  function updateModels(config: SessionConfigOption[]) {
    const catalog = readModels(config)
    models = { ...catalog, choices: [...promotions, ...catalog.choices.filter((item) => !promotions.some((choice) => choice.id === item.id))],
      ...(promotions.length ? { notice: 'Choose a “Cline free promotion” to use Cline’s current promotional route. A catalog model labelled “free” can use a different route. Provider quotas still apply.' } : {}) }
  }

  async function changeModel(id: string) {
    if (!models.choices.some((model) => model.id === id)) {
      throw new StoreError(400, 'Choose a model offered by this Cline worker.')
    }
    modelSelectionRequired = true
    try {
      const setting = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId, configId: 'model', value: id,
      })
      updateModels(setting.configOptions)
    } catch {
      throw new StoreError(502, 'Cline could not change the worker’s model.')
    }
    modelSelectionRequired = models.current !== id
    usage = undefined
    if (modelSelectionRequired) throw new StoreError(502, 'Cline did not confirm the selected model.')
    return id
  }

  try {
    const hello = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'kraflr', version: '1.0.0' }, clientCapabilities: {},
    })
    if (hello.protocolVersion !== PROTOCOL_VERSION) throw new StoreError(409, 'Update Cline to a compatible ACP release.')
    const session = nativeId
      ? await connection.agent.request(methods.agent.session.load, { sessionId: nativeId, cwd, mcpServers: [] })
      : await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
    if (!nativeId && session && 'sessionId' in session && typeof session.sessionId === 'string') sessionId = session.sessionId
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) {
      throw new StoreError(502, 'Cline returned an invalid worker session.')
    }
    const setting = await connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId, configId: 'auto_approve', type: 'boolean', value: false,
    })
    if (configValue(setting.configOptions, 'auto_approve') !== false) {
      throw new StoreError(409, 'Cline did not confirm that tool approvals require your decision. Update the Cline CLI.')
    }
    if (configValue(setting.configOptions, 'provider') === 'cline') promotions = await (options.freeModels ?? clineFreeModels)()
    updateModels(setting.configOptions)
    if (preferredModel && preferredModel !== models.current) {
      modelSelectionRequired = true
      if (models.choices.some((item) => item.id === preferredModel)) await changeModel(preferredModel)
    }
    const selected = preferredModel ?? models.current
    if (selected?.endsWith(':free') && promotions.some((item) => item.id.split('/').at(-1) === selected.split('/').at(-1)?.replace(/:free$/, ''))) {
      modelSelectionRequired = true
      models.notice = 'This saved model uses a catalog route that differs from Cline’s current free promotion. Choose and confirm the Cline free promotion before continuing.'
    }
  } catch (error) {
    await close()
    if (error instanceof StoreError) throw error
    if (error instanceof Error && /authenticat|sign.in|credentials/i.test(error.message)) {
      throw new StoreError(409, 'Sign in with `cline auth`, then open the Cline worker again.')
    }
    throw new StoreError(502, nativeId
      ? 'Cline could not reopen this worker conversation. Check the CLI account and version.'
      : 'Cline did not start a managed worker. Check `cline auth` and update the Cline CLI if needed.')
  } finally {
    startup.removeEventListener('abort', abortStartup)
  }

  let saved = Boolean(nativeId)
  return {
    id: sessionId,
    async telemetry(): Promise<AgentTelemetry> {
      return { usage }
    },
    models: () => ({ ...models, current: modelSelectionRequired ? null : models.current }),
    get modelSelectionRequired() { return modelSelectionRequired },
    async selectModel(id: string) {
      const deadline = AbortSignal.timeout(12_000)
      const abort = () => { void close() }
      deadline.addEventListener('abort', abort, { once: true })
      try {
        return await changeModel(id)
      } finally {
        deadline.removeEventListener('abort', abort)
      }
    },
    closed: childClosed,
    close,
    async attention() {
      return { question: false, permissions: [...pending.values()].map((item) => item.permission) }
    },
    async messages() {
      return output.map((item) => ({ ...item, text: redact(item.text) }))
    },
    async runTurn(text: string, checkCurrent: () => void, stop: AbortSignal) {
      if (active || pending.size) throw new StoreError(409, 'This Cline worker is already handling a task.')
      if (modelSelectionRequired) throw new StoreError(409, 'Choose a model for this Cline worker before assigning work.')
      stop.throwIfAborted()
      checkCurrent()
      appendAssistant(assistantRedactor.flush())
      const turn = { text: '', messageId: null }
      active = turn
      append('user', 'Research request received')
      const abortTurn = () => { void close() }
      stop.addEventListener('abort', abortTurn, { once: true })
      try {
        const request = connection.agent.request(methods.agent.session.prompt, {
          sessionId, prompt: [{ type: 'text', text }],
        })
        promptDone = request
        const result = await request
        appendAssistant(assistantRedactor.flush())
        stop.throwIfAborted()
        if (result.stopReason !== 'end_turn' || !turn.text.trim()) {
          throw new StoreError(502, 'Cline did not complete the assignment. Check its CLI account, model, and usage.')
        }
        if (!saved) {
          onSaved(sessionId)
          saved = true
        }
        return redact(turn.text)
      } catch (error) {
        appendAssistant(assistantRedactor.flush())
        if (stop.aborted) {
          await close()
          appendAssistant(assistantRedactor.flush())
          throw Object.assign(new StoreError(409, 'The Cline assignment was interrupted.'), { partialReply: redact(turn.text) })
        }
        const detail = error instanceof Error ? redact(error.message) : ''
        const message = error instanceof StoreError ? error : new StoreError(502,
          /quota|credit|rate.?limit|insufficient|429/i.test(detail) ? 'Cline reported a provider usage limit. Check the account or choose another available model, then retry.'
            : /authenticat|unauthori[sz]ed|sign.?in|401|403/i.test(detail) ? 'Cline reported an authentication problem. Check its CLI sign-in, then retry.'
            : /timeout|timed.?out|connection|network|fetch failed|econn/i.test(detail) ? 'Cline’s connection failed before its report finished. Captured text and prepared files remain available; retry when the connection is ready.'
            : 'Cline stopped before finishing its report. Captured text and prepared files remain available; check its account/model and retry.')
        if (turn.text.trim()) {
          if (!saved) { onSaved(sessionId); saved = true }
          Object.assign(message, { partialReply: redact(turn.text) })
        }
        append('activity', message.message)
        throw message
      } finally {
        appendAssistant(assistantRedactor.flush())
        active = undefined
        promptDone = undefined
        stop.removeEventListener('abort', abortTurn)
        clearPermissions()
      }
    },
    async decide(id: string, decision: AgentPermissionDecision, fingerprint: string, checkCurrent: () => void) {
      await guard.decide(id, fingerprint, decision, async () => pending.get(id)?.permission, checkCurrent, async () => {
        const request = pending.get(id)
        if (!request) throw new StoreError(409, 'This permission request is no longer pending.')
        pending.delete(id)
        const option = decision === 'once' ? request.allow : request.reject
        request.resolve(option ? { outcome: { outcome: 'selected', optionId: option } } : cancelled)
        append('activity', decision === 'once' ? 'Approved once' : 'Permission denied')
      })
    },
  }
}
