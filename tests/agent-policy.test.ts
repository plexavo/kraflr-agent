import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { managedAgentPolicy, prepareAgentPolicy } from '../server/agent-policy.ts'
import { emptyScope } from '../shared/research.ts'

test('managed OpenCode config guards actions and preserves unrelated model settings', async (t) => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'kraflr-policy-'))
  t.after(async () => {
    const resolved = await realpath(root)
    if (/^kraflr-policy-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  const clone = join(root, 'clone')
  await mkdir(clone)
  const scope = { ...emptyScope, repository: clone, version: 1, savedAt: new Date().toISOString() }
  const policy = managedAgentPolicy(scope)
  const canonical = (await realpath(clone)).replaceAll('\\', '/')
  assert.deepEqual(policy.permissions[0], { action: '*', resource: '*', effect: 'ask' })
  assert.ok(policy.permissions.some((rule) => rule.action === 'external_directory' && rule.resource === '*' && rule.effect === 'ask'))
  assert.ok(policy.permissions.some((rule) => rule.action === 'external_directory' && rule.resource === `${canonical}/*` && rule.effect === 'allow'))
  for (const resource of [`edit:${canonical}/*`, 'subagent:*', 'execute:*']) {
    assert.ok(policy.policies.some((rule) => rule.resource === resource && rule.effect === 'deny'))
  }
  assert.ok(!managedAgentPolicy({ ...scope, accessMode: 'read_write' }).policies.some((rule) => rule.resource.startsWith('edit:')))
  assert.ok(!managedAgentPolicy({ ...scope, repository: 'https://example.test/repo' }).permissions.some((rule) => rule.action === 'external_directory' && rule.effect === 'allow'))
  const scratch = join(root, 'scratch')
  await mkdir(join(scratch, '.opencode'), { recursive: true })
  const config = join(scratch, '.opencode', 'opencode.json')
  await writeFile(config, JSON.stringify({ model: 'fixture/reviewer', permissions: [{ action: '*', resource: '*', effect: 'allow' }] }))
  prepareAgentPolicy(scratch, scope)
  const first = await readFile(config, 'utf8')
  assert.deepEqual(JSON.parse(first), { model: 'fixture/reviewer', ...managedAgentPolicy(scope, scratch) })
  assert.ok(JSON.parse(first).policies.some((rule: { resource: string }) => rule.resource === 'edit:../clone/*'))
  prepareAgentPolicy(scratch, scope)
  assert.equal(await readFile(config, 'utf8'), first)
  await writeFile(config, '{malformed')
  assert.throws(() => prepareAgentPolicy(scratch, scope), /could not be verified/)
  const linked = join(root, 'linked')
  await mkdir(linked)
  await symlink(join(scratch, '.opencode'), join(linked, '.opencode'), 'junction')
  assert.throws(() => prepareAgentPolicy(linked, scope), /linked elsewhere/)
  assert.equal(await readFile(config, 'utf8'), '{malformed')
})

test('the tool gateway is placed where OpenCode v2 actually looks for it, and no managed policy omits mcp at all without a gateway', () => {
  const scope = { ...emptyScope, repository: 'https://example.test/repo', version: 1, savedAt: new Date().toISOString() }
  assert.equal('mcp' in managedAgentPolicy(scope), false, 'no gateway means no mcp key, not an empty or disabled one')
  const gateway = { command: '/usr/bin/node', args: ['/opt/kraflr/server/mcp-gateway.ts'], env: { KRAFLR_BURP_MCP_URL: 'http://127.0.0.1:9876/mcp' } }
  const policy = managedAgentPolicy(scope, undefined, gateway) as { mcp?: { servers?: Record<string, unknown> } }
  // OpenCode v2 nests servers under mcp.servers, not directly under mcp, and has no "enabled" field — only "disabled" (default false).
  assert.deepEqual(policy.mcp, { servers: { kraflr: { type: 'local', command: [gateway.command, ...gateway.args], environment: gateway.env } } })
  assert.equal('enabled' in (policy.mcp!.servers!.kraflr as object), false)
  assert.equal('kraflr' in policy.mcp!, false, 'a server directly under mcp is invisible to OpenCode v2')
})
