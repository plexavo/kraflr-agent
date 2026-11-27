// Runs after `pnpm install`. node-pty ships prebuilt binaries for Windows and macOS but not for Linux, where its native module has to be compiled.
// Its own install step needs a node-gyp that pnpm does not provide, and `npm rebuild` also runs node-pty's prepare step, which compiles its
// TypeScript with this project's TypeScript 7 and fails. So the native build is done here with the node-gyp that npm bundles.
// It needs Python 3, make and a C++ compiler. Run it again by hand with: node scripts/ensure-native-terminal.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const loads = () => { try { require('node-pty'); return true } catch { return false } }

/** The node-gyp bundled with this Node's npm: npm's own environment first, then the global npm install next to this Node. */
function bundledNodeGyp() {
  const tail = join('npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  const candidates = [process.env.npm_config_node_gyp, join(dirname(process.execPath), '..', 'lib', 'node_modules', tail)]
  const root = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim()
  if (root) candidates.push(join(root, tail))
  return candidates.find((path) => path && existsSync(path))
}

if (!loads()) {
  const gyp = bundledNodeGyp()
  if (gyp) {
    console.log('Kraflr: building the native terminal module (node-pty)…')
    spawnSync(process.execPath, [gyp, 'rebuild'], { cwd: join(dirname(require.resolve('node-pty')), '..'), stdio: 'inherit' })
  }
  if (!loads()) {
    // A failed build must not break the install; `kraflr doctor` and the first launch say what is missing.
    console.warn('Kraflr: node-pty could not be built, so agent terminals will not start.' + (gyp ? '' : ' npm’s bundled node-gyp was not found.')
      + ' Install Python 3, make and a C++ compiler (on Debian or Ubuntu: sudo apt install build-essential python3), then run: node scripts/ensure-native-terminal.mjs')
  }
}
