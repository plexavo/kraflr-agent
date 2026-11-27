import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One side of an HTTP exchange, bounded: the headers and the first few KiB of the body as text. */
export interface TrafficSide { headers: Record<string, string>; body: string; bytes: number }

/**
 * What Kraflr saw an agent do. `http` and `tunnel` come from the scope proxy (a blocked request is recorded too); `command` is a tool call the
 * agent made, reported by its own hooks, which also covers tools that never touch the proxy.
 */
export interface TrafficEntry {
  id: string
  at: string
  panelId: string
  agentId: string
  agent: string
  kind: 'http' | 'tunnel' | 'command'
  method?: string
  url?: string
  status?: number
  blocked?: boolean
  /** An HTTPS connection to a host that is not an authorized target, which was let through because it cannot be read or blocked. */
  outOfScope?: boolean
  reason?: string
  ms?: number
  /** For a command: the tool name and what it was given. */
  text?: string
  request?: TrafficSide
  response?: TrafficSide
}
export type TrafficSummary = Omit<TrafficEntry, 'request' | 'response'> & { hasBodies: boolean }

const panelIdPattern = /^[a-f0-9-]{36}$/

/**
 * An append-only record per panel, in the runtime's private data folder. It stays out of SQLite so a long test does not grow the research
 * database, and a file past its size limit rolls over so the log stays bounded (the newest and the previous file are kept).
 */
export function createTrafficLog(folder: string, limit = 8 * 1024 * 1024) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = (panelId: string) => { if (!panelIdPattern.test(panelId)) throw new Error('Invalid panel.'); return join(folder, panelId + '.jsonl') }
  function read(panelId: string): TrafficEntry[] {
    const path = file(panelId), entries: TrafficEntry[] = []
    for (const source of [path + '.1', path]) {
      if (!existsSync(source)) continue
      for (const line of readFileSync(source, 'utf8').split('\n')) {
        if (!line) continue
        try { entries.push(JSON.parse(line) as TrafficEntry) } catch { /* A line cut short by a crash is skipped. */ }
      }
    }
    return entries
  }
  return {
    append(entry: Omit<TrafficEntry, 'id' | 'at'> & { id?: string; at?: string }) {
      const path = file(entry.panelId)
      try { if (existsSync(path) && statSync(path).size > limit) renameSync(path, path + '.1') } catch { /* Rolling over is best effort. */ }
      const full: TrafficEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry }
      try { appendFileSync(path, JSON.stringify(full) + '\n', { mode: 0o600 }) } catch { /* A log that cannot be written must never stop the agent's request. */ }
      return full
    },
    /** Newest first, without bodies. */
    list(panelId: string, offset = 0, count = 40): { entries: TrafficSummary[]; more: boolean; total: number } {
      const all = read(panelId).reverse(), page = all.slice(offset, offset + count)
      return { entries: page.map(({ request, response, ...rest }) => ({ ...rest, hasBodies: Boolean(request || response) })), more: offset + count < all.length, total: all.length }
    },
    get(panelId: string, id: string) { return read(panelId).find((entry) => entry.id === id) },
  }
}
export type TrafficLog = ReturnType<typeof createTrafficLog>
