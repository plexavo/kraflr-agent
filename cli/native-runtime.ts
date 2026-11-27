import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync,lstatSync } from 'node:fs'
import { mkdir, writeFile,readFile,lstat,rename,unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { spawn } from 'node-pty'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentTerminals, agentEnvironment, resolveAgent } from '../server/agent-terminals.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import { spawnWindowsTerminal, type ManagedTerminal } from '../server/windows-terminal.ts'
import { stopWindowsProcessTree } from '../server/process-tree.ts'
import { agentContext } from '../server/agent-context.ts'
import { StoreError, type ResearchStore } from '../server/db.ts'
import { secretRedactor } from '../server/secrets.ts'
import type { AgentTerminalInfo, AgentChatMessage, PanelDetail, LaunchTerminalInput, SavedAgentSession } from './types.ts'
import { agentDetails, isNativeKind, limitPattern } from '../shared/agent-terminal.ts'
import { claudeSettings, claudeMcpConfig, autonomyFromEnvironment } from './claude-settings.ts'
import { gatewayServerConfig, clineMcpSettings } from '../server/mcp-gateway-config.ts'
import type { NativeAgentKind } from '../shared/agent-terminal.ts'
import { launcher } from './commands.ts'
import{NativePrompt}from'./native-prompt.ts'
import{saveConversation}from'./agent-records.ts'
import{terminalTeamInstructions,type NativeTurn}from'../shared/terminal-team.ts'
import{teamFileName,teamInstructions,teamContext}from'./team-context.ts'
import{proxyEnvironment}from'../server/scope-proxy.ts'

type Native = { info: AgentTerminalInfo; token: string; cwd: string; process: ManagedTerminal; output: string; ready: boolean;
  prompt:NativePrompt;lastUserPrompt?:string;reserved?:boolean;
  viewers: Set<Readable>; messages: AgentChatMessage[]; lastOutput: number; closed: Promise<void>; booting:boolean; model?: string;
  hubFile:string;hubPort:number;redact:(text:string)=>string; pending?: { id: string; resolve: (text: string) => void; reject: (error: Error) => void }; stopping?: Promise<void> }
