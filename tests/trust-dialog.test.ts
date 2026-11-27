import assert from 'node:assert/strict'
import test from 'node:test'
import { NativePrompt } from '../cli/native-prompt.ts'

const write = (prompt: NativePrompt, text: string) => new Promise<void>((done) => prompt.output(text, done))
/** The screen Claude Code 2.1 shows for a folder it has not seen, as captured from a real session (the cursor starts on "No, exit"). */
const dialog = (folder: string, selected: 'no' | 'yes' = 'no') => [
  'Accessing workspace:', '', folder, '',
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.", '',
  "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '',
  selected === 'no' ? '❯ No, exit' : '  No, exit', selected === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder', '', 'Enter to confirm · Esc to cancel',
].join('\r\n')

test('Claude Code’s trust screen is recognised with the folder it names, even when a narrow pane wraps the path, and the keys pick “Yes” from either starting position', async () => {
  const folder = '/home/alice/.local/state/Kraflr/data/agent-terminals/claude-0ceefd7c-c308-475d-93cb-2313eec86017'
  const wide = new NativePrompt(160, 30, 'claude'); await write(wide, dialog(folder))
  assert.equal(wide.trustDialog()?.folder, folder); assert.equal(wide.trustDialog()?.keys, '\x1b[B', 'from "No, exit" press Down first; Enter follows once the cursor is on Yes')
  assert.equal(wide.status(false).ready, false); assert.match(wide.status(false).reason, /Needs your response|trust choice/)
  const narrow = new NativePrompt(80, 30, 'claude'); await write(narrow, dialog(folder))
  assert.equal(narrow.trustDialog()?.folder, folder, 'a wrapped path is rejoined')
  const onYes = new NativePrompt(120, 30, 'claude'); await write(onYes, dialog(folder, 'yes'))
  assert.equal(onYes.trustDialog()?.keys, '\r', 'already on "Yes": just Enter')
  for (const prompt of [wide, narrow, onYes]) prompt.dispose()
})

test('the trust screen is not reported for other agents, for an ordinary prompt, or for a screen that only mentions a folder', async () => {
  const composer = ['Claude Code v2.1.331', '', '─'.repeat(100), '❯ ' + String.fromCharCode(27) + '[2mTry "how do I log an error?"' + String.fromCharCode(27) + '[22m', '─'.repeat(100), '? for shortcuts'].join('\r\n')
  const claude = new NativePrompt(100, 30, 'claude'); await write(claude, composer)
  assert.equal(claude.trustDialog(), undefined); assert.equal(claude.status(false).ready, true)
  const cline = new NativePrompt(100, 30, 'cline'); await write(cline, dialog('/x/y'))
  assert.equal(cline.trustDialog(), undefined, 'only Claude Code gets this handling')
  const partial = new NativePrompt(100, 30, 'claude'); await write(partial, 'Accessing workspace:\r\n\r\n/x/y\r\n\r\nQuick safety check: trust?\r\n')
  assert.equal(partial.trustDialog(), undefined, 'both choices must be on screen')
  for (const prompt of [claude, cline, partial]) prompt.dispose()
})

test('the "Adding a new directory" question is recognised with its folder, so only Kraflr’s own session folder is answered', async () => {
  const folder = '/var/tmp/kraflr-e2e-data/agent-terminals/ca36477e-7b15-4d39-84bc-fa8434abd911'
  const screen = ['Adding a new directory:', '', folder, '', "This session hasn't worked here before. Is this a directory you created or one you trust?", '', "Claude Code'll be able to read, edit, and execute files here.", '', '❯ No, exit', '  Yes, add it', '', 'Enter to confirm · Esc to cancel'].join('\r\n')
  const prompt = new NativePrompt(80, 30, 'claude'); await write(prompt, screen)
  assert.equal(prompt.trustDialog()?.folder, folder); assert.equal(prompt.trustDialog()?.keys, '\x1b[B')
  const other = new NativePrompt(80, 30, 'claude'); await write(other, screen.replace(folder, '/home/alice/cloned/untrusted-repo'))
  assert.equal(other.trustDialog()?.folder, '/home/alice/cloned/untrusted-repo', 'the folder is reported so the caller can refuse a folder that is not Kraflr’s own')
  prompt.dispose(); other.dispose()
})
