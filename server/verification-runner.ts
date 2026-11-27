import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAgentPlan, isProjectPlan, limitRanges } from '../shared/verification.ts'
import type { FixtureObservation, FixtureVerificationPlan, ProjectObservation, ProjectVerificationPlan, VerificationAvailability, VerificationFailureDetail, VerificationPlan, VerificationVariant } from '../shared/verification.ts'
import { StoreError } from './db.ts'

const harness = readFileSync(new URL('./fixtures/verification-export.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const dockerConfig = fileURLToPath(new URL('./fixtures/', import.meta.url))
const image = 'docker.io/library/node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5'
const label = 'com.kraflr.verification'
// Docker CLI output is kept as a bounded tail: a chatty harness is a harness problem, never a runner crash.
const outputLimit = 64 * 1024
const diagnosticLimit = 3000
// A fixed, bounded scratch area. Without one a read-only root leaves PHP, Node and Python harnesses nowhere to write.
const scratchMount = '/tmp'
const scratchOptions = (scratchMiB: number) => `rw,noexec,nosuid,nodev,size=${scratchMiB}m,mode=1777`
export const fixtureVersion = 'export-fixture-v1'
export const fixtureSource = 'https://example.test/kraflr-export-fixture'

export function fixturePlan(variant: VerificationVariant): FixtureVerificationPlan {
  return {
    variant, fixtureVersion, image,
    harnessHash: createHash('sha256').update(harness).digest('hex'),
    action: 'Start the bundled HTTP fixture on container loopback. As synthetic user Alice, request GET /exports/a and GET /exports/b.',
    expected: 'Alice’s export is returned in both versions. The vulnerable version returns Bob’s synthetic export. The patched version returns HTTP 403.',
    isolation: { network: 'none', user: '1000:1000', readOnly: true, dropCapabilities: 'ALL', noNewPrivileges: true },
    limits: { memoryMiB: 128, cpus: 0.5, processes: 64, seconds: 15 },
  }
}

export function verificationHash(plan: VerificationPlan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

/** The exact hardened `docker create` flags for an approved plan, shared by Kraflr's runner and the agent-run command. */
/** The plans that run in a container: the self-test fixture, and a researched project test as an agent runs it. */
export type ContainerPlan = FixtureVerificationPlan | ProjectVerificationPlan

export function isolationArguments(plan: ContainerPlan) {
  const { isolation, limits } = plan
  return [
    '--network', isolation.network, '--read-only', '--user', isolation.user, '--cap-drop', isolation.dropCapabilities,
    '--security-opt', 'no-new-privileges=true', '--memory', `${limits.memoryMiB}m`, '--memory-swap', `${limits.memoryMiB}m`,
    '--cpus', String(limits.cpus), '--pids-limit', String(limits.processes),
    '--tmpfs', `${scratchMount}:${scratchOptions(limits.scratchMiB ?? limitRanges.scratchMiB.fallback)}`, '--env', `HOME=${scratchMount}`, '--env', `TMPDIR=${scratchMount}`,
  ]
}

function dockerExecutable() {
  const executable = process.platform === 'win32' ? 'docker.exe' : 'docker'
  for (const path of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const candidate = join(path, executable)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* Continue to the next installed executable. */ }
  }
}

interface DockerResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** A Docker CLI call that ended unsuccessfully. Its fields mirror what the failure classifier reads. */
export class DockerError extends Error {
  readonly result: DockerResult
  readonly killed: boolean
  readonly stderr: string
  readonly code: number | null
  constructor(result: DockerResult, args: string[]) {
    super(`docker ${args.find((arg) => !arg.startsWith('-')) ?? ''} failed${result.timedOut ? ' (timed out)' : ` with exit code ${result.code}`}: ${result.stderr.trim().split('\n')[0] ?? ''}`)
    this.result = result
    this.killed = result.timedOut
    this.stderr = result.stderr
    this.code = result.code
  }
}

function tail(limit: number) {
  let text = ''
  return { push(chunk: Buffer) { text = (text + chunk.toString('utf8')).slice(-limit) }, text: () => text }
}

// Only the pieces Docker needs to find the engine are forwarded. The user's proxy and registry settings stay out of the fixture.
function dockerEnvironment() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(path|systemroot|windir|temp|tmp|tmpdir|home|userprofile|programdata|xdg_runtime_dir)$/i.test(key)))
}

