import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { scopeFields } from '../shared/research.ts'
import { parseWebTargets } from '../shared/web-scope.ts'
import type {
  CreatePanelInput, Panel, PanelDetail, ScopeInput, ScopeRevision, RepositoryCheckout,
} from '../shared/research.ts'
import type { FixtureLead, FixtureRun } from '../shared/opencode.ts'
import type { SourcePreview, SourceReviewResult, SourceReviewRun } from '../shared/source-review.ts'
import type { SavedAgentSession } from '../shared/agent-terminal.ts'
import type { ResearchRun, SavedRepositorySuggestion } from '../shared/research-run.ts'
import type { ActiveResearch, LeadCounts } from '../shared/investigation.ts'
import { isAgentExecutor } from '../shared/verification.ts'
import type { VerificationLease, VerificationRecord } from '../shared/verification.ts'
import type { EvidenceLead, EvidenceSummary, EvidenceTag, LeadReview, SaveLeadReview } from '../shared/evidence.ts'
import { isOpenLead } from '../shared/evidence.ts'
import { leadVerification } from '../shared/lead-verification.ts'
import { classifyAgentEvidence } from '../shared/security-lead.ts'
import { evidenceSchema, evidenceStore } from './evidence-store.ts'
import { decodeReport, looksLikeReport } from '../shared/report-text.ts'

const migrations = [`
  CREATE TABLE panels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('source', 'web')),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  ) STRICT;

  CREATE TABLE scope_revisions (
    panelId TEXT NOT NULL REFERENCES panels(id),
    version INTEGER NOT NULL CHECK (version > 0),
    savedAt TEXT NOT NULL,
    repository TEXT NOT NULL,
    revision TEXT NOT NULL,
    webTargets TEXT NOT NULL,
    labTargets TEXT NOT NULL,
    allowedActions TEXT NOT NULL,
    restrictions TEXT NOT NULL,
    notes TEXT NOT NULL,
    PRIMARY KEY (panelId, version)
  ) STRICT, WITHOUT ROWID;
`, `
  ALTER TABLE scope_revisions ADD COLUMN labPath TEXT NOT NULL DEFAULT '';
  ALTER TABLE scope_revisions ADD COLUMN repositoryDiscovery TEXT NOT NULL DEFAULT '';
  ALTER TABLE scope_revisions ADD COLUMN repositoryMode TEXT NOT NULL DEFAULT 'known'
    CHECK (repositoryMode IN ('known', 'discover'));
  ALTER TABLE scope_revisions ADD COLUMN accessMode TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (accessMode IN ('read_only', 'read_write', 'unspecified'));
`, `
  CREATE TABLE fixture_runs (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL REFERENCES panels(id),
    model TEXT NOT NULL,
    sessionId TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    detail TEXT NOT NULL,
    lead TEXT,
    tokens INTEGER
  ) STRICT;
  CREATE INDEX fixture_runs_panel ON fixture_runs (panelId, startedAt DESC);
  CREATE UNIQUE INDEX fixture_runs_active ON fixture_runs (panelId) WHERE status = 'running';
`, `
  ALTER TABLE scope_revisions ADD COLUMN targetName TEXT NOT NULL DEFAULT '';
  ALTER TABLE scope_revisions ADD COLUMN workspacePath TEXT NOT NULL DEFAULT '';
`, `
  CREATE TABLE source_reviews (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL,
    scopeVersion INTEGER NOT NULL,
    preview TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    detail TEXT NOT NULL,
    result TEXT,
    FOREIGN KEY (panelId, scopeVersion) REFERENCES scope_revisions (panelId, version)
  ) STRICT;
  CREATE INDEX source_reviews_panel ON source_reviews (panelId, startedAt DESC);
  CREATE UNIQUE INDEX source_reviews_active ON source_reviews (status) WHERE status = 'running';
`, `
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL REFERENCES panels(id),
    kind TEXT NOT NULL CHECK (kind IN ('opencode', 'cline')),
    label TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    scopeVersion INTEGER,
    nativeId TEXT,
    FOREIGN KEY (panelId, scopeVersion) REFERENCES scope_revisions (panelId, version),
    UNIQUE (panelId, id)
  ) STRICT;
  CREATE INDEX agent_sessions_panel ON agent_sessions (panelId, startedAt);
  CREATE TABLE agent_parents (
    panelId TEXT PRIMARY KEY REFERENCES panels(id),
    sessionId TEXT NOT NULL,
    FOREIGN KEY (panelId, sessionId) REFERENCES agent_sessions (panelId, id)
  ) STRICT;
  CREATE TABLE research_runs (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL REFERENCES panels(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX research_runs_panel ON research_runs (panelId);
  CREATE UNIQUE INDEX research_runs_active ON research_runs (panelId) WHERE status = 'running';
`, `
  ALTER TABLE agent_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'terminal'
    CHECK (mode IN ('terminal', 'cline-worker'));
`, `
  ALTER TABLE agent_sessions ADD COLUMN model TEXT;
`, `
  CREATE TABLE lead_reviews (
    panelId TEXT NOT NULL REFERENCES panels(id),
    leadId TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    note TEXT NOT NULL,
    nextAction TEXT NOT NULL,
    savedAt TEXT NOT NULL,
    PRIMARY KEY (panelId, leadId, version)
  ) STRICT, WITHOUT ROWID;
`, `
  CREATE TABLE verification_fixture (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    panelId TEXT NOT NULL REFERENCES panels(id),
    leadId TEXT NOT NULL
  ) STRICT;
  CREATE TABLE verification_runs (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL,
    scopeVersion INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'denied', 'expired', 'stale', 'cancelled',
      'reproduced', 'not_reproduced', 'inconclusive', 'error', 'interrupted')),
    record TEXT NOT NULL,
    FOREIGN KEY (panelId, scopeVersion) REFERENCES scope_revisions (panelId, version)
  ) STRICT;
  CREATE INDEX verification_panel ON verification_runs (panelId);
  CREATE UNIQUE INDEX verification_running ON verification_runs (status) WHERE status = 'running';
`, `
  ALTER TABLE lead_reviews ADD COLUMN tag TEXT
    CHECK (tag IN ('general', 'lead', 'killed_lead', 'finding'));
`, evidenceSchema, `
  CREATE TABLE IF NOT EXISTS repository_checkouts (
    panelId TEXT NOT NULL REFERENCES panels(id), scopeVersion INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(panelId, scopeVersion)
  ) STRICT;
`, `
  ALTER TABLE agent_sessions ADD COLUMN role TEXT CHECK(role IN ('parent','child'));
  CREATE TABLE IF NOT EXISTS agent_records (
    id TEXT PRIMARY KEY, panelId TEXT NOT NULL REFERENCES panels(id),
    scopeVersion INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS agent_records_panel ON agent_records(panelId);
`, `
  -- One running verification per panel, not one for the whole workspace: a test in one panel must not block another.
  DROP INDEX IF EXISTS verification_running;
  CREATE UNIQUE INDEX IF NOT EXISTS verification_running_panel ON verification_runs (panelId) WHERE status = 'running';
`, `
  -- SQLite cannot alter a CHECK constraint, so agent_sessions is rebuilt to accept the Claude Code kind.
  -- agent_parents is its only dependent table; rebuilding it too keeps foreign keys valid without disabling them.
  CREATE TABLE agent_sessions_next (
    id TEXT PRIMARY KEY,
    panelId TEXT NOT NULL REFERENCES panels(id),
    kind TEXT NOT NULL CHECK (kind IN ('opencode', 'cline', 'claude')),
    label TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    scopeVersion INTEGER,
    nativeId TEXT,
    mode TEXT NOT NULL DEFAULT 'terminal' CHECK (mode IN ('terminal', 'cline-worker')),
    model TEXT,
    role TEXT CHECK(role IN ('parent','child')),
    FOREIGN KEY (panelId, scopeVersion) REFERENCES scope_revisions (panelId, version),
    UNIQUE (panelId, id)
  ) STRICT;
  INSERT INTO agent_sessions_next (id, panelId, kind, label, startedAt, scopeVersion, nativeId, mode, model, role)
    SELECT id, panelId, kind, label, startedAt, scopeVersion, nativeId, mode, model, role FROM agent_sessions;
  CREATE TEMP TABLE agent_parents_backup AS SELECT panelId, sessionId FROM agent_parents;
  DROP TABLE agent_parents;
  DROP TABLE agent_sessions;
  ALTER TABLE agent_sessions_next RENAME TO agent_sessions;
  CREATE INDEX agent_sessions_panel ON agent_sessions (panelId, startedAt);
  CREATE TABLE agent_parents (
    panelId TEXT PRIMARY KEY REFERENCES panels(id),
    sessionId TEXT NOT NULL,
    FOREIGN KEY (panelId, sessionId) REFERENCES agent_sessions (panelId, id)
  ) STRICT;
  INSERT INTO agent_parents (panelId, sessionId) SELECT panelId, sessionId FROM agent_parents_backup;
  DROP TABLE agent_parents_backup;
`, `
  ALTER TABLE scope_revisions ADD COLUMN roeReference TEXT NOT NULL DEFAULT '';
`]

