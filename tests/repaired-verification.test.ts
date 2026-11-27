import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readdir,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,relative} from 'node:path'
import Fastify from 'fastify'
import {openStore} from '../server/db.ts'
import {buildApp} from '../server/app.ts'
import {registerLabPreparations} from '../server/lab-preparation.ts'
import {createAgentTerminals} from '../server/agent-terminals.ts'
import {preparedLabPlan,queuePreparedVerification} from '../server/prepared-verification.ts'
import {emptyScope} from '../shared/research.ts'
import type {ResearchRun} from '../shared/research-run.ts'
import type {VerificationRunner} from '../server/verification-runner.ts'

const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317','content-type':'application/json'}
async function setup(t:test.TestContext){
 const base=await realpath(tmpdir()),workspace=await mkdtemp(join(base,'kraflr-repaired-lab-')),store=openStore(':memory:')
 t.after(async()=>{assert.match(relative(base,await realpath(workspace)),/^kraflr-repaired-lab-[^\\/]+$/);await rm(workspace,{recursive:true,force:true})})
 const panel=store.createPanel({name:'Synthetic repaired lab',type:'source'});store.saveScope(panel.id,0,{...emptyScope,repository:'https://example.test/synthetic',revision:'v1',workspacePath:workspace})
 const source:ResearchRun={id:randomUUID(),panelId:panel.id,parentId:randomUUID(),parentName:'Fixture',scopeVersion:1,objective:'Synthetic metadata only',status:'running',phase:'Metadata',startedAt:new Date().toISOString(),endedAt:null,summary:'',tasks:[],leads:[],deadEnds:[],nextSteps:[]}
 store.startResearchRun(source);store.saveResearchRun({...source,status:'completed',endedAt:new Date().toISOString(),leads:[{kind:'lead',title:'Synthetic ownership hypothesis',path:'synthetic.txt',startLine:1,endLine:1,explanation:'Synthetic test metadata, not target code.',security:{hypothesis:'A synthetic boundary requires checking.',attackPath:'A fictional caller requests a fictional record.',impact:'A fictional record might cross an ownership boundary.'}}]})
 const leadId=source.id+':0',id=randomUUID(),directory=join(workspace,'.kraflr',panel.id,'labs','lab-'+id)
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'Dockerfile'),'FROM scratch\n')
 const plan=(letter:string)=>({title:'Harmless metadata plan',image:'sha256:'+letter.repeat(64),command:['/usr/bin/printf','synthetic'],action:'Synthetic runner test only.',expected:'An inconclusive result, never a finding.'})
 const preparation:ResearchRun={...source,id,leadId,purpose:'verification',labDirectory:directory,labPlan:plan('a'),status:'completed',phase:'Original lab ready',endedAt:new Date().toISOString()}
 store.startResearchRun({...preparation,status:'running'});store.saveResearchRun(preparation)
 const checkpoint=async(letter:string)=>writeFile(join(directory,'kraflr-verification.json'),JSON.stringify(plan(letter)))
 await checkpoint('a')
 return{store,panel,leadId,preparation,directory,workspace,plan,checkpoint}
}

