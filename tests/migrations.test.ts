import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../server/db.ts'
import { emptyScope } from '../shared/research.ts'

// The last three migrations add a per-panel running index, a Claude-capable agent_sessions table and the rules-of-engagement reference.
const newestMigrations = 3

test('existing workspaces keep their agents and Parent while gaining the Claude kind and per-panel verification index', async () => {
  const base = await realpath(tmpdir()), folder = await mkdtemp(join(base, 'kraflr-migrate-')), file = join(folder, 'state.sqlite')
  let store = openStore(file)
  try {
    const panel = store.createPanel({ name: 'Upgrade', type: 'source' })
    store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Synthetic', repositoryMode: 'discover', repositoryDiscovery: 'Migration test only' })
    const saved = { id: crypto.randomUUID(), panelId: panel.id, kind: 'cline' as const, mode: 'terminal' as const, label: 'Old Cline', startedAt: new Date().toISOString(), scopeVersion: 1, nativeId: 'pty:abc', role: 'parent' as const }
    store.saveAgentSession(saved)
    assert.equal(store.agentParent(panel.id), saved.id)
    store.close()
    const current = new DatabaseSync(file)
    const migrationsBeforeClaude = Number((current.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) - newestMigrations
    current.close()

    // Rewind to the schema that shipped before this change: kind limited to two values and one global running index.
    const raw = new DatabaseSync(file)
    try {
      raw.exec('PRAGMA foreign_keys = OFF')
      raw.exec(`
        ALTER TABLE scope_revisions DROP COLUMN roeReference;
        DROP INDEX verification_running_panel;
        CREATE UNIQUE INDEX verification_running ON verification_runs (status) WHERE status = 'running';
        CREATE TABLE agent_sessions_old (
          id TEXT PRIMARY KEY, panelId TEXT NOT NULL REFERENCES panels(id),
          kind TEXT NOT NULL CHECK (kind IN ('opencode', 'cline')), label TEXT NOT NULL, startedAt TEXT NOT NULL,
          scopeVersion INTEGER, nativeId TEXT, mode TEXT NOT NULL DEFAULT 'terminal' CHECK (mode IN ('terminal', 'cline-worker')),
          model TEXT, role TEXT CHECK(role IN ('parent','child')),
          FOREIGN KEY (panelId, scopeVersion) REFERENCES scope_revisions (panelId, version), UNIQUE (panelId, id)
        ) STRICT;
        INSERT INTO agent_sessions_old SELECT id, panelId, kind, label, startedAt, scopeVersion, nativeId, mode, model, role FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_old RENAME TO agent_sessions;
        CREATE INDEX agent_sessions_panel ON agent_sessions (panelId, startedAt);
        PRAGMA user_version = ${migrationsBeforeClaude};
      `)
      assert.throws(() => raw.prepare("INSERT INTO agent_sessions(id,panelId,kind,label,startedAt) VALUES('x',?,'claude','x','now')").run(panel.id), /CHECK/)
    } finally { raw.close() }

    store = openStore(file)
    assert.equal(store.agentParent(panel.id), saved.id)
    assert.equal(store.listSavedAgents().length, 1)
    assert.equal(store.findSavedAgent(panel.id, saved.id)?.label, 'Old Cline')
    store.saveAgentSession({ ...saved, id: crypto.randomUUID(), kind: 'claude', label: 'Claude', nativeId: 'pty:def', role: 'child' })
    assert.deepEqual(store.listSavedAgents().map((agent) => agent.kind).sort(), ['claude', 'cline'])
    store.close()

    const check = new DatabaseSync(file)
    try {
      const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='verification_runs'").all() as { name: string }[]).map((row) => row.name)
      assert.ok(indexes.includes('verification_running_panel') && !indexes.includes('verification_running'))
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { check.close() }
  } finally {
    try { store.close() } catch { /* Already closed. */ }
    await rm(folder, { recursive: true, force: true })
  }
})
