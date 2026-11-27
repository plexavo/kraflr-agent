import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const panelIdPattern = /^[a-f0-9-]{36}$/
export const mapLimit = 40_000

/**
 * The attack-surface map of a panel: entry points, authentication, trust boundaries and sinks, as the first agent to look at the target wrote
 * them. One plain file per panel in the runtime's private data folder. Every later session is told to read it first, so nobody repeats recon.
 */
export function createSurfaceMap(folder: string) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = (panelId: string) => { if (!panelIdPattern.test(panelId)) throw new Error('Invalid panel.'); return join(folder, panelId + '.md') }
  return {
    get(panelId: string): { text: string; updatedAt: string } | undefined {
      const path = file(panelId)
      if (!existsSync(path)) return
      const text = readFileSync(path, 'utf8')
      const [header, ...body] = text.split('\n')
      return header?.startsWith('<!-- kraflr-map ') ? { updatedAt: header.slice(16, -4).trim(), text: body.join('\n').replace(/^\n/, '') } : { updatedAt: '', text }
    },
    /** Replaces the map, or adds to it when `append` is set. Returns the saved size. */
    set(panelId: string, text: string, append = false) {
      const previous = append ? this.get(panelId)?.text ?? '' : ''
      const merged = (previous ? previous.trimEnd() + '\n\n' : '') + text.trim()
      if (merged.length > mapLimit) throw new Error(`The map is limited to ${mapLimit} characters; summarise it instead of adding more.`)
      writeFileSync(file(panelId), `<!-- kraflr-map ${new Date().toISOString()} -->\n\n${merged}\n`, { mode: 0o600 })
      return { saved: true, characters: merged.length }
    },
  }
}
export type SurfaceMap = ReturnType<typeof createSurfaceMap>
