import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync,readFileSync,lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node-pty'
import { agentDetails, agentKinds, isActiveAgent, limitPattern, maxActiveAgents } from '../shared/agent-terminal.ts'
import type { AgentAttention, AgentInstallation, AgentStoppage, AgentKind, AgentPermissionDecision, AgentTerminalInfo, LaunchTerminalInput, SavedAgentSession, TerminalSize } from '../shared/agent-terminal.ts'
import type { PanelDetail } from '../shared/research.ts'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import { agentContext } from './agent-context.ts'
import { createOpenCodeChat } from './opencode-chat.ts'
import type { OpenCodeChat } from './opencode-chat.ts'
import { startPrivateOpenCode } from './private-opencode.ts'
import { openClineWorker } from './cline-worker.ts'
import { stopWindowsProcessTree } from './process-tree.ts'
import { spawnWindowsTerminal } from './windows-terminal.ts'
import type { ManagedTerminal } from './windows-terminal.ts'
import { secretRedactor } from './secrets.ts'
import type{NativeTurn}from'../shared/terminal-team.ts'
import { prepareAgentPolicy } from './agent-policy.ts'
import type { GatewayServerConfig } from './mcp-gateway-config.ts'

const bufferLimit = 384 * 1024
const maxRemembered = 12

interface AgentTerminal {
  checkoutCommit?: string
  info: AgentTerminalInfo
  process?: ManagedTerminal
  output: string
  viewers: Set<Readable>
  chat?: OpenCodeChat | Awaited<ReturnType<typeof openClineWorker>>
  exited: Promise<void>
  shutdown?: Promise<void>
}

const launchers = {
  opencode: { override: 'KRAFLR_OPENCODE_EXE', args: ['--standalone'] },
  cline: { override: 'KRAFLR_CLINE_EXE', args: ['--tui'] },
  claude: { override: 'KRAFLR_CLAUDE_EXE', args: [] },
} satisfies Record<AgentKind, { override: string; args: string[] }>

