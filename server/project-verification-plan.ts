import type { ScopeRevision } from '../shared/research.ts'
import { limitRanges } from '../shared/verification.ts'
import type { ProjectVerificationInput, ProjectVerificationPlan, VerificationLimits } from '../shared/verification.ts'
import { StoreError } from './db.ts'

const limitProperties = Object.fromEntries(Object.entries(limitRanges).map(([name, range]) => [name, { type: 'number', minimum: range.min, maximum: range.max }]))
export const projectPlanProperties = {
  title: { type: 'string', minLength: 1, maxLength: 160, pattern: '\\S' },
  image: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  command: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 2000 } },
  action: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  expected: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  limits: { type: 'object', additionalProperties: false, properties: limitProperties },
}
/** Everything except the optional resource request is required. */
export const projectPlanRequired = Object.keys(projectPlanProperties).filter((name) => name !== 'limits')

/** The resources a plan asks for, or undefined when a requested number is missing, out of range or inconsistent. */
function readLimits(value: unknown): VerificationLimits | undefined {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return
  const given = (value ?? {}) as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const [name, range] of Object.entries(limitRanges)) {
    const requested = given[name]
    if (requested === undefined) { result[name] = range.fallback; continue }
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < range.min || requested > range.max) return
    if (name !== 'cpus' && !Number.isInteger(requested)) return
    result[name] = requested
  }
  // The scratch folder lives in memory, so it has to fit inside what the container may use.
  if (result.scratchMiB! > result.memoryMiB!) return
  return result as unknown as VerificationLimits
}

export function readProjectVerification(value: unknown): ProjectVerificationInput | undefined {
  if (!value || typeof value !== 'object') return
  const { title, image, command, action, expected, limits } = value as Partial<ProjectVerificationInput>
  const validText = (text: unknown, limit: number): text is string =>
    typeof text === 'string' && text.trim().length > 0 && text.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  if (!validText(title, 160) || !validText(action, 2000) || !validText(expected, 2000) ||
      typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image) ||
      !Array.isArray(command) || command.length < 1 || command.length > 32 ||
      command.some((arg) => typeof arg !== 'string' || arg.length > 2000 || /[\u0000\r\n]/.test(arg)) ||
      !/^\/(?:[^/\s]+\/)*[^/\s]+$/.test(command[0] ?? '') ||
      command.reduce((size, arg) => size + arg.length, 0) > 6000) return
  if (limits !== undefined && !readLimits(limits)) return
  return { title: title.trim(), image, command, action: action.trim(), expected: expected.trim(), ...(limits ? { limits } : {}) }
}

export function projectPlan(value: unknown, scope: ScopeRevision): ProjectVerificationPlan {
  const input = readProjectVerification(value)
  if (!input) throw new StoreError(400, 'Provide a local image ID, absolute container executable, arguments, and test details. Requested limits must stay within memory 128–4096 MiB, CPUs 0.5–4, processes 32–512, 10–900 seconds and scratch 16–4096 MiB (no more than the memory).')
  if (scope.repositoryMode !== 'known' || !scope.repository || !scope.revision) {
    throw new StoreError(409, 'Save the target repository and revision before queuing verification.')
  }
  const { limits: requested, ...rest } = input
  return {
    kind: 'project', ...rest, repository: scope.repository, targetVersion: scope.resolvedCommit ?? scope.revision,
    isolation: { network: 'none', user: '1000:1000', readOnly: true, dropCapabilities: 'ALL', noNewPrivileges: true },
    // Always stored in full, so recomputing a plan from its saved form gives the same fingerprint.
    limits: readLimits(requested)!,
  }
}
