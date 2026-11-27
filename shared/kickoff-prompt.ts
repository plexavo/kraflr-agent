import { accessLabels, researchLabels } from './research.ts'
import type { PanelDetail } from './research.ts'
import { parseWebTargets } from './web-scope.ts'

const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text

export type HuntDepth = 'quick' | 'standard' | 'deep'
export const huntDepths: { value: HuntDepth; label: string; description: string }[] = [
  { value: 'quick', label: 'Quick', description: 'One agent, no delegation, ~15 minutes on the highest-value spots only.' },
  { value: 'standard', label: 'Standard', description: 'The default: works alone and freely, delegates to a Child only when that clearly saves time.' },
  { value: 'deep', label: 'Deep', description: 'Exhaustive coverage, delegates to a Child freely, challenges and hunts variants as it goes.' },
]

/** How thoroughly to hunt, in a clause for each research type. Only this part of the prompt changes between depths; scope, rules and tools stay the same. */
function depthClause(depth: HuntDepth, type: 'web' | 'source'): string {
  if (depth === 'quick') return `Work alone for this pass — do not start a Child. Time-box yourself to about 15 minutes and go straight for the highest-value spots (${type === 'web' ? 'auth, access control, obvious injection points, exposed admin/debug endpoints' : 'auth, input handling, known-dangerous sinks'}) rather than covering everything.`
  if (depth === 'deep') return `${type === 'web' ? 'Go exhaustive: cover every authorized target you can enumerate, not just the obvious ones.' : 'Read exhaustively, not just the obvious entry points.'} Delegate freely — hand a Child ${type === 'web' ? 'parallel ground' : 'whole modules or directories to review in parallel'} whenever it would save time (\`kraflr agent send\`), and challenge or hunt variants of what you find as you go rather than waiting.`
  return 'Use a Child only if it clearly saves time (`kraflr agent send`).'
}

/**
 * The objective Kraflr offers the Parent once a scope is saved and the first agent is running. It is built from the scope, written for the type of
 * security research. Hunt depth controls only how thoroughly and how freely it delegates — "standard" is the default: works alone and freely, records
 * leads as it goes, and uses a Child only when that saves time.
 */
export function kickoffPrompt(panel: PanelDetail, depth: HuntDepth = 'standard'): string {
  const scope = panel.scopeHistory[0]
  if (!scope) return 'Save a research scope first; the research prompt is built from it.'
  const target = scope.targetName || panel.name
  const restrictions = scope.restrictions.trim()
  if (panel.type === 'web') {
    const targets = parseWebTargets(scope.webTargets).targets.map((item) => item.text)
    const reference = scope.roeReference.trim()
    const rules = scope.notes.trim()
      ? clip(scope.notes.trim().replace(/\s+/g, ' '), 700) + (reference ? ` (source: ${reference})` : '')
      : `published at ${reference}; read it before you send anything`
    return [
      `Research objective: test ${target} (${researchLabels.web}, scope revision ${scope.version}).`,
      '',
      `Authorized targets: ${targets.join(', ') || 'none saved'}. Nothing else is in scope.`,
      `Rules of engagement: ${rules}`,
      `Access: ${scope.accessMode === 'read_write' ? 'state-changing tests allowed where the rules allow them' : 'read-only testing (GET, HEAD, OPTIONS)'}.${restrictions ? ' Restrictions: ' + clip(restrictions, 400) : ''}`,
      '',
      `Work freely with any tool (curl, nmap, ffuf, your own scripts). Check your tools for a \`kraflr\` MCP server and call \`burp_status\`; if Burp is connected, prefer its request tools over plain curl. Read \`kraflr agent map\` first, extend it if thin. Record each lead the moment you find it with \`kraflr agent lead\` (path is the endpoint, e.g. "POST /api/export"), proven as far as you can. Move a lead to Findings with \`kraflr agent confirm\` only when you reproduced it with a control case; I decide on the rest. ${depthClause(depth, 'web')} Stay non-destructive: no DoS, brute force, mass extraction or changes to real user data.`,
    ].join('\n')
  }
  const source = scope.repository ? `${scope.repository}${scope.revision ? ' @ ' + scope.revision : ''}` : 'a repository that still needs to be found'
  return [
    `Research objective: review ${target} (${researchLabels.source}, scope revision ${scope.version}).`,
    '',
    `Source: ${source}. Kraflr prepares the checkout; inspect only that checkout.`,
    `Access: ${accessLabels[scope.accessMode].toLowerCase()}.${restrictions ? ' Restrictions: ' + clip(restrictions, 400) : ''}`,
    ...(scope.repositoryMode === 'discover' ? [`The official repository is not confirmed yet: find it first (${clip(scope.repositoryDiscovery.trim() || 'use the target name', 300)}) and return a repositorySuggestion for me to review before any analysis.`] : []),
    '',
    `Read \`kraflr agent map\` first (it may already hold a Semgrep pass — treat hits as reachability questions, not findings); extend it if thin. Record each concrete lead immediately with \`kraflr agent lead\`, exact file and lines, and how far you proved it. Move a lead to Findings with \`kraflr agent confirm\` only when you reproduced it with a control case; I decide on the rest. ${depthClause(depth, 'source')}`,
  ].join('\n')
}