function launch(executable: string, args: string[], timeout: number, signal?: AbortSignal) {
  return new Promise<DockerResult>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const child = spawn(executable, args, { env: dockerEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = tail(outputLimit), err = tail(outputLimit)
    let timedOut = false, settled = false
    const stop = () => { try { child.kill() } catch { /* The process already ended. */ } }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
    const abort = () => { stop(); finish(() => reject(signal!.reason)) }
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); settle()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => finish(() => resolve({ code, stdout: out.text(), stderr: err.text(), timedOut })))
  })
}

const pipeHosts = ['npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine']
function hostCandidates() {
  const configured = process.env.KRAFLR_DOCKER_HOST?.trim()
  // Only a local engine is acceptable; a remote daemon would not honor the local isolation guarantees.
  if (configured) return /^(?:npipe|unix):\/\/\S+$/.test(configured) ? [configured] : []
  if (process.platform === 'win32') return pipeHosts
  const runtime = process.env.XDG_RUNTIME_DIR, home = process.env.HOME
  return ['unix:///var/run/docker.sock', ...(runtime ? [`unix://${runtime}/docker.sock`] : []), ...(home ? [`unix://${home}/.docker/run/docker.sock`] : [])]
}

let resolvedHost: string | undefined
async function dockerHost(executable: string) {
  if (resolvedHost) return resolvedHost
  let denied = false
  for (const host of hostCandidates()) {
    try {
      const probe = await launch(executable, ['--config', dockerConfig, '--host', host, 'version', '--format', '{{.Server.Os}}'], 6000)
      if (probe.code === 0 && probe.stdout.trim() === 'linux') return resolvedHost = host
      if (/permission denied/i.test(probe.stderr)) denied = true
    } catch { /* Try the next local engine address. */ }
  }
  // An engine that is running but not open to this user needs a different fix from one that is not running.
  if (denied) throw new Error('Docker CLI cannot connect: permission denied on the Docker socket. Add your user to the docker group (sudo usermod -aG docker $USER) and open a new shell.')
  throw new Error('Docker CLI cannot connect: no local Linux engine answered (tried ' + (hostCandidates().join(', ') || 'none') + ').')
}

async function dockerRaw(args: string[], timeout = 7000, signal?: AbortSignal) {
  const executable = dockerExecutable()
  if (!executable) throw new Error('Docker CLI unavailable.')
  const host = await dockerHost(executable)
  // Use the bundled directory so Docker cannot inject the user's proxy configuration into the fixture.
  return launch(executable, ['--config', dockerConfig, '--host', host, ...args], timeout, signal)
}

async function docker(args: string[], timeout = 7000, signal?: AbortSignal) {
  const result = await dockerRaw(args, timeout, signal)
  if (result.code !== 0 || result.timedOut) {
    // A vanished engine invalidates the cached address so the next call probes again.
    if (/cannot connect|failed to connect|pipe.*cannot find/i.test(result.stderr)) resolvedHost = undefined
    throw new DockerError(result, args)
  }
  return result.stdout.trim()
}

function name(id: string) {
  return `kraflr-verification-${id}`
}

async function cleanup(id: string) {
  try {
    const metadata = await docker(['container', 'inspect', '--format', `{{.Id}} {{index .Config.Labels "${label}"}}`, name(id)], 15_000)
    const [container, owner] = metadata.split(' ')
    if (!container || !/^[a-f0-9]{64}$/.test(container) || owner !== id) throw new Error('Container ownership could not be verified.')
    await docker(['container', 'rm', '--force', container], 30_000)
  } catch (failure) {
    if (!/no such (object|container)/i.test((failure as { stderr?: string }).stderr ?? '')) throw failure
  }
}

function observation(output: string): FixtureObservation {
  const result = JSON.parse(output) as Partial<FixtureObservation> | null
  if (!result || !Number.isInteger(result.ownerStatus) || !Number.isInteger(result.foreignStatus) ||
      typeof result.ownerRecordReturned !== 'boolean' || typeof result.foreignRecordReturned !== 'boolean') {
    throw new Error('The fixture returned an invalid observation.')
  }
  return {
    ownerStatus: result.ownerStatus!, foreignStatus: result.foreignStatus!,
    ownerRecordReturned: result.ownerRecordReturned, foreignRecordReturned: result.foreignRecordReturned,
  }
}

