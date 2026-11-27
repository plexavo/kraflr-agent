import { realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { agentDetails } from '../shared/agent-terminal.ts'
import type { PanelDetail, ScopeRevision } from '../shared/research.ts'
import { randomUUID,createHash } from 'node:crypto'
import{setTimeout as delay}from'node:timers/promises'
import type { RepositorySuggestion, ResearchLead, ResearchRun } from '../shared/research-run.ts'
import type { EvidenceLead } from '../shared/evidence.ts'
import type { AgentTerminals } from './agent-terminals.ts'
import { agentContext } from './agent-context.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import { readPinnedSource } from './pinned-source.ts'
import { projectPlan, readProjectVerification } from './project-verification-plan.ts'
import { verificationHash } from './verification-runner.ts'
import { briefInstructions, researchBrief } from './research-brief.ts'
import { classifyAgentEvidence, securityLeadInstructions } from '../shared/security-lead.ts'
import type { VerificationRunner } from './verification-runner.ts'
import { decodeReport } from '../shared/report-text.ts'
import{terminalWork,type NativeTurn}from'../shared/terminal-team.ts'
import { preparedLabPlan, queuePreparedVerification } from './prepared-verification.ts'
import { buildReport } from './report.ts'

const reportInstructions = [
  'End your reply with one fenced code block tagged kraflr-result containing JSON.',
  'kraflr-result is a literal output-format tag, NOT a callable tool or shell command. Do not invoke it. Kraflr captures the assistant reply and stores valid evidence automatically.',
  'Include summary (string), leads (array), deadEnds (array of strings), and nextSteps (array of strings).',
  'Also include reply: two to four short plain-English sentences answering the researcher, stating uncertainty and the next useful action. Keep it under 1200 characters; do not put JSON or a large technical report in reply.',
  'Whenever you identify a project-specific security hypothesis, include it in leads; do not leave leads only in narrative text. To update an existing lead, include its saved id. Preserve distinct flaws and do not recreate existing leads as new entries.',
  'Each lead must have title, explanation, path (relative to the repository), startLine and endLine.',
  securityLeadInstructions,
  'Treat leads as hypotheses. Use exact references you inspected. Do not invent lines or claim live verification.',
  'When a lead is ready for an isolated container test, you may include verification on that lead with title, image (local sha256 image ID), command (array beginning with absolute container executable), action, expected.',
  'The image must already contain the test and its dependencies. Its org.opencontainers.image.source and org.opencontainers.image.revision labels must match this scope.',
  'The runner uses a non-root user, read-only filesystem, no host mounts, and network none. The test must exit successfully and print one line beginning KRAFLR_VERIFICATION_RESULT followed by JSON with outcome (reproduced, not_reproduced, or inconclusive), controlPassed (boolean), summary, and evidence (string).',
  'A test proposal is for researcher approval. Describe missing lab setup if an image is unavailable.',
].join('\n')

/** What a free research run asks for at the end: a plain answer. Leads are recorded as they are found, so no report format is required. */
const freeReportInstructions = [
  'Record every concrete lead with `kraflr agent lead` as soon as you have it. When you finish, answer in plain English: what you tested, what looks real and what you ruled out.',
  'A fenced kraflr-result JSON block is optional. If you add one, it is only a convenience for leads you have not already recorded.',
].join('\n')

function cleanText(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function publicHttpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 500 || /[\s\\\p{C}]/u.test(value) || !value.startsWith('https://')) return ''
  try {
    const url = new URL(value)
    if (url.username || url.password || url.port || url.search || !/\.[a-z]{2,}$/i.test(url.hostname) ||
        /\.(?:local|internal|localhost)$/i.test(url.hostname)) return ''
    return url.href.length <= 500 ? url.href : ''
  } catch {
    return ''
  }
}

function repositorySuggestion(value: unknown): RepositorySuggestion | undefined {
  if (!value || typeof value !== 'object') return
  const candidate = value as Record<string, unknown>
  const url = publicHttpsUrl(candidate.url)
  const sourceUrl = publicHttpsUrl(candidate.sourceUrl)
  const targetName = cleanText(candidate.targetName, 150)
  const reason = cleanText(candidate.reason, 1200)
  const ref = typeof candidate.revision === 'string' ? candidate.revision.trim() : ''
  const revision = /^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(ref) ? ref : ''
  if (!url || !sourceUrl || !targetName || !reason) return
  const repository = new URL(url)
  const segments = repository.pathname.split('/').filter(Boolean).length
  if (repository.hash || segments < 2 || (['github.com', 'codeberg.org'].includes(repository.hostname) && segments !== 2)) return
  return { url, targetName, revision, sourceUrl, reason }
}

