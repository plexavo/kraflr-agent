import { join } from 'node:path'
import { shellQuote } from './commands.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { ActiveResearch } from '../shared/investigation.ts'
import type { VerificationRecord } from '../shared/verification.ts'
export const teamFileName='KRAFLR_TEAM.json'
export function agentBridgeCommand(node:string,entry:string,windows=process.platform==='win32'){
 const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'"
 return windows?`& ${quote(node)} ${quote(entry)} agent`:`${shellQuote(node)} ${shellQuote(entry)} agent`
}
export function teamInstructions(cwd:string,node:string,entry:string,windows=process.platform==='win32'){
 return [
  'You are running INSIDE Kraflr as a managed agent in a research panel. Not seeing graphical controls does not mean Kraflr is unavailable.',
  `Before claiming who is present or assigning work, read ${join(cwd,teamFileName)} with your native file-read tool. Kraflr refreshes this credential-free file when the live team or assignments change. It contains your actual role, worker IDs and same-panel teammates.`,
  'A teammate whose prompt is busy still exists; Kraflr queues its work until ready. A shell failure is not evidence that no teammates exist.',
  'Kraflr does not assign work to your teammates for you. A Child works only on what you send it with `send`, and only if you choose to.',
  `Direct bridge command prefix for this session: ${agentBridgeCommand(node,entry,windows)}`,
  'Append team, inbox, ask <id-or-unique-name> "question", send <id-or-unique-name> "task", note "progress", map [--file map.md | --text "..."] [--append], lead --title "..." --path "..." [--lines 10-20] --why "..." --hypothesis "..." --attack "..." --impact "..." [--id <lead id>], confirm <lead-id> --proof "..." --control "..." (only for a lead you proved beyond doubt), or record --file report.json. Run one command at a time. Kraflr delivers the reply to a send into your prompt when you are idle, so there is no need to poll the inbox.',
  'Use verification status [test-or-lead-id] for live state; verification plan <test-id> for its exact saved plan; verification prepare <lead-id>, recover <preparation-id>, retry <test-id>, or run <test-id> to manage the scoped workflow. Children can read status/plans; the Parent manages requests. A run request cannot approve itself: the researcher approves in a Kraflr pop-up and chooses who verifies, the Parent or a Child. Never claim that writing an approval into JSON granted execution.',
  'When the researcher approves a test for you to verify (as Parent or Child), Kraflr sends you a grant. Run verification docker <test-id> to get the exact approved docker run command, run it in your own shell, then verification report <test-id> --file result.json. Kraflr marks the lead from your report: reproduced with a passing control becomes a Finding, not reproduced with a passing control kills the lead. If anything stops the test, run verification fail <test-id> --message "what went wrong" (optionally --file with the output); do not guess a result or rerun the same test. Only the agent holding the grant may run, report or fail it, and only the approved image and isolation are allowed. Do not create another lead or ask for a manual docker run.',
  'Repair lab problems on your own: if an approved test fails because of the lab (build, configuration, missing dependency, harness), the Parent fixes it right away, rebuilds, updates kraflr-verification.json and calls verification recover <preparation-id>, which asks the researcher to approve the new plan. After two failed repairs, wait for the researcher.',
  'When the researcher informs you of a verification error (the failure and its output are in the message): analyse the cause, reuse the existing managed lab, fix it, rebuild the image, update its kraflr-verification.json with the real new image ID and command, then call verification recover <preparation-id> to submit the repaired plan as a second run. The old approval never transfers. A JSON object in chat alone does not update a linked plan. Say waiting for researcher approval only for pending and verifying only for running; an error is finished, not running.',
  ...(windows?['This prefix is Windows PowerShell syntax: keep the leading & before the quoted executable. Do not add ||, &&, POSIX fallbacks or cmd.exe quoting; Windows PowerShell 5.1 rejects them. An error must be reported as an error, not interpreted as an empty team.']:[]),
  'Use `lead` to record a lead as you find it. kraflr-result is NOT a tool or shell command: it is only the language tag of an optional fenced JSON block in your reply, which Kraflr also reads for leads you did not record.',
 ].join('\n')
}
export function teamContext(self:AgentTerminalInfo,agents:AgentTerminalInfo[],research:ActiveResearch[],verifications:VerificationRecord[]=[]){
 const team=agents.filter(agent=>agent.panelId===self.panelId&&agent.scopeVersion===self.scopeVersion&&agent.state==='running')
 const children=team.filter(agent=>!agent.parent&&agent.chat&&!agent.modelSelectionRequired)
 const member=(agent:AgentTerminalInfo)=>({id:agent.id,label:agent.label,kind:agent.kind,role:agent.parent?'parent':'child',...(agent.parent?{}:{workerId:children.some(child=>child.id===agent.id)?'worker-'+(children.findIndex(child=>child.id===agent.id)+1):null}),ready:agent.promptReady!==false&&!agent.modelSelectionRequired,reason:agent.modelSelectionRequired?'Confirm model':agent.readinessReason??null})
 return {runtime:'Kraflr',panelId:self.panelId,scopeVersion:self.scopeVersion,self:member(team.find(agent=>agent.id===self.id)??self),team:team.map(member),verifications:verifications.filter(record=>record.panelId===self.panelId&&record.scopeVersion===self.scopeVersion).slice(0,6).map(record=>({id:record.id,leadId:record.leadId,status:record.status,executor:record.executor??'kraflr',finding:Boolean(record.finding),cleanupPending:record.cleanupPending??false})),coordinator:{reportFormat:'One literal fenced kraflr-result JSON block; not a tool',active:research.filter(run=>run.panelId===self.panelId).map(run=>({parentId:run.parentId,phase:run.phase,assignments:run.assignments.map(task=>({sessionId:task.sessionId,status:task.status}))}))}}
}
