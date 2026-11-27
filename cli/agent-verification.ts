import { randomUUID } from 'node:crypto'
import { StoreError,type ResearchStore } from '../server/db.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { isAgentExecutor, isAgentPlan, isProjectPlan, type VerificationRecord } from '../shared/verification.ts'
import {latestPreparedLab} from '../server/prepared-verification.ts'
import {isolationArguments,verificationHash} from '../server/verification-runner.ts'
import { shellQuote } from './commands.ts'
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>
const operations=['status','plan','run','prepare','recover','retry','docker','report','fail']
/** The agent that holds an approved test may run it whatever its role; every other operation stays with the Parent. */
const leaseOperations=['docker','report','fail']

/** The container command an agent may run itself: the approved image and the approved isolation, nothing else. */
export function approvedDockerCommand(record:VerificationRecord){
 if(!isProjectPlan(record.plan))throw new StoreError(409,'Only a researched lead’s test can be run by an agent.')
 const {plan}=record,argv=['docker','run','--rm','--pull=never','--name','kraflr-agent-'+record.id.slice(0,8),'--label','com.kraflr.agent-verification='+record.id,'--no-healthcheck',
  ...isolationArguments(plan),'--entrypoint',plan.command[0]!,plan.image,...plan.command.slice(1)]
 const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'"
 return {
  argv,
  powershell:'& '+argv.map((part,index)=>index===0?part:quote(part)).join(' '),
  posix:argv.map((part,index)=>index===0?part:shellQuote(part)).join(' '),
  notes:[
   'Run this exactly. Do not add mounts, ports, networks, privileges or a different image; the researcher approved this plan, not a modified one.',
   `The test must finish within ${plan.limits.seconds} seconds. Stop and remove the container yourself if it hangs (docker rm -f kraflr-agent-${record.id.slice(0,8)}).`,
   'In Git Bash, prefix the command with MSYS_NO_PATHCONV=1 or it rewrites container paths such as /usr/local/bin/php into Windows paths.',
   'The container prints one line: KRAFLR_VERIFICATION_RESULT {json}. Put that JSON, plus "image" (the approved sha256 id) and optionally "exitCode" and "command", in a file and pass it to kraflr agent verification report. If the test cannot finish, do not invent a result: run kraflr agent verification fail <id> --message "what went wrong".',
  ],
 }
}

function leasedTo(record:VerificationRecord,agent:AgentTerminalInfo){
 if(record.status!=='running'||!isAgentExecutor(record.executor)||!record.lease)throw new StoreError(409,'The researcher has not approved this test for an agent to run. Its status is '+record.status+'.')
 if(record.lease.agentId!==agent.id)throw new StoreError(403,'This test was approved for '+record.lease.agentLabel+', not for you.')
}

