import { spawn, type ChildProcess } from 'node:child_process'
import type { SurfaceMap } from './surface-map.ts'

export type SemgrepSpawn = (workspacePath: string, config?: string) => ChildProcess

const defaultSpawn: SemgrepSpawn = (workspacePath, config = 'auto') =>
  spawn('semgrep', ['--config', config, '--json', '--quiet', '--timeout', '120', '--max-target-bytes', '2000000', workspacePath], { cwd: workspacePath, stdio: ['ignore', 'pipe', 'ignore'] })

export interface SemgrepResult {
  check_id: string
  path: string
  start: { line: number }
  end: { line: number }
  extra: { message: string; severity?: string; metadata?: { cwe?: string[] | string; owasp?: string[] | string } }
}

export type SemgrepRun = { ok: true; results: SemgrepResult[] } | { ok: false; reason: string }

/**
 * Runs semgrep once and resolves with its parsed findings, or a plain reason it could not run (missing binary, non-JSON
 * output, a failing exit code). Shared by the background first pass and the on-demand `semgrep_scan` gateway tool, so both
 * agree on what counts as success (exit code 1 means "ran fine, found findings", not a failure).
 */
export function runSemgrepProcess(workspacePath: string, config?: string, runSemgrep: SemgrepSpawn = defaultSpawn): Promise<SemgrepRun> {
  return new Promise((resolve) => {
    const child = runSemgrep(workspacePath, config)
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 20_000_000) out += chunk })
    child.on('error', (error) => resolve({ ok: false, reason: 'semgrep could not be started: ' + error.message }))
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) { resolve({ ok: false, reason: 'semgrep exited with code ' + code }); return }
      try { resolve({ ok: true, results: (JSON.parse(out).results ?? []) as SemgrepResult[] }) }
      catch { resolve({ ok: false, reason: 'semgrep did not return valid JSON' }) }
    })
  })
}

/** `semgrep --config auto` found this but it has no CVE/CWE mapping worth repeating, so the rule id and message carry the whole signal. */
function line(result: SemgrepResult) {
  const cwe = result.extra.metadata?.cwe
  const tag = cwe ? ` [${Array.isArray(cwe) ? cwe[0] : cwe}]` : ''
  return `- ${result.path}:${result.start.line}${result.end.line !== result.start.line ? `-${result.end.line}` : ''} — ${result.extra.message.split('\n')[0]!.trim()}${tag} (${result.check_id.split('.').pop()})`
}

/** Highest severity first, then by file, so the sinks most worth an agent's time sort to the top within the character budget. */
export function summarize(results: SemgrepResult[], limit: number): string {
  const rank: Record<string, number> = { error: 0, warning: 1, info: 2 }
  const sorted = results.slice().sort((a, b) => (rank[a.extra.severity ?? 'info'] ?? 2) - (rank[b.extra.severity ?? 'info'] ?? 2) || a.path.localeCompare(b.path))
  const lines: string[] = [], seen = new Set<string>()
  for (const result of sorted) {
    const text = line(result)
    if (seen.has(text)) continue
    seen.add(text)
    if (lines.join('\n').length + text.length > limit) { lines.push(`- … ${results.length - lines.length} more hit(s) not shown; run semgrep yourself for the full list.`); break }
    lines.push(text)
  }
  return lines.join('\n')
}

/**
 * A Semgrep first pass, run once per panel in the background and folded into the attack-surface map: a hybrid static-analysis-plus-agent read
 * beats either alone (a pure LLM read misses structure a linter catches instantly; a pure static pass alone misses most real flaws, since it
 * has no notion of reachability or intent). Kraflr never blocks an agent on this — it is fire-and-forget, and silent if semgrep is not installed,
 * the scan errors, or it times out. The agent still reads the map when it is ready; if it is not there yet, nothing is lost.
 */
export function createSemgrepScan(surface: Pick<SurfaceMap, 'get' | 'set'>, budget = 6000, runSemgrep: SemgrepSpawn = defaultSpawn) {
  const started = new Set<string>()
  return {
    ensureScanned(panelId: string, workspacePath: string) {
      if (started.has(panelId) || !workspacePath) return
      started.add(panelId)
      void runSemgrepProcess(workspacePath, undefined, runSemgrep).then((run) => {
        if (!run.ok || !run.results.length) return // not installed, crashed, or ran clean; the agent reads the codebase itself as usual.
        const text = `Semgrep first pass (${run.results.length} hit(s), highest severity first — judge reachability and exploitability yourself; most are noise):\n${summarize(run.results, budget)}`
        try { surface.set(panelId, text, true) } catch { /* The map is already near its limit; the agent's own notes win. */ }
      })
    },
  }
}
export type SemgrepScan = ReturnType<typeof createSemgrepScan>
