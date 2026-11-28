import { spawn } from 'node:child_process'
import { mkdir, open, realpath } from 'node:fs/promises'
import { openSync, closeSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { address, RpcClient } from './ipc.ts'

const root=fileURLToPath(new URL('../',import.meta.url))
const args=process.argv.slice(2)
const at=args.indexOf('--data-dir')
if(at>=0&&!args[at+1]?.trim())throw new Error('Provide a data folder after --data-dir.')
const dataDir=resolve(at>=0?args.splice(at,2)[1]??'':process.env.KRAFLR_DATA_DIR??(existsSync(join(root,'data','kraflr.sqlite'))?join(root,'data'):join(process.platform==='win32'?process.env.LOCALAPPDATA??homedir():process.env.XDG_STATE_HOME??join(homedir(),'.local','state'),'Kraflr','data')))
const command=args.shift()??'tui'
/** Read a bounded file that must live inside this session's scratch folder, so an agent cannot aim a command at arbitrary files. */
async function scratchFile(rest:string[],usage:string,limit:number){
  if(rest[0]!=='--file'||!rest[1])throw new Error(`Use kraflr agent ${usage} from this session’s scratch folder.`)
  const scratch=process.env.KRAFLR_AGENT_SCRATCH
  // Without this, a shell whose cwd has moved elsewhere (for example into a pinned source checkout) would compare the
  // file against itself and always pass, silently defeating the point of the check.
  if(!scratch)throw new Error('KRAFLR_AGENT_SCRATCH is not set in this shell; Kraflr sets it for every agent session.')
  const path=await realpath(resolve(rest[1])),cwd=await realpath(scratch),offset=relative(cwd,path)
  if(isAbsolute(offset)||offset==='..'||offset.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw new Error('Keep the file inside the current session scratch folder.')
  const file=await open(path,'r')
  try{const buffer=Buffer.alloc(limit+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>limit)throw new Error('The file is too large.');return buffer.toString('utf8',0,bytesRead)}finally{await file.close()}
}
/** The native terminal module is the one dependency that can be missing after an install (it is built on Linux). Say so plainly instead of crashing the runtime with a stack trace in its log. */
function nativeTerminalProblem(){
  try{createRequire(import.meta.url)('node-pty');return undefined}
  catch(error){return 'The native terminal module (node-pty) is not built, so agents cannot be started: '+(error instanceof Error?error.message.split('\n')[0]:'unknown error')+'. Run: node scripts/ensure-native-terminal.mjs (needs Python 3, make and a C++ compiler on Linux).'}
}
if(command==='--core'){
  const{runCore}=await import('./core.ts');await runCore(dataDir)
}else if(command==='--help'||command==='help'||command==='-h'){
  console.log('Kraflr — terminal-first security research\n\n  kraflr                  Open the terminal workspace\n  kraflr attach ID         Open an existing agent in this terminal\n  kraflr status           Runtime and active agents (JSON)\n  kraflr panels           List research panels\n  kraflr doctor           Check runtime, agents and platform\n  kraflr stop             Stop this workspace runtime and agents\n  kraflr install          Install per-user command shims\n  kraflr --data-dir PATH  Choose a separate data directory\n\nInside the workspace: click controls, or use Tab and Enter.\nAgents run in independent panes inside Kraflr. Click a pane to type; click navigation to return to controls.\nNative panes run your installed OpenCode, Cline and Claude Code with their own sign-ins.\nNo browser is required. Four live agents maximum.\n')
}else if(command==='install'){
  const{install}=await import('./install.ts');console.log(await install(root))
}else if(command==='agent'){
  const socket=process.env.KRAFLR_SOCKET,token=process.env.KRAFLR_AGENT_TOKEN,agent=process.env.KRAFLR_AGENT_ID
  if(!socket||!token||!agent)throw new Error('Agent commands are available only inside an agent launched by Kraflr.')
  const rpc=new RpcClient({socket,token,agent})
  try{
    const sub=args.shift()??'context'
    let result:unknown
    if(sub==='context'||sub==='team')result=await rpc.call('context')
    else if(sub==='inbox')result=await rpc.call('inbox')
    else if(sub==='ask'||sub==='send'){const to=args.shift();result=await rpc.call(sub,{to,text:args.join(' ')},0x7fffffff)}
    else if(sub==='note')result=await rpc.call('note',{text:args.join(' ')})
    else if(sub==='verification'){
      const operation=args.shift()??'status',target=args.shift()
      if(operation==='report'){result=await rpc.call('verification',{operation,target,payload:await scratchFile(args,'verification report <test-id> --file result.json',16_000)})}
      else if(operation==='fail'){
        // --message says what went wrong; --file adds container or build output from the session scratch folder.
        const words:string[]=[];let file:string[]|undefined,inMessage=false
        for(let i=0;i<args.length;i++){const arg=args[i]!;if(arg==='--message'){inMessage=true;continue}if(arg==='--file'){file=['--file',args[++i]??''];inMessage=false;continue}if(inMessage)words.push(arg)}
        const message=words.join(' ').trim()
        const output=file?await scratchFile(file,'verification fail <test-id> --message "…" --file output.txt',16_000):''
        result=await rpc.call('verification',{operation,target,payload:JSON.stringify({message,output})})
      }
      else result=await rpc.call('verification',{operation,target})
    }
    else if(sub==='map'){
      // `map` reads the saved attack-surface map. `map --file map.md` (from the session folder) or `map --text "..."` saves one; add --append to extend it.
      const append=args.includes('--append'),rest=args.filter(arg=>arg!=='--append')
      if(rest[0]==='--file')result=await rpc.call('map',{text:await scratchFile(rest,'map --file map.md [--append]',40_000),append})
      else if(rest[0]==='--text')result=await rpc.call('map',{text:rest.slice(1).join(' '),append})
      else result=await rpc.call('map',{})
    }
    else if(sub==='lead'||sub==='confirm'||sub==='kill'){
      // --flag value pairs; an unquoted value may span several words. `confirm` and `kill` take the lead ID first.
      const id=sub!=='lead'&&!args[0]?.startsWith('--')?args.shift():undefined
      const flags:Record<string,string>={};let key=''
      for(const arg of args){if(/^--[a-z][a-z-]*$/.test(arg)){key=arg.slice(2);flags[key]='';continue}if(key)flags[key]=((flags[key]??'')+' '+arg).trim()}
      // --proof-file reads longer output from this session’s scratch folder.
      if(sub==='confirm'&&flags['proof-file']){flags.proof=[flags.proof,await scratchFile(['--file',flags['proof-file']],'confirm <lead-id> --proof-file output.txt --control "…"',16_000)].filter(Boolean).join('\n');delete flags['proof-file']}
      result=await rpc.call(sub,id?{...flags,id}:flags)
    }
    else if(sub==='record')result=await rpc.call('record',{text:await scratchFile(args,'record --file report.json',128_000)})
    else throw new Error('Agent commands: context, team, ask/send <id or name> <message>, inbox, note <message>, map [--file map.md | --text "..."] [--append], lead --title "..." --path "..." [--lines 10-20] --why "..." --hypothesis "..." --attack "..." --impact "..." [--id <lead id>], confirm <lead-id> --proof "..." --control "..." [--proof-file output.txt], kill <lead-id> --tested "..." --reason "..." (or --title "..." --path "..." instead of the ID), record --file report.json, verification <status|plan|prepare|recover|run|retry|docker|report|fail> [saved-id].')
    console.log(JSON.stringify(result,null,2))
  }finally{rpc.close()}
}else{
  async function connect(start:boolean){
    async function attempt(timeout:number){const rpc=new RpcClient(await address(dataDir));try{await rpc.call('ping',{},timeout);return rpc}catch(error){rpc.close();throw error}}
    try{return await attempt(1500)}catch{}
    if(!start)throw new Error('The terminal runtime is not running. Start it with kraflr.')
    const problem=nativeTerminalProblem();if(problem)throw new Error(problem)
    await mkdir(dataDir,{recursive:true,mode:0o700})
    const log=openSync(join(dataDir,'terminal-runtime.log'),'a',0o600)
    try{const child=spawn(process.execPath,[join(root,'bin','kraflr.mjs'),'--core','--data-dir',dataDir],{cwd:root,env:process.env,windowsHide:true,detached:true,stdio:['ignore',log,log]});child.unref()}finally{closeSync(log)}
    for(let i=0;i<120;i++){await delay(100);try{return await attempt(500)}catch{}}
    throw new Error('The runtime could not start. If the old web server owns this data directory, stop it first. See '+join(dataDir,'terminal-runtime.log'))
  }
  if(command==='doctor'){
    const{resolveAgent}=await import('../server/agent-terminals.ts')
    console.log(JSON.stringify({node:process.versions.node,platform:process.platform,interactive:Boolean(process.stdin.isTTY),dataDir,nativeTerminal:nativeTerminalProblem()??'ok',opencode:Boolean(resolveAgent('opencode')),cline:Boolean(resolveAgent('cline')),claude:Boolean(resolveAgent('claude')),docker:(await(await import('../server/verification-runner.ts')).dockerVerificationRunner.available()).detail,terminalParser:existsSync(join(root,'node_modules','@xterm','headless'))},null,2))
  }else{
    if(!['tui','attach','status','panels','stop'].includes(command))throw new Error('Unknown command. Use kraflr --help.')
    const rpc=await connect(command!=='stop'&&command!=='status'&&command!=='attach')
    if(command==='tui'){const{runTui}=await import('./tui.ts');await runTui(rpc)}
    else if(command==='attach'){try{if(!args[0])throw new Error('Use kraflr attach SESSION_ID.');const{attachTerminal}=await import('./attach.ts');await attachTerminal(rpc,args[0])}finally{rpc.close()}}
    else try{
      if(command==='status')console.log(JSON.stringify({runtime:await rpc.call('ping'),agents:await rpc.call('api',{path:'/api/agents/sessions'})},null,2))
      else if(command==='panels')console.log(JSON.stringify(await rpc.call('api',{path:'/api/panels'}),null,2))
      else if(command==='stop')console.log(JSON.stringify(await rpc.call('stop')))
      else throw new Error('Unknown command. Use kraflr --help.')
    }finally{rpc.close()}
  }
}
