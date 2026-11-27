#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const parts = process.versions.node.split('.').map(Number)
if (parts[0] < 26 || (parts[0] === 26 && (parts[1] < 13 || (parts[1] === 13 && parts[2] < 1)))) {
  const bundled = fileURLToPath(new URL('../.tools/node-v26.13.1-win-x64/node.exe', import.meta.url))
  if (process.platform === 'win32' && existsSync(bundled) && process.execPath.toLowerCase() !== bundled.toLowerCase()) {
    const result = spawnSync(bundled, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
    process.exit(result.status ?? 1)
  }
  console.error('Kraflr needs Node.js 26.13.1 or newer.'); process.exit(1)
}
try { await import('../cli/main.ts') }
catch (error) { console.error('Kraflr: ' + (error instanceof Error ? error.message : 'Startup failed.')); process.exitCode = 1 }
