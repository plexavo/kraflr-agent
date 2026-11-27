/** Native Cline plugin, loaded only in Kraflr's per-session workspace.
 * Use Cline's public beforeModel/beforeTool hooks; do not change user settings.
 */
const untracked = (name:string) => /^(team_|spawn_agent$|delegate$|delegate_task$|send_message$|task$)/.test(name)
export default {
  name:'kraflr-team-policy',
  manifest:{capabilities:['hooks']},
  hooks:{
    beforeModel({request}:{request:{tools:readonly {name:string}[]}}){return{tools:request.tools.filter(tool=>!untracked(tool.name))}},
    beforeTool({toolCall}:{toolCall:{toolName:string}}){if(untracked(toolCall.toolName))return{skip:true,reason:'Use Kraflr’s tracked tasks report or kraflr agent context / ask to work with existing panel teammates.'}},
  },
}
