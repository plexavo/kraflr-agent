import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { checkGatewayStatus } from '../server/mcp-gateway-status.ts'

/** Stands in for `spawn('semgrep', ['--version'])`, matching the fake used in tests/semgrep-scan.test.ts. */
function fakeProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & EventEmitter
  const stdout = new EventEmitter()
  ;(proc as unknown as { stdout: EventEmitter }).stdout = stdout
  return { proc, stdout, finish: (output: string, code = 0) => { stdout.emit('data', Buffer.from(output)); proc.emit('close', code) } }
}

test('semgrep reports available with its version parsed out from an upgrade-notice line above it', async () => {
  const fake = fakeProcess()
  const result = checkGatewayStatus(undefined, { runSemgrep: () => fake.proc })
  fake.finish('A new version of Semgrep is available. See https://semgrep.dev/docs/upgrading\n1.187.0\n')
  const status = await result
  assert.deepEqual(status.semgrep, { available: true, version: '1.187.0' })
  assert.deepEqual(status.burp, { configured: false })
})

test('semgrep reports unavailable on a missing binary or a non-zero exit', async () => {
  const missing = fakeProcess()
  const first = checkGatewayStatus(undefined, { runSemgrep: () => missing.proc })
  missing.proc.emit('error', Object.assign(new Error('spawn semgrep ENOENT'), { name: 'Error' }))
  assert.equal((await first).semgrep.available, false)

  const failed = fakeProcess()
  const second = checkGatewayStatus(undefined, { runSemgrep: () => failed.proc })
  failed.finish('', 127)
  const status = await second
  assert.equal(status.semgrep.available, false)
  assert.match(status.semgrep.reason!, /exited with code 127/)
})

test('burp is reported unconfigured, connected with its live tool count, or configured-but-unreachable', async () => {
  // Semgrep plays no part in these cases, so it is just made to resolve immediately rather than driven through a fake process.
  const noSemgrep = () => { throw new Error('not installed') }
  const unconfigured = await checkGatewayStatus(undefined, { runSemgrep: noSemgrep })
  assert.deepEqual(unconfigured.burp, { configured: false })

  const connected = await checkGatewayStatus('http://127.0.0.1:9876/mcp', {
    runSemgrep: noSemgrep,
    connectBurp: async () => ({ listTools: async () => ({ tools: [{}, {}, {}] }), close: async () => {} } as never),
  })
  assert.deepEqual(connected.burp, { configured: true, url: 'http://127.0.0.1:9876/mcp', connected: true, tools: 3 })

  const unreachable = await checkGatewayStatus('http://127.0.0.1:9876/mcp', {
    runSemgrep: noSemgrep,
    connectBurp: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.deepEqual(unreachable.burp, { configured: true, url: 'http://127.0.0.1:9876/mcp', connected: false, reason: 'ECONNREFUSED' })
})
