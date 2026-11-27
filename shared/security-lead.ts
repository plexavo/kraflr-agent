export interface SecurityHypothesis {
  hypothesis: string
  attackPath: string
  impact: string
}

export const securityLeadInstructions = [
  'Use kind "lead" only for a concrete, project-specific security flaw hypothesis supported by the cited code or evidence.',
  'A Lead must include a security object with hypothesis (the suspected broken security check in this project), attackPath (who can reach it, through which input or code path, and under what conditions), and impact (the unauthorized security consequence). Each field must be 12–1200 characters.',
  'Repository identity, official-source confirmation, plugin headers, release/version metadata, architecture notes, and generic advice are General evidence, even when the research objective is security-related. Set kind "general" and omit security for those facts.',
  'A version number alone is not a flaw. A known-vulnerability lead must identify the affected code or advisory, explain why this target version is affected, and describe the reachable attack path and security impact.',
  'Do not invent a security hypothesis to fill the fields. If the excerpt or public evidence is insufficient, keep the entry General or return no entry. A Lead remains an unverified hypothesis; an agent cannot mark it as an accepted Finding.',
].join('\n')

export function classifyAgentEvidence(value: unknown): { kind: 'lead' | 'general'; security?: SecurityHypothesis } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'general' }
  const entry = value as Record<string, unknown>
  if (entry.kind !== 'lead' || !entry.security || typeof entry.security !== 'object' || Array.isArray(entry.security)) {
    return { kind: 'general' }
  }
  const security = entry.security as Record<string, unknown>
  const fields = ['hypothesis', 'attackPath', 'impact'] as const
  const values = fields.map((field) => typeof security[field] === 'string' ? security[field].trim() : '')
  if (values.some((text) => text.length < 12 || text.length > 1200)) return { kind: 'general' }
  return { kind: 'lead', security: { hypothesis: values[0]!, attackPath: values[1]!, impact: values[2]! } }
}
