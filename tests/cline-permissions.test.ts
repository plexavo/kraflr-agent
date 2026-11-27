import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { spawn } from 'node:child_process'
import test from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { openClineWorker } from '../server/cline-worker.ts'

function fakeCline(secret = '', replyChunks?: string[], toolTitle = 'Inspect the fixture', failure?: string) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill() {
    stdout.end(); stdin.end(); child.emit('close', 0); return true
  } })
  let buffer = ''
  let promptId: unknown
  const decisions: unknown[] = []
  const send = (frame: object) => { stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') }
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } } })
      else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'fixture_session' } })
      else if (message.method === 'session/set_config_option') {
        assert.equal(message.params.configId, 'auto_approve')
        assert.equal(message.params.value, false)
        send({ id: message.id, result: { configOptions: [
          { id: 'auto_approve', name: 'Auto approval', type: 'boolean', currentValue: false },
          { id: 'model', name: 'Model', type: 'select', currentValue: 'fixture/model', options: [{ value: 'fixture/model', name: 'Fixture model' }] },
        ] } })
      } else if (message.method === 'session/prompt') {
        promptId = message.id
        send({ id: 1000, method: 'session/request_permission', params: { sessionId: 'fixture_session', toolCall: {
          toolCallId: 'tool_1', kind: 'execute', title: toolTitle, status: 'pending', rawInput: { command: `echo ${secret || 'fixture'}` },
        }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] } })
      } else if (message.id === 1000 && message.result) {
        decisions.push(message.result)
        for (const text of replyChunks ?? [`Completed permission review. ${secret}`]) {
          send({ method: 'session/update', params: { sessionId: 'fixture_session', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
          } } })
        }
        send(failure ? { id: promptId, error: { code: -32603, message: failure } } : { id: promptId, result: { stopReason: 'end_turn' } })
      }
    }
  })
  const spawnProcess: typeof spawn = ((_executable: unknown, args: string[]) => {
    assert.deepEqual(args, ['--acp', '--auto-approve', 'false'])
    return child
  }) as unknown as typeof spawn
  return { spawnProcess, decisions, update() {
    send({ method: 'session/update', params: { sessionId: 'fixture_session', update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'tool_1', rawInput: { command: 'Changed operation' },
    } } })
  } }
}

for (const changeDetails of [false, true]) test(`Cline ACP ${changeDetails ? 'cancels a changed pending tool request' : 'submits exactly one fingerprint-bound decision'}`,
  { timeout: 5000 }, async (t) => {
    const fixture = fakeCline()
    const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: {},
      signal: new AbortController().signal, onSaved() {}, spawnProcess: fixture.spawnProcess })
    t.after(() => worker.close())
    const turn = worker.runTurn('Inspect the synthetic source.', () => {}, new AbortController().signal)
    for (let attempt = 0; attempt < 50 && !(await worker.attention()).permissions.length; attempt++) await delay(5)
    const request = (await worker.attention()).permissions[0]!
    assert.ok(request?.fingerprint)
    await assert.rejects(worker.decide(request.id, 'once', 'a'.repeat(64), () => {}), /details changed/)
    if (changeDetails) {
      fixture.update()
      await turn
      await assert.rejects(worker.decide(request.id, 'once', request.fingerprint, () => {}), /no longer pending/)
      assert.deepEqual(fixture.decisions, [{ outcome: { outcome: 'cancelled' } }])
    } else {
      const decisions = await Promise.allSettled([
        worker.decide(request.id, 'once', request.fingerprint, () => {}),
        worker.decide(request.id, 'once', request.fingerprint, () => {}),
      ])
      assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1)
      assert.match(await turn, /Completed permission review/)
      assert.deepEqual(fixture.decisions, [{ outcome: { outcome: 'selected', optionId: 'allow' } }])
    }
  })

test('Cline hides its known API credential from permission cards, replies and research results', { timeout: 5000 }, async (t) => {
  const secret = 'synthetic-cline-api-key-12345678'
  const fixture = fakeCline(secret)
  const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: { CLINE_API_KEY: secret },
    signal: new AbortController().signal, onSaved() {}, spawnProcess: fixture.spawnProcess })
  t.after(() => worker.close())
  const turn = worker.runTurn('Inspect the synthetic source.', () => {}, new AbortController().signal)
  for (let attempt = 0; attempt < 50 && !(await worker.attention()).permissions.length; attempt++) await delay(5)
  const request = (await worker.attention()).permissions[0]!
  assert.equal(request.canApprove, false)
  assert.ok(!JSON.stringify(request).includes(secret))
  await worker.decide(request.id, 'reject', request.fingerprint, () => {})
  assert.ok(!(await turn).includes(secret))
  assert.ok(!JSON.stringify(await worker.messages()).includes(secret))
})

test('Cline retains redacted partial replies and the conversation reference after a provider failure', { timeout: 5000 }, async (t) => {
  const secret = 'synthetic-cline-api-key-12345678'
  const fixture = fakeCline(secret, [`Prepared the lab. ${secret}`], 'Inspect the fixture', `insufficient credits ${secret}`)
  let saved = ''
  const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: { CLINE_API_KEY: secret },
    signal: new AbortController().signal, onSaved(id) { saved = id }, spawnProcess: fixture.spawnProcess })
  t.after(() => worker.close())
  const result = worker.runTurn('Inspect the synthetic source.', () => {}, new AbortController().signal).catch((error: unknown) => error)
  for (let attempt = 0; attempt < 50 && !(await worker.attention()).permissions.length; attempt++) await delay(5)
  const request = (await worker.attention()).permissions[0]!
  await worker.decide(request.id, 'reject', request.fingerprint, () => {})
  const error = await result as { message: string; partialReply: string }
  assert.match(error.message, /provider usage limit/)
  assert.match(error.partialReply, /Prepared the lab/)
  assert.ok(!JSON.stringify(error).includes(secret))
  assert.equal(saved, 'fixture_session')
})

test('Cline redacts split credentials before a response reaches its truncation limit', { timeout: 5000 }, async (t) => {
  const secret = 'synthetic-cline-api-key-12345678'
  const fixture = fakeCline(secret, ['x'.repeat(255_990) + secret.slice(0, 15), secret.slice(15)])
  const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: { CLINE_API_KEY: secret },
    signal: new AbortController().signal, onSaved() {}, spawnProcess: fixture.spawnProcess })
  t.after(() => worker.close())
  const turn = worker.runTurn('Inspect the synthetic source.', () => {}, new AbortController().signal)
  for (let attempt = 0; attempt < 50 && !(await worker.attention()).permissions.length; attempt++) await delay(5)
  const request = (await worker.attention()).permissions[0]!
  await worker.decide(request.id, 'reject', request.fingerprint, () => {})
  assert.equal(await turn, 'x'.repeat(255_990) + '[REDACTED]')
  assert.ok(!JSON.stringify(await worker.messages()).includes(secret.slice(0, 10)))
})

test('managed Cline rejects native agent spawning instead of bypassing Kraflr delegation', { timeout: 5000 }, async (t) => {
  const fixture = fakeCline('', undefined, 'spawn_agent: create an untracked worker')
  const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: {},
    signal: new AbortController().signal, onSaved() {}, spawnProcess: fixture.spawnProcess })
  t.after(() => worker.close())
  await worker.runTurn('Use only Kraflr tasks.', () => {}, new AbortController().signal)
  assert.deepEqual(fixture.decisions, [{ outcome: { outcome: 'cancelled' } }])
  assert.equal((await worker.attention()).permissions.length, 0)
  assert.ok((await worker.messages()).some((item) => /Native agent spawning was blocked/.test(item.text)))
})
