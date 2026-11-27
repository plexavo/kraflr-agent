import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from '../server/app.ts'
import { openStore, StoreError } from '../server/db.ts'
import { agentContext } from '../server/agent-context.ts'
import { kickoffPrompt } from '../shared/kickoff-prompt.ts'
import { parseWebTarget, parseWebTargets } from '../shared/web-scope.ts'
import { emptyScope, researchLabels } from '../shared/research.ts'
import type { ScopeInput } from '../shared/research.ts'

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
const web: ScopeInput = { ...emptyScope, targetName: 'Shop', webTargets: 'shop.example.com\n*.api.example.com', notes: 'Only test during business hours. No load testing.', workspacePath: '/tmp/ws', accessMode: 'read_only' }
const source: ScopeInput = { ...emptyScope, targetName: 'Export tools', repository: 'https://github.com/example/export-tools', revision: 'HEAD', workspacePath: '/tmp/ws', accessMode: 'read_only', restrictions: 'No network tests' }

test('authorized targets are read as hosts, wildcards, ports and URL prefixes, and anything else is reported back', () => {
  assert.deepEqual(parseWebTarget('App.Example.com'), { text: 'App.Example.com', host: 'app.example.com', wildcard: false, path: '' })
  assert.deepEqual(parseWebTarget('*.example.com'), { text: '*.example.com', host: '*.example.com', wildcard: true, path: '' })
  assert.deepEqual(parseWebTarget('https://*.example.com'), { text: 'https://*.example.com', host: '*.example.com', wildcard: true, path: '' })
  assert.deepEqual(parseWebTarget('shop.example.com:8443'), { text: 'shop.example.com:8443', host: 'shop.example.com', wildcard: false, port: '8443', path: '' })
  assert.deepEqual(parseWebTarget('https://shop.example.com/store/'), { text: 'https://shop.example.com/store/', host: 'shop.example.com', wildcard: false, path: '/store' })
  assert.equal(parseWebTarget('10.0.0.5')?.host, '10.0.0.5')
  assert.equal(parseWebTarget('localhost')?.host, 'localhost')
  for (const bad of ['', 'com', '*.com ', 'two words', 'ftp://example.com', 'https://user:pw@example.com', 'https://example.com/?q=1', 'exa mple.com', '-bad.example.com', 'https://example.com/#x']) {
    assert.equal(parseWebTarget(bad), undefined, JSON.stringify(bad))
  }
  const mixed = parseWebTargets('shop.example.com, *.api.example.com;\nhttps://admin.example.com/panel\nnot a host,   ')
  assert.deepEqual(mixed.targets.map((item) => item.host), ['shop.example.com', '*.api.example.com', 'admin.example.com'])
  assert.deepEqual(mixed.invalid, ['not a host'])
})

test('a web application panel needs authorized targets and rules of engagement, and keeps both with the scope revision', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Shop QA', type: 'web' })
  const save = (scope: Partial<ScopeInput>) => store.saveScope(panel.id, store.readPanel(panel.id).scopeVersion, { ...web, ...scope })
  assert.throws(() => save({ webTargets: '' }), /at least one authorized target/)
  assert.throws(() => save({ webTargets: 'shop.example.com, nope nope' }), /not valid hosts or URLs: nope nope/)
  assert.throws(() => save({ notes: '', roeReference: '' }), /rules of engagement/)
  assert.throws(() => save({ repositoryMode: 'discover' }), /no repository discovery/)
  assert.equal(store.readPanel(panel.id).scopeVersion, 0, 'nothing was saved by the refused scopes')

  const linked = save({ notes: '', roeReference: 'https://example.com/roe.html' })
  assert.equal(linked.scopeVersion, 1); assert.equal(linked.scopeHistory[0]!.roeReference, 'https://example.com/roe.html')
  const filed = save({ notes: 'Loaded from the file', roeReference: 'C:\\roe.txt' })
  assert.equal(filed.scopeVersion, 2); assert.equal(filed.scopeHistory[0]!.notes, 'Loaded from the file'); assert.equal(filed.scopeHistory[1]!.roeReference, 'https://example.com/roe.html')
  assert.equal(store.readSourceScope(panel.id, 2).webTargets.includes('*.api.example.com'), true, 'agents can run on a web panel scope')
  // A source panel is unchanged: it still needs its repository and does not need rules of engagement.
  const code = store.createPanel({ name: 'Code', type: 'source' })
  assert.throws(() => store.saveScope(code.id, 0, { ...source, repository: '' }), /repository and revision/)
  assert.equal(store.saveScope(code.id, 0, source).scopeVersion, 1)
  const roe = ('x'.repeat(100) + ' ').repeat(150)
  assert.equal(save({ notes: roe }).scopeHistory[0]!.notes.length, roe.length, 'a long set of rules is stored whole')
})