/** Validate one structured result. Shared with the agent-run report path so both executors accept the same contract. */
export function readProjectObservation(value: unknown): ProjectObservation {
  const result = value as Partial<ProjectObservation> | null
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The result must be a JSON object.')
  const problems = [
    !['reproduced', 'not_reproduced', 'inconclusive'].includes(result.outcome ?? '') && 'outcome must be "reproduced", "not_reproduced" or "inconclusive"',
    typeof result.controlPassed !== 'boolean' && 'controlPassed must be true or false',
    (typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 1200) && 'summary must be a non-empty string of at most 1200 characters',
    (typeof result.evidence !== 'string' || result.evidence.length > 4000) && 'evidence must be a string of at most 4000 characters',
  ].filter(Boolean)
  const given = (value as { environment?: unknown }).environment
  const names = (list: unknown) => Array.isArray(list) && list.length <= 20 && list.every((item) => typeof item === 'string' && item.trim() && item.length <= 200)
    ? (list as string[]).map((item) => item.trim()) : undefined
  const environment = given && typeof given === 'object' && !Array.isArray(given) ? given as { fidelity?: unknown; real?: unknown; substituted?: unknown } : undefined
  if (given !== undefined && !(environment && ['full', 'partial'].includes(String(environment.fidelity)) && names(environment.real) && names(environment.substituted))) {
    problems.push('environment must be {"fidelity":"full"|"partial","real":[…],"substituted":[…]} with at most 20 short names in each list')
  }
  if (problems.length) throw new Error('The structured result is invalid: ' + problems.join('; ') + '.')
  return { kind: 'project', outcome: result.outcome!, controlPassed: result.controlPassed!,
    summary: result.summary!, evidence: result.evidence!,
    ...(environment ? { environment: { fidelity: environment.fidelity as 'full' | 'partial', real: names(environment.real)!, substituted: names(environment.substituted)! } } : {}) }
}

async function validateImage(plan: ProjectVerificationPlan) {
  const raw = await docker(['image', 'inspect', '--format',
    '{"id":{{json .Id}},"os":{{json .Os}},"labels":{{json (index .Config "Labels")}},"volumes":{{json (index .Config "Volumes")}}}', plan.image], 15_000)
  const info = JSON.parse(raw) as { id?: string; os?: string; labels?: Record<string, string>; volumes?: Record<string, unknown> }
  if (info.id !== plan.image || info.os !== 'linux' || Object.keys(info.volumes ?? {}).length) {
    throw new StoreError(409, 'Choose a local Linux image without declared volumes.')
  }
  if (info.labels?.['org.opencontainers.image.source'] !== plan.repository ||
      info.labels?.['org.opencontainers.image.revision'] !== plan.targetVersion) {
    throw new StoreError(409, 'The image’s source and revision labels must match the saved research scope.')
  }
}

async function checkIsolation(container: string, plan: ContainerPlan) {
  const template = '{"user":{{json .Config.User}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}'
  const inspect = await docker(['container', 'inspect', '--format', template, container])
  const { user, host: config, mounts } = JSON.parse(inspect) as { user: unknown; mounts: unknown; host: {
    NetworkMode?: string; ReadonlyRootfs?: boolean; Privileged?: boolean; CapDrop?: string[];
    SecurityOpt?: string[]; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number;
    Tmpfs?: Record<string, string>; Binds?: string[] | null
  } }
  const { isolation, limits } = plan
  const bytes = limits.memoryMiB * 1024 * 1024
  const scratch = config.Tmpfs?.[scratchMount] ?? ''
  if ((mounts !== null && (!Array.isArray(mounts) || mounts.length > 0)) || (config.Binds?.length ?? 0) > 0 ||
      Object.keys(config.Tmpfs ?? {}).some((path) => path !== scratchMount) || !/(?:^|,)noexec(?:,|$)/.test(scratch) ||
      user !== isolation.user || config.NetworkMode !== isolation.network || !config.ReadonlyRootfs ||
      config.Privileged !== false || !config.CapDrop?.includes(isolation.dropCapabilities) ||
      !config.SecurityOpt?.some((item) => /^no-new-privileges[=:]true$/.test(item)) ||
      config.Memory !== bytes || config.MemorySwap !== bytes || config.NanoCpus !== limits.cpus * 1e9 ||
      config.PidsLimit !== limits.processes) throw new Error('Docker did not confirm the approved isolation settings.')
}

export interface VerificationRunner {
  available(plan?: VerificationPlan): Promise<VerificationAvailability>
  run(plan: VerificationPlan, id: string, signal: AbortSignal, beforeStart: () => void): Promise<FixtureObservation | ProjectObservation>
  cleanup?(id: string): Promise<void>
}