const discoveryInstructions = [
  'For repository discovery, search public sources using the saved target name and sensible spelling/name variants.',
  'Distinguish similarly named projects. Cross-check the upstream repository against project or maintainer documentation.',
  'Only if you can support a match, include a repositorySuggestion object in kraflr-result.',
  'Use targetName, url (public HTTPS repository root), sourceUrl (public HTTPS evidence), reason, and revision.',
  'Prefer the exact commit or release tag you verified. Leave revision empty if unknown. Explain ambiguity in the summary.',
  'A repository suggestion is for researcher review. Do not clone, run code, or treat the repository as approved under this discovery scope.',
].join('\n')

export function report(reply: string) {
  const decoded = decodeReport(reply)
  const { data } = decoded
  const lines = (value: unknown) => Array.isArray(value) ? value.slice(0, 15).map((item) => cleanText(item, 1200)).filter(Boolean) : []
  const leads = Array.isArray(data.leads) ? data.leads.slice(0, 12).flatMap<ResearchLead>((item) => {
    const title = cleanText(item?.title, 160)
    const explanation = cleanText(item?.explanation, 2400)
    const path = cleanText(item?.path, 500)
    const { startLine, endLine } = item ?? {}
    if (!title || !explanation || !path || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
        startLine < 1 || endLine < startLine || endLine > 300_000 || endLine - startLine >= 120) return []
    return [{ title, explanation, path, startLine, endLine, ...(typeof item.id === 'string' && /^[a-f0-9-]{36}:(?:[0-9]{1,2}|source)$/.test(item.id) ? { id: item.id } : {}), verification: readProjectVerification(item.verification),
      ...classifyAgentEvidence(item) }]
  }) : []
  const tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, 12).flatMap((item) => {
    const worker = cleanText(item?.worker, 100)
    const objective = cleanText(item?.objective, 3000)
    return worker && objective ? [{ worker, objective }] : []
  }) : []
  return {
    structured: decoded.structured, reply: decoded.reply,
    verification: readProjectVerification(data.verification),
    summary: decoded.summary,
    leads, tasks, deadEnds: lines(data.deadEnds), nextSteps: lines(data.nextSteps),
    repositorySuggestion: repositorySuggestion(data.repositorySuggestion),
  }
}

function leadHandoff(lead: EvidenceLead, scopeVersion: number) {
  const latest = lead.reviews[0]
  const closure = lead.reviews.find((review) => review.status === 'closed')
  return [
    'Saved lead context follows. Treat it as historical evidence and researcher notes. Follow the current research scope.',
    JSON.stringify({
      id: lead.id, title: lead.title, tag: lead.tag, security: lead.security, explanation: lead.explanation, previousScope: lead.scopeVersion,
      path: lead.path, startLine: lead.startLine, endLine: lead.endLine, commit: lead.commit,
      excerpt: lead.scopeVersion === scopeVersion ? lead.evidence?.join('\n').slice(0, 6000) : undefined,
      priorOutcome: lead.summary.slice(0, 2400),
      deadEnds: lead.deadEnds.slice(0, 6).map((item) => item.slice(0, 500)),
      researcherNote: latest?.note, previousClosureReason: closure && closure !== latest ? closure.note : undefined,
      nextAction: latest ? latest.nextAction : lead.nextSteps[0],
      verification: lead.verificationResults.slice(0, 5).map((record) => ({
        id: record.id, status: record.status, scopeVersion: record.scopeVersion, image: 'image' in record.plan ? record.plan.image : undefined,
        detail: record.detail, observation: record.observation && 'kind' in record.observation
          ? { ...record.observation, evidence: record.observation.evidence.slice(0, 1200) } : record.observation,
        finding: record.finding,
      })),
    }),
  ].join('\n')
}