test('both research types can be created over the API, a web scope is validated there, and a web panel has no checkout to prepare', async () => {
  const store = openStore(':memory:')
  const app = buildApp(store, 4317)
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers, payload })
  try {
    const created = await call('POST', '/api/panels', { name: 'Shop QA', type: 'web' })
    assert.ok(created.statusCode === 200 || created.statusCode === 201, created.body)
    const panel = created.json<{ id: string; type: string }>()
    assert.equal(panel.type, 'web')
    assert.equal((await call('POST', '/api/panels', { name: 'Odd', type: 'mobile' })).statusCode, 400)
    assert.equal((await call('PUT', `/api/panels/${panel.id}/scope`, { expectedVersion: 0, scope: { ...web, notes: '' } })).statusCode, 400)
    const saved = await call('PUT', `/api/panels/${panel.id}/scope`, { expectedVersion: 0, scope: { ...web, roeReference: 'https://example.com/roe' } })
    assert.equal(saved.statusCode, 200, saved.body)
    const checkout = await call('POST', `/api/panels/${panel.id}/checkout`, {})
    assert.equal(checkout.statusCode, 200, checkout.body)
    assert.equal(checkout.json<{ checkout?: unknown }>().checkout, undefined, 'nothing is cloned for a web application test')
  } finally { await app.close() }
})

test('a web agent is told its authorized targets and rules, how a link is handled, and that it has no checkout', () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Shop QA', type: 'web' })
  const text = (scope: Partial<ScopeInput>) => agentContext(store.saveScope(panel.id, store.readPanel(panel.id).scopeVersion, { ...web, ...scope })).text
  const written = text({})
  assert.match(written, /Type of security research: Web application testing/); assert.match(written, /Authorized web targets/)
  assert.match(written, /shop\.example\.com\n\*\.api\.example\.com/); assert.match(written, /Only test during business hours/)
  assert.match(written, /Never send a request to a host, port or path that is not listed/); assert.match(written, /read-only testing: GET, HEAD and OPTIONS/)
  assert.match(written, /POST \/api\/export/); assert.match(written, /The researcher wrote the rules of engagement below/)
  assert.doesNotMatch(written, /prepared checkout|Official repository/i)
  const linked = text({ notes: '', roeReference: 'https://example.com/roe.html' })
  assert.match(linked, /published at https:\/\/example\.com\/roe\.html\. Read them with your own tools before sending any request/); assert.match(linked, /stop and ask the researcher if you cannot read them/)
  const filed = text({ notes: 'No scanners.', roeReference: 'C:\\rules\\roe.txt' })
  assert.match(filed, /loaded from the file C:\\rules\\roe\.txt; their text is saved below/); assert.match(filed, /No scanners\./)
  assert.match(text({ accessMode: 'read_write' }), /state-changing tests/)
  const code = store.createPanel({ name: 'Code', type: 'source' })
  const sourceText = agentContext(store.saveScope(code.id, 0, source)).text
  assert.match(sourceText, /Type of security research: Open-source code review/); assert.match(sourceText, /prepared checkout/); assert.doesNotMatch(sourceText, /Authorized web targets/)
})

