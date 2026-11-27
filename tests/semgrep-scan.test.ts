import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createSurfaceMap } from '../server/surface-map.ts'
import { createSemgrepScan } from '../server/semgrep-scan.ts'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Stands in for `spawn('semgrep', …)`: an EventEmitter with a `stdout` emitter, so a test can feed JSON and an exit code without a real binary. */
function fakeProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & EventEmitter
  const stdout = new EventEmitter()
  ;(proc as unknown as { stdout: EventEmitter }).stdout = stdout
  return { proc, stdout, finish: (json: string, code = 1) => { stdout.emit('data', Buffer.from(json)); proc.emit('close', code) } }
}

const finding = (path: string, lineNo: number, severity: string, message: string, cwe?: string) =>
  ({ check_id: `rules.lang.security.${message.replace(/\s+/g, '-')}`, path, start: { line: lineNo }, end: { line: lineNo }, extra: { message, severity, ...(cwe ? { metadata: { cwe: [cwe] } } : {}) } })

async function withMap(fn: (folder: string, surface: ReturnType<typeof createSurfaceMap>) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-semgrep-')))
  try { await fn(folder, createSurfaceMap(folder)) } finally { await rm(folder, { recursive: true, force: true }) }
}

test('a completed scan with findings is folded into the map, worst severity first, deduplicated and capped to the budget', () => withMap(async (_folder, surface) => {
  const panelId = '44444444-4444-4444-8444-444444444444'
  const fake = fakeProcess()
  const scan = createSemgrepScan(surface, 6000, () => fake.proc)
  scan.ensureScanned(panelId, '/workspace')
  const results = [
    finding('app/views.py', 42, 'warning', 'Possible SQL injection', 'CWE-89'),
    finding('app/auth.py', 10, 'error', 'Hardcoded secret key', 'CWE-798'),
    finding('app/views.py', 42, 'warning', 'Possible SQL injection', 'CWE-89'), // exact duplicate from an overlapping rule pack
  ]
  fake.finish(JSON.stringify({ results }), 1)
  await new Promise((done) => setImmediate(done))
  const map = surface.get(panelId)
  assert.ok(map); assert.match(map!.text, /Semgrep first pass \(3 hit\(s\)/)
  const errorLine = map!.text.indexOf('auth.py'), warningLine = map!.text.indexOf('views.py')
  assert.ok(errorLine > -1 && warningLine > -1 && errorLine < warningLine, 'the error-severity hit sorts before the warning')
  assert.equal((map!.text.match(/views\.py:42/g) ?? []).length, 1, 'the duplicate hit is collapsed')
}))

test('a panel is scanned only once even if asked again before the scan finishes, and an empty result leaves the map untouched', () => withMap(async (_folder, surface) => {
  const panelId = '55555555-5555-4555-8555-555555555555'
  let calls = 0
  const fake = fakeProcess()
  const scan = createSemgrepScan(surface, 6000, () => { calls++; return fake.proc })
  scan.ensureScanned(panelId, '/workspace'); scan.ensureScanned(panelId, '/workspace'); scan.ensureScanned(panelId, '/workspace')
  assert.equal(calls, 1, 'a scan already running for this panel is not started a second time')
  fake.finish(JSON.stringify({ results: [] }), 1)
  await new Promise((done) => setImmediate(done))
  assert.equal(surface.get(panelId), undefined, 'no findings means nothing is written')
}))

test('semgrep not being installed, a non-JSON crash, and a scan-failure exit code are all silently ignored', () => withMap(async (_folder, surface) => {
  const missing = fakeProcess(), crashed = fakeProcess(), failed = fakeProcess()
  const panels = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888']
  const scan = createSemgrepScan(surface, 6000, (workspace) => (workspace === '/missing' ? missing : workspace === '/crashed' ? crashed : failed).proc)
  scan.ensureScanned(panels[0]!, '/missing'); missing.proc.emit('error', new Error('ENOENT'))
  scan.ensureScanned(panels[1]!, '/crashed'); crashed.finish('not json at all', 1)
  scan.ensureScanned(panels[2]!, '/failed'); failed.finish('{}', 2)
  await new Promise((done) => setImmediate(done))
  for (const panelId of panels) assert.equal(surface.get(panelId), undefined)
}))

test('ensureScanned does nothing without a workspace path, so a panel with no checkout yet is never scanned', () => withMap(async (_folder, surface) => {
  let calls = 0
  const scan = createSemgrepScan(surface, 6000, () => { calls++; return fakeProcess().proc })
  scan.ensureScanned('99999999-9999-4999-8999-999999999999', '')
  assert.equal(calls, 0)
}))