const packet = (name: string, payload: unknown) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
const limit = 384 * 1024
const root = dirname(dirname(fileURLToPath(import.meta.url)))
async function privateFolder(path:string){await mkdir(path,{recursive:true,mode:0o700});if((await lstat(path)).isSymbolicLink())throw new StoreError(409,'The native session folder is linked elsewhere. Start a fresh session.')}
async function privateFile(path:string,text:string,mode=0o600){try{if((await lstat(path)).isSymbolicLink())throw new StoreError(409,'The native session configuration is linked elsewhere. Start a fresh session.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,text,{mode,flag:'wx'});try{await rename(temp,path)}finally{await unlink(temp).catch(()=>{})}}

export function createNativeRuntime(scratch: string, store: ResearchStore, socket: string,options:{onDirectReply?:(agent:AgentTerminalInfo,turn:NativeTurn)=>boolean;proxyPort?:number}={}) {
  const dataDir = dirname(scratch)
  // Agents of a web research panel send their plain-HTTP traffic through Kraflr's scope proxy; other panels have no targets to guard.
  const proxyFor=(id:string,token:string,panel:{type:string})=>options.proxyPort&&panel.type==='web'?proxyEnvironment(options.proxyPort,id,token,(process.env.KRAFLR_PROXY_ALLOW??'').split(/[\s,;]+/).filter(Boolean)):{}
  const sessions = new Map<string, Native>()
  const bridgeTokens = new Map<string, string>()
  mkdirSync(scratch,{recursive:true,mode:0o700});if(lstatSync(scratch).isSymbolicLink())throw new StoreError(409,'The terminal scratch folder is linked elsewhere.')
  const bridgeBin = join(scratch, 'bin'); mkdirSync(bridgeBin, { recursive: true, mode: 0o700 })
  if(lstatSync(bridgeBin).isSymbolicLink())throw new StoreError(409,'The terminal command folder is linked elsewhere.')
  const bridgeFile=join(bridgeBin,process.platform==='win32'?'kraflr.cmd':'kraflr')
  try{if(lstatSync(bridgeFile).isSymbolicLink())throw new StoreError(409,'The terminal command file is linked elsewhere.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  writeFileSync(bridgeFile, launcher(process.execPath,join(root,'bin','kraflr.mjs')), {mode:0o700})
  // Claude Code runs shell commands through Git Bash on Windows, which finds an extensionless script rather than the .cmd shim.
  if(process.platform==='win32'){const posixShim=join(bridgeBin,'kraflr');try{if(lstatSync(posixShim).isSymbolicLink())throw new StoreError(409,'The terminal command file is linked elsewhere.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    writeFileSync(posixShim, launcher(process.execPath,join(root,'bin','kraflr.mjs'),false), {mode:0o700})}
  const legacy = createAgentTerminals(scratch, store, {
    mcpGateway: gatewayServerConfig(process.execPath, root, dataDir),
    onNativeTurn(agent,turn){if(!options.onDirectReply?.(agent,turn))saveConversation(store,agent,turn.id,turn.prompt,turn.reply,turn.failed?'failed':'completed')},
    sessionInstructions: (id,_panel,role)=>'\n\nKraflr session ID: '+id+'. Your role at launch: '+role+'. The live roster supersedes this if the user changes the team.\n'+terminalTeamInstructions+'\n'+teamInstructions(join(scratch,id),process.execPath,join(root,'bin','kraflr.mjs'))+'\n',
    sessionEnvironment(id,_panel,cwd) { const token = randomBytes(32).toString('hex'); bridgeTokens.set(id, token); return { ...proxyFor(id,token,_panel),
      PATH: bridgeBin + (process.platform === 'win32' ? ';' : ':') + dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''), KRAFLR_SOCKET: socket, KRAFLR_AGENT_ID: id, KRAFLR_AGENT_TOKEN: token,KRAFLR_AGENT_SCRATCH:cwd,KRAFLR_TEAM_FILE:join(cwd,teamFileName),
    } },
  })
  const hookFile = pathToFileURL(join(root, 'cli', 'hook.ts')).href
  let closing = false
  let publishingTeam=false,teamPublication:Promise<void>=Promise.resolve()
  const teamCache=new Map<string,string>()
  function publishTeam(){
    teamPublication=teamPublication.catch(()=>{}).then(async()=>{
      if(closing)return
      publishingTeam=true
      try{
        const agents=terminals.list(),research=store.activeResearch()
        for(const agent of agents.filter(item=>item.state==='running')){
          const content=JSON.stringify(teamContext(agent,agents,research,store.listVerification(agent.panelId).records),null,2)
          if(teamCache.get(agent.id)===content)continue
          await privateFile(join(scratch,agent.id,teamFileName),content+'\n');teamCache.set(agent.id,content)
        }
        for(const id of teamCache.keys())if(!agents.some(agent=>agent.id===id&&agent.state==='running'))teamCache.delete(id)
      }finally{publishingTeam=false}
    })
    return teamPublication
  }
  let launching=0
  const opening=new Set<string>()
  const publish = (session: Native, kind: string, data: unknown) => { for (const viewer of session.viewers) {
    if (viewer.readableLength > limit * 3) viewer.destroy(); else viewer.push(packet(kind, data))
  } }
  function find(panel: string, id: string) {
    const session = sessions.get(id)
    if (!session || session.info.panelId !== panel) throw new StoreError(404, 'Native terminal not found.')
    return session
  }
  function current(session: Native) { store.readSourceScope(session.info.panelId, session.info.scopeVersion ?? 0); if (session.info.state !== 'running') throw new StoreError(409, 'This native terminal is stopped.') }
  async function stop(panel: string, id: string) {
    const session = sessions.get(id)
    if (!session) return legacy.stop(panel, id)
    if (session.info.panelId !== panel) throw new StoreError(404, 'Terminal not found.')
    if (session.info.state === 'exited') return session.info
    session.stopping ??= (async () => {
      session.info.state = 'stopping'; publish(session, 'state', session.info)
      session.pending?.reject(new StoreError(409, 'The native agent stopped before returning its report.'))
      if (process.platform === 'win32') await stopWindowsProcessTree(session.process.pid); else {
        // Cline can detach its private hub from the PTY process group. Only stop
        // the PID whose live command matches our unique endpoint and daemon mode.
        if(session.hubPort)try{const hub=JSON.parse(await readFile(session.hubFile,'utf8'));if(Number.isSafeInteger(hub.pid)&&hub.pid>1&&hub.port===session.hubPort){const args=(await readFile(`/proc/${hub.pid}/cmdline`,'utf8')).split('\0');if(args.includes('--cline-hub-daemon')&&args.includes(String(session.hubPort)))process.kill(hub.pid,'SIGTERM')}}catch{}
        session.process.kill()
      }
      const timer=new AbortController()
      try{await Promise.race([session.closed, delay(5000,undefined,{signal:timer.signal}).then(() => { throw new StoreError(503, 'Native process exit was not confirmed.') })])}finally{timer.abort()}
    })()
    await session.stopping; return session.info
  }
  const unsubscribe = store.onScopeChanged((panel, version) => { for (const session of sessions.values()) {
    if (session.info.panelId === panel && session.info.scopeVersion !== version && session.info.state === 'running') void stop(panel, session.info.id).catch(() => {})
  } })

  async function start(panel: PanelDetail, input: LaunchTerminalInput, saved?: SavedAgentSession) {
    if(closing)throw new StoreError(503,'The terminal runtime is stopping.')
    if(saved&&(opening.has(saved.id)||sessions.has(saved.id)&&sessions.get(saved.id)!.info.state!=='exited'))throw new StoreError(409,'This native terminal is already open.')
    if(terminals.list().filter(item=>['running','stopping'].includes(item.state)).length+launching>=4)throw new StoreError(409,'Four agents are already active. Stop one before adding another.')
    launching++;if(saved)opening.add(saved.id)
    try{const launched=await launch(panel,input,saved);try{await publishTeam()}catch(error){await stop(panel.id,launched.id);throw error}return launched}finally{launching--;if(saved)opening.delete(saved.id)}
  }
  /** Record why a native agent cannot continue. The Kraflr terminal turns this into a pop-up offering to hand its saved context to a teammate. */
  function markStopped(session:Native,kind:'limit'|'error'|'exited',detail:string){
    const name=agentDetails[session.info.kind].name,line=detail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s+/g,' ').trim().slice(0,240)
    const reason=kind==='limit'?`${name} hit a usage or rate limit${line?': '+line:'.'}`:kind==='exited'?`${name} exited without being stopped from Kraflr${line?' ('+line+')':'.'}`:`${name} stopped${line?': '+line:'.'}`
    session.info={...session.info,stoppage:{kind,reason,at:new Date().toISOString()}}
  }
  /** Text every native session reads first. Each agent gets the shell syntax its own tool actually runs. */
  function sessionText(kind:NativeAgentKind,panel:PanelDetail,cwd:string){
    return agentContext(panel).text + '\n\nKraflr terminal workspace. Keep all research within this scope. The kraflr command is available on PATH.\n'
      + 'Use `kraflr agent context` for current scope/team and `kraflr agent ask <session-id> "specific question"` to collaborate with an existing same-panel agent. Do not spawn untracked agents.\n'
      + 'For flexible handoffs, use `kraflr agent send <id-or-unique-name> "task"` without waiting and `kraflr agent inbox` to read saved messages/results. Kraflr delivers each reply to a `send` into your prompt as soon as you are idle, so you do not have to poll the inbox; use it only to review history. Parent and Child are coordination roles, not communication restrictions. Never create a waiting cycle or auto-approve a native request.\n'
      + 'Record leads with `kraflr agent lead --title "..." --path '+(panel.type==='web'?'"POST /api/export" (the endpoint) ':'"src/file.php" --lines 10-20 ')+'--why "what you saw" --hypothesis "the suspected broken check" --attack "who reaches it and how" --impact "what an attacker gains"` as soon as you have one. Each of hypothesis, attack and impact needs at least 12 characters. Add `--id <lead id>` to update a lead you already recorded. A final kraflr-result JSON block is optional.\n'
      + 'Start by reading the saved attack-surface map with `kraflr agent map`.'+(panel.type!=='web'?' It may already hold a Semgrep first pass Kraflr ran automatically; treat each hit as a reachability question to answer, not as a finding, most are noise.':'')+' If there is none, map the target as you work (entry points, authentication, trust boundaries, sinks, what you already tested) and save it with `kraflr agent map --file map.md` (write map.md in your session folder; add --append to extend it), so no later session repeats your recon.\n'
      + 'You do not need Kraflr verification to report a result. State plainly how far you proved it (reasoned from code, reproduced live with a request and response, or reproduced with a control case) in --why. The researcher kills or accepts anything you have not confirmed.\n'
      + 'Use `kraflr agent note "plain English progress"` for a status update. Do not auto-approve native tool requests.\n'
      + terminalTeamInstructions+'\n'
      // Claude Code's Bash tool is Git Bash even on Windows; Cline and the others use the platform shell.
      + teamInstructions(cwd,process.execPath,join(root,'bin','kraflr.mjs'),kind==='claude'?false:undefined)+'\n'
  }
  const pathList = (extra:string) => extra + (process.platform === 'win32' ? ';' : ':') + dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '')
  type Prepared = { args:string[]; env:NodeJS.ProcessEnv; hubFile:string; hubPort:number; workdir?:string }
  type Launch = { panel:PanelDetail; input:LaunchTerminalInput; saved?:SavedAgentSession; scope:ReturnType<ResearchStore['readSourceScope']>; id:string; cwd:string; token:string; nativeId?:string }

  async function prepareCline({ panel, input, saved, id, cwd, nativeId }:Launch):Promise<Prepared>{
    await privateFolder(join(cwd,'.cline'));await privateFolder(join(cwd,'.cline','hooks'))
    await privateFolder(join(cwd,'.cline','plugins'))
    await privateFile(join(cwd,'.cline','plugins','kraflr-team-policy.ts'),await readFile(join(root,'cli','cline-team-policy.ts'),'utf8'))
    await privateFile(join(cwd, 'AGENTS.md'), sessionText('cline',panel,cwd))
    // Cline never reads an MCP file from the project folder: it is pointed at this session's file, which also keeps the researcher's own servers.
    const shared = process.env.CLINE_MCP_SETTINGS_PATH?.trim() || join(process.env.CLINE_DATA_DIR?.trim() || join(process.env.CLINE_DIR?.trim() || join(homedir(),'.cline'),'data'),'settings','cline_mcp_settings.json')
    const mcpFile = join(cwd,'.cline','cline_mcp_settings.json')
    await privateFile(mcpFile, JSON.stringify(clineMcpSettings(await readFile(shared,'utf8').catch(()=>''), gatewayServerConfig(process.execPath, root, dataDir)), null, 2)+'\n')
    for (const name of ['TaskStart', 'UserPromptSubmit', 'TaskComplete', 'TaskError', 'TaskCancel','PreToolUse']) {
      await privateFile(join(cwd, '.cline', 'hooks', `${name}.js`), `#!/usr/bin/env node\nawait import(${JSON.stringify(hookFile)});\n`,0o700)
    }
    // Cline TUI explicitly selects its auto backend. Give each pane a distinct
    // endpoint so a previously running personal hub cannot inherit this task.
    const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)})
    const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()))
    const hubFile=join(cwd,'cline-hub-'+randomUUID()+'.json')
    const args = ['--tui', '--cwd', cwd, '--hooks-dir', join(cwd, '.cline', 'hooks'), '--auto-approve', 'false', '--system', 'You are a scoped Kraflr teammate. Current role: '+(input.role??saved?.role??'check kraflr agent team')+'. Follow the saved scope and record leads with `kraflr agent lead`. Read AGENTS.md before source research. '+terminalTeamInstructions]
    if (nativeId) args.push('--id', nativeId)
    return { args, hubFile, hubPort:port, env:{ CLINE_MCP_SETTINGS_PATH:mcpFile, GIT_CEILING_DIRECTORIES:dirname(cwd), CLINE_HUB_HOST:'127.0.0.1',CLINE_HUB_PORT:String(port),CLINE_HUB_PATHNAME:'/kraflr-'+id,CLINE_HUB_DISCOVERY_PATH:hubFile } }
  }

  async function prepareClaude({ panel, input, saved, scope, id, cwd, nativeId }:Launch):Promise<Prepared>{
    await privateFolder(join(cwd,'.claude'))
    // Claude Code asks the researcher to trust every new working folder, and its default answer is "No, exit". Running all of a panel's Claude
    // sessions from one stable folder means that choice is made once per panel. Per-session files stay in the session folder.
    const workdir = join(scratch,'claude-'+panel.id)
    await privateFolder(workdir)
    const role = input.role??saved?.role??'check kraflr agent team'
    const text = 'You are a scoped Kraflr teammate. Current role: '+role+'. Stay inside the saved scope and record leads with `kraflr agent lead`. '
      + terminalTeamInstructions + '\n\n' + sessionText('claude',panel,cwd)
    await privateFile(join(cwd,'AGENTS.md'), text)
    // These settings apply to this session only (--settings); the researcher's own Claude Code configuration is never edited.
    const autonomy = autonomyFromEnvironment()
    const gateway = gatewayServerConfig(process.execPath, root, dataDir)
    const settings = claudeSettings(process.execPath, join(root,'cli','claude-hook.ts'), autonomy, true)
    const settingsFile = join(cwd,'.claude','kraflr-settings.json')
    await privateFile(settingsFile, JSON.stringify(settings,null,2)+'\n')
    // mcpServers is only ever read from --mcp-config (or a project .mcp.json), never from --settings.
    const mcpConfigFile = join(cwd,'.claude','kraflr-mcp.json')
    await privateFile(mcpConfigFile, JSON.stringify(claudeMcpConfig(gateway),null,2)+'\n')
    const args = ['--settings', settingsFile, '--mcp-config', mcpConfigFile, '--permission-mode', 'default', '--append-system-prompt-file', join(cwd,'AGENTS.md'),
      // Resume only a conversation that really started; Claude Code has nothing to resume before the first prompt.
      ...(nativeId ? ['--resume', nativeId] : ['--session-id', id]),
      // The session folder holds the live team roster and report files the agent is told to read and write.
      '--add-dir', cwd, ...(scope.checkoutPath ? ['--add-dir', scope.checkoutPath] : [])]
    return { args, hubFile:'', hubPort:0, workdir, env:{ GIT_CEILING_DIRECTORIES:dirname(workdir), KRAFLR_AUTONOMY:autonomy, ...(scope.accessMode==='read_only'&&scope.checkoutPath?{KRAFLR_READONLY_ROOT:scope.checkoutPath}:{}) } }
  }

  async function launch(panel: PanelDetail, input: LaunchTerminalInput, saved?: SavedAgentSession) {
    for(const [id,session]of [...sessions].filter(([,session])=>session.info.state==='exited').slice(0,-12)){sessions.delete(id);bridgeTokens.delete(id);session.output='';session.messages=[]}
    if (!isNativeKind(input.kind)) {
      const info = saved ? await legacy.resume(panel, saved.id, input) : await legacy.start(panel, input)
      return info
    }
    const kind = input.kind, name = agentDetails[kind].name
    if (closing) throw new StoreError(503, 'The terminal runtime is stopping.')
    if (terminals.list().filter(item => ['running', 'stopping'].includes(item.state)).length >= 4) throw new StoreError(409, 'Four agents are already active. Stop one before adding another.')
    const scope = store.readSourceScope(panel.id, panel.scopeVersion)
    if (saved && saved.scopeVersion !== scope.version) throw new StoreError(409, 'This session belongs to an earlier scope. Start a new session.')
    const executable = resolveAgent(kind)
    if (!executable) throw new StoreError(409, 'Install the '+name+' CLI, then try again.')
    const id = saved?.id ?? randomUUID(), cwd = join(scratch, id), token = randomBytes(32).toString('hex')
    await privateFolder(cwd)
    const nativeId = saved?.nativeId?.startsWith('pty:') ? saved.nativeId.slice(4) : saved?.nativeId
    const context:Launch = { panel, input, saved, scope, id, cwd, token, nativeId: nativeId || undefined }
    const prepared = await (kind === 'claude' ? prepareClaude(context) : prepareCline(context))
    const env:NodeJS.ProcessEnv = { ...agentEnvironment(kind), PATH: pathList(bridgeBin), ...prepared.env, ...proxyFor(id,token,panel),
      KRAFLR_SOCKET: socket, KRAFLR_AGENT_ID: id, KRAFLR_AGENT_TOKEN: token,KRAFLR_AGENT_SCRATCH:cwd,KRAFLR_TEAM_FILE:join(cwd,teamFileName) }
    if(closing)throw new StoreError(503,'The terminal runtime is stopping.')
    store.readSourceScope(panel.id,scope.version)
    const terminal = process.platform === 'win32' ? spawnWindowsTerminal(executable, prepared.args, { cwd: prepared.workdir ?? cwd, cols: input.cols, rows: input.rows, env, name: 'xterm-256color' })
      : spawn(executable, prepared.args, { cwd: prepared.workdir ?? cwd, cols: input.cols, rows: input.rows, env, name: 'xterm-256color' })
    const label = input.label?.trim() || saved?.label || name
    if (!saved) store.saveAgentSession({ id, panelId: panel.id, kind, mode: 'terminal', label: input.label?.trim() || name, startedAt: new Date().toISOString(), scopeVersion: scope.version, nativeId: 'pty:',role:input.role })
    else store.saveAgentNativeId(panel.id, id, 'pty:' + (nativeId ?? ''))
    let closed = () => {}
    const info: AgentTerminalInfo = { id, panelId: panel.id, kind, mode: 'terminal', label,
      state: 'running',activity:'starting', startedAt: saved?.startedAt ?? new Date().toISOString(), scopeVersion: scope.version, exitCode: null, chat: true, parent: store.agentParent(panel.id) === id }
    let trustSteps = 0, lastTrustKey = '', lastTrustAt = 0
    const secrets = [token, env.CLINE_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN]
    const session: Native = { info, prompt:new NativePrompt(input.cols,input.rows,kind),token, cwd, process: terminal, output: '', ready: false, booting:true, viewers: new Set(), messages: [], lastOutput: Date.now(), closed: new Promise(resolve => { closed = resolve }),hubFile:prepared.hubFile,hubPort:prepared.hubPort,redact:secretRedactor(secrets).redact }
    sessions.set(id, session); bridgeTokens.set(id, token)
    // Claude Code asks whether to trust a folder, and again for each --add-dir folder, and both default to "No, exit". Kraflr made its own working folder and
    // this session's folder and keeps them private, so those two questions are answered for the researcher, one key at a time (Down, then Enter). Any other
    // folder, such as a cloned repository, is left to the researcher. A key is repeated only after the screen changed, or after 1.5 seconds without a change.
    if (kind === 'claude' && prepared.workdir) {
      const own = [prepared.workdir, cwd].map(path => path.replace(/\s+/g, ''))
      const trustTimer = setInterval(() => {
        if (session.info.state !== 'running' || trustSteps >= 12) { clearInterval(trustTimer); return }
        const dialog = session.prompt.trustDialog()
        if (!dialog) { if (!session.booting) clearInterval(trustTimer); return }
        if (!own.includes(dialog.folder)) return
        if (dialog.keys === lastTrustKey && Date.now() - lastTrustAt < 1500) return
        trustSteps++; lastTrustKey = dialog.keys; lastTrustAt = Date.now(); session.process.write(dialog.keys)
      }, 300)
      trustTimer.unref()
    }
    const redact = secretRedactor(secrets)
    terminal.onData(chunk => {
      const text = redact.write(chunk); session.output = (session.output + text).slice(-limit); session.lastOutput = Date.now()
      session.prompt.output(text,()=>{
        session.ready=session.prompt.status(false).ready
        // Claude Code has no startup greeting to match, so its first clear composer is what ends booting.
        if(kind==='claude'&&session.booting&&!session.pending&&session.ready){session.booting=false;session.info.activity='idle'}
      })
      // Startup only: known native prompt text, never an approval decision. Unknown screens require explicit readiness.
      if (kind==='cline' && session.booting && !session.pending && /Ask anything|Type a message|Ask Cline|What can I do for you\?/i.test(session.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-5000))) {session.ready = true;session.booting=false;session.info.activity='idle'}
      if (text) publish(session, 'output', text)
    })
    terminal.onExit(({ exitCode }) => {
      // An exit nobody asked for is a stoppage the researcher should hear about, with the provider's own last words when they explain it.
      if (!session.stopping && !closing) {
        const lastLine = session.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse().find(line => limitPattern.test(line))
        markStopped(session, lastLine ? 'limit' : 'exited', lastLine ?? (exitCode ? 'exit code ' + exitCode : 'the process ended'))
      }
      session.info = { ...session.info, state: 'exited', exitCode }; session.pending?.reject(new StoreError(409, 'The native '+name+' terminal exited.'))
      session.pending = undefined; publish(session, 'state', session.info); for (const viewer of session.viewers) viewer.push(null); closed()
    })
    return info
  }
  const terminals: AgentTerminals = {
    ...legacy,
    list: () => legacy.list().map(item => {const native=sessions.get(item.id);if(!native)return item;const status=native.prompt.status();return{...native.info,promptReady:!native.reserved&&!native.pending&&status.ready,readinessReason:native.reserved||native.pending?'Working':status.reason||undefined}}).map(item => ({ ...item, parent: store.agentParent(item.panelId) === item.id })),
    start: (panel, input) => start(panel, input),
    resume: (panel, id, size) => { const saved = store.findSavedAgent(panel.id, id); if (!saved) throw new StoreError(404, 'Session not found.'); return start(panel, { ...size, kind: saved.kind, label: saved.label }, saved) },
    stop,
    async dashboardSessions() { return [...await legacy.dashboardSessions(), ...[...sessions.values()].filter(item => item.info.state === 'running').map(item => item.info)].filter((item, index, items) => items.findIndex(other => other.id === item.id) === index).map(item=>({...item,model:item.model,usage:item.usage})) },
    async messages(panel, id) { return sessions.has(id) ? find(panel, id).messages : legacy.messages(panel, id) },
    async workerModels(panel, id) { return sessions.has(id) ? { current: find(panel, id).info.model ?? null, choices: [], notice: 'Use /model in this native CLI pane.' } : legacy.workerModels(panel, id) },
    async selectWorkerModel(panel, id, value) { if (sessions.has(id)) throw new StoreError(409, 'Use the native Cline /model picker in its pane.'); return legacy.selectWorkerModel(panel, id, value) },
    async researchTurn(panel, id, text, version, signal) {
      const roster=terminals.list(),identity=roster.find(agent=>agent.id===id&&agent.panelId===panel)
      if(identity)text='Verified Kraflr runtime context for this managed turn. You are inside Kraflr; use this current roster instead of assuming a failed shell command means no team. kraflr-result is a fenced reply format, never a callable tool.\n'+JSON.stringify(teamContext(identity,roster,store.activeResearch(),store.listVerification(panel).records))+'\n\n'+text
      const session = sessions.get(id)
      if (!session) return secretRedactor([bridgeTokens.get(id)]).redact(await legacy.researchTurn(panel, id, text, version, signal))
      current(session)
      if (session.pending||session.reserved) throw new StoreError(409, 'This native agent is already handling a task.')
      session.reserved=true
      session.messages.push({ id: randomUUID(), role: 'user', text })
      const task = randomUUID()
      const path = join(session.cwd, `task-${task}.md`)
      const abort = () => { session.pending?.reject(new StoreError(409, 'Research was interrupted.')); void stop(panel, id).catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        await writeFile(path, text + '\n\nReturn the requested research report. Kraflr captures it through your TaskComplete hook.\n', { mode: 0o600 })
        while ((!session.prompt.status().ready || Date.now() - session.lastOutput < 250) && !signal.aborted) { current(session); await delay(100, undefined, { signal }) }
        signal.throwIfAborted(); current(session); session.ready = false
        return await new Promise<string>((resolve, reject) => {
          session.pending = { id: task, resolve, reject }
          const prompt = text.length <= 12_000 ? text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'') : `Kraflr assignment: read ${JSON.stringify(path)} and perform that scoped task.`
          session.process.write('\x1b[200~' + prompt + '\x1b[201~')
          // Native TUIs can batch a paste and its following Enter into one paste event.
          // Submit only after the paste boundary has been processed.
          void delay(800, undefined, { signal }).then(()=>{if(session.pending?.id===task){current(session);session.process.write('\r')}}).catch(error=>session.pending?.reject(error))
        })
      } finally { signal.removeEventListener('abort', abort); session.pending = undefined;session.reserved=false }
    },
    stream(panel, id) {
      if (!sessions.has(id)) return legacy.stream(panel, id)
      const session = find(panel, id), stream = new Readable({ read() {} })
      stream.push(packet('snapshot', session.output)); stream.push(packet('state', session.info)); session.viewers.add(stream)
      stream.once('close', () => session.viewers.delete(stream)); if (session.info.state === 'exited') stream.push(null)
      return stream
    },
    input(panel, id, text) { if (!sessions.has(id)) return legacy.input(panel, id, text); const session = find(panel, id); current(session);const submission=session.prompt.input(text);if(submission)session.lastUserPrompt=session.redact(submission).slice(0,8000);session.ready=session.prompt.status().ready;session.process.write(text) },
    resize(panel, id, size) { if (!sessions.has(id)) return legacy.resize(panel, id, size);const session=find(panel,id);session.prompt.resize(size.cols,size.rows);session.process.resize(size.cols, size.rows) },
    async close() { closing = true;clearInterval(teamTimer);clearInterval(interruptTimer);await teamPublication.catch(()=>{}); unsubscribe(); await Promise.allSettled([...sessions.values()].filter(item => item.info.state !== 'exited').map(item => stop(item.info.panelId, item.info.id))); await legacy.close() },
  }
  // A turn can end without a completion hook (Esc, a menu choice, a lost hook). Once the pane proves it is at rest, stop showing it as working and
  // release any assignment still waiting on it. A waiting Cline assignment gets 45 more seconds, so a late hook is not thrown away.
  const interruptTimer=setInterval(()=>{for(const session of sessions.values()){
    if(session.info.state!=='running'||!session.prompt.interrupted())continue
    if(session.pending){
      if(session.info.kind==='cline'&&!session.prompt.interrupted(Date.now()-45_000))continue
      session.pending.reject(new StoreError(409,'The turn was stopped in the '+agentDetails[session.info.kind].name+' pane before it reported.'))
    }
    session.prompt.settle();session.ready=true;session.info.activity='idle'
  }},1000);interruptTimer.unref()
  const teamTimer=setInterval(()=>{if(!publishingTeam)void publishTeam().catch(()=>console.error('Could not refresh the live Kraflr team context.'))},750);teamTimer.unref()
  return { terminals,
    authenticate(id: string, token: string) { const expected = bridgeTokens.get(id); return Boolean(expected && expected.length === token.length && timingSafeEqual(Buffer.from(expected), Buffer.from(token))) },
    redact(id:string,text:string){return sessions.get(id)?.redact(text)??secretRedactor([bridgeTokens.get(id)]).redact(text)},
    ready(id: string) { const session = sessions.get(id); if (session) {current(session);if(session.pending)throw new StoreError(409,'This agent has an active assignment. Finish or stop it first.');const state=session.prompt.confirm();if(!state.ready)throw new StoreError(409,state.reason+'. Clear the native prompt and resolve pending work first.');session.ready = true;session.booting=false;session.info.activity='idle'; return true }; return false },
    respond(panel:string,id:string,text:string){const session=sessions.get(id);if(session){find(panel,id);current(session);session.process.write(text)}else legacy.input(panel,id,text)},
    async hook(id: string, payload: { name: string; sessionId?: string; text?: string;prompt?:string;timestamp?:string;error?:string }) {
      const session = sessions.get(id); if (!session) throw new StoreError(404, 'Native agent not found.')
      current(session)
      session.prompt.hook(payload.name)
      if(payload.prompt)session.lastUserPrompt=session.redact(payload.prompt).slice(0,8000)
      // SessionStart precedes any conversation, so its id is not resumable yet; the first submitted prompt makes it so.
      if (payload.name !== 'SessionStart' && payload.sessionId && /^[a-zA-Z0-9_-]{1,120}$/.test(payload.sessionId)) store.saveAgentNativeId(session.info.panelId, id, 'pty:' + payload.sessionId)
      if (/TaskStart|UserPromptSubmit/.test(payload.name)) {session.ready = false;session.info.activity='working';session.info.prompted=true;if(session.info.stoppage)session.info={...session.info,stoppage:undefined}}
      if (/TaskComplete|TaskError|TaskCancel/.test(payload.name)) {
        session.ready = true
        session.info.activity='idle'
        const text = session.redact(String(payload.text ?? '')).slice(0, 256_000)
        const errorType = String(payload.error ?? '')
        if (payload.name === 'TaskComplete') { if (session.info.stoppage) session.info = { ...session.info, stoppage: undefined } }
        // A turn that ended on a provider limit or a rejected login cannot be retried by the same agent, so say so instead of leaving a silent idle pane.
        else if (payload.name === 'TaskError') {
          if (/rate_limit|billing_error/.test(errorType) || limitPattern.test(text)) markStopped(session, 'limit', text || errorType)
          else if (/authentication_failed/.test(errorType)) markStopped(session, 'error', 'its login was rejected. ' + text)
        }
        if (text) session.messages.push({ id: randomUUID(), role: 'assistant', text })
        session.messages=session.messages.slice(-40)
        if (session.pending) {
          if (payload.name === 'TaskComplete' && text) session.pending.resolve(text)
          else session.pending.reject(new StoreError(502, agentDetails[session.info.kind].name+' finished without a usable report. Check its native pane and retry.'))
        } else if (text) {
          const turn:NativeTurn={id:payload.timestamp??randomUUID(),prompt:session.lastUserPrompt??'Direct native conversation',reply:text,failed:payload.name!=='TaskComplete'}
          if(!options.onDirectReply?.(session.info,turn))saveConversation(store,session.info,turn.id,turn.prompt,text,turn.failed?'failed':'completed')
        }
      }
      return {}
    },
  }
}