test('the prepared research prompt is built from the saved scope for each type, works alone and makes a Child optional', () => {
  const store = openStore(':memory:')
  const code = store.saveScope(store.createPanel({ name: 'Code', type: 'source' }).id, 0, source)
  const codePrompt = kickoffPrompt(code)
  assert.match(codePrompt, /review Export tools \(Open-source code review, scope revision 1\)/); assert.match(codePrompt, /https:\/\/github\.com\/example\/export-tools @ HEAD/)
  assert.match(codePrompt, /No network tests/); assert.match(codePrompt, /Use a Child only if it clearly saves time/); assert.match(codePrompt, /kraflr agent lead/)
  assert.match(codePrompt, /Move a lead to Findings with `kraflr agent confirm` only when you reproduced it with a control case; I decide on the rest/); assert.doesNotMatch(codePrompt, /Do not run project code|kraflr-result|tasks array/)
  const found = store.saveScope(store.createPanel({ name: 'Find', type: 'source' }).id, 0, { ...source, repository: '', revision: '', repositoryMode: 'discover', repositoryDiscovery: 'The Export Tools plugin by Example' })
  assert.match(kickoffPrompt(found), /official repository is not confirmed yet: find it first \(The Export Tools plugin by Example\)/)

  const site = store.saveScope(store.createPanel({ name: 'Shop', type: 'web' }).id, 0, { ...web, roeReference: 'https://example.com/roe', notes: 'No   load\ntesting.' })
  const webPrompt = kickoffPrompt(site)
  assert.match(webPrompt, new RegExp(`test Shop \\(${researchLabels.web}, scope revision 1\\)`)); assert.match(webPrompt, /Authorized targets: shop\.example\.com, \*\.api\.example\.com\. Nothing else is in scope\./)
  assert.match(webPrompt, /Rules of engagement: No load testing\. \(source: https:\/\/example\.com\/roe\)/); assert.match(webPrompt, /read-only testing \(GET, HEAD, OPTIONS\)/)
  assert.match(webPrompt, /Use a Child only if it clearly saves time/); assert.match(webPrompt, /Work freely with any tool/)
  assert.match(webPrompt, /path is the endpoint/); assert.match(webPrompt, /no DoS, brute force/); assert.doesNotMatch(webPrompt, /tasks array|kraflr-result|approve/)
  const linkOnly = store.saveScope(store.createPanel({ name: 'Link', type: 'web' }).id, 0, { ...web, notes: '', roeReference: 'https://example.com/roe' })
  assert.match(kickoffPrompt(linkOnly), /published at https:\/\/example\.com\/roe; read it before you send anything/)
  assert.match(kickoffPrompt({ ...site, scopeHistory: [] }), /Save a research scope first/)

  // Hunt depth changes only the delegation/thoroughness clause; the objective, scope and rules stay identical across depths.
  const quickWeb = kickoffPrompt(site, 'quick'), deepWeb = kickoffPrompt(site, 'deep')
  assert.match(quickWeb, /do not start a Child/); assert.match(quickWeb, /about 15 minutes/); assert.doesNotMatch(quickWeb, /Delegate freely/)
  assert.match(deepWeb, /Delegate freely/); assert.match(deepWeb, /Go exhaustive/); assert.doesNotMatch(deepWeb, /do not start a Child/)
  for (const prompt of [quickWeb, deepWeb]) { assert.match(prompt, /Authorized targets: shop\.example\.com/); assert.match(prompt, /no DoS, brute force/) }
  const deepCode = kickoffPrompt(code, 'deep')
  assert.match(deepCode, /Delegate freely/); assert.match(deepCode, /Read exhaustively/); assert.match(deepCode, /No network tests/)

  assert.equal(new StoreError(400, 'x').status, 400)
})

test('on any panel the researcher can accept a lead as a Finding with their own evidence note, without a Docker verification', () => {
  const store = openStore(':memory:')
  const lead = (panelId: string, path: string, scopeVersion: number) => {
    const run = { id: crypto.randomUUID(), panelId, parentId: crypto.randomUUID(), parentName: 'Parent', scopeVersion, objective: 'Test', status: 'running' as const, phase: 'Testing', startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] }
    store.startResearchRun(run)
    store.saveResearchRun({ ...run, status: 'completed', leads: [{ title: 'Missing ownership check', explanation: 'An export may skip an ownership check.', path, startLine: 1, endLine: 1, kind: 'lead', security: { hypothesis: 'The export handler may skip the ownership check.', attackPath: 'A logged-in user requests another user’s export id.', impact: 'Another user’s export could be read.' } }] })
    return run.id + ':0'
  }
  const site = store.createPanel({ name: 'Shop', type: 'web' }); store.saveScope(site.id, 0, web)
  const id = lead(site.id, 'POST /api/export', 1)
  const review = (note: string) => store.saveLeadReview(site.id, id, { expectedVersion: store.readEvidence(site.id, id).reviews[0]?.version ?? 0, status: 'open', tag: 'finding', note, nextAction: '' })
  assert.throws(() => review(''), /Record the evidence/)
  assert.equal(store.readEvidence(site.id, id).tag, 'lead')
  assert.equal(review('Replayed the request with a second test account and received the first account’s export.').tag, 'finding')
  assert.equal(store.listEvidence(site.id, 0, 'finding').leads.length, 1)

  const code = store.createPanel({ name: 'Code', type: 'source' }); store.saveScope(code.id, 0, source)
  const codeLead = lead(code.id, 'src/export.php', 1)
  assert.throws(() => store.saveLeadReview(code.id, codeLead, { expectedVersion: 0, status: 'open', tag: 'finding', note: '', nextAction: '' }), /Record the evidence/)
  assert.equal(store.saveLeadReview(code.id, codeLead, { expectedVersion: 0, status: 'open', tag: 'finding', note: 'Read the handler and reproduced the missing check locally.', nextAction: '' }).tag, 'finding')
})
