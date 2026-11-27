import { lstat, open, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import type { VerificationRunner } from './verification-runner.ts'
import { verificationHash } from './verification-runner.ts'
import { projectPlan, readProjectVerification } from './project-verification-plan.ts'
import { decodeReport } from '../shared/report-text.ts'
import { isOpenLead } from '../shared/evidence.ts'
import type { ScopeRevision } from '../shared/research.ts'

const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export async function validLabDirectory(scope: ScopeRevision, panelId: string, directory: string) {
  if (!/^lab-[a-f0-9-]{36}$/.test(basename(directory))) return false
  const root = await realpath(scope.workspacePath).catch(() => '')
  if (!root) return false
  let path = root
  for (const part of ['.kraflr', panelId, 'labs', basename(directory)]) {
    path = join(path, part)
    const info = await lstat(path).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) return false
    if (!samePath(await realpath(path).catch(() => ''), path)) return false
  }
  return samePath(path, directory)
}

// Only bounded metadata files are read. Target files and harness contents are never opened here.
async function metadata(directory: string, name: string, limit = 16_000) {
  const path = join(directory, name)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > limit) return ''
  if (!samePath(await realpath(path).catch(() => ''), path)) return ''
  const file = await open(path, 'r').catch(() => null)
  if (!file) return ''
  try {
    if (!(await file.stat()).isFile()) return ''
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return bytesRead <= limit ? buffer.toString('utf8', 0, bytesRead) : ''
  } finally { await file.close() }
}

export async function preparedLabPlan(run: ResearchRun) {
  if (run.labDirectory) {
    if(await lstat(join(run.labDirectory,'kraflr-verification.json')).catch(()=>null)){
      try { return readProjectVerification(JSON.parse(await metadata(run.labDirectory, 'kraflr-verification.json'))) }
      catch { return undefined } // A broken replacement checkpoint must not silently resurrect an old image.
    }
  }
  const report = decodeReport(run.fullReply ?? '').data
  return readProjectVerification(run.labPlan) ?? readProjectVerification(report.verification)
    ?? (Array.isArray(report.leads) ? report.leads.flatMap((item) => item?.id === run.leadId ? [readProjectVerification(item.verification)] : []).find(Boolean) : undefined)
}

export async function preparedLabFiles(directory: string, plan?: ResearchRun['labPlan']) {
  const exists = async (name: string) => /^[a-zA-Z0-9_.-]{1,150}$/.test(name) && await lstat(join(directory, name)).then(info => info.isFile() && !info.isSymbolicLink(), () => false)
  const dockerfile = await metadata(directory, 'Dockerfile', 32_000)
  const candidates = new Set(['run-test', 'run-test.mjs', 'run-test.js', 'run-test.py', 'run-test.sh', 'run-test.php', 'verify.php'])
  for (const arg of plan?.command ?? []) if (/^\/[\w./-]+\.(?:php|mjs|js|py|sh)$/.test(arg)) candidates.add(basename(arg))
  // A COPY source is a filename hint, not executable code or proof that a test passed.
  for (const match of dockerfile.matchAll(/^\s*COPY\s+([\w.-]+\.(?:php|mjs|js|py|sh))\s+\/[\w./-]+\s*$/gm)) {
    if (/verify|test|probe|harness/i.test(match[1]!)) candidates.add(match[1]!)
  }
  return { dockerfileReady: Boolean(dockerfile), harnessReady: (await Promise.all([...candidates].map(exists))).some(Boolean) }
}
export async function latestPreparedLab(store:ResearchStore,panelId:string,leadId:string){
  const panel=store.readPanel(panelId),scope=store.readSourceScope(panelId,panel.scopeVersion),lead=store.readEvidence(panelId,leadId)
  for(const run of store.listResearchRuns(panelId).filter(run=>run.purpose==='verification'&&run.scopeVersion===scope.version&&run.leadId&&store.readEvidence(panelId,run.leadId).id===lead.id)){
    if(!run.labDirectory||!await validLabDirectory(scope,panelId,run.labDirectory))continue
    const input=await preparedLabPlan(run)
    if(input)return{run,input,plan:projectPlan(input,scope)}
  }
}
export async function queuePreparedVerification(store: ResearchStore, inspect: VerificationRunner['available'], run: ResearchRun, signal?: AbortSignal) {
  if (!run.labPlan || !run.leadId) throw new StoreError(422, 'The prepared lab has no valid image and test plan yet. Finish or recover its kraflr-verification.json file.')
  const plan = projectPlan(run.labPlan, store.readSourceScope(run.panelId, run.scopeVersion))
  const available = await inspect(plan)
  signal?.throwIfAborted()
  store.readSourceScope(run.panelId, run.scopeVersion)
  if (!available.ready) throw new StoreError(422, available.detail)
  if (!isOpenLead(store.readEvidence(run.panelId, run.leadId))) throw new StoreError(409, 'The lead is no longer open. A new test cannot be queued.')
  const planHash = verificationHash(plan)
  const now = Date.now()
  return store.addVerification({id:randomUUID(),panelId:run.panelId,leadId:run.leadId,scopeVersion:run.scopeVersion,plan,planHash,status:'pending',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60_000).toISOString()},true)
}
