import type { ResearchStore } from '../server/db.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'

/** Tool calls with nothing recorded before a running agent is reminded, and again after every further batch. */
export const remindEvery = 15
/** Tool calls with nothing recorded before a turn is held once, so the agent can record before it ends. */
export const holdAfter = 8

const recordCommands = 'a new suspicion: `kraflr agent lead`; tested and it does not hold: `kraflr agent kill <lead-id> --tested "…" --reason "…"`; proven with a control case: `kraflr agent confirm`; new endpoints or tested areas: `kraflr agent map --file map.md --append`'

/** A call that looks at the target. Kraflr's own commands and status checks are bookkeeping; file reads count only where reading is the research. */
export function isProbe(panelType: string, tool: string, summary: string) {
  if (tool === 'Bash') return !/kraflr(?:\.mjs)?["']?\s+agent\b/.test(summary)
  if (tool === 'WebFetch') return true
  if (tool.startsWith('mcp__kraflr__')) return !tool.endsWith('burp_status')
  return tool === 'Read' && panelType === 'source'
}

/**
 * Keeps agents recording while the researcher drives them with their own prompts. The instructions every session starts with fade in a long
 * conversation, so Claude Code's own hooks carry a short reminder back: with each prompt, after a run of tool calls that recorded nothing, and
 * once before such a turn ends. KRAFLR_REMINDERS=off turns all three off.
 */
export function createRecordingReminders(store: Pick<ResearchStore, 'listEvidence'>, enabled = process.env.KRAFLR_REMINDERS !== 'off') {
  const sessions = new Map<string, { unrecorded: number; heldReply?: string }>()
  const session = (id: string) => { let value = sessions.get(id); if (!value) sessions.set(id, value = { unrecorded: 0 }); return value }

  function promptContext(agent: AgentTerminalInfo) {
    const page = store.listEvidence(agent.panelId, 0, 'lead')
    const open = page.leads.filter((lead) => lead.scopeVersion === agent.scopeVersion)
    const listed = open.slice(0, 8).map((lead) => `- ${lead.id} ${lead.title}`)
    return [`Kraflr record for this panel: ${page.counts.lead} open lead(s), ${page.counts.killed_lead} killed, ${page.counts.finding} Finding(s).`,
      ...listed, ...(open.length > listed.length || page.more ? ['(`kraflr agent context` lists the rest.)'] : []),
      `Record as you work in this turn, without being asked. For ${recordCommands}.`].join('\n')
  }

  return {
    /** The agent saved a lead, a confirmation, a kill or the map. */
    recorded(agentId: string) { session(agentId).unrecorded = 0 },
    /** A tool call the agent's hook reported. Returns a reminder when one is due. */
    tool(agent: AgentTerminalInfo, panelType: string, tool: string, summary: string) {
      if (!isProbe(panelType, tool, summary)) return
      const state = session(agent.id)
      state.unrecorded++
      if (!enabled || agent.kind !== 'claude' || state.unrecorded % remindEvery) return
      return `Kraflr: ${state.unrecorded} tool calls since anything was recorded. Before you go on, record what they showed. For ${recordCommands}. If there is truly nothing to record, carry on.`
    },
    /**
     * A lifecycle event on its way to the runtime. `assigned` means Kraflr is waiting for this turn's reply as a report, which must arrive
     * untouched, so such a turn is never held. A held turn is not delivered yet: its reply is kept and joined to the one that ends the turn.
     */
    async hook(agent: AgentTerminalInfo, params: { name: string; text?: string; continuing?: boolean }, assigned: boolean, deliver: (params: any) => Promise<unknown>) {
      const state = session(agent.id), claude = agent.kind === 'claude'
      if (params.name === 'TaskComplete' && enabled && claude && !assigned && !params.continuing && state.unrecorded >= holdAfter) {
        const count = state.unrecorded
        state.unrecorded = 0; state.heldReply = params.text
        return { hold: `Kraflr: before you finish, ${count} tool calls have nothing recorded. For ${recordCommands}. Record what applies, then end with one line saying what you saved, or that there was nothing to record. Do not repeat your answer.` }
      }
      if (/^(?:TaskComplete|TaskError|TaskCancel)$/.test(params.name) && state.heldReply) {
        params = { ...params, text: [state.heldReply, params.text].filter(Boolean).join('\n\n') }
        state.heldReply = undefined
      }
      if (/^(?:UserPromptSubmit|TaskStart)$/.test(params.name)) state.heldReply = undefined
      const result = await deliver(params)
      if (params.name !== 'UserPromptSubmit' || !enabled || !claude) return result
      return { context: promptContext(agent) }
    },
  }
}
