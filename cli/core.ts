import { createServer, type Socket } from 'node:net'
import { randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink, chmod,realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore, StoreError } from '../server/db.ts'
import { acquireWorkspaceLock } from '../server/workspace-lock.ts'
import { buildApp } from '../server/app.ts'
import { createNativeRuntime } from './native-runtime.ts'
import { agentContext } from '../server/agent-context.ts'
import { researchBrief } from '../server/research-brief.ts'
import { report, exportReport } from '../server/research-team.ts'
import { maxFrame } from './ipc.ts'
import{runSummary,recordSlice}from'./records.ts'
import{createCollaboration}from'./collaboration.ts'
import type{createResearchTeam}from'../server/research-team.ts'
import{agentVerification,approvedDockerCommand}from'./agent-verification.ts'
import{labGuard}from'../server/lab-guard.ts'
import{verificationNotifications}from'./verification-notifications.ts'
import{createDelivery}from'./delivery.ts'
import{createHandoff}from'./handoff.ts'
import{recordLead,confirmLead}from'./agent-lead.ts'
import{createScopeProxy}from'../server/scope-proxy.ts'
import{createTrafficLog}from'../server/traffic-log.ts'
import{createSurfaceMap}from'../server/surface-map.ts'
import{createLeadActions}from'./lead-actions.ts'
import{createReplay}from'../server/replay.ts'
import{checkGatewayStatus}from'../server/mcp-gateway-status.ts'
import{resolveBurpUrl,writeKraflrSettings}from'../server/kraflr-settings.ts'
import{createSemgrepScan}from'../server/semgrep-scan.ts'
import{parseWebTargets}from'../shared/web-scope.ts'

