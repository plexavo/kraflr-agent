import assert from'node:assert/strict'
import test from'node:test'
import{randomUUID}from'node:crypto'
import{mkdtemp,rm,realpath}from'node:fs/promises'
import{join,relative}from'node:path'
import{tmpdir}from'node:os'
import{setTimeout as delay}from'node:timers/promises'
import{NativePrompt}from'../cli/native-prompt.ts'
import{openStore}from'../server/db.ts'
import{emptyScope}from'../shared/research.ts'
import{createCollaboration}from'../cli/collaboration.ts'
import{exchangeRecord,saveConversation}from'../cli/agent-records.ts'
import{recordSlice}from'../cli/records.ts'
import type{AgentTerminalInfo}from'../shared/agent-terminal.ts'
function setup(store:ReturnType<typeof openStore>){const panel=store.createPanel({name:'Communication QA',type:'source'});store.saveScope(panel.id,0,{...emptyScope,targetName:'No-tools communication',repositoryMode:'discover',repositoryDiscovery:'No target. Test messages only.'});return panel}
function agent(panelId:string,label:string,parent=false):AgentTerminalInfo{return{id:randomUUID(),panelId,label,parent,kind:'cline',mode:'terminal',state:'running',chat:true,scopeVersion:1,startedAt:new Date().toISOString(),exitCode:null,promptReady:true}}
const composer='\x1b[20;1H\x1b[2K› Ask anything...\x1b[23;1HPlan   Act'

test('native input captures submitted messages even when hooks omit the prompt, without treating pasted newlines as submission',async()=>{
 const prompt=new NativePrompt(100,26),output=(text:string)=>new Promise<void>(done=>prompt.output(text,done))
 try{
  await output('\x1b[2J'+composer)
  assert.equal(prompt.input('\x1b[200~Compare ALPHA\nand '),undefined)
  assert.equal(prompt.input('BETA\x1b[201~'),undefined)
  await output(composer)
  assert.equal(prompt.input('\r'),'Compare ALPHA\nand BETA')
  prompt.hook('TaskComplete')
  prompt.input('Review wrong');prompt.input('\x15');prompt.input('Review twox');prompt.input('\x7f')
  assert.equal(prompt.input('\r'),'Review two')
  prompt.hook('TaskComplete');assert.equal(prompt.input('/models\r'),undefined)
  assert.equal(prompt.input('\x1b[<0;3;20M'),undefined)
  assert.equal(prompt.input('\x1b[200~Check the comparison\x1b[201~\r'),'Check the comparison')
 }finally{prompt.dispose()}
})

test('native prompt recovers after mouse input and clearing a draft, but never through menus, approvals or active turns',async()=>{
 const prompt=new NativePrompt(100,26),output=(text:string)=>new Promise<void>(done=>prompt.output(text,done))
 try{
  await output('\x1b[2J'+composer);await delay(190);assert.equal(prompt.status().ready,true)
  prompt.input('\x1b[<0;3;20M');assert.equal(prompt.status().ready,true)
  prompt.input('hello');await output('\x1b[20;1H\x1b[2K› hello');await delay(190);assert.equal(prompt.status().ready,false)
  prompt.input('\x15');await output(composer);await delay(190);assert.equal(prompt.status().ready,true)
  await output('\x1b[22;1HSelect a model');await delay(190);assert.match(prompt.status().reason,/menu/i)
  await output('\x1b[2J'+composer+'\x1b[2;1HCline needs permission\x1b[22;1H[y] Approve  [n] Deny');await delay(190);assert.match(prompt.status().reason,/response/)
  await output('\x1b[2J'+composer);prompt.hook('TaskStart');await delay(190);assert.equal(prompt.status().ready,false)
  prompt.hook('TaskComplete');assert.equal(prompt.status().ready,true)
  prompt.resize(100,50);await output('\x1b[2J\x1b[5;1H❯ What can I do for you?\x1b[8;1HPlan   Act');assert.equal(prompt.status().ready,true,'The native composer may sit well above the bottom of a tall pane')
 }finally{prompt.dispose()}
})
test('parent and child choices persist, child hooks cannot steal parent, and an explicit parent replaces an older one',()=>{
 const store=openStore(':memory:'),panel=setup(store)
 try{
  const child=agent(panel.id,'Child'),parent=agent(panel.id,'Parent'),next=agent(panel.id,'Next parent')
  for(const [item,role]of [[child,'child'],[parent,'parent'],[next,'parent']]as const){store.saveAgentSession({...item,nativeId:'pty:',scopeVersion:1,role});if(item===child){assert.equal(store.agentParent(panel.id),undefined);store.saveAgentNativeId(panel.id,child.id,'pty:child-native');assert.equal(store.agentParent(panel.id),undefined)}}
  assert.equal(store.agentParent(panel.id),next.id);assert.equal(store.findSavedAgent(panel.id,parent.id)?.role,'child');assert.equal(store.findSavedAgent(panel.id,next.id)?.role,'parent')
 }finally{store.close()}
})

