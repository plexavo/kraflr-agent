import assert from'node:assert/strict'
import test from'node:test'
import{randomUUID}from'node:crypto'
import{setTimeout as delay}from'node:timers/promises'
import{openStore}from'../server/db.ts'
import{createResearchTeam}from'../server/research-team.ts'
import{emptyScope}from'../shared/research.ts'
import{terminalWork}from'../shared/terminal-team.ts'
import{saveConversation}from'../cli/agent-records.ts'
import{recordSlice}from'../cli/records.ts'
import type{AgentTerminalInfo}from'../shared/agent-terminal.ts'
const json=(value:object)=>'```kraflr-result\n'+JSON.stringify({leads:[],deadEnds:[],nextSteps:[],...value})+'\n```'
function setup(){const store=openStore(':memory:'),panel=store.createPanel({name:'Native conversation team',type:'source'});store.saveScope(panel.id,0,{...emptyScope,targetName:'Harmless comparisons',repositoryMode:'discover',repositoryDiscovery:'No target access in tests.'});const parent:AgentTerminalInfo={id:randomUUID(),panelId:panel.id,kind:'opencode',mode:'terminal',label:'Parent',state:'running',chat:true,parent:true,startedAt:'now',scopeVersion:1,exitCode:null},child={...parent,id:randomUUID(),kind:'cline' as const,label:'Child',parent:false,promptReady:true};return{store,panel,parent,child}}
async function finished(store:ReturnType<typeof openStore>,panel:string){for(let i=0;i<100;i++){const run=store.listResearchRuns(panel)[0];if(run&&run.status!=='running')return run;await delay(10)}throw Error('The native conversation team did not finish')}

test('terminal work classification excludes greetings, local commands and explicit solo work',()=>{
 for(const text of['hi','thanks!','/model','Please review this alone, parent-only','Do not delegate this comparison'])assert.equal(terminalWork(text),false,text)
 for(const text of['Compare two harmless strings and share the work','Hey, investigate the scoped project with your child','Review this comparison for accuracy','Continue','Fix it'])assert.equal(terminalWork(text),true,text)
})
test('a normal parent terminal reply becomes a child task and consolidated parent reply without resending the initial prompt',async()=>{
 const{store,panel,parent,child}=setup(),calls:string[]=[]
 const team=createResearchTeam(store,{list:()=>[parent,child],async researchTurn(_panel,id,prompt){calls.push(id);if(id===child.id){assert.match(prompt,/Count the two strings/);return json({summary:'CHILD_OK',reply:'The child counted two strings.',tasks:[]})}assert.match(prompt,/CHILD_OK/);return json({summary:'PARENT_FINAL_OK',reply:'The child result was checked.',tasks:[]})}},undefined,true)
 try{
  const native={id:'native-message',prompt:'Compare two harmless strings and delegate a useful part.',reply:json({summary:'Parent task plan',tasks:[{worker:'worker-1',objective:'Count the two strings; use no tools.'}]})}
  assert.equal(team.acceptNative(parent,native),true);const run=await finished(store,panel.id)
  assert.deepEqual(calls,[child.id,parent.id]);assert.equal(run.status,'completed');assert.equal(run.tasks[0]?.sessionId,child.id);assert.equal(run.tasks[0]?.status,'completed');assert.match(run.fullReply!,/Parent task plan/);assert.match(run.fullReply!,/PARENT_FINAL_OK/)
  assert.equal(team.acceptNative(parent,native),true);assert.equal(calls.length,2)
  saveConversation(store,parent,native.id,native.prompt,native.reply);assert.equal(store.listResearchRuns(panel.id).length,1,'The adopted initial reply must not also appear as a duplicate raw conversation')
 }finally{await team.close();store.close()}
})
test('a Parent that does not delegate gets no automatic child review, and a busy child still waits for an explicit task',async()=>{
 const{store,panel,parent,child}=setup();child.promptReady=false
 const calls:string[]=[]
 const team=createResearchTeam(store,{list:()=>[parent,child],async researchTurn(_panel,id,prompt){calls.push(id);if(id===child.id)assert.match(prompt,/Research assignment proposed by parent/);return json({summary:id===child.id?'CHILD_DONE':'Parent consolidated',tasks:[]})}},undefined,true)
 try{
  // No tasks array: nothing is assigned and no child is asked to review.
  assert.equal(team.acceptNative(parent,{id:'native-review',prompt:'Review this harmless comparison and check its assumptions.',reply:'My initial plain English answer.'}),true)
  const alone=await finished(store,panel.id);assert.equal(alone.tasks.length,0);assert.deepEqual(calls,[])
  // An explicit task waits for the busy child, then runs once.
  assert.equal(team.acceptNative(parent,{id:'native-explicit',prompt:'Compare two harmless strings and delegate a useful part.',reply:json({summary:'Plan',tasks:[{worker:'worker-1',objective:'Count the two strings; use no tools.'}]})}),true)
  await delay(40);assert.equal(calls.length,0);assert.match(store.listResearchRuns(panel.id)[0]!.phase,/Waiting for Child/)
  child.promptReady=true;const run=await finished(store,panel.id);assert.equal(run.tasks[0]?.automatic,false);assert.deepEqual(calls,[child.id,parent.id]);assert.match(recordSlice(run).text,/Assigned by: Parent task plan/)
 }finally{await team.close();store.close()}
})
test('by default a direct Parent conversation stays a plain session: no run is created and no child is asked',async()=>{
 const{store,panel,parent,child}=setup();let calls=0
 const team=createResearchTeam(store,{list:()=>[parent,child],async researchTurn(){calls++;return''}})
 try{
  assert.equal(team.acceptNative(parent,{id:'plain',prompt:'Compare two harmless strings and share the work',reply:json({summary:'Plan',tasks:[{worker:'worker-1',objective:'Count them.'}]})}),false)
  await delay(30);assert.equal(calls,0);assert.equal(store.listResearchRuns(panel.id).length,0)
 }finally{await team.close();store.close()}
})
test('child messages, greetings, historical replies and parent-only requests cannot start automatic team work',async()=>{
 const{store,parent,child}=setup();let calls=0
 const team=createResearchTeam(store,{list:()=>[parent,child],async researchTurn(){calls++;return''}})
 try{
  assert.equal(team.acceptNative(parent,{id:'hi',prompt:'hi',reply:'Hello'}),false)
  assert.equal(team.acceptNative(child,{id:'child',prompt:'Review this comparison',reply:'Child answer'}),false)
  assert.equal(team.acceptNative(parent,{id:'old',prompt:'Review this old comparison',reply:'Old answer',historical:true}),false)
  assert.equal(team.acceptNative(parent,{id:'solo',prompt:'Review this comparison, parent-only',reply:'Solo answer'}),false)
  assert.equal(calls,0)
 }finally{await team.close();store.close()}
})
