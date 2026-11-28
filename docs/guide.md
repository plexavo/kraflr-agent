# Kraflr Agent guide

Kraflr is a terminal workspace for authorized open-source security research. Each research panel owns its scope, agent sessions, Leads, Killed Leads, Findings and research record. Create up to four live agents total; each runs in an independent terminal pane inside Kraflr. OpenCode and Cline use their own sign-ins and model access.

## The workspace

Start it with `kraflr`. Install steps are in the [README](../README.md).

Maximize Kraflr for multiple agent panes. The workspace works from **75 columns × 25 rows**; around **160 columns × 45 rows** gives four agents more room. Investigation, panel creation and research spaces occupy the upper sidebar; each selected panel's Agents, Leads, Killed leads, Findings, Scope and Research record sit below the lower divider. Its name is centered in bold above the running-agent count. The narrower sidebar and compact header/footer leave more room for terminal panes, which extend to the right edge and final workspace row. Kraflr uses visible buttons and mouse clicks; ordinary **Tab**, arrows and **Enter** also navigate controls. It has no custom letter or control-key shortcuts.

Kraflr matches the host background to its charcoal canvas while open and restores the reported background on detach, falling back to a profile-default reset when it is not reported. Fragmented terminal color replies are consumed locally, never sent into an agent. No terminal settings file is changed. Windows Terminal owns the pixels outside the character grid; for literally zero outer padding, set its profile **Appearance → Padding** to **0** ([Microsoft's padding setting](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance#padding)).

| Action | Visible control |
| --- | --- |
| Create a panel and scope | New panel / New research panel |
| Open a panel | Sidebar research space / Research spaces |
| Add an agent and choose Parent/Child | New session (no empty slots are reserved) |
| Focus an agent terminal | Click inside its pane / sidebar agent |
| Models and stopped sessions | Agent controls |
| Give work to the team | Type directly in the Parent terminal |
| Read full replies and General evidence | Research record |
| Change scope | Scope → Edit scope |
| Explain / Verify | Select a lead |
| Review an approval | Pulsing agent indicator / Approvals |
| Leave the workspace | Detach |

The Investigation overview has a Kraflr ASCII wordmark and animated agent count. Sidebar indicators distinguish ready, starting, active, approval and question states. Native Cline indicators observe its current permission screen; managed OpenCode requests use its API. These indicators never grant permission automatically.

**New session** adds an independent terminal pane **inside Kraflr**. No separate CMD/PowerShell windows open, and no empty terminal slots are reserved. One session fills the workspace; two sit side by side; three use a large left pane with two stacked right panes; four form a 2×2 grid. The limit is four live agents across the workspace.

Click inside a pane to type. Escape, Ctrl+C, Tab, native model menus and approvals go to that agent. Click a sidebar item, workspace tab or **Workspace controls** to return to Kraflr navigation. A first mouse click focuses a pane; it does not approve a native request. Mouse input is translated into the chosen pane's coordinates, with scrollback available when the CLI has no mouse tracking enabled.

The renderer updates only changed cells and reuses parsed terminal contents during status animations. Native output schedules a prompt redraw independently of the slower animation timer. The existing colors, tab layout and block wordmark remain.

One Kraflr view owns each live terminal's input and dimensions. A pane already open in another view displays a reconnect message; close that view before using **Retry pane**. The underlying agent keeps running.

**Detach** leaves the runtime and agents running. **`kraflr stop`** stops the runtime and its agents. Reopen saved conversations through Agent controls after restarting. A reboot ends processes; saved records survive. The advanced `kraflr attach SESSION_ID` command remains an explicit manual attachment option; the workspace never launches an external terminal application.

If a workspace or pinned clone was moved or deleted, launching an agent shows the exact missing location and an **Edit scope** action. Save the replacement workspace before retrying. Kraflr creates a new scope revision and prepares the source there; it does not silently rebind the old revision.

## Fast mode: agents work freely, Findings need proof

A Parent explores freely inside the saved scope and records each lead the moment it finds one with a single command, without ending its turn:

```
kraflr agent lead --title "SSRF in the importer" --path "POST /api/import" --why "what it saw and how far it proved it" --hypothesis "the suspected broken check" --attack "who reaches it and how" --impact "what an attacker gains"
```

Code reviews add `--lines 10-20`; `--id` updates a lead already recorded. Kraflr never requires a plan, a report format or a verification before an agent tests inside the scope.

**How a lead becomes a Finding.** Three ways: an agent confirms it, an approved Docker test reproduces it, or you accept it with your evidence note. An agent confirms only what it has proven beyond doubt:

```
kraflr agent confirm <lead-id> --proof "what it did and the real response or output" --control "the control case and how it differed"
```

Kraflr requires both parts but **does not check the proof itself**, so the Finding reads **Confirmed by agent**, the report labels it as not independently checked, and **Not valid · move back to Leads** reverses it. An agent cannot confirm a lead you already moved or killed, a lead with a Docker verification in progress, or one a Challenge or Verify did not confirm. Docker verification stays optional for source reviews as **Verify in Docker**.

**Killed leads.** An agent records what its own testing ruled out, with what it tried and why that settles it:

```
kraflr agent kill <lead-id> --tested "what it tried and what came back" --reason "why that rules it out"
```

For a dead end that was never a lead, `--title` and `--path` replace the ID. Kraflr does not check the test, so the note reads **Killed by** the agent and **Reopen · move back to Leads** reverses it. An agent cannot kill a Finding, a lead you reopened, a lead with a Docker verification in progress, or one a Challenge or Verify upheld.

**Recording reminders (Claude Code sessions).** So that records stay current when you write your own prompts, Kraflr's hooks remind the agent:

- Each prompt carries the open leads and the recording commands.
- After 15 tool calls with nothing recorded, the agent is reminded, and again after every further 15.
- A turn with 8 or more such calls is held once before it ends, so the agent can record or say there was nothing. A report Kraflr is waiting for is never held.

Start Kraflr with `KRAFLR_REMINDERS=off` to turn them off. OpenCode and Cline sessions get the instructions and the commands, but no reminders.

Around that, from the Agents screen and the lead menu:

- **Kickoff prompt** sends the prepared research prompt to the Parent whenever it is ready (it waits a short while for a starting agent). It first asks for a **hunt depth** (Strix-style presets): **Quick** (one agent, no delegation, ~15 minutes on the highest-value spots), **Standard** (the default — works alone and freely, delegates only when it clearly saves time), or **Deep** (exhaustive coverage, delegates to a Child freely, challenges and hunts variants as it goes). This only changes the prompt's wording; Kraflr does not enforce it. Nothing pops up when an agent starts, and the button disappears once the Parent has been given work, whether that was the kickoff or your own prompt. It stays available under **Agent controls → Research tools**.
- **Attack-surface map.** The first agent to look at a target saves a map (entry points, authentication, trust boundaries, sinks, what it already tested) with `kraflr agent map --file map.md`; every later session is told to read it first with `kraflr agent map`. Read it under **Agent controls → Research tools → Attack-surface map** or on the Scope screen. On a source-review panel, Kraflr also runs a Semgrep first pass in the background the first time an agent reads context (if `semgrep` is on PATH; silently skipped otherwise) and folds a condensed, severity-sorted summary into the same map — a static pass catches structure an LLM read alone tends to miss, and an agent judging reachability on top of it catches far more than either alone. It never blocks an agent; if the scan is not done yet, the agent just does not see it this time.
- **Challenge this lead** (on an open lead) asks an agent to try to *disprove* it in about five minutes — a Child if one is running (ideally on a different model, so the Parent keeps working meanwhile), or the Parent itself if no Child is available. Its verdict (holds / does not hold / unclear) is added to the lead as a note. The five minutes is a request in the prompt, not a timer: Kraflr cannot stop an agent without ending its session.
- **Verify this lead** (web panels, on an open lead) is the live-target equivalent of Verify in Docker: there is no lab to build against a real site, so it asks an agent — the Parent by default, or a Child — to reproduce the claim with an actual request and response and report confirmed, not confirmed or inconclusive, neutrally rather than arguing either side. Its verdict is added to the lead the same way a challenge is; accepting or killing the lead afterward is still entirely yours.
- **Hunt variants** is offered after you accept a Finding (and from any Finding): an agent looks for the same flaw pattern elsewhere in the scope and records each hit as a new lead.
- **Generate PoC** (on a Finding) asks the Parent (or a chosen Child) to write a complete, copy-pasteable proof of concept — curl commands, a short script, or exact steps, with real values, nothing left to fill in. It is attached to the Finding and opened with **View PoC**, a scrollable pop-up you can select and copy straight out of.
- **Replay as a different account** (web panels, on a plain-HTTP entry in Traffic) is the Autorize pattern: resend a request Kraflr already captured with one header swapped for a second account's value (a session cookie, a bearer token) and diff the live response against the original. A matching status and a similar body for a different identity is the signal of broken access control — usually IDOR. The replay is sent directly by Kraflr, not through an agent, and logged as its own traffic entry; it never files a lead by itself. From the result, **Ask the Parent to confirm and record** hands it to the Parent to verify and, if it holds up, record with `kraflr agent lead`. This only works on a captured `http` entry — an HTTPS tunnel is never decrypted, so Kraflr never captured enough of the original request to resend it (see below).
- **Export report** (Findings screen) writes a Markdown report into the agent workspace: scope, each Finding with the agents' write-up and either your evidence note or the agent's labelled confirmation, what was ruled out and why, what is still open, and for web panels the recorded requests.
- **Tool gateway** gives every agent one MCP server ("kraflr") instead of a separate one per third-party tool. It exposes `semgrep_scan` itself (run it on demand on any path in the workspace, not just the automatic first pass above), plus `burp_status` and, only once set, every tool Burp Suite's own MCP server reports — each proxied under a `burp_` prefix, discovered live rather than hardcoded, so it tracks whatever your installed Burp version actually offers. Set your running Burp's MCP endpoint from **Agent controls → Research tools → Set Burp MCP URL** (Burp Suite's MCP server extension prints it; Kraflr never starts or bundles Burp itself) — it is saved in the data directory and survives restarts, so there is nothing to export in a shell profile. `KRAFLR_BURP_MCP_URL` still works as a one-off override for a single launch if you set it, taking priority over the saved value. The gateway reads the saved URL when it needs it, so running sessions pick up a new or changed URL on their next `burp_status` call and are told to refresh their tool list; if a CLI does not refresh it, reopen that session. Claude Code gets the gateway through a session `--mcp-config` file, OpenCode through an `mcp` entry in the session's `opencode.json`, and Cline through a session settings file named by `CLINE_MCP_SETTINGS_PATH`, which also keeps the MCP servers from your own Cline settings (servers added from inside a Kraflr Cline session stay in that session). Requests Burp sends for an agent leave from Burp itself, so Kraflr's scope proxy neither records nor blocks them.
- **Short Burp responses.** A response over 6,000 characters from Burp's request tools reaches the agent as its status line, headers and the first 2,000 characters of the body; a body identical to an earlier one (apart from script nonces) is not repeated. The whole result is saved under `responses` in the session folder. The agent can add `kraflr_find` (a regular expression), `kraflr_headers_only` or `kraflr_full` to a request. Other tools, including proxy history, are passed through unchanged.

Research panels show whether they are active or not: in **Research panels**, each shows `●` with how many agents are currently running, or `○ Idle` when none are.

Claude Code asks whether to trust a folder, and again for each extra folder, and both questions default to "No, exit". Kraflr answers Yes **only** for its own two folders (the panel's working folder and the session folder inside its private data directory). Any other folder, such as a cloned repository, is left to you in the agent pane.

## Scope proxy and the traffic record (web application panels)

Agents of a **web application testing** panel get `HTTP_PROXY` and `HTTPS_PROXY` (and the lowercase forms) pointing at a proxy that Kraflr runs on 127.0.0.1, with their own credentials in the URL. `NO_PROXY` lists the agent's own providers (Anthropic, OpenAI, OpenRouter, GitHub, package registries and the like; extend it with `KRAFLR_PROXY_ALLOW=host1,host2`), so an agent's own model traffic never goes through the proxy and can never be stalled by it. A local lab is deliberately not in that list. Any tool that honours proxy settings (curl, wget, Python `requests`, Go programs, `ffuf -x`, `sqlmap --proxy`…) goes through the proxy:

- A plain-HTTP request to an **authorized target** is forwarded and recorded: method, URL, status, timing, the headers and the first 4 KiB of each body, attributed to the agent that sent it.
- A request to **anything else** is refused with a `403` that tells the agent which targets are authorized, is never sent, and is recorded as blocked.
- The proxy accepts only requests that carry a running agent's credentials, and it will not forward to itself.
- Open **Traffic** on the Agents screen to read the record (blocked requests in red). Each entry opens with its full recorded request and response. On Claude Code sessions the same list also shows every shell command, file read and fetch the agent ran, so tools that never touch the proxy are still accounted for.

What it does **not** do, so you can judge how far to trust it:

- It only sees tools that honour proxy settings. A tool that ignores them (a raw socket, `nmap`, Node's built-in `fetch`, a browser driver with its own network settings) is neither recorded nor blocked.
- **Plain HTTP is enforced**: an unauthorized request is refused and never sent. **HTTPS is only a host-level record by default**: the proxy tunnels it without reading it, so an HTTPS connection to a host that is not an authorized target is let through and recorded as *OUT OF SCOPE (HTTPS, not blocked)*, in red, with no request or response (Kraflr cannot see inside it). Start Kraflr with `KRAFLR_PROXY_HTTPS=1` for strict mode, which refuses those tunnels instead. Strict mode can block a tool that legitimately needs a host you have not listed; add it to `KRAFLR_PROXY_ALLOW`.
- A target path limit (`https://app.example.com/shop/`) is enforced for HTTP; for a tunnel only host and port can be checked.
- The record is stored unredacted in `<data dir>/traffic/` (private folder, one file per panel, rolled over at 8 MiB, previous file kept), because cookies and tokens are part of the evidence. Treat it like the research it records.

## Research workflow

1. Create a panel and choose the **type of security research**. **Open-source code review** asks for the target name, its official repository URL or a clean local Git clone, and an absolute research workspace folder, plus read-only or read/write access and restrictions; source preparation records the exact Git commit automatically. **Web application testing** asks for the target name, the **authorized targets** (domains such as `app.example.com`, wildcards such as `*.example.com`, hosts with a port, or URLs with a path), the **rules of engagement** (write them in the form, link to them, or choose a text file, which is read and saved with the scope), and the workspace folder, plus whether state-changing tests are allowed and any restrictions. A web panel has no repository to clone. Every agent receives the targets and the rules, is told to test nothing else, and is told how to handle a link it has to read itself. Kraflr records and shows the authorized targets; it cannot stop an agent's own tools from reaching a host, so the rules are a brief to the agent and a record for you, not a firewall.
2. Open Agents and start OpenCode, Cline or Claude Code. Created agents appear as live panes inside their research panel. The workspace allows **four live agents total**. Choose **Parent** or **Child** when creating the session. The first session defaults to Parent; later sessions default to Child. Choosing another Parent replaces the previous one when no research or exchange is active. Each pane and sidebar entry shows its role. Any of the three CLIs can fill either role, including two sessions of the same agent.
3. Use the CLI's native model picker and sign-in. Cline and Claude Code use `/model`. OpenCode can use Agent controls for verified model confirmation; a successful direct native reply also confirms the model actually used, without switching providers or models. A Claude Code session starts free: its tools are pre-allowed, so it works like a plain Claude Code session and does not ask before each action (set `KRAFLR_PERMISSIONS=ask` before starting `kraflr` to bring Claude Code's own approval prompts back). OpenCode and Cline keep their own permission behaviour, visible in their pane.
4. Select **Kickoff prompt** to send a research prompt built from your saved scope. For a code review it names the repository, access and restrictions; for a web test it lists the authorized targets and the rules of engagement. In both, the Parent works alone and freely, and a Child is used only if the Parent decides it saves time (`kraflr agent send`). Send it as it is, or add an instruction first. You can also type the objective directly in the **Parent terminal**. Kraflr never assigns a Child work on its own, including during lab preparation. Replies stay in the native terminals; **Research record** retains the full parent/child exchange. The Team line shows progress or why a child is waiting.
5. Agents report project-specific security hypotheses into Leads. Background facts remain General evidence, accessible through **Research record**. Stable evidence identities prevent exact duplicates. Matching titles/files with overlapping citations update the same lead even if the agent narrows its line range. Existing overlapping duplicates are reconciled on startup while preserving aliases, reviews and test history. Distinct titles/files or disjoint citations stay separate. A recorded lead is a claim; it becomes a Finding only through the three routes above.
6. Open a Lead → **Verify** to start its lab preparation immediately. The lead animates as **Verifying** (yellow); **Verification progress** follows the lab, approval, execution and outcome. When the exact Docker plan is ready, a **pop-up** shows it, even while you are typing into an agent. Approve it with **Parent verification · mark Finding or killed lead** or **Child verification · mark Finding or killed lead**. That agent runs the container in its own shell and reports the result; Kraflr then marks the lead from the report: a reproduced result with a passing control becomes a **Finding** (green), a result that did not reproduce with a passing control **kills the lead**, and anything else stays a lead. Kraflr does not run researched tests itself. No second chat prompt is needed. Agents build and debug the lab on their own; any permission prompt a CLI shows is still your decision. Docker must be running; a built image or an agent's claim alone never confirms anything.

For an unknown repository, leave its URL blank and add a discovery note. Ask the parent to find it, then use **Review repository** in Scope to review and save its suggestion. Changing scope stops that panel's earlier-scope agents and interrupts research/tests while preserving completed work.

For a pending test, typing **I approve** in the Parent pane reopens Kraflr's exact-plan review. The phrase alone does not execute anything; choose Parent or Child verification after reviewing the plan.

### When a test hits an error

A failure after approval (a build or config error, a missing file, a crashed or malformed harness, an agent that never reports) turns the lead and the progress line **red** (**Error faced**) and opens a pop-up with the failure, its exit code and its output. You choose:

A lab problem does not wait for you: the Parent repairs the lab, rebuilds and submits the new plan, which comes back as a fresh approval. After two failed repairs it stops and waits. The pop-up offers:

- **Inform agent**: use it if the agent has stopped. The Parent analyses the error, repairs the existing lab, rebuilds, updates `kraflr-verification.json` and asks for approval again. While it works the lead reads **Analysing verification error**. A repair that leaves the image and command unchanged is rejected, because the same test would fail the same way.
- **Cancel verification**: the test is closed and nothing more runs. The agent must ask for approval again before it runs anything else.

A container failure reports its own exit code and output, and a result printed in the wrong shape names the exact field to fix, so the agent repairs the lab instead of guessing.

A Dockerfile edit does not modify an immutable image. The Parent must rebuild the image and update the existing lab's `kraflr-verification.json`. **Review repaired plan** then adopts that checkpoint, checks the replacement image and presents a fresh approval. Pending obsolete plans are superseded, and their approval cannot transfer. Agents submit the checkpoint with `kraflr agent verification recover <preparation-id>`; a new image mentioned only in chat is not a submitted plan. Status tools distinguish a finished error from a running test.

Cline and Claude Code readiness follows their actual native composer and lifecycle events. Mouse interaction does not make an idle teammate unavailable; clearing a draft or closing a menu restores readiness automatically. Active work, permission requests, questions, menus and unsent drafts block automatic prompt delivery. The pane displays the reason. **Mark native prompt ready** remains a checked fallback and cannot bypass those states.

## Agent-run verification

**The lab guard.** Agents build, rebuild and smoke-test labs freely. Writing `kraflr-verification.json` submits a lab: while its lead is open, that image (by ID or tag), a mount of its lab folder and its compose file start only through the exact approved command, run by the agent you chose. A chat message such as "run the docker" is not an approval; typing it in the Parent pane opens the plan for review. Claude Code and Cline check each shell command through their pre-tool hooks and refuse the rest, and the refusal appears in Traffic. OpenCode has no such hook here: its own permission prompt and instructions apply. This is a guardrail, not a sandbox — a script that calls Docker indirectly, or a rebuilt copy under another image ID, is not seen.

Every researched lead is verified by an agent you choose at approval, and that agent also marks the result. There is no Kraflr-run path for them.

- **Parent verification** and **Child verification**. Kraflr leases the approved test to that agent for 30 minutes and delivers it with the exact steps. With more than one Child you pick which one; an agent that already stopped is never offered.
- The agent runs `kraflr agent verification docker <test-id>`, which prints the exact approved `docker run` command (read-only root, no network, no host mounts, dropped capabilities, no new privileges, 256 MiB, one CPU, 64 processes, 60 seconds and a bounded 64 MiB scratch `/tmp`). It runs that command in its own shell, where your native permission prompt applies, then submits `kraflr agent verification report <test-id> --file result.json`.
- If anything stops the test the agent runs `kraflr agent verification fail <test-id> --message "what went wrong"` (optionally `--file output.txt`). That is the **Error faced** state above.
- Kraflr marks the lead from the report. Reproduced with a passing control: Finding. Not reproduced with a passing control: killed lead, with the agent's summary as the recorded reason. A failed control, an inconclusive result or an error never creates a Finding or kills a lead.
- A Child's result is also sent to the Parent so it can explain it to you.

An agent-reported result is labeled as such: Kraflr cannot see what an agent ran in its own shell, so it checks only the lease holder, that the reported image is the approved image and that the observation is well formed. Approving is what authorizes the agent to mark the lead; you can reopen a killed lead from its tag at any time and its history is kept. A lease ends when the agent reports or fails, you cancel, the scope changes, Kraflr shuts down or 30 minutes pass. Kraflr's own Docker runner remains only for the bundled self-test fixture and for inspecting an image's labels when a plan is queued; set `KRAFLR_DOCKER_HOST` to a local `npipe://` or `unix://` address if your engine is not the Docker Desktop default.

## Agents that stop

When an agent hits a usage or rate limit, is rejected by its provider, or exits without being stopped from Kraflr, its marker turns **red** and a pop-up names the agent and the reason. Choose **Hand saved context to <agent>** to give a running teammate the stopped agent's saved assignments, its latest replies, the research brief and any verification test it was approved to run (that approval moves to the new agent, which receives its own grant). Hands-over can also be started later from **Agent controls**. A stoppage is announced once and clears when the agent completes a turn again.

## Replies between agents

A reply to `kraflr agent send` is delivered into the asking agent's prompt as soon as that agent is idle, one delivery at a time per agent, so a Parent no longer has to be told to check its inbox. `kraflr agent ask` still returns its answer directly, and `kraflr agent inbox` remains for reviewing history.

### Optional Docker verification needs the real stack

Docker verification is optional (you can accept a Finding without it). When you do ask for it, a shimmed run is not a verification. The prompt an agent receives when you click **Verify** requires the real application at the recorded commit, its real database server (for WordPress a real MySQL or MariaDB, not SQLite) and the project's real install or bootstrap flow, with nothing shimmed, stubbed or swapped. The agent's report must include an `environment` statement: `fidelity` (`full` or `partial`), what was `real` and what was `substituted`. Only `full`, with the real components named and nothing substituted, can create a Finding or kill a lead. A partial or unstated environment is saved as **inconclusive** with the agent's own description, and the result pop-up shows the statement. This is self-reported, so read it.

A faithful stack needs more than the defaults, so a plan can ask for resources in a `limits` object: memory 128–4096 MiB, CPUs 0.5–4, processes 32–512, 10–900 seconds and 16–4096 MiB of scratch space (never more than the memory, because it is held in memory). The approval pop-up shows the exact numbers and flags anything above the defaults. Network stays off, so the image must contain every dependency.

Optional Docker verification is built for code review. Web application panels do not start it; accept or kill their leads from the evidence the agent recorded.

## Claude Code

Claude Code runs in a native pane like Cline. Kraflr starts it with a session-only `--settings` file, so your own Claude Code configuration is never edited:

- Lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PreToolUse`) report prompts and finished turns to Kraflr. `PreToolUse` denies untracked sub-agents in an ask session, edits to a read-only source checkout, and starting a submitted lab outside its approved run.
- Permission mode stays `default` and bypass mode is disabled for the session. Native approvals remain yours.
- The first time you use a research panel, Claude Code asks whether you trust its working folder. Its default answer is **No, exit**: choose **Yes, I trust this folder**. Kraflr treats that dialog as a blocked prompt and never answers it. All Claude sessions of a panel share one folder, so you answer once per panel.
- Your normal Claude Code sign-in is used. An `ANTHROPIC_API_KEY` in your environment is **not** forwarded, because it would override your subscription login and switch usage to metered API billing. To pass chosen variables on purpose, set `KRAFLR_CLAUDE_ENV` to a comma-separated list such as `ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL`.
- Reopening a saved session resumes its conversation once a prompt has been submitted; before that there is nothing to resume, so it starts fresh.
- On Windows Claude Code runs shell commands in Git Bash, so Kraflr installs a bash `kraflr` shim next to the `.cmd` one and gives Claude bash-syntax instructions. In Git Bash, prefix `docker` commands that contain container paths with `MSYS_NO_PATHCONV=1`.
- `KRAFLR_CLAUDE_EXE` overrides executable discovery. Some turns end without a hook (Esc, a menu choice), so Kraflr also reads the pane: after a few idle, quiet seconds with no spinner it stops showing the agent as working and releases a waiting assignment. Cline gets longer.

## Agent collaboration

Native sessions receive `AGENTS.md` with the saved scope and prepared source location. A session-scoped bridge provides:

Every live agent also receives a credential-free `KRAFLR_TEAM.json` in its scratch folder. Kraflr updates it when teammates, roles, readiness or assignments change. It identifies the runtime, actual Parent/Child roles and current worker IDs, including busy children. Managed turns receive a fresh roster directly. Instructions provide an absolute bridge command appropriate to the agent's OS; Windows PowerShell commands use a leading `&` and avoid unsupported `||`/`&&` fallbacks. A failed command does not establish that teammates are absent.

```text
kraflr agent context
kraflr agent team
kraflr agent ask <session-id-or-unique-name> "a specific scoped question"
kraflr agent send <session-id-or-unique-name> "a task without waiting"
kraflr agent inbox
kraflr agent note "short progress update"
kraflr agent record --file report.json
kraflr agent lead --title "..." --path "..." --why "..." --hypothesis "..." --attack "..." --impact "..."
kraflr agent confirm <lead-id> --proof "..." --control "..."
kraflr agent map [--file map.md]
kraflr agent verification status [test-or-lead-id]
kraflr agent verification plan <test-id>
kraflr agent verification prepare <lead-id>
kraflr agent verification recover <preparation-id>
kraflr agent verification run <test-id>
kraflr agent verification retry <test-id>
kraflr agent verification docker <test-id>
kraflr agent verification report <test-id> --file result.json
kraflr agent verification fail <test-id> --message "what went wrong"
```

Verification commands read the real saved state. The Parent can prepare or recover a lab and ask for a fresh approval; Children can read status and plans. `run` reports whether the plan awaits approval, is executing or has finished: it cannot grant approval or start a container. Only the agent you chose when approving a test can use `docker`, `report` and `fail` for it, only with the approved image and isolation. Notifications wait for a clear prompt and preserve drafts and native permissions. Full replies are saved in Research record, without creating evidence from status text.

Parent and Child are coordination roles: any same-panel teammate can contact another. `ask` waits for the answer; `send` returns a queued exchange ID immediately, and `inbox` shows requests, status and replies. Unique names and session IDs work; `parent` and `child` aliases work when unambiguous. Messages wait for an available prompt and never answer permissions or overwrite drafts. A maximum of sixteen pending exchanges per panel prevents an unbounded queue. Cancel a pending exchange through Record.

`kraflr-result` is a fenced JSON reply format, not a callable tool or executable command; valid evidence is captured from the reply. Record retains who assigned each task.

The bridge checks live agent identity, scope and panel membership. It cannot approve tests or invoke owner administration; the only Finding it can create is a labelled `confirm`. Waiting handoff cycles are rejected. Notes update the dashboard; durable research belongs in reports. During a tracked run, agents return their report to that assignment instead of saving a duplicate record.

A direct conversation with the Parent stays a plain session: Kraflr starts no team run from it and asks no Child to review it. The Parent delegates with `kraflr agent send` when it chooses to.

Direct Cline conversations are captured through native submitted-input tracking and completion hooks. OpenCode uses its local session API, including full replies and the actual model used. Stable turn IDs avoid duplicate records; an adopted conversation belongs to its combined team record. Structured `agent record` remains available for an explicit report. Direct bridge handoffs are durably saved before delivery, then updated with the full reply or interruption/failure status; they appear alongside research runs in Record. A session-local Cline plugin removes untracked engine team tools; native tool approvals remain in place. Interactive agents run under your user account, not inside an OS filesystem/network isolation boundary.

Each Cline session has separate private hub discovery and a loopback endpoint, preventing another session's service environment or collaboration identity from being reused. Kraflr does not copy provider credentials or require a second model subscription. Native provider billing and quotas still apply.

## Storage

The data folder is `%LOCALAPPDATA%/Kraflr/data` on Windows and `$XDG_STATE_HOME/Kraflr/data` (normally `~/.local/state/Kraflr/data`) on Linux. A source checkout that already holds `data/kraflr.sqlite` keeps using it.

`kraflr --data-dir <absolute-path>` or `KRAFLR_DATA_DIR` selects another workspace; use the same choice for later commands. The terminal runtime uses an authenticated named pipe on Windows or a mode-0600 Unix socket on Linux. Web application panels also run the scope proxy on `127.0.0.1`. Only one runtime may own a data folder.

Scratch folders and task checkpoints live in `<data>/agent-terminals`. Prepared source, labs and exported briefs live under the scope's workspace. Native CLI histories and credentials stay in each CLI's own storage. Settings that are not tied to a panel, such as the saved Burp MCP URL, live in `<data>/settings.json`.

## Running under WSL2 or another Linux terminal

Keep research workspaces on the Linux filesystem, not under `/mnt/c/...`: file permissions and speed are correct there. You need:

- **Git.** Running from source also needs Node 26.13.1 or newer 26.x, pnpm 12, Python 3, make and a C++ compiler; the installer needs none of these.
- **Docker access for your user** (`docker ps` works without sudo; join the `docker` group otherwise). Docker Desktop with WSL integration or a Docker engine inside the distro both work; Kraflr finds `/var/run/docker.sock`, or use `KRAFLR_DOCKER_HOST=unix:///path`. Verification images are built and run by your agents with this engine.
- **The agent CLIs installed inside Linux** (`claude`, `cline`, `opencode`) and signed in there. Windows installs and sign-ins do not carry over. Kraflr looks on `PATH` and in `~/.local/bin`, `~/.opencode/bin` and the npm global `bin`; `KRAFLR_CLAUDE_EXE`, `KRAFLR_CLINE_EXE` and `KRAFLR_OPENCODE_EXE` override it.
- A terminal with 24-bit color and mouse reporting (Windows Terminal is fine). `kraflr doctor` prints what it found, including Docker.
- Optional: `semgrep` on `PATH` (background first pass and the `semgrep_scan` gateway tool) and, if you want Burp's tools proxied through the gateway, Burp Suite running with its MCP server extension and its URL saved from **Agent controls → Research tools → Set Burp MCP URL**. Neither is required to use Kraflr. Semgrep installs the same way as on any Linux box (`pip install semgrep`, `uv tool install semgrep`, …) — WSL adds nothing extra there. Burp is different: see below if it runs on Windows while Kraflr runs in WSL.

### Burp Suite on Windows, Kraflr in WSL

Burp's MCP Server extension rejects any request whose `Host` header isn't `127.0.0.1` or `localhost`, even once its bind address is set to `0.0.0.0` (a DNS-rebinding guard). WSL2's own `127.0.0.1` is not the Windows host's `127.0.0.1` — in NAT mode (the default; mirrored networking is opt-in via `.wslconfig`) the host is only reachable from WSL at the virtual network's gateway IP, and a request sent there carries that IP as its `Host` header, which Burp refuses with a `403`. A relay fixes this: it listens on WSL's own loopback, forwards each request to the host and names Burp's port in the `Host` header. It listens on **9877**, not on Burp's **9876**: WSL mirrors a port opened inside WSL onto Windows loopback (`wslrelay.exe`), so a relay on 9876 would take Burp's port and Burp would fail with *Address already in use* whenever WSL started first.

1. In Burp: **Extensions → BApp Store** → install **MCP Server** (PortSwigger's own, not "MCP Server Scanner" — a different, unrelated tool). Open the new **MCP** tab, check **Enabled**, and under **Advanced options** keep port `9876` and change the host from `127.0.0.1` to `0.0.0.0` (needed so Burp accepts the connection arriving over the WSL virtual adapter at all, before the `Host` header is even checked). Leave **Enable tools that can edit your config** unchecked.
2. In WSL, run the relay as a systemd user service so it survives reboots:
   ```sh
   APP="$HOME/.local/share/kraflr/app"; NODE="$APP/runtime/bin/node"
   # Running from source instead? APP=/path/to/kraflr-agent; NODE=$(command -v node)
   GATEWAY=$(ip route show default | awk '{print $3}')
   loginctl enable-linger "$USER"   # keeps the service running without an active login session
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/burp-relay.service <<EOF
   [Unit]
   Description=Loopback relay to Burp Suite MCP server on the Windows host
   [Service]
   ExecStart="$NODE" "$APP/scripts/burp-relay.mjs" 9877 $GATEWAY 9876
   Restart=on-failure
   [Install]
   WantedBy=default.target
   EOF
   systemctl --user daemon-reload
   systemctl --user enable --now burp-relay
   ```
   The arguments are the relay's port, a fallback host address and Burp's port. The relay looks up the Windows host address again on every connection, since it can change across reboots.
3. In Kraflr: **Agent controls → Research tools → Set Burp MCP URL** → `http://127.0.0.1:9877/mcp` (the relay's port). This is saved in the data directory, not a shell variable, so it survives restarts regardless of which terminal or launch method starts Kraflr next.
4. If it still doesn't connect, check Windows Firewall: an inbound rule for TCP 9876 scoped to the WSL subnet, from an **elevated** PowerShell: `New-NetFirewallRule -DisplayName "Kraflr - Burp MCP (WSL only)" -Direction Inbound -Protocol TCP -LocalPort 9876 -RemoteAddress <your-WSL-subnet> -Action Allow` (`ip route` in WSL shows the subnet). Keep any rule for this port limited to the WSL subnet: with Burp on `0.0.0.0`, a client that is not a browser can leave out the headers Burp checks, so a rule open to your network would let other machines drive Burp.

None of this is needed if Burp and Kraflr are both on Windows, or both inside WSL (via WSLg) — only the split setup crosses the Host-header check. In those setups use Burp's own URL, `http://127.0.0.1:9876/mcp`.

## Run from source

Use a current patched Node 26 release (**26.13.1 or newer 26.x**) and pnpm **12.21.0**. On Linux, install Git, Python 3 and a C/C++ build toolchain.

```sh
pnpm install --frozen-lockfile
node bin/kraflr.mjs install
export PATH="$HOME/.local/bin:$PATH"
kraflr
```

Dependency install scripts are not run. Instead, the project's own postinstall (`scripts/ensure-native-terminal.mjs`) builds the one native module Kraflr needs, `node-pty`, with the node-gyp bundled in npm when it does not already load (Linux has no prebuilt binary). If it prints a warning, install `build-essential` and `python3` and run `node scripts/ensure-native-terminal.mjs`; `kraflr doctor` shows `nativeTerminal: ok` when it worked. Do not use `npm rebuild node-pty`: it also compiles node-pty's TypeScript with this project's TypeScript 7, which fails.

On Windows, `node bin/kraflr.mjs install` creates the user-level command and adds its folder to your PATH, preserving existing entries.

```sh
pnpm check
pnpm test
```

## Releases

The installer downloads a release built by [the release workflow](../.github/workflows/release.yml). To publish one, set the version in `package.json`, commit, then push a matching tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow tests the code, builds `kraflr-agent-linux-x64.tar.gz` with its own Node.js, installs it once to check it and attaches it to the release. Running the workflow by hand does the same without publishing.

The installer accepts `KRAFLR_VERSION` (a given release), `KRAFLR_INSTALL_DIR`, `KRAFLR_BIN_DIR` and `KRAFLR_RELEASE_URL` (a folder holding a locally built release).
