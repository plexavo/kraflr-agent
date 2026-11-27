import assert from 'node:assert/strict'
import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { buildApp } from '../server/app.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../server/db.ts'
import { connectOpenCode } from '../server/opencode.ts'
import { emptyScope } from '../shared/research.ts'
import type { Panel, PanelDetail } from '../shared/research.ts'
import type { FixtureRun } from '../shared/opencode.ts'

const port = 4317
const host = `127.0.0.1:${port}`
const headers = { host, origin: `http://${host}`, 'content-type': 'application/json' }
const scope = {
  ...emptyScope,
  targetName: 'Export tools',
  repository: 'example/export-tools',
  revision: '4f28ed8b0a57eac8d02065908e6415a0e575c932',
  allowedActions: 'Read-only source review.',
  restrictions: 'No production traffic.',
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'kraflr-test-'))
  const file = join(dir, 'research.sqlite')
  t.after(async () => {
    await rm(file, { force: true })
    await rmdir(dir)
  })
  return { store: () => openStore(file), dir, file }
}

test('panel scopes and their history persist in SQLite across app restarts', async (t) => {
  const sandbox = await fixture(t)
  const store = sandbox.store()
  const webId = store.createPanel({ name: 'Older web panel', type: 'web' }).id
  let app = buildApp(store, port)
  let panelId = ''
  let latestNotes = ''
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/panels', headers,
      payload: { name: ' Export tools ', type: 'source' },
    })
    assert.equal(created.statusCode, 201)
    const initial = created.json<PanelDetail>()
    panelId = initial.id
    assert.equal(initial.name, 'Export tools')
    assert.deepEqual(initial.scopeHistory, [])

    const web = await app.inject({
      method: 'POST', url: '/api/panels', headers, payload: { name: 'Web QA', type: 'web' },
    })
    assert.ok([200, 201].includes(web.statusCode), 'web application panels can be created')
    assert.equal(web.json<PanelDetail>().type, 'web')

    const url = `/api/panels/${panelId}/scope`
    const first = await app.inject({ method: 'PUT', url, headers, payload: { expectedVersion: 0, scope } })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(first.json<PanelDetail>().scopeVersion, 1)

    const candidates = ['First draft.', 'Second draft.']
    const responses = await Promise.all(candidates.map((notes) => app.inject({
      method: 'PUT', url, headers, payload: { expectedVersion: 1, scope: { ...scope, notes } },
    })))
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409])
    latestNotes = candidates[responses.findIndex((response) => response.statusCode === 200)]!

    const retried = await app.inject({
      method: 'PUT', url, headers, payload: { expectedVersion: 1, scope: { ...scope, notes: latestNotes } },
    })
    assert.equal(retried.statusCode, 200)
    assert.equal(retried.json<PanelDetail>().scopeVersion, 2)
  } finally {
    await app.close()
  }

  app = buildApp(sandbox.store(), port)
  try {
    const list = await app.inject({ method: 'GET', url: '/api/panels', headers: { host } })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json<Panel[]>().length, 3, 'the source panel, the older web panel and the web panel created over the API')
    const response = await app.inject({ method: 'GET', url: `/api/panels/${panelId}`, headers: { host } })
    assert.equal(response.statusCode, 200)
    const restored = response.json<PanelDetail>()
    assert.equal(restored.name, 'Export tools')
    assert.deepEqual(restored.scopeHistory.map((entry) => entry.version), [2, 1])
    assert.equal(restored.scopeHistory[0]?.notes, latestNotes)
    assert.equal(restored.scopeHistory[1]?.notes, '')
    assert.equal(restored.scopeHistory[0]?.revision, scope.revision)
    const other = await app.inject({ method: 'GET', url: `/api/panels/${webId}`, headers: { host } })
    assert.deepEqual(other.json<PanelDetail>().scopeHistory, [])

    const webOnly = await app.inject({
      method: 'PUT', url: `/api/panels/${webId}/scope`, headers,
      payload: { expectedVersion: 0, scope: { ...emptyScope, targetName: 'Web QA', webTargets: 'https://app.example.test/', allowedActions: 'Review the authorized application.' } },
    })
    assert.equal(webOnly.statusCode, 400, 'a web scope needs its rules of engagement')
    const withRules = await app.inject({
      method: 'PUT', url: `/api/panels/${webId}/scope`, headers,
      payload: { expectedVersion: 0, scope: { ...emptyScope, targetName: 'Web QA', webTargets: 'https://app.example.test/', notes: 'Read-only testing of app.example.test only.' } },
    })
    assert.equal(withRules.statusCode, 200, withRules.body)
  } finally {
    await app.close()
  }
})