test('a repaired checkpoint replaces failed/pending linked plans with fresh approval and never replays the old image',async t=>{
 const s=await setup(t)
 const parent={id:randomUUID(),panelId:s.panel.id,parent:true,kind:'cline',label:'Parent',chat:true,state:'running',scopeVersion:1}
 const runner:VerificationRunner={async available(plan){return{ready:true,image:plan?.image??'',detail:'Synthetic inspector only'}},async run(){throw Error('Kraflr never runs a researched lead')}}
 const app=buildApp(s.store,4317,{verificationRunner:runner,terminals:{...createAgentTerminals(s.workspace,s.store),list:()=>[parent]} as any}),root=`/api/panels/${s.panel.id}`,post=(url:string,payload:object)=>app.inject({method:'POST',url,headers,payload})
 const approve=(record:{id:string;planHash:string},note:string)=>post(`${root}/verification/${record.id}/decision`,{choice:'approve',executor:'parent',planHash:record.planHash,note})
 try{
  await app.ready();const initial=await queuePreparedVerification(s.store,runner.available,{...s.preparation,labPlan:s.plan('a')});s.store.linkRecoveredVerification(s.panel.id,s.preparation.id,initial.id)
  assert.equal((await approve(initial,'Synthetic initial approval')).statusCode,202)
  assert.equal((await post(`${root}/verification/${initial.id}/failure`,{message:'Synthetic first failure'})).statusCode,200)
  assert.equal(s.store.readTest(s.panel.id,initial.id).status,'error')
  await s.checkpoint('b')
  const page=(await app.inject({url:`${root}/lab-preparation?lead=${s.leadId}`,headers})).json();assert.equal(page.preparations[0].planChanged,true);assert.equal(page.preparations[0].canRecover,true)
  const unchanged=await post(`${root}/verification/${initial.id}/retry`,{});assert.equal(unchanged.statusCode,409);assert.match(unchanged.body,/repaired lab|Repair the lab/)
  const recover=async()=>{const response=await post(`${root}/lab-preparation/recover`,{runId:s.preparation.id});assert.equal(response.statusCode,200,response.body);return response.json()}
  const repaired=await recover();assert.equal(repaired.plan.image,s.plan('b').image);assert.equal(repaired.status,'pending');assert.equal(repaired.decision,undefined);assert.equal(repaired.finding,undefined);assert.equal((await recover()).id,repaired.id)
  await s.checkpoint('c');assert.equal((await approve(repaired,'Obsolete pending plan')).statusCode,409)
  const next=await recover();assert.notEqual(next.planHash,repaired.planHash);assert.equal(s.store.readTest(s.panel.id,repaired.id).status,'stale');assert.equal(s.store.readTest(s.panel.id,initial.id).decision?.saveFindingOnSuccess,true)
  assert.equal((await approve(repaired,'Old approval must fail')).statusCode,409)
  assert.equal((await approve(next,'Fresh exact approval')).statusCode,202)
  await s.checkpoint('d');assert.equal((await post(`${root}/lab-preparation/recover`,{runId:s.preparation.id})).statusCode,409,'a running test blocks replacing its plan')
  const reported=await post(`${root}/verification/${next.id}/report`,{image:next.plan.image,observation:{outcome:'inconclusive',controlPassed:true,summary:'Synthetic non-finding',evidence:'No target was run'}});assert.equal(reported.statusCode,200,reported.body)
  assert.equal(s.store.readTest(s.panel.id,next.id).status,'inconclusive');assert.equal(s.store.listEvidence(s.panel.id,0,'lead').leads.length,1);assert.equal(s.store.listEvidence(s.panel.id,0,'finding').leads.length,0)
 }finally{await app.close()}
})

test('repair preparation reuses an already linked completed lab folder instead of allocating another lab',async t=>{
 const s=await setup(t),app=Fastify(),parent={id:randomUUID(),panelId:s.panel.id,parent:true,chat:true,state:'running',scopeVersion:1};let bound=0,captured=''
 const initial=await queuePreparedVerification(s.store,async()=>({ready:true,detail:'Metadata only',image:''}),s.preparation);s.store.linkRecoveredVerification(s.panel.id,s.preparation.id,initial.id);s.store.resolveVerification(s.panel.id,initial.id,initial.planHash,'deny','Synthetic test ended')
 registerLabPreparations(app,s.store,{list:()=>[parent],async bindRepository(){bound++}} as any,{start(_panel:string,_prompt:string,id:string,_lead:string,options:{labDirectory:string}){captured=options.labDirectory;return{id}}} as any,{async prepare(){}} as any,async()=>({ready:true,detail:'Metadata only',image:''}))
 try{const response=await app.inject({method:'POST',url:`/api/panels/${s.panel.id}/lab-preparation`,payload:{id:randomUUID(),leadId:s.leadId}});assert.equal(response.statusCode,202,response.body);assert.equal(captured,s.directory);assert.equal(bound,1);assert.equal((await readdir(join(s.workspace,'.kraflr',s.panel.id,'labs'))).length,1)}finally{await app.close();s.store.close()}
})

test('an invalid repaired checkpoint cannot fall back to the obsolete image from the original report',async t=>{
 const s=await setup(t)
 try{await writeFile(join(s.directory,'kraflr-verification.json'),'{broken');assert.equal(await preparedLabPlan(s.preparation),undefined)}finally{s.store.close()}
})
