import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'
import { CleanupError } from '../server/verification-runner.ts'
import type { VerificationRunner } from '../server/verification-runner.ts'
import type { PanelDetail } from '../shared/research.ts'
import type { VerificationRecord } from '../shared/verification.ts'

test('failed container cleanup blocks further execution, survives restart, and must be confirmed before a fresh approval', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kraflr-cleanup-test-'))
  const file = join(directory, 'workspace.sqlite')
  let store = openStore(file)
  let app: ReturnType<typeof buildApp>
  let cleanupSucceeds = false
  let executions = 0
  let cleanups = 0
  let failExecutionCleanup = true
  const runner: VerificationRunner = {
    async available() { return { ready: true, image: '', detail: 'Synthetic recovery runner.' } },
    async cleanup() { cleanups++; if (!cleanupSucceeds) throw new Error('Synthetic cleanup failure') },
    async run(_plan, _id, _signal, beforeStart) {
      beforeStart(); executions++
      if (failExecutionCleanup) throw new CleanupError('Synthetic container cleanup was not confirmed.')
      return { ownerStatus: 200, ownerRecordReturned: true, foreignStatus: 200, foreignRecordReturned: true }
    },
  }
  const start = () => buildApp(store, 4317, { verificationRunner: runner })
  app = start()
  t.after(async () => { await app.close(); await unlink(file); await rmdir(directory) })
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const post = (url: string, payload: object) => app.inject({ method: 'POST', headers, url, payload })
  const get = (url: string) => app.inject({ headers, url })
  const panel = (await post('/api/verification/fixture', {})).json<PanelDetail>()
  const route = `/api/panels/${panel.id}/verification`
  const queue = async () => (await post(route, { variant: 'vulnerable' })).json<VerificationRecord>()
  const approve = (record: VerificationRecord) => post(`${route}/${record.id}/decision`, { choice: 'approve', note: '', planHash: record.planHash })
  const first = await queue()
  assert.equal((await approve(first)).statusCode, 202)
  for (let attempt = 0; attempt < 30 && store.readTest(panel.id, first.id).status === 'running'; attempt++) await delay(10)
  assert.equal(store.readTest(panel.id, first.id).status, 'error')
  assert.equal(store.readTest(panel.id, first.id).cleanupPending, true)
  const next = await queue()
  assert.equal((await approve(next)).statusCode, 503)
  assert.equal(executions, 1)
  await app.close()
  store = openStore(file); app = start()
  assert.equal((await get('/api/verification/availability')).json().ready, false)
  assert.equal(cleanups, 1)
  assert.equal((await approve(next)).statusCode, 503)
  await app.close()
  cleanupSucceeds = true; failExecutionCleanup = false
  store = openStore(file); app = start()
  assert.equal((await get('/api/verification/availability')).json().ready, true)
  assert.equal(store.readTest(panel.id, first.id).cleanupPending, false)
  assert.equal((await approve(first)).statusCode, 409)
  assert.equal((await approve(next)).statusCode, 202)
  for (let attempt = 0; attempt < 30 && store.readTest(panel.id, next.id).status === 'running'; attempt++) await delay(10)
  assert.equal(store.readTest(panel.id, next.id).status, 'reproduced')
  assert.equal(executions, 2)
})
