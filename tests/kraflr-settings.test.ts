import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readKraflrSettings, writeKraflrSettings, resolveBurpUrl } from '../server/kraflr-settings.ts'

async function withDataDir(fn: (folder: string) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-settings-')))
  try { await fn(folder) } finally { await rm(folder, { recursive: true, force: true }) }
}

test('a saved setting persists across reads, an empty value clears it, and a missing file reads as empty', () => withDataDir(async (folder) => {
  assert.deepEqual(readKraflrSettings(folder), {})
  writeKraflrSettings(folder, { burpMcpUrl: 'http://127.0.0.1:9876/mcp' })
  assert.deepEqual(readKraflrSettings(folder), { burpMcpUrl: 'http://127.0.0.1:9876/mcp' })
  const raw = JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))
  assert.deepEqual(raw, { burpMcpUrl: 'http://127.0.0.1:9876/mcp' })
  writeKraflrSettings(folder, { burpMcpUrl: '' })
  assert.deepEqual(readKraflrSettings(folder), {}, 'an empty value removes the key rather than saving a blank string')
}))

test('a corrupt or non-object settings file is treated as empty rather than thrown', () => withDataDir(async (folder) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(folder, 'settings.json'), 'not json at all')
  assert.deepEqual(readKraflrSettings(folder), {})
  await writeFile(join(folder, 'settings.json'), '[1,2,3]')
  assert.deepEqual(readKraflrSettings(folder), {})
}))

test('resolveBurpUrl prefers KRAFLR_BURP_MCP_URL over the saved setting, and falls back to the saved one when the env var is unset or blank', () => withDataDir(async (folder) => {
  const original = process.env.KRAFLR_BURP_MCP_URL
  try {
    delete process.env.KRAFLR_BURP_MCP_URL
    assert.equal(resolveBurpUrl(folder), undefined)
    writeKraflrSettings(folder, { burpMcpUrl: 'http://127.0.0.1:9876/mcp' })
    assert.equal(resolveBurpUrl(folder), 'http://127.0.0.1:9876/mcp')
    process.env.KRAFLR_BURP_MCP_URL = '   '
    assert.equal(resolveBurpUrl(folder), 'http://127.0.0.1:9876/mcp', 'a blank env var does not override a real saved setting')
    process.env.KRAFLR_BURP_MCP_URL = 'http://127.0.0.1:1234/mcp'
    assert.equal(resolveBurpUrl(folder), 'http://127.0.0.1:1234/mcp', 'a set env var overrides the saved setting')
  } finally {
    if (original === undefined) delete process.env.KRAFLR_BURP_MCP_URL; else process.env.KRAFLR_BURP_MCP_URL = original
  }
}))
