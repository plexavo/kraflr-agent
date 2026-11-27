import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp,realpath,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { openStore,StoreError } from '../server/db.ts'
import { buildApp } from '../server/app.ts'
import { fixturePlan,verificationHash,verificationFailure,VerificationExecutionError } from '../server/verification-runner.ts'
import { agentVerification } from '../cli/agent-verification.ts'
import { verificationNotifications } from '../cli/verification-notifications.ts'
import { createDelivery } from '../cli/delivery.ts'
import { ApprovalInput } from '../cli/approval-input.ts'
import type { ResearchRun,ResearchLead } from '../shared/research-run.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { VerificationRecord } from '../shared/verification.ts'
import { emptyScope } from '../shared/research.ts'
const hypothesis:ResearchLead={kind:'lead',title:'Synthetic ownership hypothesis',path:'synthetic.txt',startLine:174,endLine:184,explanation:'Synthetic metadata for deduplication only.',security:{hypothesis:'A synthetic ownership boundary needs review.',attackPath:'A synthetic caller reaches the synthetic path.',impact:'Synthetic fixture data could be returned.'}}
function add(store:ReturnType<typeof openStore>,panelId:string,lead:ResearchLead){const run:ResearchRun={id:randomUUID(),panelId,parentId:randomUUID(),parentName:'Fixture',scopeVersion:1,objective:'Metadata only',status:'running',phase:'Fixture',startedAt:new Date().toISOString(),endedAt:null,summary:'',tasks:[],leads:[],deadEnds:[],nextSteps:[]};store.startResearchRun(run);store.saveResearchRun({...run,status:'completed',endedAt:new Date().toISOString(),leads:[lead]});return run.id+':0'}

test('overlapping citations of the same named lead update one identity without merging separate flaws',()=>{
 const store=openStore(':memory:');try{const panel=store.createPanel({name:'Dedup metadata',type:'source'});store.saveScope(panel.id,0,{...emptyScope,targetName:'Synthetic',repositoryMode:'discover',repositoryDiscovery:'Metadata test only'})
  const first=add(store,panel.id,hypothesis),second=add(store,panel.id,{...hypothesis,startLine:178,endLine:180,title:'  Synthetic   ownership hypothesis ',explanation:'A narrower citation, not a new lead.'})
  assert.equal(store.readEvidence(panel.id,second).id,first);assert.equal(store.listEvidence(panel.id,0,'lead').leads.length,1);assert.equal(store.readEvidence(panel.id,first).startLine,178)
  add(store,panel.id,{...hypothesis,startLine:220,endLine:230});add(store,panel.id,{...hypothesis,title:'Different synthetic flaw'});assert.equal(store.listEvidence(panel.id,0,'lead').leads.length,3)
 }finally{store.close()}
})

test('legacy overlapping duplicates reconcile while keeping aliases, researcher closure and verification history',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-dedup-overlap-')),file=join(folder,'state.sqlite');let store=openStore(file)
 try{const panel=store.createPanel({name:'Legacy overlap',type:'source'});store.saveScope(panel.id,0,{...emptyScope,targetName:'Metadata',repositoryMode:'discover',repositoryDiscovery:'No target'})
  const first=add(store,panel.id,hypothesis),duplicate=randomUUID()+':0',testId=randomUUID();store.close()
  const db=new DatabaseSync(file);try{
   const row=db.prepare('SELECT * FROM evidence_items WHERE id=?').get(first) as any,payload=JSON.stringify({...JSON.parse(row.payload),id:duplicate,startLine:178,endLine:180})
   db.prepare('INSERT INTO evidence_items VALUES(?,?,?,?,?,?,?)').run(duplicate,panel.id,1,'legacy-different-range',payload,new Date(Date.parse(row.createdAt)+1).toISOString(),row.updatedAt)
   db.prepare('INSERT INTO evidence_links VALUES(?,?,?,?)').run(panel.id,duplicate,duplicate,payload)
   db.prepare('INSERT INTO lead_reviews(panelId,leadId,version,status,note,nextAction,savedAt,tag) VALUES(?,?,?,?,?,?,?,?)').run(panel.id,duplicate,1,'closed','Preserve this researcher decision.','',new Date().toISOString(),'killed_lead')
   const plan=fixturePlan('patched');db.prepare('INSERT INTO verification_runs VALUES(?,?,?,?,?)').run(testId,panel.id,1,'error',JSON.stringify({id:testId,panelId:panel.id,leadId:duplicate,scopeVersion:1,plan,planHash:verificationHash(plan),status:'error',createdAt:new Date().toISOString(),expiresAt:new Date().toISOString(),detail:'Synthetic old engine failure'}))
  }finally{db.close()}
  store=openStore(file);assert.equal(store.listEvidence(panel.id,0).leads.length,1);assert.equal(store.readEvidence(panel.id,duplicate).id,first);assert.equal(store.readEvidence(panel.id,first).tag,'killed_lead');assert.equal(store.readEvidence(panel.id,first).verificationResults[0]!.id,testId)
 }finally{try{store.close()}catch{}assert.match(relative(base,folder),/^kraflr-dedup-overlap-[^\\/]+$/);await rm(folder,{recursive:true,force:true})}
})

