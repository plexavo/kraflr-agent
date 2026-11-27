import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentBridgeCommand,teamContext,teamInstructions } from '../cli/team-context.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
const agent=(panelId:string,parent=false):AgentTerminalInfo=>({id:randomUUID(),panelId,kind:parent?'opencode':'cline',mode:'terminal',label:parent?'Parent':'Child',parent,state:'running',scopeVersion:1,chat:true,promptReady:true,startedAt:'now',exitCode:null})

test('team snapshots identify the real parent, include busy children and exclude other scopes/panels and credentials',()=>{
 const panel=randomUUID(),parent=agent(panel,true),child=agent(panel),blocked=agent(panel),foreign=agent(randomUUID()),old={...agent(panel),scopeVersion:2}
 child.promptReady=false;child.readinessReason='Working';blocked.modelSelectionRequired=true
 const value=teamContext(parent,[parent,blocked,child,foreign,old],[])
 assert.equal(value.runtime,'Kraflr');assert.equal(value.self.role,'parent');assert.equal(value.team.length,3)
 assert.equal(value.team.find(item=>item.id===child.id)?.ready,false);assert.equal(value.team.find(item=>item.id===child.id)?.workerId,'worker-1');assert.equal(value.team.find(item=>item.id===blocked.id)?.workerId,null)
 assert.doesNotMatch(JSON.stringify(value),/KRAFLR_AGENT_TOKEN|password|socket|objective|authorization/)
 const stopped=teamContext(parent,[parent,{...child,state:'exited'}],[]);assert.equal(stopped.team.length,1)
 const changed=teamContext(parent,[{...parent,parent:false},{...child,parent:true}],[]);assert.equal(changed.self.role,'child');assert.equal(changed.team.find(item=>item.id===child.id)?.role,'parent')
})

test('agent instructions describe the live roster and the one-line lead command, and say Kraflr assigns no work on its own',()=>{
 const text=teamInstructions('C:/Research space','C:/Node/node.exe','C:/App/main.mjs',true)
 assert.match(text,/INSIDE Kraflr/);assert.match(text,/KRAFLR_TEAM.json/);assert.match(text,/shell failure is not evidence/);assert.match(text,/NOT a tool or shell command/);assert.match(text,/PowerShell 5.1/)
 assert.match(text,/lead --title/);assert.match(text,/does not assign work to your teammates/);assert.doesNotMatch(text,/independent child review automatically/)
})

test('the platform bridge command executes literal paths and quoted arguments without POSIX fallback syntax',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,"kraflr-bridge-quote's-")),entry=join(folder,"entry with ' quote.mjs"),execute=promisify(execFile)
 try{
  await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const prefix=agentBridgeCommand(process.execPath,entry)
  const command=prefix+" send child 'a quoted message'"
  const {stdout}=process.platform==='win32'?await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:15_000}):await execute('/bin/sh',['-c',command],{timeout:15_000})
  assert.deepEqual(JSON.parse(stdout.trim()),['agent','send','child','a quoted message'])
  if(process.platform==='win32')await assert.rejects(execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Write-Output OK || Write-Output fallback'],{windowsHide:true,timeout:15_000}),/token|InvalidEndOfLine|valid statement separator/i)
 }finally{assert.match(relative(base,folder),/^kraflr-bridge-quote's-[^\\/]+$/);await rm(folder,{recursive:true,force:true})}
})
