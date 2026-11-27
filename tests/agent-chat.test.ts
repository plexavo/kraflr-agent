import assert from 'node:assert/strict'
import test from 'node:test'
import { agentContext } from '../server/agent-context.ts'
import { createOpenCodeChat } from '../server/opencode-chat.ts'
import type { PrivateOpenCode } from '../server/private-opencode.ts'
import { emptyScope } from '../shared/research.ts'

test('new agent context contains the saved research scope revision', () => {
  const now = new Date().toISOString()
  const panel = {
    id: 'test', name: 'The export investigation', type: 'source' as const,
    createdAt: now, updatedAt: now, repositoryMode: 'known' as const, scopeVersion: 3,
  }
  const scope = {
    ...emptyScope, version: 3, savedAt: now, targetName: 'Export module',
    repository: 'https://example.test/export.git', revision: 'release-x',
    workspacePath: 'C:/Research/Notes', restrictions: 'Source review only.',
    notes: 'Owner check is the focus.',
  }
  const context = agentContext({ ...panel, scopeHistory: [scope] })
  assert.equal(context.revision, 3)
  for (const value of [panel.name, scope.targetName, scope.repository, scope.revision,
    scope.workspacePath, scope.restrictions, scope.notes, 'Read only']) {
    assert.ok(context.text.includes(value))
  }
})