/** A failure that happened inside the container or in its result, not in Docker itself. */
export class ContainerFailure extends Error {
  readonly code: string
  readonly exitCode?: number
  readonly output?: string
  constructor(code: string, message: string, extra: { exitCode?: number; output?: string } = {}) {
    super(message)
    this.code = code
    this.exitCode = extra.exitCode
    this.output = extra.output
  }
}

// Harness output is untrusted data: keep a bounded tail with terminal control sequences removed.
function sanitize(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(-diagnosticLimit)
}

export function verificationFailure(failure: unknown, stage: string): VerificationFailureDetail {
  if (failure instanceof ContainerFailure) {
    const hints: Record<string, string> = {
      harness_failed: `The test command exited with code ${failure.exitCode ?? 'non-zero'} before reporting a result. Ask the parent to repair the harness using the saved output, rebuild the image, then recover the lab for a new approval. Retrying the unchanged image fails the same way.`,
      output_invalid: `${failure.message} The harness must exit 0 after printing exactly one KRAFLR_VERIFICATION_RESULT JSON line. Ask the parent to fix the harness output, rebuild, and recover the lab.`,
      test_timeout: 'The test did not finish within its time limit. Ask the parent to make the harness faster or bounded, rebuild, and recover the lab. Retrying the same image will time out again.',
      oom_killed: 'The test exceeded its memory limit. Ask the parent to reduce the harness footprint; do not relax the isolation policy.',
      harness_command_missing: 'The container could not start the approved command. Ask the parent to fix the executable or harness path inside the image, then request a new plan.',
    }
    return { stage, code: failure.code, retryable: false, hint: hints[failure.code] ?? failure.message,
      ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }), ...(failure.output ? { output: failure.output } : {}) }
  }
  const error = failure as { stderr?: string; message?: string; code?: string | number; killed?: boolean }
  const text = String(error.stderr ?? '') + ' ' + String(error.message ?? '')
  let code = 'docker_operation_failed', retryable = true,
    hint = 'Docker rejected this operation. Retry the saved test with fresh approval; if the same error repeats, check Docker Desktop and ask the parent to repair the lab.'
  if (error.killed || /ETIMEDOUT|timed? out/i.test(text)) { code = 'docker_timeout'; hint = 'Docker did not finish this operation in time. Keep the built image and retry the saved test with fresh approval.' }
  else if (/failed to connect|cannot connect|daemon.*running|pipe.*cannot find|no local linux engine/i.test(text)) { code = 'docker_unavailable'; hint = 'Start Docker Desktop and wait for its Linux engine, then retry the saved test.' }
  else if (/no such image|image.*not found/i.test(text)) { code = 'image_missing'; retryable = false; hint = 'The approved image is no longer local. Ask the parent to restore/build it and propose a new image ID.' }
  else if (/executable file not found|exec:.*no such file|OCI.*executable|not a directory.*exec/i.test(text)) { code = 'harness_command_missing'; retryable = false; hint = 'Ask the parent to fix the executable or harness path inside the image, then request a new plan.' }
  else if (/already in use|conflict.*container/i.test(text)) { code = 'container_conflict'; retryable = false; hint = 'A previous container still exists. Confirm cleanup before requesting a fresh test.' }
  else if (/unknown flag|invalid.*(?:cpu|memory|swap|pids|tmpfs)|not support.*(?:memory|swap|cpu)/i.test(text)) { code = 'engine_configuration'; retryable = false; hint = 'The Docker engine rejected the requested settings. Check Linux-engine resource support; do not relax the isolation policy.' }
  else if (/did not confirm the approved isolation/i.test(text)) { code = 'isolation_unconfirmed'; retryable = false; hint = 'Docker did not apply the approved isolation settings, so the test was not started. Update Docker Desktop and retry.' }
  return { stage, code, retryable, hint }
}

export class VerificationExecutionError extends StoreError {
  diagnostic: VerificationFailureDetail
  constructor(failure: unknown, stage: string) {
    const diagnostic = verificationFailure(failure, stage)
    super(502, `Verification failed while ${stage} (${diagnostic.code}). ${diagnostic.hint}`)
    this.diagnostic = diagnostic
  }
}
export class CleanupError extends Error { diagnostic?: VerificationFailureDetail }

