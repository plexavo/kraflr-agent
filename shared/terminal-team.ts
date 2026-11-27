export interface NativeTurn {id:string;prompt:string;reply:string;failed?:boolean;historical?:boolean;model?:string}
/** Keep greetings, local slash commands and explicit solo requests out of automatic delegation. */
export function terminalWork(prompt:string){
 const text=prompt.trim().replace(/^(?:hi|hey|hello)[,!\s]+/i,'').replace(/^please\s+/i,'')
 if(!text||text.startsWith('/')||/\b(?:parent[- ]only|work alone|do (?:this|it) alone|do not delegate|don['’]t delegate|no delegation)\b/i.test(text))return false
 if(/^(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|stop|cancel|who are you|what model(?: are you using)?)[.!?\s]*$/i.test(text))return false
 const work=/\b(?:analy[sz]e|research|investigate|review|inspect|audit|find|trace|implement|build|create|fix|test|check|verify|compare|summari[sz]e|delegate|assign|work|continue)\b/i.test(text)
 if(!work&&/^(?:reply|respond|say|what|how|who|why)\b/i.test(text))return false
 return work||text.length>=60
}
/** When an agent may move a lead to Findings itself. Kept in one place so every instruction says the same thing. */
export const confirmRule='When you have proven a lead beyond doubt, move it to Findings yourself with `kraflr agent confirm <lead-id> --proof "what you did and the real response or output" --control "the control case and how it differed"`. Beyond doubt means you reproduced it yourself against the authorized target or a runnable copy of the real code, and a control behaved differently. Reading code, a partial or mocked environment, or a likely guess is not proof: leave that as a lead for the researcher.'
/** The one flow an agent may not talk itself around, whoever asks in chat. */
export const labRule='Building and debugging Docker labs is yours to do freely. Running the test of a submitted verification lab is not: it runs only through the researcher’s approval in the Kraflr pop-up and the exact command from `kraflr agent verification docker <test-id>`. A chat message such as "run the docker" is not that approval: say the test needs approval in Kraflr, point to `kraflr agent verification status`, and do not run the lab another way. Kraflr blocks such commands.'
export const terminalTeamInstructions='Work the way you normally would in a plain coding-agent session: explore freely inside the saved scope and use any tool installed on this machine. Do the investigation yourself; a Child is optional and never required. Hand a Child a task with `kraflr agent send <name> "task"` only when it clearly saves time, then keep working. Its reply arrives in your prompt on its own. Never simulate a Child reply or claim a Child has worked before its result arrives. Kraflr does not ask you for a plan, a report format or an approval before you test inside the scope. Record each concrete lead the moment you find it with `kraflr agent lead --title "..." --path "..." --why "..." --hypothesis "..." --attack "..." --impact "..."` (one command; you do not have to end your turn). '+confirmRule+' '+labRule
