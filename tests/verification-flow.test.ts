import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'
import { CleanupError } from '../server/verification-runner.ts'
import type { VerificationRunner } from '../server/verification-runner.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { VerificationRecord, ProjectObservation } from '../shared/verification.ts'

const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317','content-type':'application/json'}
async function setup(observation?:ProjectObservation){
 const store=openStore(':memory:');let releases=()=>{},gate:Promise<void>|undefined,cleanupError=false,calls=0
 const runner:VerificationRunner={async available(){return{ready:true,detail:'Synthetic test engine',image:''}},async run(_plan,_id,signal,beforeStart){calls++;beforeStart();if(gate)await gate;signal.throwIfAborted();if(cleanupError)throw new CleanupError('Synthetic cleanup not confirmed');return observation??{ownerStatus:200,ownerRecordReturned:true,foreignStatus:200,foreignRecordReturned:true}}}
 const listed:unknown[]=[],terminals={list:()=>listed,async close(){},async dashboardSessions(){return[]}} as unknown as AgentTerminals
 const app=buildApp(store,4317,{verificationRunner:runner,terminals})
 const post=(url:string,body:object)=>app.inject({method:'POST',url,headers,payload:body})
 const panel=(await post('/api/verification/fixture',{})).json(),leadId=store.listEvidence(panel.id,0).leads[0]!.id,route=`/api/panels/${panel.id}/verification`
 const queue=async()=>{const response=await post(route,{variant:'vulnerable'});assert.equal(response.statusCode,201,response.body);return response.json<VerificationRecord>()}
 const approve=(record:VerificationRecord,extra:object={})=>post(`${route}/${record.id}/decision`,{planHash:record.planHash,choice:'approve',note:'Reviewed exact plan and conditionally accepted only a controlled reproduction.',saveFindingOnSuccess:true,...extra})
 const settle=async(record:VerificationRecord)=>{for(let i=0;i<100&&store.readTest(panel.id,record.id).status==='running';i++)await delay(5);return store.readTest(panel.id,record.id)}
 return{store,app,panel,leadId,route,post,queue,approve,settle,listed,calls:()=>calls,hold(){gate=new Promise<void>(resolve=>{releases=resolve})},release(){releases()},failCleanup(){cleanupError=true}}
}

test('verification progresses from approval through runner execution to a persisted Finding without another agent prompt',async()=>{
 const s=await setup();try{
  assert.equal(s.store.readEvidence(s.panel.id,s.leadId).verificationProgress?.state,'unverified')
  const record=await s.queue();assert.equal(s.calls(),0)
  let lead=s.store.readEvidence(s.panel.id,s.leadId)
  assert.equal(lead.verificationProgress?.state,'awaiting_approval');assert.equal(lead.verificationProgress?.canVerify,false)
  const duplicate=await s.post(`/api/panels/${s.panel.id}/lab-preparation`,{id:randomUUID(),leadId:s.leadId});assert.equal(duplicate.statusCode,409);assert.match(duplicate.body,/already in progress/)
  s.hold();assert.equal((await s.approve(record)).statusCode,202)
  assert.equal(s.store.readEvidence(s.panel.id,s.leadId).verificationProgress?.state,'running')
  assert.equal((await s.approve(record)).statusCode,409)
  s.release();const result=await s.settle(record);assert.equal(result.status,'reproduced');assert.equal(result.finding?.acceptance,'conditional');assert.equal(result.decision?.saveFindingOnSuccess,true)
  lead=s.store.readEvidence(s.panel.id,s.leadId);assert.equal(lead.tag,'finding');assert.equal(lead.verificationProgress?.state,'verified');assert.equal(lead.verificationProgress?.canVerify,false)
  assert.equal(s.store.listEvidence(s.panel.id,0,'finding').leads[0]?.verificationProgress?.label,'Verified');assert.equal(s.store.listEvidence(s.panel.id,0,'lead').leads.length,0)
  assert.equal(s.store.countLeads()[0]?.findings,1);assert.equal(s.calls(),1)
  const version=lead.reviews[0]!.version;s.store.finishVerification(result);assert.equal(s.store.readEvidence(s.panel.id,s.leadId).reviews[0]!.version,version,'Repeated completion cannot accept twice')
  s.store.saveScope(s.panel.id,1,{...s.panel.scopeHistory[0],notes:'A new source scope'})
  assert.equal(s.store.readEvidence(s.panel.id,s.leadId).verificationProgress?.scopeVersion,1)
  assert.match(s.store.readEvidence(s.panel.id,s.leadId).verificationProgress!.label,/scope 1/)
 }finally{s.release();await s.app.close()}
})