export function createResearchTeam(store: ResearchStore, terminals: Pick<AgentTerminals, 'list' | 'researchTurn'>,
  inspectLab?: VerificationRunner['available'], coordinateDirectTurns = false) {
  const lifetime = new AbortController()
  const active = new Map<string, { run: ResearchRun; stop: AbortController; done: Promise<void> }>()
  const latestNative=new Map<string,string>()
  const unsubscribeScope = store.onScopeChanged((panelId, version) => {
    for (const current of active.values()) {
      if (current.run.panelId === panelId && current.run.scopeVersion !== version) {
        current.stop.abort(new StoreError(409, 'The research scope changed. Completed work has been saved; start a new run on the current revision.'))
      }
    }
  })

  async function attachEvidence(run: ResearchRun, scope: ScopeRevision, leads: ResearchLead[]) {
    const keys = new Set(run.leads.map((lead) => `${lead.path}:${lead.startLine}:${lead.endLine}:${lead.title}`))
    for (const lead of leads) {
      const key = `${lead.path}:${lead.startLine}:${lead.endLine}:${lead.title}`
      const existing = run.leads.find((item) => (lead.id && item.id === lead.id) || `${item.path}:${item.startLine}:${item.endLine}:${item.title}` === key)
      if (existing) {
        const changedCitation = existing.path !== lead.path || existing.startLine !== lead.startLine || existing.endLine !== lead.endLine
        const preserved = existing.kind === 'lead' && lead.kind !== 'lead' ? { kind: existing.kind, security: existing.security } : {}
        Object.assign(existing, lead, preserved)
        if (changedCitation) { delete existing.commit; delete existing.evidence }
        const excerpt = await readPinnedSource(scope, { scopeVersion: scope.version, path: lead.path, startLine: lead.startLine,
          endLine: lead.endLine, model: '', objective: '' }).catch(() => null)
        if (excerpt) Object.assign(existing, { commit: excerpt.commit, evidence: excerpt.lines })
        continue
      }
      if (keys.has(key) || run.leads.length >= 24) continue
      store.readSourceScope(run.panelId, run.scopeVersion)
      keys.add(key)
      const excerpt = await readPinnedSource(scope, {
        scopeVersion: scope.version, path: lead.path, startLine: lead.startLine, endLine: lead.endLine,
        model: '', objective: '',
      }).catch(() => null)
      if (run.leads.length < 24 && !run.leads.some((item) =>
        `${item.path}:${item.startLine}:${item.endLine}:${item.title}` === key)) {
        run.leads.push(excerpt ? { ...lead, commit: excerpt.commit, evidence: excerpt.lines } : lead)
      }
    }
  }

  async function execute(run: ResearchRun, scope: ScopeRevision, context: string, workers: AgentTerminalInfo[], handoff: string[], stop: AbortSignal,native?:{reply:string;current:()=>boolean}) {
    // Research and human approvals do not have a fixed wall-clock deadline.
    // Adapter requests have connection deadlines; explicit stop/scope/shutdown still cancel work.
    const signal = AbortSignal.any([lifetime.signal, stop])
    const update = () => store.saveResearchRun(run)
    const turn = (id: string, text: string) => terminals.researchTurn(run.panelId, id, text, run.scopeVersion, signal)
    async function reportedTurn(id: string, text: string) {
      let fullReply = ''
      let latestReply = ''
      try {
        const original = await turn(id, text)
        let result = report(original)
        fullReply = original
        // Free research has no required report format: leads are recorded live with `kraflr agent lead`, so a plain answer is accepted as it is.
        // A saved lab checkpoint already carries everything Kraflr needs, so a missing report must not delay the approval pop-up with another turn.
        if (!result.structured && run.purpose === 'verification' && !await preparedLabPlan(run)) {
          run.phase = 'Saving the evidence report'
          update()
          const repaired = await turn(id, [
            'Your previous answer was saved, but its structured research report was missing or invalid.',
            'Do not do more research or use tools. Reformat only the evidence you already inspected. Do not invent security flaws or references.',
            reportInstructions,
          ].join('\n'))
          const formatted = report(repaired)
          fullReply += '\n\n--- Structured report repair ---\n\n' + repaired
          if (formatted.structured) result = formatted
          else run.reportWarning = 'The full reply is saved, but the agent did not provide a valid evidence report after one repair attempt.'
        }
        latestReply = result.reply
        return result
      } catch (error) {
        const partial = error && typeof error === 'object' && 'partialReply' in error && typeof error.partialReply === 'string' ? error.partialReply : ''
        if (partial) fullReply += (fullReply ? '\n\n--- Interrupted report ---\n\n' : '') + partial
        throw error
      } finally {
        if (id === run.parentId && fullReply) {
          run.parentReplies = [...(run.parentReplies ?? []), fullReply]
          run.fullReply = run.parentReplies.join('\n\n--- Parent turn ---\n\n')
          run.reply = latestReply
        } else if (fullReply) {
          const task = run.tasks.find((item) => item.sessionId === id)
          if (task) task.fullReply = fullReply
        }
      }
    }
    const available = new Map(workers.map((worker, index) => [`worker-${index + 1}`, worker]))
    const roster = [...available].map(([id, worker]) => `${id} (${worker.label}, ${agentDetails[worker.kind].name})`)
    const discovery = scope.repositoryMode === 'discover' ? [discoveryInstructions] : []
    try {
      const initial = native?report(native.reply):await reportedTurn(run.parentId, [
        run.purpose === 'verification' ? 'You are the parent agent for this authorized open-source research run.' : 'You are the parent agent for this authorized security research run. Work the way you normally would: explore freely inside the saved scope and use any tool installed on this machine.',
        ...(run.purpose === 'verification' ? [
          'Worker IDs below identify existing Kraflr sessions. Delegation is optional: do the work yourself unless a helper clearly saves time. Delegate ONLY by returning a tasks array in your kraflr-result JSON, then finish your reply. Kraflr dispatches those tasks and brings the results back to you. A worker receives nothing you did not put in that array.',
          'Do not use spawn_agent, task, delegate, or any engine-native agent-spawning or messaging tool. Do not create additional agents. A native subagent is not a Kraflr worker.',
          'Stay within the saved scope. Live testing requires a separate approval.',
          roster.length ? 'Use tasks items with worker and objective. Use only these worker IDs and assign each at most one task per round. The team supports up to two rounds of handoff and returned results:' : 'There are no eligible workers for this run; handle it yourself and say so.',
        ] : [
          'Do the investigation yourself. Record each concrete lead the moment you find it with `kraflr agent lead`; do not wait for the end of the turn. Helpers are optional: only when a task would clearly save time, return it in a tasks array and Kraflr delivers it to that worker; otherwise leave tasks empty.',
          roster.length ? 'Workers you may use, if you want to:' : 'There are no workers for this run; handle everything yourself.',
        ]),
        ...roster,
        run.purpose === 'verification' ? reportInstructions : freeReportInstructions,
        ...discovery,
        'Saved research scope:', context,
        ...handoff,
        'Researcher objective:', run.objective,
      ].join('\n'))
      if(native){run.fullReply=native.reply;run.parentReplies=[native.reply];run.reply=initial.reply}
      await attachEvidence(run, scope, initial.leads)
      run.summary = initial.summary
      if (run.purpose === 'verification') run.labPlan = initial.verification ?? initial.leads.find((item) => item.id === run.leadId)?.verification
      run.deadEnds = initial.deadEnds
      run.nextSteps = initial.nextSteps
      // Only the Parent assigns work. Kraflr never hands a Child a task the Parent did not ask for.
      async function dispatch(assignments: ReturnType<typeof report>['tasks'], round: number) {
        const selected = new Set<string>()
        const tasks: ResearchRun['tasks'] = []
        function assign(worker: AgentTerminalInfo, objective: string) {
          if (selected.has(worker.id)) return
          const live = terminals.list().find(item => item.id === worker.id && item.panelId === run.panelId && item.scopeVersion === run.scopeVersion && item.state === 'running' && item.chat && !item.modelSelectionRequired && (native||item.promptReady!==false))
          if (!live) return
          if (run.tasks.some(task => task.sessionId === worker.id && task.status === 'failed')) return
          selected.add(worker.id)
          tasks.push({ sessionId: worker.id, agent: worker.label, objective, round, automatic: false, status: 'assigned', result: '' })
        }
        for (const assignment of assignments) {
          const names = workers.filter(worker => worker.id === assignment.worker || worker.label.toLowerCase() === assignment.worker.toLowerCase())
          const worker = available.get(assignment.worker) ?? (names.length === 1 ? names[0] : undefined)
          if (worker) assign(worker, assignment.objective)
        }
        if (!tasks.length) return []
        run.tasks.push(...tasks)
        run.team = { workerIds: workers.map(item => item.id), rounds: round, automaticReviews: 0 }
        run.phase = `Parent assigned child tasks · round ${round} of 2`
        update()
        return await Promise.all(tasks.map(async (task) => {
          try {
            if(native)for(;;){
              signal.throwIfAborted();store.readSourceScope(run.panelId,run.scopeVersion)
              const live=terminals.list().find(item=>item.id===task.sessionId&&item.state==='running'&&item.scopeVersion===run.scopeVersion)
              if(!live)throw new StoreError(409,'The child session stopped before receiving its assignment.')
              if(live.promptReady!==false&&!live.modelSelectionRequired)break
              run.phase=`Waiting for ${task.agent}: ${live.readinessReason??'finish its current interaction'}`;update()
              await delay(150,undefined,{signal})
            }
            const result = await reportedTurn(task.sessionId, [
              `Research assignment proposed by parent ${run.parentName}, delivered by Kraflr.`,
              'Perform this assignment yourself. Do not spawn or delegate to native subagents; Kraflr manages the team.',
              'Stay within the saved scope. Return evidence to the parent. Live testing requires separate approval.',
              reportInstructions, 'Saved research scope:', context,
              ...handoff,
              ...discovery,
              'Researcher objective:', run.objective, 'Your assignment:', task.objective,
            ].join('\n'))
            task.status = 'completed'
            if (run.purpose === 'verification' && result.verification) run.labPlan = result.verification
            task.result = result.summary
            await attachEvidence(run, scope, result.leads)
            run.deadEnds = [...new Set([...run.deadEnds, ...result.deadEnds])].slice(0, 24)
            run.nextSteps = [...new Set([...run.nextSteps, ...result.nextSteps])].slice(0, 24)
            // Detailed replies remain saved; do not send duplicate full transcripts into the parent's context.
            return { summary: result.summary.slice(0, 4000), reply: result.reply,
              leads: result.leads.slice(0, 6).map(lead => ({ ...lead, explanation: lead.explanation.slice(0, 1200), evidence: undefined })),
              verification: result.verification, deadEnds: result.deadEnds.slice(0, 5), nextSteps: result.nextSteps.slice(0, 5) }
          } catch (error) {
            task.status = signal.aborted ? 'interrupted' : 'failed'
            task.result = error instanceof StoreError ? error.message : 'This worker did not return a result.'
            return null
          } finally {
            update()
          }
        }))
      }
      let assignments = initial.tasks
      for (let round = 1; round <= 2; round++) {
        const before = run.tasks.length
        const workerReports = await dispatch(assignments, round)
        if (run.tasks.length === before) break
        signal.throwIfAborted()
        if(native&&!native.current()){run.nextSteps.push('Child results were saved. A newer parent-terminal message superseded automatic consolidation.');break}
        run.phase = `Parent is reviewing worker results · round ${round} of 2`
        update()
        const final = await reportedTurn(run.parentId, [
          'Consolidate this investigation using the worker results below. Treat worker output as evidence to evaluate.',
          `Kraflr runtime confirmation: you are parent session ${run.parentId} (${run.parentName}) in panel ${run.panelId}, scope ${run.scopeVersion}. You are inside Kraflr. The sessions below actually received the recorded assignments. A failed shell command never proved that Kraflr or its children were absent; correct earlier assumptions using these runtime facts.`,
          JSON.stringify({assignmentSource:'Parent task plan delivered by Kraflr',workers:workers.map(worker=>({id:worker.id,name:worker.label,kind:worker.kind,role:'child'}))}),
          'Explain limitations, leads, dead ends, and next actions. Explicitly acknowledge failed workers rather than claiming they reviewed anything.',
          round === 1 ? 'If a concrete follow-up is needed, return tasks for one final worker round using the roster below. Otherwise return tasks: [] and finish.' : 'This is the final turn. Do not assign additional tasks; list remaining work in nextSteps.',
          ...roster,
          ...(run.purpose === 'verification' ? ['Return the prepared image and exact test plan in the top-level verification object. Do not claim the test ran; it still requires Kraflr approval.'] : []),
          reportInstructions,
          ...discovery,
          JSON.stringify({ tasks: run.tasks.slice(before).map(({ fullReply: _full, ...task }) => task), reports: workerReports }),
        ].join('\n'))
        run.summary = final.summary
        if (run.purpose === 'verification') run.labPlan = final.verification ?? final.leads.find((item) => item.id === run.leadId)?.verification ?? run.labPlan
        if (discovery.length) run.repositorySuggestion = final.repositorySuggestion
        run.deadEnds = [...new Set([...run.deadEnds, ...final.deadEnds])].slice(0, 24)
        run.nextSteps = [...new Set([...run.nextSteps, ...final.nextSteps])].slice(0, 24)
        await attachEvidence(run, scope, final.leads)
        assignments = final.tasks
        if (!assignments.length) break
        if (round === 2) run.nextSteps = [...new Set([...run.nextSteps, 'The two-round collaboration limit was reached. Start a new research request for additional worker follow-ups.'])]
      }
      if (discovery.length && !run.repositorySuggestion) run.repositorySuggestion = initial.repositorySuggestion
      signal.throwIfAborted()
      if (run.purpose === 'verification') {
        run.labPlan = await preparedLabPlan(run)
        if (!run.labPlan || !run.leadId) throw new StoreError(422, 'The parent did not return a built Docker image and a valid test plan. Its full reply is saved; finish kraflr-verification.json or recover the prepared lab.')
        if (run.repairOf) {
          const failed = store.readTest(run.panelId, run.repairOf)
          if (verificationHash(projectPlan(run.labPlan, scope)) === failed.planHash) {
            throw new StoreError(422, 'The agent did not change the image or command, so the same test would fail the same way. Its reply is saved; ask it to rebuild the lab and update kraflr-verification.json.')
          }
        }
        run.phase = 'Checking the prepared Docker image'
        update()
        if (!inspectLab) throw new StoreError(503, 'Docker image inspection is unavailable.')
        const queued = await queuePreparedVerification(store, inspectLab, run, signal)
        run.verificationId = queued.id
      }
      run.status = 'completed'
      run.phase = run.purpose === 'verification' ? 'Docker image checked. Review and approve the isolated test.' : 'Research record saved'
    } catch (error) {
      run.status = signal.aborted ? 'interrupted' : 'failed'
      run.phase = stop.aborted && stop.reason instanceof StoreError ? stop.reason.message
        : stop.aborted ? 'Stopped by researcher. Completed work has been saved.'
        : signal.aborted ? 'This run was interrupted. Completed work has been saved.'
        : error instanceof StoreError ? error.message : 'The research run could not finish.'
      for (const task of run.tasks) if (task.status === 'assigned') task.status = 'interrupted'
    } finally {
      run.endedAt = new Date().toISOString()
      update()
    }
  }

  return {
    acceptNative(agent:AgentTerminalInfo,turn:NativeTurn){
      // A direct conversation with the Parent stays a plain session. Kraflr no longer turns it into a coordinated run with automatic child tasks;
      // the Parent delegates with `kraflr agent send` when it chooses to.
      if(!coordinateDirectTurns)return false
      if(turn.historical)return false
      latestNative.set(agent.id,turn.id)
      if(turn.failed||!terminalWork(turn.prompt)||lifetime.signal.aborted)return false
      const current=terminals.list().find(item=>item.id===agent.id&&item.parent&&item.state==='running'&&item.scopeVersion===agent.scopeVersion&&!item.modelSelectionRequired)
      if(!current)return false
      const workers=terminals.list().filter(item=>item.panelId===agent.panelId&&item.id!==agent.id&&!item.parent&&item.chat&&item.state==='running'&&item.scopeVersion===agent.scopeVersion&&!item.modelSelectionRequired)
      if(!workers.length)return false
      const hex=createHash('sha256').update(`terminal-team:${agent.id}:${turn.id}`).digest('hex').slice(0,32),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
      try{store.readResearchRun(agent.panelId,id);return true}catch(error){if(!(error instanceof StoreError&&error.status===404))throw error}
      if(store.activeResearch().some(run=>run.panelId===agent.panelId))return false
      const panel=store.readPanel(agent.panelId),scope=store.readSourceScope(panel.id,agent.scopeVersion??0)
      const run:ResearchRun={id,panelId:panel.id,parentId:agent.id,parentName:agent.label,scopeVersion:scope.version,purpose:'conversation',objective:turn.prompt.slice(0,8000),status:'running',phase:'Parent terminal plan received; assigning children',startedAt:new Date().toISOString(),endedAt:null,summary:'',tasks:[],leads:[],deadEnds:[],nextSteps:[]}
      store.startResearchRun(run)
      const stop=new AbortController(),done=execute(run,scope,agentContext(panel).text,workers,[briefInstructions(researchBrief(store,panel.id))],stop.signal,{reply:turn.reply,current:()=>latestNative.get(agent.id)===turn.id})
        .catch(()=>console.error('Could not save the terminal team record.')).finally(()=>active.delete(id))
      active.set(id,{run,stop,done});return true
    },
    start(panelId: string, objective: string, id: string, leadId?: string, preparation?: { labDirectory: string; repairOf?: string }) {
      try { return store.readResearchRun(panelId, id) } catch (error) {
        if (!(error instanceof StoreError && error.status === 404)) throw error
      }
      if (lifetime.signal.aborted) throw new StoreError(503, 'Kraflr is shutting down.')
      const panel = store.readPanel(panelId)
      const scope = store.readSourceScope(panelId, panel.scopeVersion)
      const lead = leadId ? store.readEvidence(panelId, leadId) : undefined
      if (lead?.status === 'closed') throw new StoreError(409, 'Change this item’s tag to Lead before continuing it.')
      const team = terminals.list().filter((session) =>
        session.panelId === panelId && session.chat && session.state === 'running' && session.scopeVersion === scope.version
        && !session.modelSelectionRequired && session.promptReady!==false)
      const parent = team.find((session) => session.parent)
      if (!parent) throw new StoreError(409, 'Open a managed OpenCode, Cline or Claude Code parent with a confirmed model and the current scope revision. For a native pane (Cline or Claude Code), finish its current work or check that its prompt is clear before marking it ready.')
      const history = briefInstructions(researchBrief(store, panelId))
      const run: ResearchRun = {
        id, panelId, parentId: parent.id, parentName: parent.label, scopeVersion: scope.version, objective,
        status: 'running', phase: team.length > 1 ? 'Parent is planning team tasks' : 'Parent is investigating', startedAt: new Date().toISOString(), endedAt: null,
        summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [],
        ...(preparation && { purpose: 'verification' as const, labDirectory: preparation.labDirectory, phase: preparation.repairOf ? 'Analysing the verification error and repairing the lab' : 'Preparing lab files and Docker image', ...(preparation.repairOf ? { repairOf: preparation.repairOf } : {}) }),
        ...(lead && { leadId: lead.id, leadReviewVersion: lead.reviews[0]?.version ?? 0 }),
      }
      store.startResearchRun(run)
      const stop = new AbortController()
      const done = execute(run, scope, agentContext(panel).text, team.filter((session) => !session.parent),
        [history, ...(lead ? [leadHandoff(lead, scope.version)] : [])], stop.signal)
        .catch(() => console.error('Could not save the research record.'))
        .finally(() => active.delete(id))
      active.set(id, { run, stop, done })
      return run
    },
    cancel(panelId: string, id: string) {
      const saved = store.readResearchRun(panelId, id)
      if (saved.status !== 'running') return saved
      const current = active.get(id)
      if (!current || current.run.panelId !== panelId) throw new StoreError(409, 'This run is awaiting recovery after a restart.')
      current.run.phase = 'Stopping research. Completed work is being saved.'
      store.saveResearchRun(current.run)
      current.stop.abort()
      return current.run
    },
    async close() {
      unsubscribeScope()
      lifetime.abort()
      await Promise.allSettled([...active.values()].map((item) => item.done))
    },
  }
}

