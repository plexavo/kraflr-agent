export interface OpenCodeConnection {
  status: 'unconfigured' | 'unreachable' | 'unsupported' | 'connected'
  version?: string
  model?: string
}

export interface FixtureLead {
  title: string
  explanation: string
  line: number
}

export interface FixtureRun {
  id: string
  panelId: string
  model: string
  sessionId: string | null
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  detail: string
  lead: FixtureLead | null
  tokens: number | null
}
export const fixtureFile = 'export-download.js'
export const fixtureSource = [
  'export function downloadExport(store, viewer, exportId) {',
  '  if (!viewer) return { status: 401 };',
  '  const entry = store.getExport(exportId);',
  '  if (!entry) return { status: 404 };',
  '  return { status: 200, body: entry.data };',
  '}',
].map((line, index) => `${index + 1}: ${line}`)