test('loopback API rejects untrusted browser writes and invalid scope records', async (t) => {
  const sandbox = await fixture(t)
  const app = buildApp(sandbox.store(), port)
  try {
    const payload = { name: 'Scope test', type: 'source' }
    const url = '/api/panels'
    assert.equal((await app.inject({ method: 'GET', url, headers: { host: 'rebind.example.test' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url, headers: { host }, payload })).statusCode, 403)
    assert.equal((await app.inject({
      method: 'POST', url, headers: { ...headers, origin: 'https://external.example.test' }, payload,
    })).statusCode, 403)
    assert.equal((await app.inject({
      method: 'POST', url, headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload,
    })).statusCode, 403)
    assert.equal((await app.inject({
      method: 'POST', url, headers: { ...headers, 'content-type': 'text/plain' }, payload: JSON.stringify(payload),
    })).statusCode, 415)
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, name: '  ' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, extra: true } })).statusCode, 400)
    const before = await app.inject({ method: 'GET', url, headers: { host } })
    assert.deepEqual(before.json(), [])
    assert.equal(before.headers['cache-control'], 'no-store')

    const created = await app.inject({ method: 'POST', url, headers, payload })
    const scopeUrl = `${url}/${created.json<PanelDetail>().id}/scope`
    for (const invalid of [
      { ...scope, repository: '', revision: 'unbound-version' },
      { ...scope, targetName: '  ' },
      { ...scope, allowedActions: ' ', accessMode: 'unspecified' },
      { ...scope, repository: '', revision: '' },
      { ...scope, executable: 'unexpected field' },
    ]) {
      const response = await app.inject({
        method: 'PUT', url: scopeUrl, headers, payload: { scope: invalid, expectedVersion: 0 },
      })
      assert.equal(response.statusCode, 400)
    }
    const saved = await app.inject({ method: 'GET', url: scopeUrl.replace(/\/scope$/, ''), headers: { host } })
    assert.deepEqual(saved.json<PanelDetail>().scopeHistory, [])
  } finally {
    await app.close()
  }
})

test('agent launches accept supported CLIs on research panels that have a saved scope', async (t) => {
  const sandbox = await fixture(t)
  const store = sandbox.store()
  const source = store.createPanel({ name: 'Source target', type: 'source' })
  const web = store.createPanel({ name: 'Older web panel', type: 'web' })
  const app = buildApp(store, port, {
    terminals: createAgentTerminals(join(sandbox.dir, 'terminals'), store),
  })
  try {
    const catalog = await app.inject({ url: '/api/agents', headers: { host } })
    assert.equal(catalog.statusCode, 200)
    const agents = catalog.json()
    assert.deepEqual(agents.map((agent: { kind: string }) => agent.kind), ['opencode', 'cline', 'claude'])
    for (const agent of agents) assert.deepEqual(Object.keys(agent).sort(), ['installed', 'kind'])

    const launch = (id: string, kind: string) => app.inject({
      method: 'POST', url: `/api/panels/${id}/terminal`, headers,
      payload: { kind, cols: 100, rows: 26 },
    })
    assert.equal((await launch(source.id, 'powershell')).statusCode, 400)
    const rejectedPanel = await launch(web.id, 'cline')
    assert.equal(rejectedPanel.statusCode, 409)
    assert.match(rejectedPanel.json().message, /research scope/)
    const sessions = await app.inject({ url: '/api/agents/sessions', headers: { host } })
    assert.equal(sessions.statusCode, 200)
    assert.deepEqual(sessions.json(), [])
  } finally {
    await app.close()
  }
})

test('old scope revisions migrate and a discovery note can be resolved in a new revision', async (t) => {
  const sandbox = await fixture(t)
  const initial = sandbox.store()
  const id = initial.createPanel({ name: 'Upstream review', type: 'source' }).id
  initial.saveScope(id, 0, scope)
  initial.close()

  const oldDatabase = new DatabaseSync(sandbox.file)
  oldDatabase.exec(`
    DROP TABLE verification_runs;
    DROP TABLE verification_fixture;
    DROP TABLE lead_reviews;
    DROP TABLE agent_parents;
    DROP TABLE agent_sessions;
    DROP TABLE research_runs;
    DROP TABLE source_reviews;
    DROP TABLE fixture_runs;
    ALTER TABLE scope_revisions DROP COLUMN targetName;
    ALTER TABLE scope_revisions DROP COLUMN workspacePath;
    ALTER TABLE scope_revisions DROP COLUMN labPath;
    ALTER TABLE scope_revisions DROP COLUMN repositoryDiscovery;
    ALTER TABLE scope_revisions DROP COLUMN repositoryMode;
    ALTER TABLE scope_revisions DROP COLUMN accessMode;
    ALTER TABLE scope_revisions DROP COLUMN roeReference;
    PRAGMA user_version = 1;
  `)
  oldDatabase.close()

  const labPath = 'C:\\Lab\\Example fixture'
  const app = buildApp(sandbox.store(), port)
  try {
    const route = `/api/panels/${id}`
    const previous = (await app.inject({ url: route, headers })).json<PanelDetail>().scopeHistory[0]
    assert.equal(previous?.allowedActions, scope.allowedActions)
    assert.equal(previous?.accessMode, 'unspecified')
    assert.equal(previous?.repository, scope.repository)
    assert.equal(previous?.workspacePath, '')
    assert.equal(previous?.targetName, '')

    const discovery = {
      ...emptyScope, targetName: 'Export tools', repositoryMode: 'discover', labPath,
      repositoryDiscovery: 'Use the official project site to find upstream.',
    }
    const save = (expectedVersion: number, draft: unknown) => app.inject({
      method: 'PUT', url: `${route}/scope`, headers, payload: { expectedVersion, scope: draft },
    })
    assert.equal((await save(1, { ...discovery, repositoryDiscovery: '' })).statusCode, 400)
    assert.equal((await save(1, { ...scope, ...discovery, repository: scope.repository, revision: scope.revision })).statusCode, 400)
    const pending = await save(1, discovery)
    assert.equal(pending.statusCode, 200, pending.body)
    assert.equal(pending.json<PanelDetail>().repositoryMode, 'discover')

    const resolved = await save(2, {
      ...scope, labPath, workspacePath: 'C:\\Research\\Export tools',
      repositoryDiscovery: discovery.repositoryDiscovery, accessMode: 'read_write',
    })
    assert.equal(resolved.statusCode, 200, resolved.body)
    const panel = resolved.json<PanelDetail>()
    assert.equal(panel.repositoryMode, 'known')
    assert.deepEqual(panel.scopeHistory.map((revision) => revision.accessMode), ['read_write', 'read_only', 'unspecified'])
    assert.equal(panel.scopeHistory[1]?.labPath, labPath)
    assert.equal(panel.scopeHistory[1]?.workspacePath, '')
    assert.equal(panel.scopeHistory[0]?.workspacePath, 'C:\\Research\\Export tools')
    assert.equal(panel.scopeHistory[0]?.targetName, 'Export tools')
  } finally {
    await app.close()
  }
})