function localDirectory(path: string) {
  return isAbsolute(path) && (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(path))
}

async function contextDirectory(panel: PanelDetail, scopes: (ScopeRevision | undefined)[]) {
  const current = panel.scopeHistory[0]
  const workspace = current?.workspacePath ?? ''
  if (!localDirectory(workspace)) throw new StoreError(409, 'Choose a local agent workspace folder in Research scope.')
  const directory = await realpath(workspace).catch(() => '')
  if (!localDirectory(directory) || !(await stat(directory).catch(() => null))?.isDirectory()) {
    throw new StoreError(409, 'The saved agent workspace folder is unavailable.')
  }
  for (const protectedScope of new Set([...scopes, current])) {
    if (!protectedScope || protectedScope.accessMode === 'read_write' || !localDirectory(protectedScope.checkoutPath ?? protectedScope.repository)) continue
    const repo = await realpath(protectedScope.checkoutPath ?? protectedScope.repository).catch(() => '')
    if (repo) {
      const path = relative(repo, directory)
      if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
        throw new StoreError(409, 'Choose an agent workspace outside the read-only checkout.')
      }
    }
  }
  return directory
}

async function writeContext(directory: string, name: string, document: string) {
  const path = join(directory, name)
  try {
    await writeFile(path, document, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError(409, 'This context file already exists in the workspace.')
    throw new StoreError(422, 'Kraflr could not write the context file to the selected workspace.')
  }
  return { name, path }
}

export async function exportResearchRun(store: ResearchStore, panelId: string, id: string) {
  const run = store.readResearchRun(panelId, id)
  if (run.status === 'running') throw new StoreError(409, 'Wait for the research run to finish before saving its context.')
  const panel = store.readPanel(panelId)
  const scope = panel.scopeHistory.find((item) => item.version === run.scopeVersion)
  const directory = await contextDirectory(panel, [scope])
  const name = `kraflr-research-${run.id}.md`
  const scopeText = scope ? agentContext({ ...panel, scopeHistory: [scope] }).text : ''
  const document = [
    `# ${panel.name}`, '', `Run ${run.id} · ${run.status}`, `Parent agent: ${run.parentName}`, '',
    '## Objective', '', run.objective, '', '## Outcome', '', run.summary || run.phase, '',
    ...(run.fullReply ? ['## Full parent reply', '', run.fullReply, ''] : []),
    '## Scope', '', scopeText, '## Assignments', '',
    ...run.tasks.flatMap((task) => [`### ${task.agent} (${task.status})`, '', task.objective, '', task.fullReply || task.result, '']),
    '## Reported evidence', '',
    ...run.leads.flatMap((lead) => [`### ${lead.title}`, '', lead.explanation,
      ...(lead.security ? [`Security hypothesis: ${lead.security.hypothesis}`, `Attack path: ${lead.security.attackPath}`,
        `Potential impact: ${lead.security.impact}`] : []),
      `${lead.path}:${lead.startLine}–${lead.endLine}${lead.commit ? ` · ${lead.commit}` : ' · Citation unverified'}`,
      '', ...(lead.evidence ?? []).map((line, index) => `    ${lead.startLine + index}  ${line}`), '']),
    '## Dead ends', '', ...run.deadEnds.map((line) => `- ${line}`), '',
    '## Next steps', '', ...run.nextSteps.map((line) => `- ${line}`), '',
  ].join('\n')
  return writeContext(directory, name, document)
}

export async function exportResearchBrief(store: ResearchStore, panelId: string) {
  const panel = store.readPanel(panelId)
  const brief = researchBrief(store, panelId)
  const directory = await contextDirectory(panel, panel.scopeHistory)
  const document = [
    `# ${panel.name}`, '', `Saved scope revision ${panel.scopeVersion}`, '',
    '## Current authorization', '', agentContext(panel).text,
    '## Last research', '', brief.latestRun ? `${brief.latestRun.objective}\n\n${brief.latestRun.summary || brief.latestRun.phase}` : 'Research has not started.',
    '', '## Last assignments', '',
    ...(brief.latestRun?.tasks ?? []).flatMap((task) => [`### ${task.agent} · ${task.status}`, '', task.objective, '', task.result, '']),
    '', '## Open leads', '',
    ...brief.openLeads.flatMap((lead) => [`### ${lead.title}`, '', `Lead ${lead.id} · Scope ${lead.scopeVersion}`,
      `${lead.path} lines ${lead.startLine}–${lead.endLine}`, '', lead.nextAction, '']),
    '## Researcher decisions', '',
    ...brief.decisions.flatMap((decision) => [`### ${decision.title}`, '', `${decision.tag ?? (decision.status === 'closed' ? 'killed_lead' : 'general')} · ${decision.savedAt}`,
      '', decision.note, '', decision.nextAction, '']),
    '## Known dead ends', '', ...brief.deadEnds.map((item) => `- Scope ${item.scopeVersion} · ${item.text}`), '',
    '## Verification results', '',
    ...brief.verification.flatMap((item) => [`- ${item.status} · Scope ${item.scopeVersion} · Lead ${item.leadId}`,
      item.detail, item.finding, '']),
    '## Suggested next steps', '', ...brief.nextSteps.map((item) => `- ${item}`), '',
  ].join('\n')
  return writeContext(directory, `kraflr-brief-${panel.id}-${randomUUID()}.md`, document)
}

/** Writes the report (Findings, ruled-out leads, open leads) into the panel's agent workspace, never into a read-only checkout. */
export async function exportReport(store: ResearchStore, panelId: string, appendix: string[] = []) {
  const panel = store.readPanel(panelId)
  const directory = await contextDirectory(panel, panel.scopeHistory)
  return writeContext(directory, `kraflr-report-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.md`, buildReport(store, panelId, appendix))
}
