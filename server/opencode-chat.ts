import type { AgentChatMessage, AgentPermission, AgentPermissionDecision, AgentTelemetry, WorkerModels } from '../shared/agent-terminal.ts'
import { StoreError } from './db.ts'
import type { PrivateOpenCode } from './private-opencode.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { createPermissionGuard } from './agent-permissions.ts'
import { secretRedactor } from './secrets.ts'

function items(response: unknown): Record<string, unknown>[] {
  const data = (response as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.some((item) => !item || typeof item !== 'object')) {
    throw new StoreError(502, 'OpenCode returned an unexpected session response.')
  }
  return data
}

function modelRef(value: unknown) {
  const model = value as { id?: unknown; providerID?: unknown; variant?: unknown } | null
  if (!model || typeof model.id !== 'string' || typeof model.providerID !== 'string' ||
      !/^[^\s/\p{C}]{1,100}$/u.test(model.providerID) || !/^[^\s\p{C}]{1,240}$/u.test(model.id)) return
  return { id: model.id, providerID: model.providerID }
}

function turnFailure(item: Record<string, unknown>) {
  const error = item.error as { type?: unknown; message?: unknown; status?: unknown; response?: { body?: unknown } } | undefined
  // Never copy arbitrary provider payloads, headers or credentials into persisted research.
  const details = [error?.message, error?.response?.body].filter((value): value is string => typeof value === 'string').join(' ').slice(0, 16_000)
  if (/free messages|free.{0,15}(?:limit|allowance)|daily.{0,15}(?:limit|allowance)/i.test(details)) {
    return 'OpenCode reported a free-model usage limit for this session. Check the provider reset, or choose another available model using Model and send the objective again.'
  }
  if (error?.status === 429 || /rate.?limit|quota|too many requests/i.test(details)) {
    return 'The OpenCode provider reported a usage or rate limit. Check its allowance or choose an available model, then send the objective again.'
  }
  if (error?.status === 401 || error?.status === 403) {
    return 'The OpenCode provider refused access. Check this session’s provider sign-in with /connect and its model selection.'
  }
  if (/context.{0,20}(?:length|limit|window)|maximum.{0,20}tokens/i.test(details)) {
    return 'The OpenCode model rejected the context size. Choose a model with a suitable context window or start a fresh agent with the saved research brief.'
  }
  return 'OpenCode did not complete this turn. Check its terminal for details.'
}

