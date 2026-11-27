import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ResearchStore } from './db.ts'
import { preparedLabPlan } from './prepared-verification.ts'
import { isOpenLead } from '../shared/evidence.ts'
import { isAgentExecutor, isProjectPlan, type VerificationRecord } from '../shared/verification.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { mentionsContainerTool } from '../shared/containers.ts'

/**
 * Keeps a submitted Docker lab inside the approval flow. Agents build and debug labs freely; once a lab is submitted (its checkpoint or a test plan
 * names an image) and its lead is still open, that lab starts only through the exact command of an approved test held by the same agent.
 * This is a guardrail on the commands an agent's own tool hooks report, not a sandbox: a script that calls Docker indirectly is not seen.
 */

/**
 * The simple commands a shell line runs, each as its words. Quoted text stays one word and heredoc bodies are skipped, so a Docker command that
 * is only quoted in a message or written into a file is not mistaken for one being run.
 */
export function shellCommands(line: string) {
  const text = line.replace(/[\\`]\r?\n/g, ' '), commands: string[][] = [], heredocs: string[] = []
  let words: string[] = [], word = '', started = false, quote = ''
  const endWord = () => { if (started) words.push(word); word = ''; started = false }
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = [] }
  for (let at = 0; at < text.length; at++) {
    const next = text[at]!
    if (quote) {
      if (next === quote) quote = ''
      else if (next === '\\' && quote === '"' && /["\\$`]/.test(text[at + 1] ?? '')) word += text[++at]
      else word += next
    } else if (next === '"' || next === "'") { quote = next; started = true }
    else if (next === '<' && /^<<-?(?!<)/.test(text.slice(at, at + 3)) && text[at - 1] !== '<') {
      const opening = /^<<-?[ \t]*["']?([A-Za-z_]\w*)["']?/.exec(text.slice(at))
      if (opening) { endWord(); heredocs.push(opening[1]!); at += opening[0].length - 1 } else { word += next; started = true }
    } else if (next === '\n') {
      endCommand()
      while (heredocs.length) {
        const closing = new RegExp(`\\n[ \\t]*${heredocs.shift()}[ \\t]*(?=\\r?\\n|\\r?$)`).exec(text.slice(at))
        at = closing ? at + closing.index + closing[0].length - 1 : text.length
      }
    } else if (/[;&|()]/.test(next)) endCommand()
    else if (/[ \t\r]/.test(next)) endWord()
    else { word += next; started = true }
  }
  endCommand()
  return commands
}

