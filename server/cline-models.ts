import type { WorkerModels } from '../shared/agent-terminal.ts'
type Choice = WorkerModels['choices'][number]
let cache: { at: number; choices: Choice[] } | undefined
let pending: Promise<Choice[]> | undefined
/** Public vendor metadata only. Authentication stays inside the installed CLI. */
export function clineFreeModels(): Promise<Choice[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return Promise.resolve(cache.choices)
  return pending ??= (async () => {
    try {
      const response = await fetch('https://api.cline.bot/api/v1/ai/cline/recommended-models', { signal: AbortSignal.timeout(4000), redirect: 'error', credentials: 'omit' })
      if (!response.ok) throw new Error('Catalog unavailable')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty catalog')
      let raw = ''
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          raw += decoder.decode(value, { stream: true })
          if (raw.length > 128_000) throw new Error('Catalog too large')
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const data = JSON.parse(raw + decoder.decode()) as { free?: unknown }
      const choices = Array.isArray(data.free) ? data.free.slice(0, 30).flatMap<Choice>((item) => {
        if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{1,199}$/.test(item.id)) return []
        return [{ id: item.id, name: `${typeof item.name === 'string' ? item.name.slice(0, 150) : item.id} · Cline free promotion` }]
      }) : []
      cache = { at: Date.now(), choices }
      return choices
    } catch { return cache?.choices ?? [] }
    finally { pending = undefined }
  })()
}