export async function createOpenCodeChat(server: PrivateOpenCode, title: string, nativeId?: string | null, preferredModel?: string | null) {
  if (nativeId && !/^ses_[a-zA-Z0-9_-]{1,100}$/.test(nativeId)) throw new StoreError(409, 'Invalid saved OpenCode session.')
  const response = (nativeId ? await server.request(`/api/session/${nativeId}`, {
    errorMessage: 'OpenCode could not find this saved conversation in the current profile.',
  }) : await server.request('/api/session', { body: { title } })) as { data?: { id?: unknown } } | null
  const id = response?.data?.id
  if (typeof id !== 'string' || !/^ses_[a-zA-Z0-9_-]{1,100}$/.test(id) || (nativeId && nativeId !== id)) {
    throw new StoreError(502, 'OpenCode did not return a valid session ID.')
  }
  const path = `/api/session/${id}`
  const priorPrompts=new Set<string>();let historyUnknown=false
  if(nativeId)try{for(const item of items(await server.request(`${path}/message?limit=100&order=desc`,{signal:AbortSignal.timeout(3000)})))if(item.type==='user'&&typeof item.id==='string')priorPrompts.add(item.id)}catch{historyUnknown=true}
  const guard = createPermissionGuard(id, [server.credentials.OPENCODE_SERVER_PASSWORD])
  const { redact } = secretRedactor([server.credentials.OPENCODE_SERVER_PASSWORD])
  let modelSelectionRequired = false
  let changingModel = false
  let active = false
  const managedPrompts=new Set<string>()

  async function models(): Promise<WorkerModels> {
    const [catalog, current, fallback] = await Promise.all([
      server.request('/api/model'), server.request(path), server.request('/api/model/default').catch(() => undefined),
    ])
    const choices = items(catalog).flatMap((item) => {
      const ref = modelRef(item)
      if (!ref || item.enabled !== true || (item.type !== undefined && item.type !== 'chat')) return []
      const name = typeof item.name === 'string' ? item.name.slice(0, 180) : ref.id
      return [{ id: `${ref.providerID}/${ref.id}`, name: `${name} · ${ref.providerID}` }]
    }).sort((a, b) => a.name.localeCompare(b.name))
    const selected = modelRef((current as { data?: { model?: unknown } } | null)?.data?.model)
      ?? modelRef((fallback as { data?: unknown } | null)?.data)
    return { current: !modelSelectionRequired && selected ? `${selected.providerID}/${selected.id}` : null,
      choices: [...new Map(choices.map((item) => [item.id, item])).values()] }
  }

  async function selectModel(value: string) {
    if (changingModel || active) throw new StoreError(409, 'Wait for this OpenCode turn or model change to finish.')
    changingModel = true
    try {
      const catalog = await models()
      if (!catalog.choices.some((item) => item.id === value)) throw new StoreError(400, 'Choose an available model from this OpenCode session’s catalog.')
      const state = (await server.request(path) as { data?: { time?: { busy?: number; idle?: number } } } | null)?.data
      if ((state?.time?.busy ?? 0) > (state?.time?.idle ?? 0)) throw new StoreError(409, 'Wait for the current OpenCode turn to finish.')
      const divider = value.indexOf('/')
      const ref = { providerID: value.slice(0, divider), id: value.slice(divider + 1) }
      modelSelectionRequired = true
      await server.request(`${path}/model`, { body: { model: ref } })
      const confirmed = modelRef((await server.request(path) as { data?: { model?: unknown } } | null)?.data?.model)
      if (!confirmed || confirmed.id !== ref.id || confirmed.providerID !== ref.providerID) {
        throw new StoreError(502, 'OpenCode did not confirm the selected model. Choose it again before starting research.')
      }
      modelSelectionRequired = false
      return value
    } finally { changingModel = false }
  }

  if (preferredModel) {
    try { await selectModel(preferredModel) }
    catch { modelSelectionRequired = true }
  }

  function assistantText(item: Record<string, unknown>) {
    if (item.type !== 'assistant' || !Array.isArray(item.content)) return ''
    return item.content.map((part: { type?: string; text?: unknown } | null) =>
      part?.type === 'text' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n\n')
  }

  async function attention() {
    const [requests, forms] = await Promise.all([
      server.request(`${path}/permission`),
      server.request(`${path}/form`),
    ])
    const permissions: AgentPermission[] = items(requests).flatMap((item) => {
      if (item.sessionID !== id || typeof item.id !== 'string' || !/^per_[a-zA-Z0-9_-]{1,100}$/.test(item.id)) {
        throw new StoreError(502, 'OpenCode could not verify the identity of a pending request.')
      }
      const action = typeof item.action === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(item.action) ? item.action : ''
      const resources = Array.isArray(item.resources) ? item.resources as unknown[] : []
      const canApprove = Boolean(action) && resources.length > 0 && resources.length <= 20
        && resources.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2500)
      const metadata = item.metadata as { description?: unknown } | undefined
      const description = typeof metadata?.description === 'string' && metadata.description.length <= 600
        ? metadata.description : undefined
      return guard.snapshot({ id: item.id, action: action || 'Permission request',
        resources: canApprove ? resources as string[] : [], description, canApprove })
    })
    return { permissions, question: items(forms).length > 0 }
  }

  return {
    id,
    close: server.close,
    attention,
    async refreshConfiguration(checkCurrent: () => void) {
      if (active || changingModel) throw new StoreError(409, 'Wait for the current OpenCode request before preparing source access.')
      const pending = await attention()
      if (pending.permissions.length || pending.question) throw new StoreError(409, 'Resolve this OpenCode session’s pending request before preparing source access.')
      const state = (await server.request(path) as { data?: { time?: { busy?: number; idle?: number } } } | null)?.data
      if ((state?.time?.busy ?? 0) > (state?.time?.idle ?? 0)) throw new StoreError(409, 'Wait for the OpenCode terminal turn to finish before preparing source access.')
      checkCurrent()
      await server.request('/api/location/reload', { method: 'POST' })
      checkCurrent()
    },
    models,
    selectModel,
    get modelSelectionRequired() { return modelSelectionRequired },
    async telemetry(): Promise<AgentTelemetry> {
      const [session, recent] = await Promise.allSettled([
        server.request(path, { signal: AbortSignal.timeout(2500) }),
        server.request(`${path}/message?limit=6&order=desc`, { signal: AbortSignal.timeout(2500) }).then(items),
      ])
      const stats = session.status === 'fulfilled' ? (session.value as {
        data?: { id?: unknown; tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } } }
      } | null)?.data : undefined
      const tokens = stats?.id === id ? stats.tokens : undefined
      const counters = [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write]
      const total = counters.every((value): value is number => Number.isSafeInteger(value) && value! >= 0)
        ? counters.reduce((sum, value) => sum + value, 0) : undefined
      const selected = session.status === 'fulfilled' ? modelRef((session.value as { data?: { model?: unknown } } | null)?.data?.model) : undefined
      const model = selected ?? (recent.status === 'fulfilled' ? modelRef(recent.value.find((item) => item.type === 'assistant')?.model) : undefined)
      return {
        model: !modelSelectionRequired && model
          ? `${model.providerID}/${model.id}`.slice(0, 240) : undefined,
        usage: total !== undefined && Number.isSafeInteger(total) ? { kind: 'session', tokens: total } : undefined,
      }
    },
    async messages(): Promise<AgentChatMessage[]> {
      const data = items(await server.request(`${path}/message?limit=25&order=desc`))
      return data.reverse().flatMap<AgentChatMessage>((item) => {
        if (typeof item.id !== 'string') return []
        if (item.type === 'idle' && item.outcome === 'failed') return [{ id: item.id, role: 'activity', text: turnFailure(item) }]
        if (item.type === 'user') {
          return typeof item.text === 'string' ? [{ id: item.id, role: 'user', text: redact(item.text).slice(0, 9000) }] : []
        }
        const text = assistantText(item)
        return text ? [{ id: item.id, role: 'assistant', text: redact(text).slice(0, 16000) }] : []
      })
    },
    async completedTurns(){
      const messages=items(await server.request(`${path}/message?limit=100&order=desc`,{signal:AbortSignal.timeout(3000)})).reverse()
      const turns:{id:string;prompt:string;reply:string;failed:boolean;historical:boolean;model?:string}[]=[]
      for(let index=0;index<messages.length;index++){
        const user=messages[index]!;if(user.type!=='user'||typeof user.id!=='string'||managedPrompts.has(user.id))continue
        const tail=messages.slice(index+1),end=tail.findIndex(item=>item.type==='idle'||item.type==='user')
        if(end<0||tail[end]?.type!=='idle')continue
        const failed=tail[end]?.outcome!=='succeeded',reply=redact(tail.slice(0,end).map(assistantText).filter(Boolean).join('\n\n')).slice(0,256_000)
        const historical=historyUnknown||priorPrompts.has(user.id),used=modelRef(tail.slice(0,end).findLast(item=>item.type==='assistant')?.model)
        if(!failed&&!historical&&used)modelSelectionRequired=false
        turns.push({id:user.id,prompt:redact(typeof user.text==='string'?user.text:'').trim().slice(0,8000),reply:reply+(failed?'\n'+turnFailure(tail[end]!):''),failed,historical,...(used?{model:used.providerID+'/'+used.id}:{})})
      }
      return turns
    },
    async runTurn(text: string, checkCurrent: () => void, signal: AbortSignal) {
      if (active || changingModel) throw new StoreError(409, 'This OpenCode session is already handling a request.')
      if (modelSelectionRequired) throw new StoreError(409, 'Choose and confirm a model for this OpenCode session before starting research.')
      active = true
      try {
        const { permissions, question } = await attention()
        if (permissions.length || question) throw new StoreError(409, 'Resolve this session’s pending request before sending a prompt.')
        signal.throwIfAborted()
        checkCurrent()
        try {
          const admitted = await server.request(`${path}/prompt`, {
            body: { text, delivery: 'queue' }, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          }) as { data?: { id?: unknown } } | null
          const promptId = admitted?.data?.id
          if (typeof promptId !== 'string') throw new StoreError(502, 'OpenCode did not confirm prompt delivery.')
          managedPrompts.add(promptId)
          for (;;) {
            await delay(850, undefined, { signal })
            const messages = items(await server.request(`${path}/message?limit=100&order=desc`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })).reverse()
            const index = messages.findIndex((message) => message.type === 'user' && message.id === promptId)
            if (index < 0) continue
            const turn = messages.slice(index + 1)
            const end = turn.findIndex((message) => message.type === 'idle' || message.type === 'user')
            if (end < 0) continue
            if (turn[end]?.type !== 'idle') throw new StoreError(409, 'Another prompt interrupted this research turn.')
            if (turn[end]?.outcome !== 'succeeded') {
              throw new StoreError(502, turnFailure(turn[end]!))
            }
            return redact(turn.slice(0, end).map(assistantText).filter(Boolean).join('\n\n')).slice(0, 256_000)
          }
        } catch (failure) {
          if (signal.aborted) {
            await server.request(`${path}/interrupt?resume=false`, {
              method: 'POST', signal: AbortSignal.timeout(3000),
            }).catch(() => {})
            signal.throwIfAborted()
          }
          throw failure
        }
      } finally { active = false }
    },
    async decide(requestId: string, decision: AgentPermissionDecision, fingerprint: string, checkCurrent: () => void) {
      await guard.decide(requestId, fingerprint, decision, async () =>
        (await attention()).permissions.find((permission) => permission.id === requestId), checkCurrent, async () => {
        await server.request(`${path}/permission/${requestId}/reply`, { body: { decision } })
      })
    },
  }
}

export type OpenCodeChat = Awaited<ReturnType<typeof createOpenCodeChat>>