async function startContainer(container: string, plan: ContainerPlan, signal: AbortSignal) {
  const attached = await dockerRaw(['container', 'start', '--attach', container], plan.limits.seconds * 1000, signal)
  const state = await docker(['container', 'inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}', container], 15_000)
  const [exit, oom] = state.split(' ')
  const exitCode = Number(exit)
  const output = sanitize([attached.stderr, attached.stdout].filter(Boolean).join('\n'))
  if (attached.timedOut) throw new ContainerFailure('test_timeout', 'The test exceeded its time limit.', { output })
  if (oom === 'true') throw new ContainerFailure('oom_killed', 'The test exceeded its memory limit.', { exitCode, output })
  if (/executable file not found|no such file or directory|permission denied/i.test(attached.stderr) && (exitCode === 126 || exitCode === 127)) {
    throw new ContainerFailure('harness_command_missing', 'The approved command could not start.', { exitCode, output })
  }
  if (exitCode !== 0 || attached.code !== 0) throw new ContainerFailure('harness_failed', 'The test command failed.', { exitCode: Number.isInteger(exitCode) ? exitCode : undefined, output })
  return attached.stdout
}

export const dockerVerificationRunner: VerificationRunner = {
  async available(plan) {
    const selectedImage = plan?.image ?? image
    try {
      // Docker Desktop can take several seconds to answer when it is busy; a slow engine must not read as a missing one.
      const info = await docker(['info', '--format', '{{.OSType}} {{.CgroupDriver}} {{.MemoryLimit}} {{.PidsLimit}}'], 25_000)
      if (!/^linux (?:systemd|cgroupfs) true true$/.test(info)) {
        return { ready: false, image: selectedImage, detail: 'Verification requires a local Linux Docker engine with resource limits.' }
      }
    } catch (failure) {
      const reason = (failure as Error).message
      return { ready: false, image: selectedImage, detail: /permission denied/i.test(reason) ? reason
        : /no local linux engine/i.test(reason)
        ? 'Start Docker (Docker Desktop’s Linux engine, or the docker service), or set KRAFLR_DOCKER_HOST to a local npipe:// or unix:// address. ' + reason
        : 'Start Docker’s Linux engine or check local Docker access.' }
    }
    // Without a plan the question is only whether the engine works. The bundled self-test image is checked when a self-test plan asks for it,
    // and a researched lead's own image when its plan is queued; neither belongs in a general "is Docker usable" answer.
    if (!plan) return { ready: true, image: selectedImage, detail: 'Docker ready.' }
    try {
      const id = await docker(['image', 'inspect', '--format', '{{.Id}}', selectedImage], 15_000)
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Image unavailable.')
      if (plan && isProjectPlan(plan)) await validateImage(plan)
      return { ready: true, image: selectedImage, detail: 'Docker ready.' }
    } catch (failure) {
      return { ready: false, image: selectedImage, detail: failure instanceof StoreError ? failure.message : 'The approved image is missing from local Docker.' }
    }
  },
  cleanup,
  async run(plan, id, signal, beforeStart) {
    // Kraflr's runner only executes the bundled self-test. A researched lead is run by the agent the researcher approves. Refused before
    // anything else, so that no container cleanup (which needs Docker) can replace this answer.
    if (isAgentPlan(plan)) throw new StoreError(409, 'A researched lead is verified by an agent, not by Kraflr’s runner.')
    let stage = 'checking the approved image'
    let diagnostic: VerificationFailureDetail | undefined
    try {
      signal.throwIfAborted()
      const command = ['/usr/local/bin/node', '--input-type=module', '--eval', harness, '--', plan.variant]
      stage = 'creating the isolated container'
      const container = await docker([
        'container', 'create', '--pull=never', '--name', name(id), '--label', `${label}=${id}`,
        ...isolationArguments(plan), '--log-driver', 'none',
        '--no-healthcheck', '--entrypoint', command[0]!, plan.image, ...command.slice(1),
      ], 30_000, signal)
      if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Unexpected fixture container ID.')
      stage = 'checking the container isolation settings'
      await checkIsolation(container, plan)
      signal.throwIfAborted()
      beforeStart()
      stage = 'running the test command'
      const output = await startContainer(container, plan, signal)
      stage = 'reading the test’s structured result'
      return observation(output)
    } catch (failure) {
      if (failure instanceof StoreError || signal.aborted) throw failure
      const error = new VerificationExecutionError(failure, stage)
      diagnostic = error.diagnostic
      throw error
    } finally {
      try { await cleanup(id) } catch {
        const error = new CleanupError('Kraflr could not confirm fixture container cleanup.')
        error.diagnostic = diagnostic
        throw error
      }
    }
  },
}