test('agent verification tools expose real state and retry a saved failed plan without granting approval',async()=>{
 const store=openStore(':memory:');let calls=0
 const app=buildApp(store,4317,{verificationRunner:{async available(){return{ready:true,detail:'Synthetic engine',image:''}},async run(){calls++;throw new VerificationExecutionError({killed:true},'creating the isolated container')}}})
 const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317','content-type':'application/json'},api=async(path:string,method='GET',body?:unknown)=>{const response=await app.inject({url:path,method:method as 'GET'|'POST',headers,payload:body as any});if(response.statusCode>=400)throw new StoreError(response.statusCode,response.json().message);return response.json()}
 try{const panel=await api('/api/verification/fixture','POST',{}),lead=store.listEvidence(panel.id,0).leads[0]!,parent:AgentTerminalInfo={id:randomUUID(),panelId:panel.id,parent:true,kind:'opencode',mode:'terminal',label:'Parent',state:'running',scopeVersion:1,chat:true,promptReady:true,startedAt:'now',exitCode:null},record=await api(`/api/panels/${panel.id}/verification`,'POST',{variant:'vulnerable'})
  assert.equal((await agentVerification(store,api,parent,'run',record.id)).record.status,'pending');assert.equal(calls,0)
  await assert.rejects(agentVerification(store,api,parent,'approve',record.id),/commands/)
  await assert.rejects(agentVerification(store,api,{...parent,parent:false},'run',record.id),/Parent manages/)
  await api(`/api/panels/${panel.id}/verification/${record.id}/decision`,'POST',{choice:'approve',planHash:record.planHash,note:'Approve synthetic runner probe'})
  for(let i=0;i<100&&store.readTest(panel.id,record.id).status==='running';i++)await delay(5)
  const failed=(await agentVerification(store,api,parent,'status',record.id)).record;assert.equal(failed.status,'error');assert.equal(failed.failure.code,'docker_timeout')
  const retried=(await agentVerification(store,api,parent,'retry',record.id)).record;assert.equal(retried.leadId,lead.id);assert.equal(retried.planHash,record.planHash);assert.equal(retried.status,'pending');assert.equal(retried.decision,undefined);assert.equal(calls,1)
  assert.equal((await agentVerification(store,api,parent,'retry',record.id)).record.id,retried.id);assert.equal(store.listEvidence(panel.id,0,'lead').leads.length,1)
 }finally{await app.close()}
})

test('runner outcomes return automatically to an available Parent and notification text cannot create leads',async()=>{
 const store=openStore(':memory:'),panel=store.createPanel({name:'Notification QA',type:'source'});store.saveScope(panel.id,0,{...emptyScope,targetName:'No target',repositoryMode:'discover',repositoryDiscovery:'Notification metadata only'})
 const parent:AgentTerminalInfo={id:randomUUID(),panelId:panel.id,parent:true,kind:'cline',mode:'terminal',label:'Parent',state:'running',scopeVersion:1,chat:true,promptReady:false,startedAt:'now',exitCode:null};let received=0
 const terminals={list:()=>[parent],async researchTurn(_panel:string,_id:string,text:string){received++;assert.match(text,/docker_timeout/);assert.match(text,/Do not do research/);return 'The saved test failed to create its container. Retry the saved plan after checking Docker.'}},delivery=createDelivery(store,terminals as never),notifications=verificationNotifications(terminals as never,delivery)
 try{const record={id:randomUUID(),panelId:panel.id,leadId:randomUUID()+':0',scopeVersion:1,status:'error',detail:'Container operation timed out',failure:{stage:'creating the isolated container',code:'docker_timeout',retryable:true,hint:'Retry the saved plan.'}} as VerificationRecord
  notifications.enqueue(record);notifications.enqueue(record);await delay(30);assert.equal(received,0);parent.promptReady=true
  for(let i=0;i<80&&!store.listResearchRuns(panel.id).some(run=>run.status==='completed');i++)await delay(10)
  const saved=store.listResearchRuns(panel.id);assert.equal(saved.length,1);assert.equal(saved[0]!.status,'completed');assert.match(saved[0]!.tasks[0]!.fullReply!,/saved test failed/);assert.equal(received,1);assert.equal(store.listEvidence(panel.id,0).leads.length,0)
 }finally{await delivery.close();store.close()}
})

test('container errors provide bounded actionable diagnostics and approval phrases only request review',()=>{
 const failure=verificationFailure({killed:true,stderr:'sensitive-value-should-not-appear'},'creating the isolated container');assert.equal(failure.code,'docker_timeout');assert.doesNotMatch(JSON.stringify(failure),/sensitive-value/)
 assert.equal(verificationFailure({stderr:'failed to connect to Docker daemon'},'creating').code,'docker_unavailable')
 const input=new ApprovalInput();assert.equal(input.input('I approve'),false);assert.equal(input.input('\r'),true);assert.equal(input.input('The agent says I approve\r'),false);assert.equal(input.input('\x1b[200~I approve\nmore text\x1b[201~\r'),false);assert.equal(input.input('\x1b[200~I app'),false);assert.equal(input.input('rove\x1b[201~\r'),true);assert.equal(input.input('I app\x1b[Drove\r'),false)
})
