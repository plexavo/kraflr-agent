import assert from 'node:assert/strict'
import test from 'node:test'
import { createPermissionGuard } from '../server/agent-permissions.ts'
import { secretRedactor } from '../server/secrets.ts'

const base = { id: 'per_test', action: 'shell', description: 'Inspect the source.', resources: ['git status'], canApprove: true }

test('approvals bind displayed details to one adapter lifetime and cannot be replayed or submitted concurrently', async () => {
  const guard = createPermissionGuard('session-one')
  let current = guard.snapshot(base)
  const original = current.fingerprint
  let sent = 0
  const send = (fingerprint: string) => guard.decide(base.id, fingerprint, 'once', async () => current, () => {}, async () => { sent++ })
  current = guard.snapshot({ ...base, resources: ['git push'] })
  await assert.rejects(send(original), /details changed/)
  const otherSession = createPermissionGuard('session-one').snapshot({ ...base, resources: ['git push'] })
  await assert.rejects(send(otherSession.fingerprint), /details changed/)
  const results = await Promise.allSettled([send(current.fingerprint), send(current.fingerprint)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(sent, 1)
  await assert.rejects(send(current.fingerprint), /already submitted/)
})

test('failed scope checks do not send an approval; uncertain delivery cannot be retried', async () => {
  const guard = createPermissionGuard('scope-session')
  const current = guard.snapshot(base)
  let sent = 0
  await assert.rejects(guard.decide(base.id, current.fingerprint, 'once', async () => current,
    () => { throw new Error('Changed scope') }, async () => { sent++ }), /Changed scope/)
  assert.equal(sent, 0)
  await assert.rejects(guard.decide(base.id, current.fingerprint, 'once', async () => current, () => {}, async () => {
    sent++; throw new Error('Delivery timeout')
  }), /Delivery timeout/)
  await assert.rejects(guard.decide(base.id, current.fingerprint, 'once', async () => current, () => {}, async () => { sent++ }), /already submitted/)
  assert.equal(sent, 1)
})

test('sensitive or misleading permission cards can be denied but cannot be approved', async () => {
  const secret = 'synthetic-private-password-12345'
  const guard = createPermissionGuard('secret-session', [secret])
  const permission = guard.snapshot({ ...base, resources: [`echo ${secret}`] })
  assert.equal(permission.canApprove, false)
  assert.ok(!JSON.stringify(permission).includes(secret))
  await assert.rejects(guard.decide(base.id, permission.fingerprint, 'once', async () => permission, () => {}, async () => {}), /cannot be approved/)
  let denied = false
  await guard.decide(base.id, permission.fingerprint, 'reject', async () => permission, () => {}, async () => { denied = true })
  assert.ok(denied)
  assert.equal(guard.snapshot({ ...base, resources: ['read report\u202e.exe'] }).canApprove, false)
})

test('known private credentials are redacted across every terminal chunk boundary', () => {
  const secret = 'synthetic-private-password-12345'
  const input = `before ${secret} after!`
  for (let split = 0; split <= input.length; split++) {
    const redactor = secretRedactor([secret])
    assert.equal(redactor.write(input.slice(0, split)) + redactor.write(input.slice(split)) + redactor.flush(), 'before [REDACTED] after!')
  }
  const ordinary = secretRedactor([secret])
  assert.equal(ordinary.write('ordinary terminal output\r\n'), 'ordinary terminal output\r\n')
})