test('OpenCode prompts wait for pending approvals and decisions use the exact request ID', async () => {
  const sessionId = 'ses_test'
  const requestId = 'per_test'
  const base = `/api/session/${sessionId}`
  const calls: { path: string; body: unknown }[] = []
  let requests = [{ id: requestId, sessionID: sessionId, action: 'shell', resources: ['echo test'] }]
  const server: PrivateOpenCode = {
    url: 'http://127.0.0.1:0',
    credentials: { OPENCODE_SERVER_USERNAME: 'test', OPENCODE_SERVER_PASSWORD: 'test' },
    close: async () => {},
    async request(path, options) {
      if (path === '/api/session') return { data: { id: sessionId } }
      if (path === base) return { data: { id: sessionId, tokens: { input: 40, output: 7, reasoning: 3, cache: { read: 6, write: 4 } } } }
      if (path === `${base}/permission`) return { data: requests }
      if (path === `${base}/form`) return { data: [] }
      if (path === `${base}/message?limit=25&order=desc`) return { data: [
        { id: 'reply', type: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
        { id: 'prompt', type: 'user', text: 'Do a review' },
      ] }
      if (path === `${base}/message?limit=6&order=desc`) return { data: [
        { id: 'reply', type: 'assistant', model: { providerID: 'fixture', id: 'reviewer' } },
      ] }
      if (path === `${base}/message?limit=100&order=desc`) return { data: [
        { id: 'idle', type: 'idle', outcome: 'succeeded' },
        { id: 'reply', type: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
        { id: 'prompt', type: 'user', text: 'Do a review' },
      ] }
      calls.push({ path, body: options?.body })
      return { data: { id: 'prompt' } }
    },
  }
  const chat = await createOpenCodeChat(server, 'Fixture agent')
  const fingerprint = (await chat.attention()).permissions[0]!.fingerprint
  assert.deepEqual(await chat.telemetry(), { model: 'fixture/reviewer', usage: { tokens: 60, kind: 'session' } })
  await assert.rejects(chat.runTurn('Do a review', () => {}, new AbortController().signal), /pending request/)
  await assert.rejects(chat.decide('per_other', 'once', fingerprint, () => {}), /no longer pending/)
  await assert.rejects(chat.decide(requestId, 'once', fingerprint, () => { throw new Error('Scope changed') }), /Scope changed/)
  assert.equal(calls.length, 0)

  await chat.decide(requestId, 'reject', fingerprint, () => {})
  requests = []
  assert.equal(await chat.runTurn('Do a review', () => {}, new AbortController().signal), 'Reviewed.')
  assert.deepEqual(calls, [
    { path: `${base}/permission/${requestId}/reply`, body: { decision: 'reject' } },
    { path: `${base}/prompt`, body: { text: 'Do a review', delivery: 'queue' } },
  ])
  assert.deepEqual(await chat.messages(), [
    { id: 'prompt', role: 'user', text: 'Do a review' },
    { id: 'reply', role: 'assistant', text: 'Reviewed.' },
  ])
})

test('cancelling a delivered OpenCode prompt interrupts the exact session', async () => {
  const calls: string[] = []
  const stop = new AbortController()
  const chat = await createOpenCodeChat({
    url: 'http://127.0.0.1:0',
    credentials: { OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture' },
    close: async () => {},
    async request(path) {
      calls.push(path)
      if (path === '/api/session') return { data: { id: 'ses_stop' } }
      if (path.endsWith('/permission') || path.endsWith('/form')) return { data: [] }
      if (path.endsWith('/prompt')) {
        stop.abort()
        return { data: { id: 'prompt_stop' } }
      }
      assert.equal(path, '/api/session/ses_stop/interrupt?resume=false')
      return { data: { interrupted: true } }
    },
  }, 'Cancellation fixture')
  await assert.rejects(chat.runTurn('Review this fixture.', () => {}, stop.signal), { name: 'AbortError' })
  assert.equal(calls.filter((path) => path === '/api/session/ses_stop/interrupt?resume=false').length, 1)
})

test('OpenCode model selection uses the native session API and verifies the model used by the next turn', async () => {
  let selected = { providerID: 'fixture', id: 'first' }
  let busy = false
  let confirm = true
  const switches: unknown[] = []
  const prompts: unknown[] = []
  const server: PrivateOpenCode = {
    url: 'http://127.0.0.1:0', credentials: { OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture-password' },
    async close() {}, async request(path, options) {
      if (path === '/api/session') return { data: { id: 'ses_models' } }
      if (path === '/api/model') return { data: [
        { ...selected, id: 'first', name: 'First', enabled: true, type: 'chat', settings: { apiKey: 'must-not-leave-adapter' } },
        { id: 'second', providerID: 'fixture', name: 'Second', enabled: true },
        { id: 'disabled', providerID: 'fixture', name: 'Disabled', enabled: false },
        { id: 'image', providerID: 'fixture', name: 'Image', enabled: true, type: 'image' },
      ] }
      if (path === '/api/model/default') return { data: { providerID: 'fixture', id: 'first' } }
      if (path === '/api/session/ses_models') return { data: { id: 'ses_models', model: selected, time: { busy: busy ? 2 : 0, idle: 1 } } }
      if (path.endsWith('/model')) {
        switches.push(options?.body)
        if (confirm) selected = (options!.body as { model: typeof selected }).model
        return
      }
      if (path.endsWith('/permission') || path.endsWith('/form')) return { data: [] }
      if (path.endsWith('/prompt')) { prompts.push(selected); return { data: { id: 'prompt' } } }
      if (path.includes('/message?limit=100')) return { data: [
        { type: 'idle', outcome: 'succeeded' },
        { type: 'assistant', content: [{ type: 'text', text: `${selected.providerID}/${selected.id}` }] },
        { type: 'user', id: 'prompt' },
      ] }
      if (path.includes('/message?limit=6')) return { data: [{ type: 'assistant', model: { providerID: 'fixture', id: 'first' } }] }
      throw new Error(`Unexpected fixture route ${path}`)
    },
  }
  const chat = await createOpenCodeChat(server, 'Model test')
  assert.deepEqual(await chat.models(), { current: 'fixture/first', choices: [
    { id: 'fixture/first', name: 'First · fixture' }, { id: 'fixture/second', name: 'Second · fixture' },
  ] })
  await assert.rejects(chat.selectModel('fixture/unknown'), /available model/)
  busy = true
  await assert.rejects(chat.selectModel('fixture/second'), /current OpenCode turn/)
  busy = false
  assert.equal(switches.length, 0)
  await chat.selectModel('fixture/second')
  assert.deepEqual(switches, [{ model: { providerID: 'fixture', id: 'second' } }])
  assert.equal((await chat.models()).current, 'fixture/second')
  assert.equal((await chat.telemetry()).model, 'fixture/second') // Current selection wins over an older assistant.
  assert.equal(await chat.runTurn('Synthetic check.', () => {}, new AbortController().signal), 'fixture/second')
  assert.deepEqual(prompts, [{ providerID: 'fixture', id: 'second' }])
  const restored = await createOpenCodeChat(server, 'Restore model', null, 'fixture/first')
  assert.equal((await restored.models()).current, 'fixture/first')
  confirm = false
  await assert.rejects(restored.selectModel('fixture/second'), /did not confirm/)
  assert.equal(restored.modelSelectionRequired, true)
  await assert.rejects(restored.runTurn('Must not dispatch.', () => {}, new AbortController().signal), /confirm a model/)
})

test('OpenCode provider limits are explained without persisting raw response credentials', async () => {
  const secret = 'unknown-provider-secret-never-display'
  const server: PrivateOpenCode = {
    url: 'http://127.0.0.1:0', credentials: { OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture-password' },
    async close() {}, async request(path) {
      if (path === '/api/session') return { data: { id: 'ses_limit' } }
      if (path.endsWith('/permission') || path.endsWith('/form')) return { data: [] }
      if (path.endsWith('/prompt')) return { data: { id: 'prompt' } }
      return { data: [
        { id: 'failed', type: 'idle', outcome: 'failed', error: { type: 'provider', status: 429,
          message: "You've used today's free messages.", response: { body: `Credential: ${secret}` } } },
        { id: 'prompt', type: 'user', text: 'Synthetic greeting.' },
      ] }
    },
  }
  const chat = await createOpenCodeChat(server, 'Limit report')
  await assert.rejects(chat.runTurn('Synthetic greeting.', () => {}, new AbortController().signal), /free-model usage limit/)
  const messages = await chat.messages()
  assert.ok(messages.some((item) => item.role === 'activity' && /free-model usage limit/.test(item.text)))
  assert.ok(!JSON.stringify(messages).includes(secret))
})