// Lead IDs use their immutable run ID and result position, including runs saved before this feature.
const evidenceQuery = `
  WITH candidates AS (
    SELECT panelId, id, json_extract(payload, '$.title') AS title, json_extract(payload, '$.path') AS path,
      json_extract(payload, '$.startLine') AS startLine, json_extract(payload, '$.endLine') AS endLine,
      scopeVersion, createdAt, agent_evidence_kind(payload) AS originalKind FROM evidence_items
  ), reviewed AS (
    SELECT c.*, COALESCE((
      SELECT status FROM lead_reviews WHERE panelId = c.panelId AND leadId IN (SELECT aliasId FROM evidence_links WHERE canonicalId = c.id) ORDER BY savedAt DESC, version DESC LIMIT 1
    ), 'open') AS status, (
      SELECT tag FROM lead_reviews WHERE panelId = c.panelId AND leadId IN (SELECT aliasId FROM evidence_links WHERE canonicalId = c.id) ORDER BY savedAt DESC, version DESC LIMIT 1
    ) AS reviewTag, EXISTS (
      SELECT 1 FROM verification_runs v WHERE v.panelId = c.panelId AND v.status = 'reproduced'
        AND json_extract(v.record, '$.leadId') IN (SELECT aliasId FROM evidence_links WHERE canonicalId = c.id) AND json_type(v.record, '$.finding') = 'object'
    ) AS hasAcceptedFinding
    FROM candidates c
  )
  SELECT c.panelId, c.id, c.title, c.path, c.startLine, c.endLine, c.scopeVersion, c.createdAt, c.status,
    c.hasAcceptedFinding,
    CASE WHEN c.status = 'closed' THEN 'killed_lead' WHEN c.reviewTag IS NOT NULL THEN c.reviewTag
      WHEN c.hasAcceptedFinding THEN 'finding' ELSE c.originalKind END AS tag
  FROM reviewed c
`

const panelQuery = `
  SELECT p.*, COALESCE(
    (SELECT MAX(s.version) FROM scope_revisions s WHERE s.panelId = p.id), 0
  ) AS scopeVersion, (
    SELECT s.repositoryMode FROM scope_revisions s
    WHERE s.panelId = p.id ORDER BY s.version DESC LIMIT 1
  ) AS repositoryMode
  FROM panels p
`

