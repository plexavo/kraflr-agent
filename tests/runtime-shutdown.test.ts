import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'
import { emptyScope } from '../shared/research.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { createResearchTeam } from '../server/research-team.ts'

test('terminal-only runtime shutdown aborts active team work and saves interruption before closing SQLite without an HTTP listener',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-shutdown-qa-')),file=join(folder,'state.sqlite'),store=openStore(file)
 const panel=store.createPanel({name:'Synthetic shutdown check',type:'source'})
 store.saveScope(panel.id,0,{...emptyScope,targetName:'Harmless messages',repositoryMode:'discover',repositoryDiscovery:'No target access.'})
 const parent:AgentTerminalInfo={id:randomUUID(),panelId:panel.id,kind:'cline',mode:'terminal',label:'Parent',parent:true,state:'running',chat:true,promptReady:true,scopeVersion:1,startedAt:'now',exitCode:null},child={...parent,id:randomUUID(),label:'Child',parent:false}
 let started=false,aborted=false,terminalsClosed=false,team:ReturnType<typeof createResearchTeam>|undefined
 const terminals={list:()=>[parent,child],async researchTurn(_panel:string,_id:string,_text:string,_scope:number,signal:AbortSignal){started=true;return await new Promise<string>((_resolve,reject)=>{const abort=()=>{aborted=true;reject(signal.reason)};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})})},async close(){terminalsClosed=true}} as unknown as AgentTerminals
 const app=buildApp(store,4317,{terminals,coordinateDirectTurns:true,onResearchTeam:value=>{team=value}})
 try{
  await app.ready();assert.ok(team)
  assert.equal(team.acceptNative(parent,{id:'native-shutdown',prompt:'Compare ALPHA and BETA with the child.',reply:'```kraflr-result\n'+JSON.stringify({summary:'Assign comparison',tasks:[{worker:'worker-1',objective:'Compare the two harmless words.'}],leads:[]})+'\n```'}),true)
  for(let i=0;i<30&&!started;i++)await delay(10)
  assert.equal(started,true)
  await app.close()
  assert.equal(aborted,true);assert.equal(terminalsClosed,true)
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false})
  try{const row=db.prepare('SELECT record FROM research_runs').get() as{record:string},run=JSON.parse(row.record);assert.equal(run.status,'interrupted');assert.equal(run.tasks[0].status,'interrupted');assert.match(run.fullReply,/Assign comparison/)}finally{db.close()}
 }finally{
  await team?.close().catch(()=>{});await app.close().catch(()=>{})
  assert.match(relative(base,folder),/^kraflr-shutdown-qa-[^\\/]+$/);await rm(folder,{recursive:true,force:true})
 }
})
