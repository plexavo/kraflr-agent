import type { FixtureLead, OpenCodeConnection } from '../shared/opencode.ts'
import { fixtureFile, fixtureSource } from '../shared/opencode.ts'
import { StoreError } from './db.ts'

const permissions = [{ permission: '*', pattern: '*', action: 'deny' }]
const openCodeVersion = '1.19.5'
const fixturePrompt = [
  'Review this fictional source excerpt for a possible missing ownership check.',
  'Use only this excerpt. Return bare JSON with exactly these keys: "title" (string under 160 characters), "explanation" (string under 1200 characters), and "line" (integer from the excerpt).',
  `Fixture file: ${fixtureFile}`,
  ...fixtureSource,
].join('\n')

function readLead(parts: { type?: string; text?: string }[] | undefined): Partial<FixtureLead> | undefined {
  if (!Array.isArray(parts)) return undefined
  const text = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('').trim()
  if (!text || text.length > 2400) return undefined
  const fenced = /^\x60\x60\x60(?:json)?\s*([\s\S]+?)\s*\x60\x60\x60$/i.exec(text)
  try {
    const lead: unknown = JSON.parse(fenced?.[1] ?? text)
    if (lead && typeof lead === 'object' && Object.keys(lead).length === 3) return lead as Partial<FixtureLead>
  } catch {
    return undefined
  }
}

interface Settings {
  port: number
  username: string
  password: string
  providerID: string
  modelID: string
}

export function readOpenCodeSettings(env: NodeJS.ProcessEnv): Settings | null {
  const port = Number(env.KRAFLR_OPENCODE_PORT ?? 4096)
  const password = env.KRAFLR_OPENCODE_PASSWORD
  const model = /^([a-zA-Z0-9_-]{1,100})\/(\S{1,180})$/.exec(env.KRAFLR_OPENCODE_MODEL ?? '')
  const username = env.KRAFLR_OPENCODE_USERNAME || 'opencode'
  if (!password || !model?.[1] || !model[2] || !Number.isInteger(port) || port < 1024 || port > 65535) return null
  return { port, username, password, providerID: model[1], modelID: model[2] }
}

export function connectOpenCode(settings: Settings, send: typeof fetch = fetch) {
  const base = `http://127.0.0.1:${settings.port}`
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`
  const model = `${settings.providerID}/${settings.modelID}`

  async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await send(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new StoreError(502, 'OpenCode rejected the request. Check the server and its model settings.')
    }
    return response.json()
  }

  async function check(): Promise<OpenCodeConnection> {
    try {
      const health = await request('/global/health') as { healthy?: boolean; version?: unknown } | null
      if (health?.healthy !== true || typeof health.version !== 'string') return { status: 'unreachable', model }
      const version = health.version.slice(0, 80)
      return { status: version === openCodeVersion ? 'connected' : 'unsupported', version, model }
    } catch {
      return { status: 'unreachable', model }
    }
  }

  return {
    model,
    check,
    async createSession(signal: AbortSignal) {
      const session = await request('/session', {
        title: 'Kraflr fixture review',
        permission: permissions,
      }, AbortSignal.any([signal, AbortSignal.timeout(7000)])) as { id?: unknown; permission?: unknown } | null
      if (typeof session?.id !== 'string' || !/^ses_[a-zA-Z0-9_-]{1,100}$/.test(session.id)) {
        throw new StoreError(502, 'OpenCode returned an invalid session identity.')
      }
      const rules = session.permission as (typeof permissions) | undefined
      if (!Array.isArray(rules) || rules.length !== 1 || rules[0]?.permission !== '*' ||
          rules[0].pattern !== '*' || rules[0].action !== 'deny') {
        throw new StoreError(502, 'OpenCode did not confirm the deny-all tools policy.')
      }
      return session.id
    },
    async review(sessionId: string, signal: AbortSignal): Promise<{ lead: FixtureLead; tokens: number | null }> {
      const response = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
        model: { providerID: settings.providerID, modelID: settings.modelID },
        parts: [{ type: 'text', text: fixturePrompt }],
      }, signal) as {
        info?: { role?: string; sessionID?: string; error?: unknown; tokens?: { total?: number } }
        parts?: { type?: string; text?: string }[]
      } | null
      const info = response?.info
      const result = readLead(response?.parts)
      const line = result?.line
      if (info?.role !== 'assistant' || info.sessionID !== sessionId || info.error ||
          typeof result?.title !== 'string' || !result.title.trim() || result.title.length > 160 ||
          typeof result.explanation !== 'string' || !result.explanation.trim() || result.explanation.length > 1200 ||
          typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > fixtureSource.length) {
        throw new StoreError(502, 'OpenCode did not return a valid source-linked lead.')
      }
      const total = info.tokens?.total
      return {
        lead: { title: result.title.trim(), explanation: result.explanation.trim(), line },
        tokens: typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null,
      }
    },
    async abort(sessionId: string) {
      try {
        return await request(`/session/${encodeURIComponent(sessionId)}/abort`, {}) === true
      } catch {
        return false
      }
    },
  }
}

export type OpenCode = ReturnType<typeof connectOpenCode>