test('run-only approval retains explicit Finding acceptance and verified leads do not advertise another test',async()=>{
 const s=await setup();try{
  const record=await s.queue();assert.equal((await s.approve(record,{saveFindingOnSuccess:false})).statusCode,202)
  const result=await s.settle(record);assert.equal(result.finding,undefined)
  const lead=s.store.readEvidence(s.panel.id,s.leadId);assert.equal(lead.tag,'lead');assert.equal(lead.verificationProgress?.state,'verified');assert.equal(lead.verificationProgress?.canVerify,false)
  assert.equal((await s.post(`/api/panels/${s.panel.id}/lab-preparation`,{id:randomUUID(),leadId:s.leadId})).statusCode,409)
  assert.equal((await s.post(`${s.route}/${record.id}/finding`,{note:'Reviewed the controlled result.'})).statusCode,200)
  assert.equal(s.store.readEvidence(s.panel.id,s.leadId).tag,'finding')
 }finally{await s.app.close()}
})

test('failed controls, non-reproductions and inconclusive results never auto-create Findings',async()=>{
 for(const [outcome,controlPassed]of [['reproduced',false],['not_reproduced',true],['inconclusive',true]]as const){
  const s=await setup({kind:'project',outcome,controlPassed,summary:'Synthetic observation only',evidence:'No target code'});try{
   const record=await s.queue();assert.equal((await s.approve(record)).statusCode,202);const result=await s.settle(record)
   assert.equal(result.finding,undefined);assert.notEqual(result.status,'reproduced');assert.equal(s.store.listEvidence(s.panel.id,0,'finding').leads.length,0);assert.equal(s.store.readEvidence(s.panel.id,s.leadId).verificationProgress?.canVerify,true)
  }finally{await s.app.close()}
 }
})

test('project-plan requests continue idempotently, block duplicate plans and the verifying agent’s report enters Findings',async()=>{
 const s=await setup();try{
  s.listed.push({id:randomUUID(),panelId:s.panel.id,parent:true,kind:'cline',mode:'terminal',label:'Parent',state:'running',scopeVersion:1,chat:true,startedAt:'now',exitCode:null})
  const payload={id:randomUUID(),leadId:s.leadId,scopeVersion:1,plan:{title:'Synthetic project plan',image:'sha256:'+'c'.repeat(64),command:['/usr/local/bin/node','/app/synthetic-check.mjs'],action:'Run only the synthetic check',expected:'Synthetic observation with a control'}}
  const response=await s.post(`${s.route}/project`,payload);assert.equal(response.statusCode,201,response.body);const record=response.json<VerificationRecord>()
  assert.equal((await s.post(`${s.route}/project`,payload)).statusCode,200)
  assert.equal((await s.post(`${s.route}/project`,{...payload,id:randomUUID()})).statusCode,409)
  assert.equal((await s.approve(record)).statusCode,400,'a researched lead needs a named verifier');assert.equal((await s.approve(record,{executor:'parent'})).statusCode,202)
  const reported=await s.post(`${s.route}/${record.id}/report`,{image:payload.plan.image,observation:{outcome:'reproduced',controlPassed:true,summary:'Synthetic report reproduced its synthetic hypothesis',evidence:'Test fixture metadata; no target code',environment:{fidelity:'full',real:['Synthetic application'],substituted:[]}}});assert.equal(reported.statusCode,200,reported.body)
  assert.ok(s.store.readTest(s.panel.id,record.id).finding)
  assert.equal(s.store.readEvidence(s.panel.id,s.leadId).tag,'finding');assert.equal(s.calls(),0,'Kraflr’s runner never executed it')
 }finally{await s.app.close()}
})

test('conditional acceptance cannot bypass a fingerprint, denial, cleanup failure or a newer researcher decision',async()=>{
 const s=await setup();try{
  const record=await s.queue();assert.equal((await s.approve(record,{planHash:'a'.repeat(64)})).statusCode,409)
  assert.equal((await s.approve(record,{choice:'deny'})).statusCode,400);assert.equal(s.calls(),0)
  s.hold();assert.equal((await s.approve(record)).statusCode,202)
  s.store.saveLeadReview(s.panel.id,s.leadId,{expectedVersion:0,status:'closed',tag:'killed_lead',note:'Researcher ruled this hypothesis out during execution.',nextAction:''})
  s.release();assert.equal((await s.settle(record)).finding,undefined);assert.equal(s.store.readEvidence(s.panel.id,s.leadId).tag,'killed_lead')
 }finally{s.release();await s.app.close()}
 const cleanup=await setup();try{cleanup.failCleanup();const record=await cleanup.queue();await cleanup.approve(record);const result=await cleanup.settle(record);assert.equal(result.status,'error');assert.equal(result.finding,undefined);assert.equal(result.cleanupPending,true)}finally{await cleanup.app.close()}
 const reviewed=await setup();try{reviewed.hold();const record=await reviewed.queue();await reviewed.approve(record);reviewed.store.saveLeadReview(reviewed.panel.id,reviewed.leadId,{expectedVersion:0,status:'open',tag:'lead',note:'Keep this open for a fresh impact review.',nextAction:''});reviewed.release();assert.equal((await reviewed.settle(record)).finding,undefined);assert.equal(reviewed.store.readEvidence(reviewed.panel.id,reviewed.leadId).tag,'lead')}finally{reviewed.release();await reviewed.app.close()}
})
