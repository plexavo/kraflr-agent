import assert from'node:assert/strict'
import test from'node:test'
import{mkdtemp,mkdir,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,relative,resolve}from'node:path'
import{TerminalInput}from'../cli/terminal-input.ts'
import{activity,activityGlyph,visibleAttention,orbit,kraflrAscii}from'../cli/activity.ts'
import{openStore}from'../server/db.ts'
import{createRepositoryCheckouts}from'../server/repository-checkout.ts'
import{emptyScope}from'../shared/research.ts'
import type{AgentTerminalInfo}from'../shared/agent-terminal.ts'

test('native routing frames fragmented mouse, coalesced keys and bracketed paste without dispatching pasted clicks',()=>{
 const input=new TerminalInput()
 assert.deepEqual(input.feed('\x1b[<0;'),[])
 assert.deepEqual(input.feed('9;7Mhello\x1b[<0;9;7m'),[{type:'mouse',button:0,x:8,y:6,pressed:true},{type:'data',text:'hello'},{type:'mouse',button:0,x:8,y:6,pressed:false}])
 assert.deepEqual(input.feed('\x1b[200~text\x1b[<0;9;7M\x02'),[])
 assert.deepEqual(input.feed('\x1b[201~'),[{type:'data',text:'\x1b[200~text\x1b[<0;9;7M\x02\x1b[201~'}])
 assert.deepEqual(input.feed('\x1b[A\x03'),[{type:'data',text:'\x1b[A'},{type:'data',text:'\x03'}])
 input.feed('\x1b');assert.deepEqual(input.flushEscape(),[{type:'escape'}])
 input.feed('x'.repeat(128_001));assert.equal(input.buffer,'')
 assert.deepEqual(input.feed('\x1b]11;rgb:0c0c/'),[])
 assert.deepEqual(input.feed('0c0c/0c0c\x1b'),[])
 assert.deepEqual(input.feed('\\hello'),[{type:'background',color:'rgb:0c0c/0c0c/0c0c'},{type:'data',text:'hello'}])
 assert.deepEqual(input.feed('\x1b[200~\x1b]11;rgb:00/00/00\x07\x1b[201~'),[{type:'data',text:'\x1b[200~\x1b]11;rgb:00/00/00\x07\x1b[201~'}])
})
test('approval indicators require correlated native viewport markers and never grant permission',()=>{
 assert.equal(visibleAttention(['Cline needs permission']),undefined)
 assert.equal(visibleAttention(['quoted Cline needs permission','[y] Approve [n] Deny']),undefined)
 assert.equal(visibleAttention(['Cline needs permission','[y] Approve   [n] Deny']),'approval')
 assert.equal(visibleAttention(['Cline is asking a question','How should Cline continue?']),'question')
 const agent={state:'running',activity:'idle'} as AgentTerminalInfo
 assert.equal(activity(agent,undefined,undefined,false,false),'ready')
 assert.equal(activity(agent,undefined,undefined,true,false),'active')
 assert.equal(activity(agent,undefined,'approval',true,true),'approval')
 const request={panelId:'p',terminalId:'a',permissions:[{id:'x',fingerprint:'f',action:'Read',resources:[],canApprove:false}],question:false}
 const original=JSON.stringify(request)
 assert.equal(activity(agent,request,undefined,true,true),'approval');assert.equal(JSON.stringify(request),original)
 assert.equal(activity({...agent,state:'offline'},request,undefined,false,false),'stopped')
 assert.notEqual(activityGlyph('approval',0),activityGlyph('active',0))
 assert.equal(new Set([0,180,360,540].map(orbit)).size,4)
 assert.equal(new Set([0,170,340,510].map(n=>activityGlyph('ready',n))).size,1)
 assert.equal(kraflrAscii.length,5)
})
test('missing workspace and missing pinned clone produce specific recovery instructions without rebinding source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kraflr-launch-test-')),store=openStore(':memory:'),checkout=createRepositoryCheckouts(store)
 try{
  const p=store.createPanel({name:'Workspace recovery',type:'source'}),workspace=join(root,'missing')
  store.saveScope(p.id,0,{...emptyScope,targetName:'Synthetic UI QA',repository:'https://example.test/ui-qa',workspacePath:workspace,revision:'HEAD'})
  await assert.rejects(checkout.prepare(p.id),/saved workspace folder is missing.*Open Scope/)
  await mkdir(workspace)
  store.saveCheckout({panelId:p.id,scopeVersion:1,repository:'https://example.test/ui-qa',path:join(workspace,'source'),commit:'a'.repeat(40),preparedAt:new Date().toISOString()})
  await assert.rejects(checkout.prepare(p.id),/pinned source clone is missing.*update the workspace in Scope/)
  assert.equal(store.readPanel(p.id).scopeVersion,1);assert.equal(store.readPanel(p.id).checkout?.commit,'a'.repeat(40))
 }finally{await checkout.close();store.close();const target=resolve(root),base=resolve(tmpdir());assert.ok(relative(base,target).startsWith('kraflr-launch-test-'));await rm(target,{recursive:true,force:true})}
})