test('a solo native conversation keeps repository discovery review available without the removed prompt composer',()=>{
 const store=openStore(':memory:'),panel=setup(store),parent=agent(panel.id,'Parent',true)
 try{
  saveConversation(store,parent,'discovery','Find the official repository','```kraflr-result\n'+JSON.stringify({summary:'Synthetic metadata only',leads:[],repositorySuggestion:{targetName:'Synthetic project',url:'https://example.test/org/repo',sourceUrl:'https://example.test/project',reason:'Synthetic supporting metadata',revision:''}})+'\n```')
  assert.equal(store.latestRepositorySuggestion(panel.id)?.url,'https://example.test/org/repo')
  assert.equal(store.listEvidence(panel.id,0,'lead').leads.length,0)
 }finally{store.close()}
})
test('a queued handoff waits for a clear native prompt, returns output, and persists full messages beside an active research record',async()=>{
 const store=openStore(':memory:'),panel=setup(store),sender=agent(panel.id,'Parent',true),child=agent(panel.id,'Child');child.promptReady=false;child.readinessReason='Unsent draft'
 let deliveries=0
 const team=createCollaboration(store,{list:()=>[sender,child],async researchTurn(){deliveries++;return'KRAFLR_COLLAB_OK '+ 'saved reply '.repeat(3000)}},(_id,text)=>text)
 try{
  const exchange=team.start(sender,'Child','Return a harmless confirmation.');assert.equal(store.readResearchRun(panel.id,exchange.id).status,'running')
  await delay(200);assert.equal(deliveries,0);assert.match(store.readResearchRun(panel.id,exchange.id).phase,/draft/)
  assert.throws(()=>team.start(child,'Parent','A circular request'),/cycle/)
  child.promptReady=true;child.readinessReason=undefined
  const response=await exchange.done();assert.match(response.reply,/KRAFLR_COLLAB_OK/);assert.equal(deliveries,1)
  const saved=store.readResearchRun(panel.id,exchange.id);assert.equal(saved.status,'completed');assert.ok(saved.tasks[0]!.fullReply!.length>16000);assert.match(recordSlice(saved).text,/harmless confirmation/);assert.equal(team.inbox(child)[0]?.id,exchange.id)
  const other=agent(randomUUID(),'Other panel');assert.throws(()=>team.start(sender,other.id,'No cross-panel message'),/same panel/)
 }finally{await team.close();store.close()}
})
test('communication and native replies survive restart, deduplicate and preserve interruption without creating findings',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-record-qa-')),file=join(folder,'qa.sqlite')
 let store=openStore(file);const panel=setup(store),sender=agent(panel.id,'Parent',true),child=agent(panel.id,'Child'),queued=exchangeRecord(sender,child,'Remember this queued task')
 try{
  store.saveAgentRecord(queued);saveConversation(store,sender,'native-turn','A harmless question','A harmless answer.');saveConversation(store,sender,'native-turn','A harmless question','A duplicate answer must not replace it.')
  assert.equal(store.listResearchRuns(panel.id).length,2);store.close();store=openStore(file);store.interruptResearchRuns()
  assert.equal(store.readResearchRun(panel.id,queued.id).status,'interrupted')
  const conversation=store.listResearchRuns(panel.id).find(run=>run.purpose==='conversation')!;assert.equal(conversation.fullReply,'A harmless answer.');assert.equal(conversation.objective,'A harmless question');assert.equal(store.listEvidence(panel.id,0,'finding').leads.length,0)
 }finally{store.close();assert.ok(relative(base,folder).startsWith('kraflr-record-qa-'));await rm(folder,{recursive:true,force:true})}
})