export async function agentVerification(store:ResearchStore,api:Api,agent:AgentTerminalInfo,operation:string,target?:string,payload?:unknown){
 const base=`/api/panels/${agent.panelId}`
 if(typeof operation!=='string'||target!==undefined&&typeof target!=='string')throw new StoreError(400,'Use a verification command and a saved ID.')
 store.readSourceScope(agent.panelId,agent.scopeVersion??0)
 if(!operations.includes(operation))throw new StoreError(400,'Verification commands: status, plan, prepare, recover, retry, run, docker, report, fail.')
 if(target&&(!/^[a-f0-9-]{36}(?::(?:[0-9]{1,2}|source))?$/.test(target)))throw new StoreError(400,'Use a saved lead, preparation or test ID.')
 if(!['status','plan',...leaseOperations].includes(operation)&&!agent.parent)throw new StoreError(403,'The current Parent manages verification; Children may read its status and plan, and run a test the researcher approved for them.')
 if(operation==='prepare'){
  if(!target)throw new StoreError(400,'Choose the saved lead ID to verify.')
  const lead=store.readEvidence(agent.panelId,target)
  const result=await api(base+'/lab-preparation','POST',{id:randomUUID(),leadId:lead.id})
  return {preparationId:result.id,status:result.status,message:'Preparation is queued with the Parent. Return this turn so Kraflr can deliver the assignment. Do not create another lead.'}
 }
 if(operation==='recover'){
  if(!target)throw new StoreError(400,'Choose the saved preparation ID.')
  // An agent may repair and resubmit on its own, but not forever: after the third failure on a lead the researcher decides.
  const leadId=store.readResearchRun(agent.panelId,target).leadId
  if(leadId&&store.listVerification(agent.panelId,leadId).records.filter(record=>record.scopeVersion===agent.scopeVersion&&record.status==='error').length>2)throw new StoreError(409,'Two repairs of this lab have already failed. Stop here and tell the researcher what is blocking it; they choose Inform agent or Cancel verification.')
  const record=await api(base+'/lab-preparation/recover','POST',{runId:target})
  return {record,message:'The current built lab plan is submitted. Present this exact image/command for fresh researcher approval; previous approval does not transfer. No execution was authorized by recovery.'}
 }
 if(!target){if(operation!=='status')throw new StoreError(400,'Choose a saved test ID.');return {records:store.listVerification(agent.panelId).records.slice(0,10),preparations:store.listResearchRuns(agent.panelId).filter(run=>run.purpose==='verification').slice(0,5).map(run=>({id:run.id,leadId:run.leadId,status:run.status,phase:run.phase}))}}
 const record=target.includes(':')?store.listVerification(agent.panelId,target).records[0]:store.listVerification(agent.panelId).records.find(record=>record.id===target)??store.readTest(agent.panelId,target)
 if(!record)return {status:'not_prepared',leadId:store.readEvidence(agent.panelId,target).id,message:'No saved test exists yet. Use verification prepare with this lead ID.'}
 if(operation==='retry')return {record:await api(`${base}/verification/${record.id}/retry`,'POST',{}),message:'The unchanged saved image/command is awaiting fresh researcher approval. This does not execute a test or adopt a repaired image. Use recover after updating the lab checkpoint for a repair.'}
 if(operation==='docker'){
  leasedTo(record,agent)
  return {testId:record.id,...approvedDockerCommand(record),leaseExpiresAt:record.lease!.expiresAt}
 }
 if(operation==='fail'){
  leasedTo(record,agent)
  let failure:Record<string,unknown>
  try{const parsed=JSON.parse(String(payload??''));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw 0;failure=parsed}
  catch{throw new StoreError(400,'Describe the problem: kraflr agent verification fail <test-id> --message "what went wrong" [--file container-output.txt]')}
  const {message,output,exitCode,stage}=failure as Record<string,any>
  if(typeof message!=='string'||!message.trim())throw new StoreError(400,'Say what went wrong with --message "…".')
  const finished=await api(`${base}/verification/${record.id}/failure`,'POST',{message:message.slice(0,1200),...(typeof output==='string'&&output.trim()?{output:output.slice(-3000)}:{}),...(Number.isInteger(exitCode)?{exitCode}:{}),...(typeof stage==='string'&&stage.trim()?{stage:stage.slice(0,60)}:{})})
  return {record:finished,message:'The error is saved and the researcher sees it as Error faced. Do not rerun this test. '+(agent.parent?'If the cause is in the lab, repair it now: fix it, rebuild, update kraflr-verification.json and run verification recover <preparation-id>; the repaired plan needs its own approval. Otherwise, or after two failed repairs, explain the blocker and end your turn.':'End your turn now; the Parent repairs the lab, and the repaired plan needs its own approval.')}
 }
 if(operation==='report'){
  leasedTo(record,agent)
  if(!isAgentPlan(record.plan))throw new StoreError(409,'Only a researched lead’s test can be reported by an agent.')
  let report:Record<string,unknown>
  try{const parsed=JSON.parse(String(payload??''));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw 0;report=parsed}
  catch{throw new StoreError(400,'Provide the result as a JSON object: kraflr agent verification report <test-id> --file result.json')}
  const {image,outcome,controlPassed,summary,evidence,exitCode,command,environment}=report as Record<string,any>
  const finished=await api(`${base}/verification/${record.id}/report`,'POST',{...(isProjectPlan(record.plan)?{image:image??record.plan.image}:{}),observation:{outcome,controlPassed,summary,evidence:evidence??'',...(environment!==undefined?{environment}:{})},
   ...(typeof command==='string'?{command:command.slice(0,2000)}:{}),...(Number.isInteger(exitCode)?{exitCode}:{})})
  return {record:finished,message:finished.finding?'Reproduced with a passing control: saved as a Finding under the researcher’s approval. The result is labeled agent-reported. Tell the researcher in plain English.'
   :finished.killedLead?'Not reproduced with a passing control: the lead was killed under the researcher’s approval and is in Killed leads. The result is labeled agent-reported. Tell the researcher in plain English.'
   :'The result is saved and the lead keeps its status: the outcome was inconclusive, the control failed, or the environment was not a full end-to-end one (read record.detail). A shimmed or partial environment can neither confirm nor kill a lead. Tell the researcher what is missing and what a full run needs.'}
 }
 if(operation==='run'&&record.scopeVersion!==agent.scopeVersion)throw new StoreError(409,'This test belongs to an earlier scope. Prepare a current-scope plan.')
 const engine=['status','plan','run'].includes(operation)&&!isAgentExecutor(record.executor)&&!isProjectPlan(record.plan)?await api(`${base}/verification/${record.id}/availability`):undefined
 const prepared=await latestPreparedLab(store,agent.panelId,record.leadId),changed=Boolean(prepared&&verificationHash(prepared.plan)!==record.planHash)
 const message=record.status==='running'
  ?isAgentExecutor(record.executor)
   ?`The researcher approved this exact test for ${record.lease?.agentLabel??'an agent'} to run until ${record.lease?.expiresAt}. ${record.lease?.agentId===agent.id?`Run kraflr agent verification docker ${record.id}, run the printed command, then report ${record.id} --file result.json, or fail ${record.id} --message "…" if something stops it.`:'Only that agent may run it.'} No other container is authorized.`
   :'The bundled self-test is running in Kraflr. Do not run a second container.'
  :changed?'A repaired lab checkpoint differs from this saved plan. No replacement test is running. Call verification recover with its preparation ID and present the new plan for fresh approval.'
  :record.status==='pending'?'Awaiting the researcher’s approval in the Kraflr pop-up. A chat sentence or JSON file alone is not an execution grant. At approval the researcher chooses who verifies: the Parent or a Child. That agent runs the test, reports it and Kraflr marks the lead from the report.'
  :record.status==='error'||record.status==='interrupted'?'This test ended with an error. Do not rerun it. If the cause is in the lab, the Parent repairs it, rebuilds, updates the checkpoint and calls recover to ask for a new approval (at most two failed repairs); otherwise the researcher chooses Inform agent or Cancel.'
  :'This test has finished; do not claim to be waiting for its outcome. After a repair, update the lab checkpoint and recover its preparation ID to submit a new plan for approval. Agent claims never override this record.'
 return {record,engine,executionActive:record.status==='running',...(prepared?{preparedLab:{preparationId:prepared.run.id,image:prepared.plan.image,planChanged:changed}}:{}),message}
}