export async function runCore(dataDir: string) {
  dataDir = resolve(dataDir); await mkdir(dataDir, { recursive: true, mode: 0o700 })
  dataDir=await realpath(dataDir)
  const release = await acquireWorkspaceLock(dataDir)
  try{await startCore(dataDir,release)}catch(error){await release();throw error}
}
async function startCore(dataDir:string,release:()=>Promise<void>){
  const key = createHash('sha256').update(process.platform === 'win32' ? dataDir.toLowerCase() : dataDir).digest('hex').slice(0, 24)
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\kraflr-terminal-${key}` : join(tmpdir(), `kraflr-${process.getuid?.() ?? 'user'}-${key}.sock`)
  const token = randomBytes(32).toString('hex')
  const store = openStore(join(dataDir, 'kraflr.sqlite'))
  store.interruptResearchRuns()
  let terminalTeam:ReturnType<typeof createResearchTeam>|undefined
  const traffic=createTrafficLog(join(dataDir,'traffic'))
  let native!:ReturnType<typeof createNativeRuntime>
  // The proxy asks the runtime who an agent is on every request, so a stopped agent or an edited scope takes effect at once.
  const https=process.env.KRAFLR_PROXY_HTTPS==='1'?'strict' as const:'pass' as const
  const proxy=await createScopeProxy({https,allowHosts:(process.env.KRAFLR_PROXY_ALLOW??'').split(/[\s,;]+/).filter(Boolean),log:entry=>traffic.append(entry),identify(id,agentToken){
    if(!native.authenticate(id,agentToken))return
    const agent=native.terminals.list().find(item=>item.id===id&&item.state==='running');if(!agent)return
    try{const panel=store.readPanel(agent.panelId);if(panel.type!=='web')return;return{panelId:panel.id,agentId:id,agent:agent.label,targets:parseWebTargets(panel.scopeHistory[0]?.webTargets??'').targets}}catch{return}
  }})
  native = createNativeRuntime(join(dataDir, 'agent-terminals'), store, socketPath,{onDirectReply:(agent,turn)=>terminalTeam?.acceptNative(agent,turn)??false,proxyPort:proxy.port})
  const delivery=createDelivery(store,native.terminals)
  const surface=createSurfaceMap(join(dataDir,'maps'))
  const leadActions=createLeadActions(store,native.terminals,request=>delivery.send(request))
  const replay=createReplay(store,traffic)
  const semgrep=createSemgrepScan(surface)
  const collaboration=createCollaboration(store,native.terminals,(id,text)=>native.redact(id,text),delivery)
  const notifications=verificationNotifications(native.terminals,delivery)
  const handoff=createHandoff(store,native.terminals,(id,text)=>native.redact(id,text),delivery,record=>notifications.grant(record))
  const app = buildApp(store, 4317, { terminals: native.terminals,onResearchTeam:team=>{terminalTeam=team},onVerificationResult:record=>notifications.enqueue(record),onVerificationGrant:record=>notifications.grant(record) })
  try{await app.ready()}catch(error){await app.close().catch(()=>{});throw error}
  const clients = new Set<Socket>()
  const attached=new Map<string,Socket>(),sizes=new Map<string,{cols:number;rows:number}>()
  const progress=new Map<string,{text:string;at:string}>()
  let closing = false
  const owner = (supplied: unknown) => typeof supplied === 'string' && supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  const inject = async (method: string, url: string, payload?: unknown) => {
    if (!['GET', 'POST', 'PUT'].includes(method) || !url.startsWith('/api/') || url.length > 5000) throw new StoreError(400, 'Unsupported runtime action.')
    const runs=/^\/api\/panels\/([a-f0-9-]{36})\/research-runs$/.exec(url)
    if(method==='GET'&&runs){store.readPanel(runs[1]!);return store.listResearchRuns(runs[1]!).map(runSummary)}
    const result = await app.inject({ method: method as 'GET' | 'POST' | 'PUT', url,
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }, payload: payload as object })
    const data = result.body ? JSON.parse(result.body) : null
    if (result.statusCode >= 400) throw new StoreError(result.statusCode, data?.message ?? 'The action could not finish.')
    return data
  }
  const server = createServer(socket => {
    clients.add(socket); socket.setEncoding('utf8')
    const watched = new Map<string, ReturnType<typeof native.terminals.stream>>()
    let buffer = '', inFlight = 0
    const send = (message: object) => { if (socket.writableLength > maxFrame * 2) { socket.destroy(); return }; socket.write(JSON.stringify(message) + '\n') }
    socket.on('close', () => { clients.delete(socket); for(const[id,client]of attached)if(client===socket)attached.delete(id);for (const stream of watched.values()) stream.destroy() })
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > maxFrame) { socket.destroy(); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (++inFlight > 32) { socket.destroy(); return }
        void (async () => {
          let id: unknown
          try {
            const request = JSON.parse(line); id = request.id
            if (typeof id !== 'string' || id.length > 100) throw new StoreError(400, 'Invalid request ID.')
            const params = request.params ?? {}
            let result: unknown
            if (request.agent) {
              if (!native.authenticate(request.agent, request.token)) throw new StoreError(403, 'This agent capability is unavailable.')
              const agent = native.terminals.list().find(item => item.id === request.agent && item.state === 'running')
              if (!agent) throw new StoreError(409, 'This agent has stopped.')
              store.readSourceScope(agent.panelId, agent.scopeVersion ?? 0)
              if (request.method === 'hook') result = await native.hook(agent.id, params)
              else if (request.method === 'context') {
                const panel = store.readPanel(agent.panelId)
                if (panel.type !== 'web') {
                  const workspace = panel.scopeHistory[0]?.checkoutPath || panel.scopeHistory[0]?.workspacePath
                  if (workspace) semgrep.ensureScanned(agent.panelId, workspace)
                }
                result = { scope: agentContext(panel).text, brief: researchBrief(store, agent.panelId), map: surface.get(agent.panelId)?.text ?? '',
                  team: native.terminals.list().filter(item => item.panelId === agent.panelId && item.scopeVersion===agent.scopeVersion && item.state === 'running').map(item => ({ id:item.id,label:item.label,parent:item.parent,role:item.parent?'parent':'child',kind:item.kind,ready:item.promptReady!==false&&!item.modelSelectionRequired,reason:item.modelSelectionRequired?'Confirm model':item.readinessReason })) }
              }
              else if(request.method==='inbox')result=collaboration.inbox(agent)
              else if(request.method==='verification')result=await agentVerification(store,(path,method,body)=>inject(method??'GET',path,body),agent,params.operation??'status',params.target,params.payload)
              else if (request.method === 'note') {
                if(typeof params.text!=='string'||!params.text.trim()||params.text.length>1000)throw new StoreError(400,'Provide a short progress note.')
                progress.set(agent.id,{text:native.redact(agent.id,params.text),at:new Date().toISOString()});result={updated:true}
              }
              else if (request.method === 'ask'||request.method==='send') {
                if(typeof params.to!=='string'||params.to.length>100)throw new StoreError(400,'Choose a teammate ID or unique name.')
                const exchange=collaboration.start(agent,params.to,params.text,{notify:request.method==='send'})
                result=request.method==='send'?{id:exchange.id,status:exchange.status}:await exchange.done()
              } else if (request.method === 'map') {
                // The panel's attack-surface map: read it, replace it or add to it. Every later session is told to read it first.
                if (typeof params.text === 'string') {
                  if (!params.text.trim()) throw new StoreError(400, 'Provide the map text.')
                  try { result = surface.set(agent.panelId, native.redact(agent.id, params.text), params.append === true) } catch (error) { throw new StoreError(400, error instanceof Error ? error.message : 'The map could not be saved.') }
                } else result = surface.get(agent.panelId) ?? { text: '', updatedAt: '', note: 'No map has been saved for this panel yet.' }
              } else if (request.method === 'activity') {
                // A tool call the agent's own hooks reported: recorded for the researcher, never a decision.
                if(typeof params.tool!=='string'||!/^[A-Za-z_]{2,40}$/.test(params.tool)||typeof params.summary!=='string')throw new StoreError(400,'Provide the tool and what it was given.')
                traffic.append({panelId:agent.panelId,agentId:agent.id,agent:agent.label,kind:'command',text:native.redact(agent.id,params.tool+': '+params.summary).slice(0,700)});result={}
              } else if (request.method === 'guard') {
                if(typeof params.command!=='string'||params.command.length>20_000)throw new StoreError(400,'Provide the shell command.')
                const reason=await labGuard(store,agent,params.command,typeof params.cwd==='string'?params.cwd:'',record=>approvedDockerCommand(record).argv)
                // The researcher sees what was stopped beside the agent's other commands.
                if(reason)traffic.append({panelId:agent.panelId,agentId:agent.id,agent:agent.label,kind:'command',text:native.redact(agent.id,'Refused by Kraflr (lab not approved): '+params.command).slice(0,700)})
                result={reason}
              } else if (request.method === 'lead') {
                result=recordLead(store,agent,params,text=>native.redact(agent.id,text))
              } else if (request.method === 'confirm') {
                result=confirmLead(store,agent,params,text=>native.redact(agent.id,text))
              } else if (request.method === 'record') {
                if (typeof params.text !== 'string' || params.text.length > 128_000) throw new StoreError(400, 'Provide a bounded structured report.')
                const text=native.redact(agent.id,params.text),parsed = report(text)
                if (!parsed.structured) throw new StoreError(400, 'The report needs a valid kraflr-result JSON block.')
                if (store.activeResearch().some(item => item.panelId === agent.panelId)) throw new StoreError(409, 'Return the report to the current assignment; it is already being recorded.')
                const now = new Date().toISOString(), run = { id:randomUUID(),panelId:agent.panelId,parentId:agent.id,parentName:agent.label,scopeVersion:agent.scopeVersion!,objective:'Native agent report',status:'running' as const,phase:'Native report saved',startedAt:now,endedAt:now,
                  reply:parsed.reply,summary:parsed.summary,fullReply:text,leads:parsed.leads,tasks:[],deadEnds:parsed.deadEnds,nextSteps:parsed.nextSteps }
                store.startResearchRun(run); store.saveResearchRun({ ...run,status:'completed' }); result = { id:run.id,leads:parsed.leads.length }
              } else throw new StoreError(403, 'Agents can only use their scoped context, collaboration, report and verification commands.')
            } else {
              if (!owner(request.token)) throw new StoreError(403, 'This runtime capability is unavailable.')
              if (request.method === 'ping') result = { pid:process.pid,version:1 }
              else if(request.method==='terminal-views')result={attached:[...attached.keys()]}
              else if(request.method==='map'){store.readPanel(String(params.panel));result=surface.get(String(params.panel))??{text:'',updatedAt:''}}
              else if(request.method==='gateway-status'){result=await checkGatewayStatus(resolveBurpUrl(dataDir))}
              else if(request.method==='burp-url'){result={url:resolveBurpUrl(dataDir)??'',fromEnv:Boolean(process.env.KRAFLR_BURP_MCP_URL?.trim())}}
              else if(request.method==='set-burp-url'){
                if(typeof params.url!=='string')throw new StoreError(400,'Give a Burp MCP URL, or leave it blank to clear it.')
                const url=params.url.trim()
                if(url){try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw new Error()}catch{throw new StoreError(400,'That is not a valid http(s) URL.')}}
                writeKraflrSettings(dataDir,{burpMcpUrl:url})
                result={url:resolveBurpUrl(dataDir)??''}
              }
              else if(request.method==='challenge'){if(typeof params.panel!=='string'||typeof params.leadId!=='string'||(params.who!==undefined&&!['child','parent'].includes(params.who)))throw new StoreError(400,'Choose a lead.');result=leadActions.challenge(params.panel,params.leadId,params.who==='parent'?'parent':'child',typeof params.agentId==='string'?params.agentId:undefined)}
              else if(request.method==='verify-lead'){if(typeof params.panel!=='string'||typeof params.leadId!=='string'||(params.who!==undefined&&!['child','parent'].includes(params.who)))throw new StoreError(400,'Choose a lead.');result=leadActions.verify(params.panel,params.leadId,params.who==='child'?'child':'parent',typeof params.agentId==='string'?params.agentId:undefined)}
              else if(request.method==='variants'){if(typeof params.panel!=='string'||typeof params.leadId!=='string'||!['child','parent'].includes(params.who))throw new StoreError(400,'Choose a Finding and who hunts.');result=leadActions.variants(params.panel,params.leadId,params.who,typeof params.agentId==='string'?params.agentId:undefined)}
              else if(request.method==='poc'){if(typeof params.panel!=='string'||typeof params.leadId!=='string')throw new StoreError(400,'Choose a Finding.');result=leadActions.generatePoc(params.panel,params.leadId,undefined,typeof params.agentId==='string'?params.agentId:undefined)}
              else if(request.method==='replay-cross-account'){
                if(typeof params.panel!=='string'||typeof params.entryId!=='string'||typeof params.header!=='string'||typeof params.value!=='string')throw new StoreError(400,'Choose a request, a header to swap and the other account\'s value.')
                result=await replay.crossAccount(params.panel,params.entryId,params.header,params.value)
              }
              else if(request.method==='replay-record'){
                if(typeof params.panel!=='string'||typeof params.summary!=='string')throw new StoreError(400,'Nothing to hand to the Parent.')
                result=leadActions.reportReplay(params.panel,params.summary)
              }
              else if(request.method==='export-report'){
                if(typeof params.panel!=='string')throw new StoreError(400,'Choose a research panel.')
                const panel=store.readPanel(params.panel),requests=panel.type==='web'?traffic.list(params.panel,0,200).entries.filter(entry=>entry.kind!=='command'):[]
                const appendix=requests.length?[`${requests.length} most recent proxied requests (${requests.filter(entry=>entry.blocked).length} blocked), newest first. Full request and response records stay in the Kraflr traffic log.`,'',...requests.map(entry=>`- ${String(entry.at).slice(0,19)} ${entry.blocked?'BLOCKED ':''}${entry.method} ${entry.status||'—'} ${entry.url} (${entry.agent})`)]:[]
                result=await exportReport(store,params.panel,appendix)
              }
              else if(request.method==='traffic'){
                if(typeof params.panel!=='string')throw new StoreError(400,'Choose a research panel.')
                store.readPanel(params.panel)
                if(typeof params.id==='string'){const entry=traffic.get(params.panel,params.id);if(!entry)throw new StoreError(404,'That entry is no longer in the log.');result=entry}
                else{if(!Number.isSafeInteger(params.offset??0)||(params.offset??0)<0)throw new StoreError(400,'Choose a valid offset.');result=traffic.list(params.panel,params.offset??0,25)}
              }
              else if(request.method==='cancel-communication')result=delivery.has(params.id)?delivery.cancel(params.panel,params.id):collaboration.cancel(params.panel,params.id)
              else if(request.method==='handoff'){
                if(typeof params.panel!=='string'||typeof params.from!=='string'||typeof params.to!=='string')throw new StoreError(400,'Choose the stopped agent and the agent that receives its context.')
                result=await handoff.run(params.panel,params.from,params.to)
              }
              else if(request.method==='terminal-attach'){
                const session=native.terminals.list().find(item=>item.id===params.id&&item.state==='running')
                if(!session)throw new StoreError(404,'This agent is no longer running.')
                store.readSourceScope(session.panelId,session.scopeVersion??0)
                if(attached.has(session.id)&&attached.get(session.id)!==socket)throw new StoreError(409,'This agent is in use in another Kraflr view. Close that view before reconnecting this pane.')
                attached.set(session.id,socket)
                const size={cols:Math.max(10,Math.min(500,Number(params.cols)||100)),rows:Math.max(4,Math.min(200,Number(params.rows)||30))}
                try{native.terminals.resize(session.panelId,session.id,size)}catch(error){attached.delete(session.id);throw error}
                sizes.set(session.id,size);for(const client of clients)if(client!==socket&&client.writableLength<maxFrame)client.write(JSON.stringify({event:'terminal-size',id:session.id,...size})+'\n')
                result=session
              }
              else if (request.method === 'api') {result = await inject(params.method ?? 'GET', params.path ?? '', params.body);if(params.path==='/api/investigation')result={...(result as object),research:(result as {research:Parameters<typeof runSummary>[0][]}).research.map(runSummary),progress:Object.fromEntries(progress)}}
              else if(request.method==='research-record'){
                if(!Number.isSafeInteger(params.offset??0)||(params.offset??0)<0)throw new StoreError(400,'Choose a valid record offset.')
                result=recordSlice(store.readResearchRun(params.panel,params.id),params.offset??0)
              }
              else if (request.method === 'watch') {
                const session = native.terminals.list().find(item => item.id === params.id)
                if (!session) throw new StoreError(404, 'Session not found.')
                if (!watched.has(session.id)) {
                  const stream = native.terminals.stream(session.panelId, session.id); watched.set(session.id, stream)
                  stream.on('data', packet => send({event:'pty',id:session.id,packet:String(packet)}))
                  stream.on('close', () => {watched.delete(session.id);if(!socket.destroyed)send({event:'terminal-end',id:session.id})}); stream.on('error', () => {})
                }
                result = sizes.get(session.id)??{}
              } else if (request.method === 'input') {if(attached.has(params.id)&&attached.get(params.id)!==socket)throw new StoreError(409,'Input belongs to this agent’s active Kraflr pane.'); const text=String(params.text ?? '').slice(0,64_000);if(params.generated)native.respond(params.panel,params.id,text);else native.terminals.input(params.panel,params.id,text); result = {} }
              else if (request.method === 'resize') {if(attached.has(params.id)&&attached.get(params.id)!==socket)throw new StoreError(409,'Size belongs to this agent’s active Kraflr pane.');const size={cols:Math.max(10,Math.min(500,Number(params.cols)||80)),rows:Math.max(4,Math.min(200,Number(params.rows)||24))};native.terminals.resize(params.panel,params.id,size);sizes.set(params.id,size);for(const client of clients)if(client!==socket&&client.writableLength<maxFrame)client.write(JSON.stringify({event:'terminal-size',id:params.id,...size})+'\n');result = {} }
              else if (request.method === 'ready') result = {ready:native.ready(params.id)}
              else if (request.method === 'mkdir') {
                if(typeof params.path!=='string'||!isAbsolute(params.path)||/[\x00-\x1f]/.test(params.path))throw new StoreError(400,'Choose an absolute local workspace folder.')
                await mkdir(params.path,{recursive:true,mode:0o700});result={path:params.path}
              }
              else if (request.method === 'stop') { result = {stopping:true}; setTimeout(() => void close(),100) }
              else throw new StoreError(400,'Unknown runtime command.')
            }
            send({id,result})
          } catch (error) { send({id,error:error instanceof StoreError ? error.message : 'Kraflr could not complete this runtime request.'}) }
          finally { inFlight-- }
        })()
      }
    })
  })
  async function close() {
    if (closing) return; closing = true
    for (const socket of clients) socket.destroy()
    server.close(); await delivery.close();await collaboration.close();await proxy.close();await app.close(); await release()
    await unlink(join(dataDir,'terminal-runtime.json')).catch(()=>{})
    if (process.platform !== 'win32') await unlink(socketPath).catch(()=>{})
  }
  try {
    if (process.platform !== 'win32') await unlink(socketPath).catch(()=>{})
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)})
    if (process.platform !== 'win32') await chmod(socketPath,0o600)
    await writeFile(join(dataDir,'terminal-runtime.json'),JSON.stringify({socket:socketPath,token,pid:process.pid,version:1}),{mode:0o600})
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void close())
  } catch(error) { await close(); throw error }
}