test('OpenCode fixture review confirms policy, saves a lead, and cancels its own session', async (t) => {
  const sandbox = await fixture(t)
  const store = sandbox.store()
  const id = store.createPanel({ name: 'Scope label stays local', type: 'source' }).id
  const differentPanel = store.createPanel({ name: 'Second panel', type: 'source' }).id
  let cancelled = false
  let hold = false
  let createCount = 0
  let requestCount = 0
  let messageStarted: (() => void) | undefined
  const openCode = connectOpenCode({
    port: 4096, username: 'opencode', password: 'fixture-test', providerID: 'fixture', modelID: 'example',
  }, async (url, init) => {
    requestCount += 1
    assert.equal(new URL(String(url)).origin, 'http://127.0.0.1:4096')
    assert.equal(init?.redirect, 'error')
    const path = new URL(String(url)).pathname
    const body = JSON.parse(String(init?.body ?? 'null'))
    if (path === '/global/health') return Response.json({ healthy: true, version: '1.19.5' })
    if (path === '/session') {
      assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }])
      createCount += 1
      return Response.json({ id: `ses_fixture${createCount}`, permission: body.permission })
    }
    if (path.endsWith('/abort')) {
      cancelled = true
      assert.equal(path, '/session/ses_fixture2/abort')
      return Response.json(true)
    }
    assert.equal(path, `/session/ses_fixture${createCount}/message`)
    assert.equal(body.model.modelID, 'example')
    assert.doesNotMatch(body.parts[0].text, /Scope label stays local/)
    assert.match(body.parts[0].text, /export-download\.js/)
    const signal = init?.signal
    if (hold && signal) {
      messageStarted?.()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return Response.json({
      info: {
        role: 'assistant', sessionID: `ses_fixture${createCount}`, tokens: { total: 15 },
      },
      parts: [{ type: 'text', text: JSON.stringify({
        title: 'Missing export ownership check', explanation: 'Any viewer can reach the return on line 5.', line: 5,
      }) }],
    })
  })
  const app = buildApp(store, port, { openCode })
  const url = `/api/panels/${id}/fixture-run`
  async function waitFor(status: FixtureRun['status']) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { run } = (await app.inject({ url, headers })).json<{ run: FixtureRun | null }>()
      if (run?.status === status) return run
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.fail(`Fixture run never reached ${status}.`)
  }
  try {
    assert.equal((await app.inject({ url: '/api/opencode', headers })).json().status, 'connected')
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode, 202)
    const run = await waitFor('completed')
    assert.equal(run.lead?.line, 5)
    assert.equal(run.tokens, 15)

    hold = true
    const waiting = new Promise<void>((resolve) => { messageStarted = resolve })
    const started = (await app.inject({ method: 'POST', url, headers, payload: {} })).json<FixtureRun>()
    await waiting
    const wrongPanel = await app.inject({
      method: 'POST', url: `/api/panels/${differentPanel}/fixture-run/cancel`, headers, payload: { runId: started.id },
    })
    assert.equal(wrongPanel.statusCode, 409)
    const stopping = await app.inject({ method: 'POST', url: `${url}/cancel`, headers, payload: { runId: started.id } })
    assert.equal(stopping.statusCode, 202)
    await waitFor('cancelled')
    assert.equal(cancelled, true)
    assert.ok(requestCount > 4)
  } finally {
    await app.close()
  }
  const reopened = sandbox.store()
  try {
    assert.equal(reopened.latestFixtureRun(id)?.status, 'cancelled')
    assert.equal(reopened.latestFixtureRun(differentPanel), null)
  } finally {
    reopened.close()
  }
})