/** The command without what only wraps it: variable assignments, sudo, timeout and the like. */
function unwrapped(words: string[]) {
  let at = 0, wrapped = false
  for (; at < words.length; at++) {
    const word = words[at]!
    if (/^(?:\$env:)?[A-Za-z_]\w*=/.test(word)) continue
    if (/^(?:sudo|time|nohup|exec|command|env|nice|stdbuf|xargs|then|do|else|if|while|!|\{)$/.test(word)) { wrapped = true; continue }
    if (word === 'timeout') { wrapped = true; while (/^(?:-|\d+(?:\.\d+)?[smhd]?$)/.test(words[at + 1] ?? '')) at++; continue }
    if (wrapped && word.startsWith('-')) continue
    break
  }
  return words.slice(at)
}
const program = (word = '') => word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')

/** Every command that actually runs, including the script handed to another shell with -c. */
function executed(line: string, depth = 0): string[][] {
  return shellCommands(line).flatMap((words) => {
    const command = unwrapped(words), name = program(command[0])
    if (depth < 3 && /^(?:bash|sh|zsh|dash|powershell|pwsh|cmd|wsl)$/.test(name)) {
      const flag = command.findIndex((word, index) => index > 0 && /^(?:-[a-z]*c|-command|\/c)$/i.test(word))
      if (flag > 0 && command[flag + 1]) return executed(command.slice(flag + 1).join(' '), depth + 1)
    }
    return command.length ? [command] : []
  })
}

// Global options that take a value and may sit between the program and its command.
const valued = /^(?:-H|--host|--context|-c|--config|-l|--log-level|--url|--connection)$/
/** What a command does with containers: `launch` starts or creates one from an image, `compose` does so from a compose file. */
function containerStart(command: string[]): { launch: string[] } | { compose: true } | undefined {
  const name = program(command[0]), starting = (words: string[]) => words.some((word) => /^(?:up|run|start|create)$/.test(word))
  if (name === 'docker-compose' || name === 'podman-compose') return starting(command.slice(1)) ? { compose: true } : undefined
  if (name !== 'docker' && name !== 'podman') return
  let at = 1
  while (command[at]?.startsWith('-')) at += valued.test(command[at]!) ? 2 : 1
  if (command[at] === 'compose') return starting(command.slice(at + 1)) ? { compose: true } : undefined
  if (command[at] === 'container') at++
  return command[at] === 'run' || command[at] === 'create' ? { launch: command.slice(at + 1) } : undefined
}

export type ImageResolver = (reference: string) => Promise<string | undefined>

/** The ID a tag points at right now, so a locked image cannot be started under another name. Undefined when Docker does not know it. */
export const resolveImage: ImageResolver = (reference) => new Promise((done) => {
  execFile('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], { timeout: 4000, windowsHide: true },
    (error, stdout) => done(error ? undefined : String(stdout).trim()))
})

interface Lock { leadId: string; image: string; folder?: string }

async function lockedLabs(store: ResearchStore, panelId: string): Promise<Lock[]> {
  const open = (leadId: string) => { try { return isOpenLead(store.readEvidence(panelId, leadId)) } catch { return false } }
  const locks: Lock[] = []
  for (const run of store.listResearchRuns(panelId)) {
    if (run.purpose !== 'verification' || !run.leadId || !run.labDirectory || !open(run.leadId)) continue
    const plan = await preparedLabPlan(run).catch(() => undefined)
    if (plan) locks.push({ leadId: run.leadId, image: plan.image, folder: basename(run.labDirectory) })
  }
  for (const record of store.listVerification(panelId).records) {
    if (isProjectPlan(record.plan) && open(record.leadId)) locks.push({ leadId: record.leadId, image: record.plan.image })
  }
  return locks
}

/** The reason to refuse a shell command, or undefined when it may run. `approvedCommand` gives the exact argv a running grant allows. */
export async function labGuard(store: ResearchStore, agent: AgentTerminalInfo, command: string, cwd: string,
  approvedCommand: (record: VerificationRecord) => string[], resolve: ImageResolver = resolveImage): Promise<string | undefined> {
  if (!mentionsContainerTool(command)) return
  // The one allowed start: the approved command, unchanged (output may be redirected), from the agent holding that grant.
  const grants = store.listVerification(agent.panelId).records
    .filter((record) => record.status === 'running' && isAgentExecutor(record.executor) && record.lease?.agentId === agent.id).map(approvedCommand)
  const approved = (words: string[]) => grants.some((argv) => argv.every((word, index) => words[index] === word) && (words.length === argv.length || /^\d?[<>]/.test(words[argv.length]!)))
  const starts = executed(command).filter((words) => !approved(words)).flatMap((words) => containerStart(words) ?? [])
  if (!starts.length) return
  const locks = await lockedLabs(store, agent.panelId)
  if (!locks.length) return
  let hit: Lock | undefined
  for (const start of starts) {
    if ('compose' in start) hit = locks.find((lock) => lock.folder && (command.includes(lock.folder) || cwd.includes(lock.folder)))
    // The image named by ID, or the lab folder mounted into some other image.
    else hit = locks.find((lock) => start.launch.some((word) => word.includes(lock.image.slice(7, 19)) || Boolean(lock.folder && word.includes(lock.folder))))
    if (!hit && 'launch' in start) {
      for (const reference of start.launch.filter((word) => /^[a-z0-9][\w./:@-]{0,200}$/i.test(word)).slice(0, 8)) {
        const id = await resolve(reference)
        hit = locks.find((lock) => lock.image === id)
        if (hit) break
      }
    }
    if (hit) break
  }
  if (!hit) return
  return `Kraflr blocked this command: it starts the Docker lab submitted for lead ${hit.leadId}, which is still waiting on verification. A chat message is not an approval, so do not look for another way to run it. `
    + `Run \`kraflr agent verification status ${hit.leadId}\`. The researcher approves the saved test in the Kraflr pop-up and chooses who verifies it; that agent then runs the exact command printed by \`kraflr agent verification docker <test-id>\`, unchanged. `
    + 'If no test is saved yet, finish kraflr-verification.json or run `kraflr agent verification recover <preparation-id>`, then tell the researcher to review it.'
}
