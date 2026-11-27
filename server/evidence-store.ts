import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ResearchLead, ResearchRun } from '../shared/research-run.ts'
import type { SourceReviewRun } from '../shared/source-review.ts'

export const evidenceSchema = `
  CREATE TABLE IF NOT EXISTS evidence_items (
    id TEXT PRIMARY KEY, panelId TEXT NOT NULL REFERENCES panels(id), scopeVersion INTEGER NOT NULL,
    identity TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    UNIQUE(panelId, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS evidence_identity ON evidence_items(panelId, scopeVersion, identity);
  CREATE TABLE IF NOT EXISTS evidence_links (
    panelId TEXT NOT NULL, aliasId TEXT NOT NULL, canonicalId TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(panelId, aliasId), FOREIGN KEY(panelId, canonicalId) REFERENCES evidence_items(panelId, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS evidence_canonical ON evidence_links(canonicalId);
`

type EvidenceData = ResearchLead & { runId: string; origin: 'research' | 'source'; scopeVersion: number;
  agent: string; objective: string; summary: string; deadEnds: string[]; nextSteps: string[] }
const normalizedTitle=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()
const normalizedPath=(value:string)=>value.replaceAll('\\','/').replace(/^\.\//,'')
function sameOverlappingLead(a:ResearchLead,b:ResearchLead){return a.kind==='lead'&&b.kind==='lead'&&normalizedTitle(a.title)===normalizedTitle(b.title)&&normalizedPath(a.path)===normalizedPath(b.path)&&Math.max(a.startLine,b.startLine)<=Math.min(a.endLine,b.endLine)}

export function evidenceStore(database: DatabaseSync) {
  const alias = database.prepare('SELECT canonicalId FROM evidence_links WHERE panelId = ? AND aliasId = ?')
  const item = database.prepare('SELECT id, payload, scopeVersion, updatedAt FROM evidence_items WHERE panelId = ? AND id = ?')
  const match = database.prepare('SELECT id FROM evidence_items WHERE panelId = ? AND scopeVersion = ? AND identity = ? ORDER BY createdAt, id LIMIT 1')
  const add = database.prepare('INSERT INTO evidence_items VALUES (?, ?, ?, ?, ?, ?, ?)')
  const link = database.prepare('INSERT INTO evidence_links VALUES (?, ?, ?, ?)')
  const edit = database.prepare('UPDATE evidence_items SET identity = ?, payload = ?, updatedAt = ? WHERE panelId = ? AND id = ?')
  const candidates=database.prepare('SELECT id,payload,scopeVersion,updatedAt,identity FROM evidence_items WHERE panelId=? AND scopeVersion=? ORDER BY createdAt,id')
  const protectedItem = database.prepare(`SELECT EXISTS(SELECT 1 FROM verification_runs WHERE panelId = ? AND status = 'reproduced'
    AND json_type(record, '$.finding') = 'object' AND json_extract(record, '$.leadId') IN
      (SELECT aliasId FROM evidence_links WHERE canonicalId = ?)) OR COALESCE((SELECT status FROM lead_reviews
        WHERE panelId = ? AND leadId IN (SELECT aliasId FROM evidence_links WHERE canonicalId = ?)
        ORDER BY savedAt DESC, version DESC LIMIT 1), '') = 'closed' AS accepted`)
  function resolve(panelId: string, id: string) { return (alias.get(panelId, id)?.canonicalId as string | undefined) ?? id }
  function index(panelId: string, nativeId: string, data: EvidenceData, createdAt: string, updatedAt: string) {
    if (alias.get(panelId, nativeId)) return
    const identity = createHash('sha256').update(JSON.stringify([
      data.path.replaceAll('\\', '/').replace(/^\.\//, ''), data.startLine, data.endLine,
      data.title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
    ])).digest('hex')
    const requested = data.id ? item.get(panelId, resolve(panelId, data.id)) : undefined
    const overlaps=candidates.all(panelId,data.scopeVersion).filter(row=>sameOverlappingLead(JSON.parse(String(row.payload)),data))
    const target = requested?.scopeVersion === data.scopeVersion ? requested
      : match.get(panelId, data.scopeVersion, identity)??(overlaps.length===1?overlaps[0]:undefined)
    const id = target?.id as string | undefined ?? nativeId
    const previous = target ? JSON.parse(String(item.get(panelId, id)!.payload)) as ResearchLead : undefined
    if (previous?.kind === 'lead' && previous.security && data.kind !== 'lead') data = { ...data, kind: 'lead', security: previous.security }
    const payload = JSON.stringify({ ...data, id })
    if (!target) add.run(id, panelId, data.scopeVersion, identity, payload, createdAt, updatedAt)
    link.run(panelId, nativeId, id, JSON.stringify(data))
    if (target) {
      const current = item.get(panelId, id)!
      if (updatedAt >= String(current.updatedAt) && !protectedItem.get(panelId, id, panelId, id)?.accepted) edit.run(identity, payload, updatedAt, panelId, id)
    }
  }
  function research(run: ResearchRun) {
    if (run.status === 'running') return
    run.leads.forEach((lead, position) => index(run.panelId, `${run.id}:${position}`, { ...lead, runId: run.id,
      origin: 'research', scopeVersion: run.scopeVersion, agent: run.parentName, objective: run.objective,
      summary: run.summary, deadEnds: run.deadEnds, nextSteps: run.nextSteps }, run.startedAt, run.endedAt ?? run.startedAt))
  }
  function source(panelId: string, run: SourceReviewRun) {
    if (run.status !== 'completed' || !run.result?.lead) return
    const lead = run.result.lead
    index(panelId, `${run.id}:source`, { ...lead, path: run.excerpt.path, commit: run.excerpt.commit,
      evidence: run.excerpt.lines.slice(lead.startLine - run.excerpt.startLine, lead.endLine - run.excerpt.startLine + 1),
      runId: run.id, origin: 'source', scopeVersion: run.scopeVersion, agent: `OpenCode · ${run.model}`,
      objective: run.objective, summary: run.result.summary, deadEnds: [], nextSteps: [] }, run.startedAt, run.finishedAt ?? run.startedAt)
  }
  return { research, source, resolve,
    reconcile(){
      const retained:({id:string;panelId:string;scopeVersion:number;payload:string;updatedAt:string;identity:string})[]=[]
      for(const raw of database.prepare('SELECT id,panelId,scopeVersion,payload,updatedAt,identity FROM evidence_items ORDER BY createdAt,id').all()){
        const row=raw as unknown as typeof retained[number],data=JSON.parse(row.payload) as EvidenceData
        const matches=retained.filter(other=>other.panelId===row.panelId&&other.scopeVersion===row.scopeVersion&&sameOverlappingLead(JSON.parse(other.payload),data))
        if(matches.length!==1){retained.push(row);continue}
        const target=matches[0]!,targetProtected=Boolean(protectedItem.get(target.panelId,target.id,target.panelId,target.id)?.accepted),sourceProtected=Boolean(protectedItem.get(row.panelId,row.id,row.panelId,row.id)?.accepted)
        if(!targetProtected&&(sourceProtected||row.updatedAt>=target.updatedAt)){
          target.payload=JSON.stringify({...data,id:target.id});target.updatedAt=row.updatedAt;target.identity=row.identity
          edit.run(target.identity,target.payload,target.updatedAt,target.panelId,target.id)
        }
        database.prepare('UPDATE evidence_links SET canonicalId=? WHERE panelId=? AND canonicalId=?').run(target.id,row.panelId,row.id)
        database.prepare('DELETE FROM evidence_items WHERE panelId=? AND id=?').run(row.panelId,row.id)
      }
    },
    read(panelId: string, id: string) {
      const row = item.get(panelId, resolve(panelId, id))
      return row ? { id: row.id as string, data: JSON.parse(row.payload as string) as EvidenceData } : undefined
    },
  }
}