export function resolveAgent(kind: AgentKind) {
  const windows = process.platform === 'win32'
  const executable = windows ? `${kind}.exe` : kind
  const folders = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  const npmPrefixes = [process.env.npm_config_prefix, process.env.APPDATA && join(process.env.APPDATA, 'npm')]
  const packages = kind === 'opencode' ? ['@opencode/cli'] : kind === 'claude' ? ['@anthropic-ai/claude-code'] : [
    `cline/node_modules/@cline/cli-windows-${process.arch}`, `@cline/cli-windows-${process.arch}`,
  ]
  const candidates = [process.env[launchers[kind].override]]
  // Claude Code's native installer puts the binary in the home folder rather than on every shell's PATH.
  if (kind === 'claude') for (const base of [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')]) candidates.push(join(base, executable))
  if (windows) {
    for (const prefix of [...npmPrefixes, ...folders]) {
      if (!prefix || !isAbsolute(prefix)) continue
      for (const name of packages) candidates.push(join(prefix, 'node_modules', name, 'bin', executable))
    }
  }
  for (const folder of folders) candidates.push(join(folder, executable))
  // On Linux and macOS the installers put these CLIs in per-user folders that a non-login shell often does not have on PATH.
  if (!windows) {
    const prefix = process.env.npm_config_prefix
    for (const base of [join(homedir(), '.local', 'bin'), join(homedir(), '.opencode', 'bin'), join(homedir(), '.npm-global', 'bin'), ...(prefix && isAbsolute(prefix) ? [join(prefix, 'bin')] : []), '/usr/local/bin']) candidates.push(join(base, executable))
  }
  for (const path of candidates) {
    if (!path || !isAbsolute(path)) continue
    if (windows && extname(path).toLowerCase() !== '.exe') continue
    // WSL leaks the Windows PATH into Linux, so a CLI installed only on Windows can otherwise resolve here as if it
    // were a native Linux install, then fail confusingly at spawn time. /mnt/<drive>/... is always a Windows mount.
    if (!windows && /^\/mnt\/[a-z]\//i.test(path)) continue
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      // The npm package can ship a tiny placeholder in bin/ until its installer swaps in the real binary.
      if (kind === 'claude' && windows && info.size < 1_000_000) continue
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // Continue looking for an installed executable.
    }
  }
  return null
}

export function agentEnvironment(kind: AgentKind) {
  const allowed = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'USER',
    'USERNAME', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    // The shell an agent's commands run in, and the Docker engine its own docker commands should reach (for example a non-default socket in WSL).
    'SHELL', 'DOCKER_HOST', 'DOCKER_CONTEXT',
  ]
  if (kind === 'cline') allowed.push('CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_API_KEY')
  // Claude Code signs in through its own config folder, so the researcher's subscription login works as it does in any terminal. An ambient
  // ANTHROPIC_API_KEY is deliberately not forwarded: it would override that login and silently move usage to metered API billing.
  // KRAFLR_CLAUDE_ENV names extra variables (for example ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL) the researcher chooses to pass through.
  if (kind === 'claude') {
    const chosen = (process.env.KRAFLR_CLAUDE_ENV ?? '').split(',').map((name) => name.trim()).filter((name) => /^[A-Z][A-Z0-9_]{1,63}$/.test(name) && !name.startsWith('KRAFLR_'))
    allowed.push('CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SHELL', ...chosen)
  }
  const env = Object.fromEntries(allowed.flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
  return {
    ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
    ...(kind === 'cline' && { CLINE_SESSION_BACKEND_MODE: 'local' }),
  }
}

function event(name: string, payload: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

function publish(session: AgentTerminal, name: string, payload: unknown) {
  const packet = event(name, payload)
  for (const stream of session.viewers) {
    if (stream.readableLength > bufferLimit * 3) stream.destroy()
    else stream.push(packet)
  }
}

export function createAgentTerminals(scratchRoot: string, store: ResearchStore, overrides: Partial<{
  resolveAgent: typeof resolveAgent
  spawn: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ManagedTerminal
  startPrivateOpenCode: typeof startPrivateOpenCode
  openClineWorker: typeof openClineWorker
  stopTerminal: (terminal: ManagedTerminal) => Promise<void>
  sessionEnvironment: (id: string, panel: PanelDetail, cwd: string) => Record<string, string>
  sessionInstructions: string | ((id:string,panel:PanelDetail,role:'parent'|'child')=>string)
  onNativeTurn:(session:AgentTerminalInfo,turn:NativeTurn)=>void
  mcpGateway: GatewayServerConfig
}> = {}) {
  const runtime = { resolveAgent, spawn: process.platform === 'win32' ? spawnWindowsTerminal : spawn, startPrivateOpenCode, openClineWorker,
    stopTerminal: async (terminal: ManagedTerminal) => {
      if (process.platform === 'win32') await stopWindowsProcessTree(terminal.pid)
      else terminal.kill()
    }, ...overrides }
  const sessions = new Map<string, AgentTerminal>()
  let closing = false
  let starting = 0
  const lifetime = new AbortController()
  const restoring = new Set<string>()
  const assigned = new Set<string>()
  const observed=new Map<string,Set<string>>()
  let polling=false
  async function pollNativeTurns(){if(polling||closing||!runtime.onNativeTurn)return;polling=true
    try{for(const session of sessions.values()){
      if(session.info.kind!=='opencode'||session.info.state!=='running'||!session.chat||!('completedTurns' in session.chat))continue
      try{const seen=observed.get(session.info.id)??new Set<string>();observed.set(session.info.id,seen)
        for(const turn of await session.chat.completedTurns())if(!seen.has(turn.id)){
          if(!turn.failed&&!turn.historical&&turn.model){store.saveAgentModel(session.info.panelId,session.info.id,turn.model);session.info.model=turn.model;session.info.modelSelectionRequired=false}
          runtime.onNativeTurn(session.info,turn);seen.add(turn.id)
        }
      }catch{/* A transient local API failure must not invent a completed record. */}
    }}finally{polling=false}
  }
  const nativeRecordTimer=runtime.onNativeTurn?setInterval(()=>void pollNativeTurns(),1500):undefined
  const unsubscribeScope = store.onScopeChanged((panelId, version) => {
    for (const session of sessions.values()) {
      if (session.info.panelId === panelId && session.info.scopeVersion !== version && session.info.state === 'running') {
        session.info.detail = 'Stopped because the research scope changed. Start a new agent on the current revision.'
        void stop(panelId, session.info.id).catch(() => {
          session.info.detail = 'The scope changed, but process shutdown could not be confirmed. Check this agent before restarting it.'
          publish(session, 'state', session.info)
        })
      }
    }
  })

  function read(panelId: string, terminalId: string) {
    const session = sessions.get(terminalId)
    if (!session || session.info.panelId !== panelId) throw new StoreError(404, 'This terminal is no longer available.')
    return session
  }

  function running(panelId: string, terminalId: string) {
    const session = read(panelId, terminalId)
    if (session.info.state !== 'running') throw new StoreError(409, 'This terminal has stopped.')
    return session
  }

  async function stop(panelId: string, terminalId: string) {
    const session = read(panelId, terminalId)
    if (session.info.state === 'exited') return session.info
    if (!session.shutdown) {
      session.info = { ...session.info, state: 'stopping' }
      publish(session, 'state', session.info)
      session.shutdown = (async () => {
        const timeout = new AbortController()
        try {
          if (session.process) {
            await runtime.stopTerminal(session.process)
            // Wait for the PTY to observe process exit before stopping the private server.
            const exited = await Promise.race([session.exited.then(() => true), delay(3000, false, { signal: timeout.signal })])
            if (!exited) throw new Error('Terminal shutdown was not observed.')
          }
        } finally {
          timeout.abort()
          await session.chat?.close()
        }
      })().catch(() => {
        session.shutdown = undefined
        throw new StoreError(503, 'Kraflr could not confirm this agent stopped. Check its process.')
      })
    }
    await session.shutdown
    return session.info
  }

  function managedChat(panelId: string, terminalId: string) {
    const session = running(panelId, terminalId)
    const worker = session.chat
    if (!worker) throw new StoreError(409, 'Choose a live managed OpenCode or Cline session.')
    return { session, worker }
  }

  function list(): AgentTerminalInfo[] {
    const parents = new Set(store.listAgentParents().map((parent) => parent.sessionId))
    return store.listSavedAgents().map(({ nativeId, model, ...record }) => {
      const live = sessions.get(record.id)
      return {
        ...record, model: model ?? undefined, state: 'offline', exitCode: null,
        chat: record.mode === 'cline-worker' || (record.kind === 'opencode' && Boolean(nativeId)),
        ...live?.info, parent: parents.has(record.id),
      }
    })
  }

  async function launch(panel: PanelDetail, { kind, label, cols, rows, role, mode = 'terminal' }: LaunchTerminalInput,
    saved?: SavedAgentSession): Promise<AgentTerminalInfo> {
    if (closing) throw new StoreError(503, 'Kraflr is shutting down.')
    const launchScope = store.readSourceScope(panel.id, panel.scopeVersion)
    if (saved && saved.scopeVersion !== panel.scopeVersion) {
      throw new StoreError(409, 'This conversation uses an earlier scope. Start a new agent with the current revision; its research brief preserves earlier work.')
    }
    if (mode === 'cline-worker' && kind !== 'cline') throw new StoreError(400, 'The Cline worker mode requires Cline.')
    const { name } = agentDetails[kind]
    const active = [...sessions.values()].filter((session) => isActiveAgent(session.info))
    if (active.length + starting >= maxActiveAgents) {
      throw new StoreError(409, `Kraflr supports ${maxActiveAgents} active agents. Stop one before opening another.`)
    }
    const executable = runtime.resolveAgent(kind)
    if (!executable) throw new StoreError(409, `Install the ${name} CLI or set ${launchers[kind].override} to its executable.`)
    const id = saved?.id ?? randomUUID()
    if (restoring.has(id) || (sessions.has(id) && sessions.get(id)?.info.state !== 'exited')) {
      throw new StoreError(409, 'This terminal is already open.')
    }
    const cwd = join(scratchRoot, id)
    const title = label?.trim() || name
    const history = saved ? panel.scopeHistory.filter((revision) => revision.version === saved.scopeVersion) : panel.scopeHistory
    const context = agentContext({ ...panel, scopeHistory: history })
    const launchRole=role??saved?.role??(store.agentParent(panel.id)&&store.agentParent(panel.id)!==id?'child':'parent')
    const extraInstructions=typeof overrides.sessionInstructions==='function'?overrides.sessionInstructions(id,panel,launchRole):overrides.sessionInstructions
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    if(lstatSync(cwd).isSymbolicLink())throw new StoreError(409,'The session folder is linked elsewhere. Start a fresh session.')
    const instructions = join(cwd, 'AGENTS.md')
    if (!existsSync(instructions)) writeFileSync(instructions, context.text + (extraInstructions ?? ''), { flag: 'wx', mode: 0o600 })
    else if(extraInstructions){
      if(lstatSync(instructions).isSymbolicLink())throw new StoreError(409,'The session instruction file is linked elsewhere. Start a fresh session.')
      if(statSync(instructions).size>128_000)throw new StoreError(409,'This session’s instruction file is too large. Start a fresh session.')
      const previous=readFileSync(instructions,'utf8')
      if(!previous.includes(extraInstructions.trim()))writeFileSync(instructions,previous+extraInstructions,{mode:0o600})
    }
    if (kind === 'opencode') prepareAgentPolicy(cwd, launchScope, runtime.mcpGateway)
    let chat: OpenCodeChat | undefined
    let worker: Awaited<ReturnType<typeof openClineWorker>> | undefined
    let args = launchers[kind].args
    let env = { ...agentEnvironment(kind), ...overrides.sessionEnvironment?.(id, panel, cwd) }
    let terminal: ManagedTerminal | undefined
    const startedAt = saved?.startedAt ?? new Date().toISOString()
    starting++
    restoring.add(id)
    try {
      if (mode === 'cline-worker') {
        worker = await runtime.openClineWorker({
          executable, cwd, env, nativeId: saved?.nativeId, preferredModel: saved?.model, signal: lifetime.signal,
          onSaved: (nativeId) => store.saveAgentNativeId(panel.id, id, nativeId),
        })
      } else if (kind === 'opencode') {
        try {
          const server = await runtime.startPrivateOpenCode(executable, cwd, env, lifetime.signal)
          try {
            chat = await createOpenCodeChat(server, title, saved?.nativeId, saved?.model)
            args = ['--server', server.url, '--session', chat.id]
            env = { ...env, ...server.credentials }
          } catch (failure) {
            await server.close()
            throw failure
          }
        } catch (error) {
          throw error instanceof StoreError ? error : new StoreError(503, 'OpenCode could not start its managed API. Update the CLI and retry.')
        }
      }
      if (closing) throw new StoreError(503, 'Kraflr is shutting down.')
      store.readSourceScope(panel.id, context.revision ?? 0)
      if (!saved) store.saveAgentSession({
        id, panelId: panel.id, kind, mode, label: title, startedAt, scopeVersion: context.revision, nativeId: chat?.id ?? null,role,
      })
      else if (!saved.nativeId && chat) store.saveAgentNativeId(panel.id, id, chat.id)
      if (!worker) terminal = runtime.spawn(executable, args, { cwd, cols, rows, env, name: 'xterm-256color' })
    } catch (error) {
      await (worker ?? chat)?.close()
      if (error instanceof StoreError) throw error
      throw new StoreError(503, `Kraflr could not start ${name} in a managed terminal.`)
    } finally {
      starting--
      restoring.delete(id)
    }
    const info: AgentTerminalInfo = {
      id, panelId: panel.id, kind, mode, label: title,
      state: 'running', startedAt, exitCode: null,
      scopeVersion: context.revision, chat: Boolean(worker ?? chat),
      model: worker?.models().current ?? (chat && !chat.modelSelectionRequired ? saved?.model ?? undefined : undefined),
      modelSelectionRequired: chat ? !saved?.model || chat.modelSelectionRequired : worker?.modelSelectionRequired,
      parent: store.agentParent(panel.id) === id,
    }
    let markExited = () => {}
    const exited = new Promise<void>((resolve) => { markExited = resolve })
    const redactOutput = secretRedactor([(env as NodeJS.ProcessEnv).CLINE_API_KEY, (env as NodeJS.ProcessEnv).OPENCODE_SERVER_PASSWORD, (env as NodeJS.ProcessEnv).KRAFLR_AGENT_TOKEN])
    const session: AgentTerminal = { process: terminal, info, output: '', viewers: new Set(), chat: worker ?? chat, exited,
      checkoutCommit: launchScope.resolvedCommit }
    sessions.set(id, session)
    if (sessions.size > maxRemembered) {
      const expired = [...sessions].find(([, candidate]) => candidate.info.state === 'exited')
      if (expired) sessions.delete(expired[0])
    }
    terminal?.onData((chunk) => {
      const text = redactOutput.write(chunk)
      session.output = (session.output + text).slice(-bufferLimit)
      if (text) publish(session, 'output', text)
    })
    const exit = (exitCode: number | null) => {
      const tail = redactOutput.flush()
      if (tail) { session.output = (session.output + tail).slice(-bufferLimit); publish(session, 'output', tail) }
      void chat?.close().catch(() => {})
      // An exit nobody asked for is a stoppage the researcher should hear about, with the provider's own last words when they explain it.
      const asked = Boolean(session.shutdown) || closing
      const lastLine = session.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse().find((line) => limitPattern.test(line))
      const stoppage: AgentStoppage | undefined = asked ? undefined : lastLine
        ? { kind: 'limit', reason: `${name} stopped: ${lastLine.slice(0, 240)}`, at: new Date().toISOString() }
        : { kind: 'exited', reason: `${name} exited${exitCode ? ` with code ${exitCode}` : ''} without being stopped from Kraflr.`, at: new Date().toISOString() }
      session.info = { ...session.info, state: 'exited', exitCode: exitCode ?? null, ...(stoppage ? { stoppage } : {}) }
      publish(session, 'state', session.info)
      for (const stream of session.viewers) stream.push(null)
      session.viewers.clear()
      markExited()
    }
    terminal?.onExit(({ exitCode }) => exit(exitCode ?? null))
    if (worker) void worker.closed.then(exit)
    return info
  }

  return {
    installations(): AgentInstallation[] {
      return agentKinds.map((kind) => ({ kind, installed: Boolean(runtime.resolveAgent(kind)) }))
    },
    list,
    async dashboardSessions() {
      const snapshots = await Promise.all(list().filter(isActiveAgent).map(async (info) => {
        const live = sessions.get(info.id)
        const telemetry = info.state === 'running' ? await live?.chat?.telemetry().catch(() => undefined) : undefined
        return { ...info, state: live?.info.state ?? info.state, model: telemetry?.model ?? live?.info.model, usage: telemetry?.usage }
      }))
      return snapshots.filter(isActiveAgent)
    },
    start: launch,
    async bindRepository(panelId: string) {
      const panel = store.readPanel(panelId)
      const scope = store.readSourceScope(panelId, panel.scopeVersion)
      if (!scope.resolvedCommit) return
      for (const session of sessions.values()) {
        if (session.info.panelId !== panelId || session.info.state !== 'running' || session.info.kind !== 'opencode' ||
            !session.chat || !('refreshConfiguration' in session.chat) || session.checkoutCommit === scope.resolvedCommit) continue
        if (assigned.has(session.info.id)) throw new StoreError(409, 'Wait for this panel’s agent assignment to finish before preparing source access.')
        assigned.add(session.info.id)
        try {
          prepareAgentPolicy(join(scratchRoot, session.info.id), scope, runtime.mcpGateway)
          await session.chat.refreshConfiguration(() => { running(panelId, session.info.id); store.readSourceScope(panelId, scope.version) })
          session.checkoutCommit = scope.resolvedCommit
        } finally { assigned.delete(session.info.id) }
      }
    },
    async resume(panel: PanelDetail, id: string, size: TerminalSize) {
      const saved = store.findSavedAgent(panel.id, id)
      if (!saved) throw new StoreError(404, 'This saved terminal does not belong to the panel.')
      if (saved.nativeId?.startsWith('pty:')) throw new StoreError(409, 'Reopen this native session from the Kraflr terminal command.')
      return launch(panel, { ...size, kind: saved.kind, mode: saved.mode, label: saved.label }, saved)
    },
    async attention(): Promise<AgentAttention[]> {
      const watched = [...sessions.values()].filter((session) => session.chat && session.info.state === 'running')
      return Promise.all(watched.map(async (session) => {
        const { panelId, id: terminalId } = session.info
        try {
          return { panelId, terminalId, ...await session.chat!.attention() }
        } catch {
          return { panelId, terminalId, permissions: [], question: false, unavailable: true }
        }
      }))
    },
    async messages(panelId: string, terminalId: string) {
      return await running(panelId, terminalId).chat?.messages() ?? []
    },
    async workerModels(panelId: string, terminalId: string) {
      return await managedChat(panelId, terminalId).worker.models()
    },
    async selectWorkerModel(panelId: string, terminalId: string, id: string) {
      const { session, worker } = managedChat(panelId, terminalId)
      if (assigned.has(terminalId)) throw new StoreError(409, 'Wait for the current assignment or model change to finish.')
      store.readSourceScope(panelId, session.info.scopeVersion ?? 0)
      assigned.add(terminalId)
      const requiredBefore = session.info.modelSelectionRequired
      let confirmed = false
      try {
        const model = await worker.selectModel(id)
        if (running(panelId, terminalId) !== session) throw new StoreError(409, 'Reopen this managed session before choosing a model.')
        store.readSourceScope(panelId, session.info.scopeVersion ?? 0)
        store.saveAgentModel(panelId, terminalId, model)
        confirmed = true
      } finally {
        const catalog = await Promise.resolve(worker.models()).catch(() => ({ current: null }))
        session.info = { ...session.info, model: catalog.current ?? undefined,
          modelSelectionRequired: worker.modelSelectionRequired || (!confirmed && requiredBefore) }
        assigned.delete(terminalId)
      }
      return session.info
    },
    async researchTurn(panelId: string, terminalId: string, text: string, scopeVersion: number, signal: AbortSignal) {
      signal.throwIfAborted()
      const session = running(panelId, terminalId)
      if (session.info.modelSelectionRequired) throw new StoreError(409, 'Choose and confirm this session’s model before starting research.')
      if (!session.chat || assigned.has(terminalId)) throw new StoreError(409, 'This session is unavailable for another research task.')
      assigned.add(terminalId)
      try {
        const reply = await session.chat.runTurn(text, () => {
          if (running(panelId, terminalId) !== session || session.info.scopeVersion !== scopeVersion) {
            throw new StoreError(409, 'This session does not use the current research scope.')
          }
          store.readSourceScope(panelId, scopeVersion)
        }, signal)
        if (session.info.stoppage) session.info = { ...session.info, stoppage: undefined }
        return reply
      } catch (failure) {
        if (signal.aborted) {
          await stop(panelId, terminalId).catch(() => {})
        } else if (failure instanceof Error && limitPattern.test(failure.message)) {
          // A provider limit does not end the process, but the agent cannot continue; the researcher decides who takes over.
          session.info = { ...session.info, stoppage: { kind: 'limit', reason: failure.message.slice(0, 300), at: new Date().toISOString() } }
        }
        throw failure
      } finally {
        assigned.delete(terminalId)
      }
    },
    async decide(panelId: string, terminalId: string, id: string, decision: AgentPermissionDecision,
      fingerprint: string, checkScope: (version: number | null) => void) {
      const session = running(panelId, terminalId)
      if (!session.chat) throw new StoreError(409, 'Use this session’s terminal to review permissions.')
      await session.chat.decide(id, decision, fingerprint, () => {
        const info = running(panelId, terminalId).info
        if (decision === 'once') checkScope(info.scopeVersion)
      })
    },
    stream(panelId: string, terminalId: string) {
      const session = read(panelId, terminalId)
      if (!session.process) throw new StoreError(409, 'Use the Cline worker activity view for this session.')
      if (session.viewers.size >= 4) throw new StoreError(409, 'Too many tabs are viewing this terminal.')
      const stream = new Readable({ read() {} })
      stream.push(event('snapshot', session.output))
      stream.push(event('state', session.info))
      if (session.info.state === 'exited') stream.push(null)
      else {
        session.viewers.add(stream)
        stream.once('close', () => { session.viewers.delete(stream) })
      }
      return stream
    },
    input(panelId: string, terminalId: string, text: string) {
      const session = running(panelId, terminalId)
      store.readSourceScope(panelId, session.info.scopeVersion ?? 0)
      const terminal = session.process
      if (!terminal) throw new StoreError(409, 'This worker receives tasks from its parent.')
      terminal.write(text)
    },
    resize(panelId: string, terminalId: string, size: TerminalSize) {
      running(panelId, terminalId).process?.resize(size.cols, size.rows)
    },
    stop,
    async close() {
      closing = true
      clearInterval(nativeRecordTimer)
      unsubscribeScope()
      lifetime.abort()
      const stops = []
      for (const session of sessions.values()) {
        for (const stream of session.viewers) stream.destroy()
        if (isActiveAgent(session.info)) {
          stops.push(stop(session.info.panelId, session.info.id))
        }
        else if (session.chat) stops.push(session.chat.close())
      }
      sessions.clear()
      await Promise.allSettled(stops)
    },
  }
}

export type AgentTerminals = ReturnType<typeof createAgentTerminals>