export class StoreError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function transaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function openStore(filename: string) {
  const database = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true })
  const scopeListeners = new Set<(panelId: string, version: number) => void>()
  database.function('agent_evidence_kind', { deterministic: true }, (json) => {
    try { return classifyAgentEvidence(typeof json === 'string' ? JSON.parse(json) : null).kind }
    catch { return 'general' }
  })
  try {
    database.exec('PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL; PRAGMA trusted_schema = OFF;')

    transaction(database, () => {
      const version = Number(database.prepare('PRAGMA user_version').get()?.user_version)
      if (version > migrations.length) {
        throw new Error('The workspace was created by a newer version of Kraflr.')
      }
      for (const [index, migration] of migrations.entries()) {
        if (index >= version) database.exec(migration)
      }
      database.exec(`PRAGMA user_version = ${migrations.length}`)
    })
  } catch (error) {
    database.close()
    throw error
  }

  const evidence = evidenceStore(database)
  const list = database.prepare(`${panelQuery} ORDER BY p.updatedAt DESC, p.id ASC`)
  const get = database.prepare(`${panelQuery} WHERE p.id = ?`)
  const history = database.prepare(`
    SELECT version, savedAt, targetName, repository, revision, webTargets, labTargets,
           labPath, workspacePath, repositoryDiscovery, repositoryMode, accessMode,
           allowedActions, restrictions, notes, roeReference
    FROM scope_revisions WHERE panelId = ? ORDER BY version DESC
  `)
  const create = database.prepare('INSERT INTO panels VALUES (?, ?, ?, ?, ?)')
  const insertScope = database.prepare(`
    INSERT INTO scope_revisions (
      panelId, version, savedAt, repository, revision, webTargets,
      labTargets, allowedActions, restrictions, notes,
      labPath, repositoryDiscovery, repositoryMode, accessMode, targetName, workspacePath, roeReference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const touch = database.prepare('UPDATE panels SET updatedAt = ? WHERE id = ?')
  const lastFixture = database.prepare(`
    SELECT * FROM fixture_runs WHERE panelId = ? ORDER BY startedAt DESC, rowid DESC LIMIT 1
  `)
  const startFixture = database.prepare(`
    INSERT OR IGNORE INTO fixture_runs (id, panelId, model, status, startedAt, detail)
    VALUES (?, ?, ?, 'running', ?, 'Creating a dedicated OpenCode session.')
  `)
  const recordSession = database.prepare(`
    UPDATE fixture_runs SET sessionId = ?, detail = 'Waiting for OpenCode to review the fixture.'
    WHERE id = ? AND status = 'running'
  `)
  const finishFixture = database.prepare(`
    UPDATE fixture_runs SET status = ?, finishedAt = ?, detail = ?, lead = ?, tokens = ?
    WHERE id = ? AND status = 'running'
  `)
  const expireFixture = database.prepare(`
    UPDATE fixture_runs SET status = 'interrupted', finishedAt = ?,
      detail = 'Kraflr lost contact with this run. Check OpenCode for its session state.'
    WHERE panelId = ? AND status = 'running' AND startedAt < ?
  `)
  const sourceReviews = database.prepare(`
    SELECT preview, status, startedAt, finishedAt, detail, result
    FROM source_reviews WHERE panelId = ? ORDER BY startedAt DESC, rowid DESC LIMIT 25
  `)
  const sourceReview = database.prepare(`
    SELECT preview, status, startedAt, finishedAt, detail, result FROM source_reviews WHERE panelId = ? AND id = ?
  `)
  const startSourceReview = database.prepare(`
    INSERT OR IGNORE INTO source_reviews (id, panelId, scopeVersion, preview, status, startedAt, detail)
    VALUES (?, ?, ?, ?, 'running', ?, 'Starting a private OpenCode review.')
  `)
  const resolveSourceReview = database.prepare(`
    UPDATE source_reviews SET status = ?, finishedAt = ?, detail = ?, result = ? WHERE id = ? AND status = 'running'
  `)
  const expireSourceReviews = database.prepare(`
    UPDATE source_reviews SET status = 'interrupted', finishedAt = ?,
      detail = 'Kraflr lost contact with this source review.'
    WHERE status = 'running' AND startedAt < ?
  `)
  const savedAgents = database.prepare('SELECT * FROM agent_sessions ORDER BY startedAt ASC, rowid ASC')
  const savedAgent = database.prepare('SELECT * FROM agent_sessions WHERE panelId = ? AND id = ?')
  const saveAgent = database.prepare(`
    INSERT INTO agent_sessions (id, panelId, kind, label, startedAt, scopeVersion, nativeId, mode, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const saveNative = database.prepare('UPDATE agent_sessions SET nativeId = ? WHERE id = ?')
  const saveWorkerModel = database.prepare("UPDATE agent_sessions SET model = ? WHERE panelId = ? AND id = ? AND (kind = 'opencode' OR mode = 'cline-worker')")
  const parents = database.prepare('SELECT panelId, sessionId FROM agent_parents')
  const findParent = database.prepare('SELECT sessionId FROM agent_parents WHERE panelId = ?')
  const defaultParent = database.prepare('INSERT OR IGNORE INTO agent_parents (panelId, sessionId) VALUES (?, ?)')
  const setParent = database.prepare(`
    INSERT INTO agent_parents (panelId, sessionId) VALUES (?, ?)
    ON CONFLICT (panelId) DO UPDATE SET sessionId = excluded.sessionId
  `)
  const listRuns = database.prepare(`SELECT record FROM (
    SELECT record,rowid AS sequence,json_extract(record,'$.startedAt') AS startedAt FROM research_runs WHERE panelId = ?
    UNION ALL SELECT record,rowid AS sequence,json_extract(record,'$.startedAt') AS startedAt FROM agent_records WHERE panelId = ?
  ) ORDER BY startedAt DESC,sequence DESC LIMIT 50`)
  const getRun = database.prepare('SELECT record FROM research_runs WHERE panelId = ? AND id = ? UNION ALL SELECT record FROM agent_records WHERE panelId = ? AND id = ? LIMIT 1')
  const runningRuns = database.prepare("SELECT record FROM research_runs WHERE status = 'running'")
  const addRun = database.prepare("INSERT OR IGNORE INTO research_runs (id, panelId, status, record) VALUES (?, ?, 'running', ?)")
  const saveRun = database.prepare("UPDATE research_runs SET status = ?, record = ? WHERE id = ? AND status = 'running'")
  const leadPage = database.prepare(`SELECT * FROM (${evidenceQuery})
    WHERE panelId = ? AND (? IS NULL OR tag = ?) ORDER BY createdAt DESC, id ASC LIMIT 26 OFFSET ?`)
  const leadTags = database.prepare(`SELECT tag, count(*) AS total FROM (${evidenceQuery}) WHERE panelId = ? GROUP BY tag`)
  const evidenceTag = database.prepare(`SELECT tag, hasAcceptedFinding FROM (${evidenceQuery}) WHERE panelId = ? AND id = ?`)
  const openLeadBrief = database.prepare(`SELECT * FROM (${evidenceQuery})
    WHERE panelId = ? AND tag = 'lead' ORDER BY createdAt DESC, id ASC LIMIT 8`)
  const countLeads = database.prepare(`
    SELECT e.panelId, count(*) FILTER (WHERE e.tag <> 'general') AS total,
      count(*) FILTER (WHERE e.tag = 'killed_lead') AS closed,
      count(*) FILTER (WHERE e.tag = 'finding') AS findings
    FROM (${evidenceQuery}) e GROUP BY e.panelId
  `)
  const repositorySuggestion = database.prepare(`
    SELECT record FROM (
      SELECT record,panelId,status,rowid AS priority FROM research_runs
      UNION ALL SELECT record,panelId,status,rowid AS priority FROM agent_records
    ) WHERE panelId = ? AND status = 'completed'
      AND json_extract(record, '$.scopeVersion') = ? AND json_type(record, '$.repositorySuggestion') = 'object'
    ORDER BY json_extract(record, '$.startedAt') DESC, priority DESC LIMIT 1
  `)
  const leadReviews = database.prepare(`
    SELECT version, status, note, nextAction, savedAt, tag FROM lead_reviews
    WHERE panelId = ? AND leadId IN (SELECT aliasId FROM evidence_links WHERE canonicalId = ?) ORDER BY savedAt DESC, version DESC LIMIT 25
  `)
  const insertLeadReview = database.prepare('INSERT INTO lead_reviews (panelId, leadId, version, status, note, nextAction, savedAt, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const recentLeadReviews = database.prepare(`
    SELECT leadId, status, note, nextAction, savedAt, tag FROM lead_reviews
    WHERE panelId = ? ORDER BY savedAt DESC, version DESC LIMIT 8
  `)
  const getFixture = database.prepare('SELECT panelId, leadId FROM verification_fixture WHERE singleton = 1')
  const addFixture = database.prepare('INSERT INTO verification_fixture VALUES (1, ?, ?)')
  const listTests = database.prepare('SELECT record FROM verification_runs WHERE panelId = ? ORDER BY rowid DESC LIMIT 30')
  const leadTests = database.prepare("SELECT record FROM verification_runs WHERE panelId = ? AND json_extract(record, '$.leadId') IN (SELECT aliasId FROM evidence_links WHERE canonicalId = ?) ORDER BY rowid DESC LIMIT 30")
  const leadPreparation = database.prepare("SELECT record FROM research_runs WHERE panelId = ? AND json_extract(record, '$.purpose') = 'verification' AND json_extract(record, '$.leadId') IN (SELECT aliasId FROM evidence_links WHERE canonicalId = ?) ORDER BY rowid DESC LIMIT 1")
  const allTests = database.prepare('SELECT record FROM verification_runs ORDER BY rowid DESC LIMIT 26 OFFSET ?')
  const getTest = database.prepare('SELECT record FROM verification_runs WHERE panelId = ? AND id = ?')
  const addTest = database.prepare(`
    INSERT OR IGNORE INTO verification_runs (id, panelId, scopeVersion, status, record) VALUES (?, ?, ?, 'pending', ?)
  `)
  const changeTest = database.prepare(`
    UPDATE OR IGNORE verification_runs SET status = ?, record = ? WHERE id = ? AND status = ?
  `)
  const runningTests = database.prepare("SELECT record FROM verification_runs WHERE status = 'running'")
  const cleanupTests = database.prepare(`SELECT record FROM verification_runs
    WHERE json_extract(record, '$.cleanupPending') = 1
      OR (status = 'interrupted' AND json_type(record, '$.cleanupPending') IS NULL)`)

  function readRun(row: unknown): ResearchRun {
    const run = JSON.parse((row as { record: string }).record) as ResearchRun
    if (run.fullReply) {
      const recovered = decodeReport(run.fullReply)
      if (recovered.structured) {
        if (!run.reply || looksLikeReport(run.reply)) run.reply = recovered.reply
        if (!run.summary || looksLikeReport(run.summary)) run.summary = recovered.summary
        if (run.reportWarning) { delete run.reportWarning; run.reportRecovered = true }
      }
    }
    return run
  }

  function readVerification(row: unknown): VerificationRecord {
    const record = JSON.parse((row as { record: string }).record) as VerificationRecord
    return { ...record, leadId: evidence.resolve(record.panelId, record.leadId) }
  }

  function readTest(panelId: string, id: string) {
    const row = getTest.get(panelId, id)
    if (!row) throw new StoreError(404, 'Verification plan not found in this panel.')
    return readVerification(row)
  }

  function fixture() {
    return getFixture.get() as { panelId: string; leadId: string } | undefined
  }

  function currentVerification(record: VerificationRecord): VerificationRecord {
    if (record.status !== 'pending') return record
    if (record.scopeVersion !== readPanel(record.panelId).scopeVersion) return { ...record, status: 'stale' }
    if (Date.parse(record.expiresAt) <= Date.now()) return { ...record, status: 'expired' }
    return record
  }

  function writeScope(id: string, version: number, now: string, scope: ScopeInput) {
    insertScope.run(id, version, now, scope.repository, scope.revision,
      scope.webTargets, scope.labTargets, scope.allowedActions, scope.restrictions, scope.notes,
      scope.labPath, scope.repositoryDiscovery, scope.repositoryMode, scope.accessMode,
      scope.targetName, scope.workspacePath, scope.roeReference)
  }

  function readPanel(id: string): PanelDetail {
    const panel = get.get(id) as unknown as Panel | undefined
    if (!panel) throw new StoreError(404, 'Research panel not found.')
    const scopeHistory = history.all(id) as unknown as ScopeRevision[]
    const binding = database.prepare('SELECT record FROM repository_checkouts WHERE panelId = ? AND scopeVersion = ?').get(id, scopeHistory[0]?.version ?? 0)
    const checkout = binding ? JSON.parse(String(binding.record)) as RepositoryCheckout : undefined
    if (scopeHistory[0] && checkout) scopeHistory[0] = { ...scopeHistory[0], checkoutPath: checkout.path, resolvedCommit: checkout.commit }
    return { ...panel, scopeVersion: scopeHistory[0]?.version ?? 0, scopeHistory, ...(checkout && { checkout }) }
  }

  function latestFixtureRun(panelId: string): FixtureRun | null {
    const row = lastFixture.get(panelId) as (Omit<FixtureRun, 'lead'> & { lead: string | null }) | undefined
    if (!row) return null
    if (row.status === 'running' && Date.parse(row.startedAt) < Date.now() - 95_000) {
      return {
        ...row, status: 'interrupted', lead: null,
        detail: 'Kraflr lost contact with this run. Check OpenCode for its session state.',
      }
    }
    return { ...row, lead: row.lead ? JSON.parse(row.lead) as FixtureLead : null }
  }

  function readSourceScope(panelId: string, expectedVersion: number) {
    const panel = readPanel(panelId)
    const scope = panel.scopeHistory[0]
    // Any saved research scope with an explicit access mode (a source review or a web test) authorizes agent work; what each type may touch differs.
    if (!scope || scope.accessMode === 'unspecified') {
      throw new StoreError(409, 'Save an authorized research scope with an explicit access mode.')
    }
    if (scope.version !== expectedVersion) throw new StoreError(409, 'The scope changed. Preview the excerpt again.')
    return panel.checkout ? { ...scope, checkoutPath: panel.checkout.path, resolvedCommit: panel.checkout.commit } : scope
  }

  function sourceRun(row: unknown): SourceReviewRun {
    const { preview, result, ...run } = row as Pick<SourceReviewRun, 'status' | 'startedAt' | 'finishedAt' | 'detail'>
      & { preview: string; result: string | null }
    return { ...JSON.parse(preview) as SourcePreview, ...run,
      result: result ? JSON.parse(result) as SourceReviewResult : null }
  }

  function readEvidence(panelId: string, id: string): EvidenceLead {
    const saved = evidence.read(panelId, id)
    if (!saved) throw new StoreError(404, 'Evidence record not found in this panel.')
    id = saved.id
    const reviews = leadReviews.all(panelId, id) as unknown as LeadReview[]
    const maximum = Number(database.prepare('SELECT MAX(version) AS version FROM lead_reviews WHERE panelId = ? AND leadId IN (SELECT aliasId FROM evidence_links WHERE canonicalId = ?)').get(panelId, id)?.version ?? 0)
    if (reviews[0]) reviews[0] = { ...reviews[0], version: maximum }
    const status = reviews[0]?.status ?? 'open'
    const verificationResults = leadTests.all(panelId, id).map(readVerification).map(currentVerification)
    const classification = evidenceTag.get(panelId, id) as { tag: EvidenceTag; hasAcceptedFinding: number } | undefined
    if (!classification) throw new StoreError(404, 'Evidence record not found in this panel.')
    const { tag } = classification
    const hasAcceptedFinding = Boolean(classification.hasAcceptedFinding)
    const createdAt = String(database.prepare('SELECT createdAt FROM evidence_items WHERE id = ?').get(id)!.createdAt)
    const lead:EvidenceLead={ ...saved.data, id, status, tag, hasAcceptedFinding, reviews, verificationResults, createdAt }
    const preparation=leadPreparation.get(panelId,id)
    lead.verificationProgress=leadVerification(lead,readPanel(panelId).scopeVersion,preparation?readRun(preparation):undefined)
    return lead
  }

  function expireReviewRuns() {
    const now = Date.now()
    expireSourceReviews.run(new Date(now).toISOString(), new Date(now - 150_000).toISOString())
  }

  transaction(database, () => {
    const entries = [
      ...database.prepare("SELECT record FROM research_runs WHERE status <> 'running'").all().map((row) => {
        const run = readRun(row); return { at: run.startedAt, apply: () => evidence.research(run) }
      }),
      ...database.prepare("SELECT * FROM source_reviews WHERE status = 'completed'").all().map((row) => {
        const run = sourceRun(row); return { at: run.startedAt, apply: () => evidence.source(String(row.panelId), run) }
      }),
    ].sort((a, b) => a.at.localeCompare(b.at))
    for (const entry of entries) entry.apply()
    evidence.reconcile()
  })

  return {
    close: () => { scopeListeners.clear(); database.close() },
    onScopeChanged(listener: (panelId: string, version: number) => void) {
      scopeListeners.add(listener)
      return () => { scopeListeners.delete(listener) }
    },
    listPanels: () => list.all() as unknown as Panel[],
    readPanel,
    saveCheckout(checkout: RepositoryCheckout) {
      return transaction(database, () => {
        const scope = readSourceScope(checkout.panelId, checkout.scopeVersion)
        if (scope.repository !== checkout.repository) throw new StoreError(409, 'The repository scope changed during checkout.')
        const existing = readPanel(checkout.panelId).checkout
        if (existing && (existing.path !== checkout.path || existing.commit !== checkout.commit)) throw new StoreError(409, 'This scope already has a pinned checkout. Save a new scope to change the source.')
        database.prepare('INSERT OR IGNORE INTO repository_checkouts VALUES (?, ?, ?)').run(checkout.panelId, checkout.scopeVersion, JSON.stringify(checkout))
        return readPanel(checkout.panelId)
      })
    },
    verificationFixture: fixture,
    setupVerificationFixture(scope: ScopeInput, lead: ResearchRun['leads'][number]) {
      return transaction(database, () => {
        const existing = fixture()
        if (existing) return readPanel(existing.panelId)
        const panelId = randomUUID()
        const now = new Date().toISOString()
        create.run(panelId, 'Verification fixture', 'source', now, now)
        writeScope(panelId, 1, now, scope)
        const run: ResearchRun = {
          id: randomUUID(), panelId, parentId: '', parentName: 'Bundled verification fixture',
          scopeVersion: 1, objective: 'Check whether one synthetic account can retrieve another account’s export.',
          status: 'completed', phase: 'Baseline candidate saved', startedAt: now, endedAt: now,
          summary: 'The fixture has a vulnerable version and a patched version for comparison.',
          tasks: [], leads: [lead], deadEnds: [], nextSteps: ['Run the isolated export ownership probe.'],
        }
        addRun.run(run.id, panelId, JSON.stringify({ ...run, status: 'running' }))
        saveRun.run(run.status, JSON.stringify(run), run.id)
        evidence.research(run)
        addFixture.run(panelId, `${run.id}:0`)
        return readPanel(panelId)
      })
    },
    listVerification(panelId: string, leadId?: string) {
      readPanel(panelId)
      if (leadId) leadId = readEvidence(panelId, leadId).id
      const rows = leadId ? leadTests.all(panelId, leadId) : listTests.all(panelId)
      const records = rows.map(readVerification).map(currentVerification)
      const lab = fixture()
      const fixtureLeadId = lab?.panelId === panelId ? lab.leadId : null
      const target = leadId || fixtureLeadId
      return { leadId: fixtureLeadId, canRequest: Boolean(target && readEvidence(panelId,target).verificationProgress?.canVerify), records }
    },
    verificationQueue(offset: number) {
      const records = allTests.all(offset).map(readVerification)
      return { records: records.slice(0, 25).map(currentVerification), more: records.length > 25 }
    },
    readTest,
    addVerification(record: VerificationRecord, replacePrepared=false) {
      return transaction(database, () => {
        readSourceScope(record.panelId, record.scopeVersion)
        const lead=readEvidence(record.panelId,record.leadId)
        record.leadId=lead.id
        record.leadReviewVersion=lead.reviews[0]?.version??0
        if(replacePrepared){
          if(!isOpenLead(lead)||lead.verificationProgress?.state==='verified')throw new StoreError(409,'This lead cannot queue another prepared test. Review its saved result or reopen it explicitly.')
          const current=leadTests.all(record.panelId,lead.id).map(readVerification).map(currentVerification)
          if(current.some(test=>test.status==='running'||test.cleanupPending))throw new StoreError(409,'Finish the running test and confirm cleanup before submitting a repaired plan.')
          const existing=current.find(test=>test.status==='pending'&&test.planHash===record.planHash&&test.scopeVersion===record.scopeVersion)
          if(existing)return existing
          for(const previous of current.filter(test=>test.status==='pending')){
            previous.status='stale';previous.finishedAt=new Date().toISOString();previous.detail='Replaced by a newly prepared plan. The replacement needs its own approval.'
            changeTest.run(previous.status,JSON.stringify(previous),previous.id,'pending')
          }
        }
        if (!addTest.run(record.id, record.panelId, record.scopeVersion, JSON.stringify(record)).changes) {
          throw new StoreError(409, 'This verification request already exists.')
        }
        return record
      })
    },
    resolveVerification(panelId: string, id: string, planHash: string, decision: 'approve' | 'deny' | 'cancel', note: string, saveFindingOnSuccess=false, agent?: { executor: 'parent' | 'child'; lease: VerificationLease }) {
      return transaction(database, () => {
        const record = readTest(panelId, id)
        if (record.planHash !== planHash || record.status !== 'pending') throw new StoreError(409, 'This plan was already decided or has changed.')
        if (decision !== 'cancel') {
          readSourceScope(panelId, record.scopeVersion)
          if (Date.parse(record.expiresAt) <= Date.now()) throw new StoreError(409, 'This plan expired. Queue a new verification plan.')
          record.decision = { choice: decision, at: new Date().toISOString(), note, ...(decision==='approve'&&saveFindingOnSuccess?{saveFindingOnSuccess:true}:{}) }
          if(decision==='approve'){
            record.leadReviewVersion=readEvidence(panelId,record.leadId).reviews[0]?.version??0
            record.executor=agent?.executor??'kraflr'
            if(agent)record.lease=agent.lease
          }
        }
        record.status = decision === 'approve' ? 'running' : decision === 'deny' ? 'denied' : 'cancelled'
        if (record.status !== 'running') record.finishedAt = new Date().toISOString()
        if (!changeTest.run(record.status, JSON.stringify(record), id, 'pending').changes) {
          throw new StoreError(409, 'Another verification is already running.')
        }
        return record
      })
    },
    finishVerification(record: VerificationRecord) {
      return transaction(database,()=>{
        const approved=readTest(record.panelId,record.id)
        if(approved.status!=='running')return
        delete record.finding
        const observation=record.observation
        const confirmed=observation&&('kind' in observation?observation.outcome==='reproduced'&&observation.controlPassed:observation.ownerStatus===200&&observation.ownerRecordReturned&&observation.foreignStatus===200&&observation.foreignRecordReturned)
        const lead=readEvidence(record.panelId,record.leadId)
        if(approved.decision?.saveFindingOnSuccess&&record.status==='reproduced'&&confirmed&&!record.cleanupPending&&readPanel(record.panelId).scopeVersion===record.scopeVersion&&isOpenLead(lead)&&(lead.reviews[0]?.version??0)===(approved.leadReviewVersion??0)){
          record.finding={note:('Researcher approved this exact test and authorized saving a Finding only if reproduction and its control passed. '+(approved.decision.note||'')).slice(0,1200),acceptedAt:new Date().toISOString(),acceptance:'conditional'}
        }
        // An agent that ran the approved test also marks the lead: the approval authorized it. A hypothesis that did not
        // reproduce with a passing control is killed, with the agent's own summary as the recorded reason.
        const project=observation&&'kind' in observation?observation:undefined
        if(project&&isAgentExecutor(approved.executor)&&approved.decision?.saveFindingOnSuccess&&record.status==='not_reproduced'&&project.controlPassed&&readPanel(record.panelId).scopeVersion===record.scopeVersion&&isOpenLead(lead)&&(lead.reviews[0]?.version??0)===(approved.leadReviewVersion??0)){
          const who=approved.lease?.agentLabel??'The agent'
          record.killedLead={note:`${who} ran the approved test: the hypothesis did not reproduce and the control passed. ${project.summary}`.slice(0,1200),killedAt:new Date().toISOString()}
        }
        if(changeTest.run(record.status,JSON.stringify(record),record.id,'running').changes){
          if(record.finding)insertLeadReview.run(record.panelId,lead.id,(lead.reviews[0]?.version??0)+1,'open',record.finding.note,lead.reviews[0]?.nextAction??'',record.finding.acceptedAt,'finding')
          else if(record.killedLead)insertLeadReview.run(record.panelId,lead.id,(lead.reviews[0]?.version??0)+1,'closed',record.killedLead.note,'',record.killedLead.killedAt,'killed_lead')
        }
      })
    },
    /** The researcher closes an unfinished or failed test. The agent has to ask for a fresh approval before it can run anything again. */
    dismissVerification(panelId: string, id: string, note: string) {
      return transaction(database, () => {
        const record = readTest(panelId, id)
        if (!['error', 'interrupted', 'inconclusive'].includes(record.status)) throw new StoreError(409, 'Only a failed or inconclusive test can be cancelled this way.')
        const previous = record.status
        record.status = 'cancelled'
        record.detail = note
        record.finishedAt = new Date().toISOString()
        delete record.lease
        changeTest.run(record.status, JSON.stringify(record), id, previous)
        return record
      })
    },
    /** Hand a running test to another agent, for example after its first agent hit a usage limit. The lease clock keeps running. */
    reassignVerificationLease(panelId: string, id: string, lease: VerificationLease, executor: 'parent' | 'child') {
      return transaction(database, () => {
        const record = readTest(panelId, id)
        if (record.status !== 'running' || !isAgentExecutor(record.executor)) throw new StoreError(409, 'This test is not waiting for an agent.')
        record.lease = lease
        record.executor = executor
        changeTest.run(record.status, JSON.stringify(record), id, 'running')
        return record
      })
    },
    interruptVerification() {
      return transaction(database, () => runningTests.all().map(readVerification).map((record) => {
        record.status = 'interrupted'
        // Only Kraflr's own runner leaves a container behind to clean up; an agent-run test never had one.
        record.cleanupPending = !isAgentExecutor(record.executor)
        record.detail = 'Kraflr stopped before a result was recorded. A new plan requires a fresh approval.'
        record.finishedAt = new Date().toISOString()
        changeTest.run(record.status, JSON.stringify(record), record.id, 'running')
        return record.id
      }))
    },
    pendingVerificationCleanup: () => cleanupTests.all().map(readVerification),
    recordVerificationCleanup(panelId: string, id: string, complete: boolean) {
      const record = readTest(panelId, id)
      const previous = record.status
      record.cleanupPending = !complete
      if (!complete) record.status = 'error'
      record.detail = complete
        ? previous === 'interrupted'
          ? 'The previous test was interrupted. Container cleanup is confirmed; request a fresh plan.'
          : 'Container cleanup is now confirmed. Request a fresh approval to try this test again.'
        : 'Container cleanup is unconfirmed. New verification runs are blocked until Docker confirms the container is gone; Kraflr retries automatically.'
      changeTest.run(record.status, JSON.stringify(record), id, previous)
      return record
    },
    acceptVerificationFinding(panelId: string, id: string, note: string) {
      return transaction(database, () => {
        const record = readTest(panelId, id)
        if (record.status !== 'reproduced') throw new StoreError(409, 'A reproduced result is required to accept a finding.')
        if (record.finding) throw new StoreError(409, 'This result already has an accepted finding.')
        record.finding = { note, acceptedAt: new Date().toISOString() }
        changeTest.run(record.status, JSON.stringify(record), id, 'reproduced')
        const lead = readEvidence(panelId, record.leadId)
        const latest = lead.reviews[0]
        insertLeadReview.run(panelId, lead.id, (latest?.version ?? 0) + 1, 'open', note, latest?.nextAction ?? '',
          record.finding.acceptedAt, 'finding')
        return record
      })
    },
    listEvidence(panelId: string, offset: number, tag?: EvidenceTag) {
      readPanel(panelId)
      const rows = leadPage.all(panelId, tag ?? null, tag ?? null, offset) as unknown as EvidenceSummary[]
      const counts: Record<EvidenceTag, number> = { general: 0, lead: 0, killed_lead: 0, finding: 0 }
      for (const row of leadTags.all(panelId) as unknown as { tag: EvidenceTag; total: number }[]) counts[row.tag] = row.total
      return { leads: rows.slice(0, 25).map(row=>({...row,verificationProgress:readEvidence(panelId,row.id).verificationProgress})), more: rows.length > 25, counts }
    },
    openLeadsForBrief(panelId: string) {
      return openLeadBrief.all(panelId) as unknown as EvidenceSummary[]
    },
    recentLeadDecisions(panelId: string) {
      return recentLeadReviews.all(panelId) as unknown as (Pick<LeadReview, 'status' | 'tag' | 'note' | 'nextAction' | 'savedAt'> & { leadId: string })[]
    },
    countLeads: () => countLeads.all() as unknown as LeadCounts[],
    activeResearch(): ActiveResearch[] {
      return runningRuns.all().map(readRun).map(({ panelId, parentId, objective, phase, tasks }) => ({
        panelId, parentId, objective, phase,
        assignments: tasks.map(({ sessionId, objective, status }) => ({ sessionId, objective, status })),
      }))
    },
    latestRepositorySuggestion(panelId: string): SavedRepositorySuggestion | null {
      const panel = readPanel(panelId)
      if (panel.repositoryMode !== 'discover') return null
      const row = repositorySuggestion.get(panelId, panel.scopeVersion)
      if (!row) return null
      const run = readRun(row)
      return run.repositorySuggestion ? {
        ...run.repositorySuggestion, runId: run.id, scopeVersion: run.scopeVersion, parentName: run.parentName,
      } : null
    },
    readEvidence,
    saveLeadReview(panelId: string, id: string, input: SaveLeadReview) {
      const note = input.note.trim()
      const nextAction = input.nextAction.trim()
      if (input.status === 'closed' && !note) throw new StoreError(400, 'Record why you are killing this lead.')
      return transaction(database, () => {
        const lead = readEvidence(panelId, id)
        const latest = lead.reviews[0]
        const version = latest?.version ?? 0
        const tag = input.tag ?? (input.status === 'closed' ? 'killed_lead'
          : latest?.status === 'closed' ? 'lead' : lead.tag)
        if (tag && ((tag === 'killed_lead') !== (input.status === 'closed'))) {
          throw new StoreError(400, 'The evidence tag and lead state do not match.')
        }
        if (tag === 'finding' && !lead.hasAcceptedFinding) {
          // The researcher is the only gate. A Finding needs no Docker verification: the evidence they record and their acceptance make it one.
          if (!note) throw new StoreError(400, 'Record the evidence that confirms this Finding and how you confirmed it.')
        }
        if (lead.tag === 'finding' && tag !== 'finding' && !note) {
          throw new StoreError(400, 'Record your reason for changing a confirmed finding.')
        }
        if (latest?.status === input.status && latest.note === note && latest.nextAction === nextAction && (latest.tag ?? null) === tag) return lead
        if (version !== input.expectedVersion) throw new StoreError(409, 'This lead changed in another tab. Reload it before saving.')
        insertLeadReview.run(panelId, lead.id, version + 1, input.status, note, nextAction, new Date().toISOString(), tag)
        return readEvidence(panelId, id)
      })
    },
    listSavedAgents: () => savedAgents.all() as unknown as SavedAgentSession[],
    listAgentParents: () => parents.all() as unknown as { panelId: string; sessionId: string }[],
    findSavedAgent(panelId: string, id: string) {
      return savedAgent.get(panelId, id) as unknown as SavedAgentSession | undefined
    },
    agentParent(panelId: string) {
      return findParent.get(panelId)?.sessionId as string | undefined
    },
    saveAgentSession(session: SavedAgentSession) {
      transaction(database, () => {
        saveAgent.run(session.id, session.panelId, session.kind, session.label,
          session.startedAt, session.scopeVersion, session.nativeId, session.mode,session.role??null)
        if(session.role==='parent'){
          database.prepare("UPDATE agent_sessions SET role='child' WHERE panelId=? AND id<>? AND role='parent'").run(session.panelId,session.id)
          setParent.run(session.panelId,session.id)
        }else if (session.role!=='child'&&((session.kind === 'opencode' && session.nativeId) || session.mode === 'cline-worker' || session.nativeId?.startsWith('pty:'))) defaultParent.run(session.panelId, session.id)
      })
    },
    saveAgentNativeId(panelId: string, id: string, nativeId: string) {
      transaction(database, () => {
        const session = savedAgent.get(panelId, id)
        if (!session) throw new StoreError(404, 'Agent session not found.')
        saveNative.run(nativeId, id)
        if (session.role!=='child'&&(session.kind === 'opencode' || session.mode === 'cline-worker' || nativeId.startsWith('pty:'))) defaultParent.run(panelId, id)
      })
    },
    saveAgentModel(panelId: string, id: string, model: string) {
      if (!saveWorkerModel.run(model, panelId, id).changes) throw new StoreError(404, 'Managed agent session not found.')
    },
    assignAgentParent(panelId: string, id: string) {
      const session = savedAgent.get(panelId, id)
      if (!session || !((session.kind === 'opencode' && session.nativeId) || (session.kind !== 'opencode' && (session.mode === 'cline-worker' || String(session.nativeId ?? '').startsWith('pty:'))))) {
        throw new StoreError(409, 'Choose a managed OpenCode, Cline or Claude Code session as the parent.')
      }
      readSourceScope(panelId, typeof session.scopeVersion === 'number' ? session.scopeVersion : 0)
      setParent.run(panelId, id)
      database.prepare("UPDATE agent_sessions SET role=CASE WHEN id=? THEN 'parent' ELSE 'child' END WHERE panelId=?").run(id,panelId)
    },
    listResearchRuns(panelId: string) {
      readPanel(panelId)
      return listRuns.all(panelId,panelId).map(readRun)
    },
    readResearchRun(panelId: string, id: string) {
      const result = getRun.get(panelId, id,panelId,id)
      if (!result) throw new StoreError(404, 'Research run not found.')
      return readRun(result)
    },
    startResearchRun(run: ResearchRun) {
      if (!addRun.run(run.id, run.panelId, JSON.stringify(run)).changes) {
        throw new StoreError(409, 'This panel already has a research run in progress.')
      }
    },
    saveAgentRecord(run:ResearchRun){
      const panel=readPanel(run.panelId)
      if(panel.scopeVersion!==run.scopeVersion){if(run.status==='running')throw new StoreError(409,'The collaboration scope changed.');run={...run,status:'interrupted',phase:'Scope changed during collaboration.'}}
      if(run.purpose!=='collaboration'&&run.purpose!=='conversation')throw new StoreError(400,'Choose an agent communication record.')
      const changed=database.prepare(`INSERT INTO agent_records(id,panelId,scopeVersion,status,record) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record WHERE agent_records.status='running'`).run(run.id,run.panelId,run.scopeVersion,run.status,JSON.stringify(run))
      if(changed.changes&&run.status==='completed'&&run.purpose==='conversation')evidence.research(run)
    },
    hasAgentRecord(panelId:string,id:string){return Boolean(database.prepare('SELECT id FROM agent_records WHERE panelId=? AND id=?').get(panelId,id))},
    saveResearchRun(run: ResearchRun) {
      return transaction(database, () => {
        const changed = Boolean(saveRun.run(run.status, JSON.stringify(run), run.id).changes)
        if (changed) evidence.research(run)
        return changed
      })
    },
    linkRecoveredVerification(panelId: string, runId: string, verificationId: string) {
      return transaction(database, () => {
        const row = getRun.get(panelId, runId,panelId,runId)
        if (!row) throw new StoreError(404, 'Research run not found.')
        const run = readRun(row)
        if (run.status === 'running' || run.purpose !== 'verification') throw new StoreError(409, 'Finish or stop this preparation before recovering its lab.')
        readSourceScope(panelId, run.scopeVersion)
        const record = readTest(panelId, verificationId)
        if (!run.leadId || record.leadId !== readEvidence(panelId, run.leadId).id || record.scopeVersion !== run.scopeVersion) throw new StoreError(409, 'This verification belongs to another lead or scope.')
        run.verificationId = verificationId
        // Keep the original status, failure phase, timestamps and full report as historical facts.
        database.prepare('UPDATE research_runs SET record = ? WHERE panelId = ? AND id = ? AND status <> ?')
          .run(JSON.stringify(run), panelId, runId, 'running')
        return run
      })
    },
    interruptResearchRuns() {
      for(const row of database.prepare("SELECT record FROM agent_records WHERE status='running'").all()){
        const run=readRun(row);run.status='interrupted';run.phase='Kraflr restarted during this exchange.';run.endedAt=new Date().toISOString();for(const task of run.tasks)if(task.status==='assigned')task.status='interrupted'
        database.prepare("UPDATE agent_records SET status='interrupted',record=? WHERE id=?").run(JSON.stringify(run),run.id)
      }
      for (const row of runningRuns.all()) {
        const run = readRun(row)
        run.status = 'interrupted'
        run.phase = 'Kraflr restarted during this run.'
        run.endedAt = new Date().toISOString()
        for (const task of run.tasks) if (task.status === 'assigned') task.status = 'interrupted'
        saveRun.run(run.status, JSON.stringify(run), run.id)
        evidence.research(run)
      }
    },
    readSourceScope,
    listSourceReviews(panelId: string): SourceReviewRun[] {
      readPanel(panelId)
      expireReviewRuns()
      return sourceReviews.all(panelId).map(sourceRun)
    },
    findSourceReview(panelId: string, id: string): SourceReviewRun | undefined {
      const row = sourceReview.get(panelId, id)
      return row ? sourceRun(row) : undefined
    },
    createSourceReview(panelId: string, preview: SourcePreview): SourceReviewRun {
      return transaction(database, () => {
        readSourceScope(panelId, preview.scopeVersion)
        expireReviewRuns()
        const inserted = startSourceReview.run(
          preview.id, panelId, preview.scopeVersion, JSON.stringify(preview), new Date().toISOString(),
        )
        if (!inserted.changes) throw new StoreError(409, 'Another source review is already running.')
        return sourceRun(sourceReview.get(panelId, preview.id))
      })
    },
    finishSourceReview(id: string, status: Exclude<SourceReviewRun['status'], 'running'>, detail: string,
      result: SourceReviewResult | null = null) {
      transaction(database, () => {
        resolveSourceReview.run(status, new Date().toISOString(), detail, result ? JSON.stringify(result) : null, id)
        const row = database.prepare('SELECT * FROM source_reviews WHERE id = ?').get(id)
        if (row) evidence.source(String(row.panelId), sourceRun(row))
      })
    },
    latestFixtureRun,
    createFixtureRun(panelId: string, model: string): FixtureRun {
      return transaction(database, () => {
        const panel = readPanel(panelId)
        if (panel.type !== 'source') throw new StoreError(400, 'OpenCode fixture reviews run from an open-source panel.')
        expireFixture.run(new Date().toISOString(), panelId, new Date(Date.now() - 95_000).toISOString())
        const id = randomUUID()
        const inserted = startFixture.run(id, panelId, model, new Date().toISOString())
        if (!inserted.changes) throw new StoreError(409, 'A fixture review is already running for this panel.')
        return latestFixtureRun(panelId)!
      })
    },
    recordFixtureSession(id: string, sessionId: string) {
      recordSession.run(sessionId, id)
    },
    finishFixtureRun(id: string, status: Exclude<FixtureRun['status'], 'running'>, detail: string,
      lead: FixtureLead | null = null, tokens: number | null = null) {
      finishFixture.run(status, new Date().toISOString(), detail, lead ? JSON.stringify(lead) : null, tokens, id)
    },
    createPanel(input: CreatePanelInput): PanelDetail {
      const id = randomUUID()
      const now = new Date().toISOString()
      create.run(id, input.name, input.type, now, now)
      return readPanel(id)
    },
    saveScope(id: string, expectedVersion: number, scope: ScopeInput): PanelDetail {
      let changed = false
      const saved = transaction(database, () => {
        const panel = readPanel(id)
        if (panel.type === 'source' && scope.repositoryMode === 'known' && !scope.repository) {
          throw new StoreError(400, 'Open-source review requires a repository and revision.')
        }
        if (panel.type === 'web') {
          // A web test is only ever as wide as what the researcher authorized, so both the targets and the rules they were authorized under are required.
          const { targets, invalid } = parseWebTargets(scope.webTargets)
          if (!targets.length) throw new StoreError(400, 'Enter at least one authorized target: a domain such as app.example.com, a wildcard such as *.example.com, or a URL.')
          if (invalid.length) throw new StoreError(400, `These authorized targets are not valid hosts or URLs: ${invalid.slice(0, 3).join(', ')}.`)
          if (!scope.notes.trim() && !scope.roeReference.trim()) throw new StoreError(400, 'Provide the rules of engagement: write them, link to them, or choose a file.')
          if (scope.repositoryMode !== 'known') throw new StoreError(400, 'Web application testing has no repository discovery.')
        }

        const latest = panel.scopeHistory[0]
        const keys = [...Object.keys(scopeFields), 'repositoryMode', 'accessMode'] as (keyof ScopeInput)[]
        if (latest && keys.every((key) => latest[key] === scope[key])) return panel
        if (panel.scopeVersion !== expectedVersion) {
          throw new StoreError(409, 'The scope changed in another tab. Review the latest revision before saving again.')
        }

        const now = new Date().toISOString()
        writeScope(id, expectedVersion + 1, now, scope)
        touch.run(now, id)
        changed = true
        return readPanel(id)
      })
      if (changed) for (const listener of scopeListeners) listener(id, saved.scopeVersion)
      return saved
    },
  }
}

export type ResearchStore = ReturnType<typeof openStore>
