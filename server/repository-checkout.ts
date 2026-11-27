import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { StoreError } from './db.ts'
import type { ResearchStore } from './db.ts'
import { fullCommit } from '../shared/source-review.ts'

const execute = promisify(execFile)
export function publicRepository(value: string) {
  if (/[\s\\\p{C}]/u.test(value)) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
        !['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'].includes(url.hostname) ||
        !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\/?$/.test(url.pathname) || url.pathname.split('/').some((part) => part === '..' || part === '.')) return
    return url.href
  } catch { return }
}

async function git(cwd: string, args: string[], signal: AbortSignal, network = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(key)))
  const { stdout } = await execute('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.longpaths=true', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'submodule.recurse=false',
    '-c', 'protocol.allow=never', '-c', `protocol.https.allow=${network ? 'always' : 'never'}`, '-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' },
    signal, windowsHide: true, timeout: network ? 120_000 : 10_000, maxBuffer: 8192,
  })
  return stdout.trim()
}

export async function ownedDirectory(workspace: string, ...parts: string[]) {
  if (!isAbsolute(workspace) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(workspace))) throw new StoreError(409, 'Choose an existing local agent workspace folder in Scope.')
  const root = await realpath(workspace).catch(() => '')
  if (!root || !(await lstat(root)).isDirectory()) throw new StoreError(409, 'The agent workspace folder is unavailable.')
  let current = root
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw new StoreError(409, 'Invalid managed workspace directory.')
    current = join(current, part)
    await mkdir(current, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(current)
    const resolved = await realpath(current)
    const offset = relative(root, resolved)
    if (info.isSymbolicLink() || !info.isDirectory() || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) {
      throw new StoreError(409, 'A managed workspace directory points elsewhere. Choose another workspace.')
    }
  }
  return current
}

export function createRepositoryCheckouts(store: ResearchStore) {
  const active = new Map<string, Promise<ReturnType<ResearchStore['readPanel']>>>()
  const lifetime = new AbortController()
  async function prepare(panelId: string) {
    const panel = store.readPanel(panelId)
    const scope = store.readSourceScope(panelId, panel.scopeVersion)
    // A web application test has no repository to clone.
    if (panel.type === 'web' || scope.repositoryMode !== 'known') return panel
    if(scope.workspacePath && !(await lstat(scope.workspacePath).catch(()=>null))?.isDirectory()){
      throw new StoreError(409,`The saved workspace folder is missing: ${scope.workspacePath}. Open Scope and choose its current location or a new workspace. No agent was started.`)
    }
    if (panel.checkout) {
      if(!(await lstat(panel.checkout.path).catch(()=>null))?.isDirectory())throw new StoreError(409,`The pinned source clone is missing: ${panel.checkout.path}. Restore that clone, or update the workspace in Scope to prepare a fresh copy. No agent was started.`)
      const pinned = await git(panel.checkout.path, ['rev-parse', '--verify', '--end-of-options', `${panel.checkout.commit}^{commit}`], lifetime.signal)
      if (pinned !== panel.checkout.commit) throw new StoreError(409, 'The pinned checkout is unavailable. Restore it or save a new scope.')
      const head = await git(panel.checkout.path, ['rev-parse', 'HEAD'], lifetime.signal)
      if (head !== pinned || await git(panel.checkout.path, ['status', '--porcelain', '--untracked-files=normal'], lifetime.signal)) {
        throw new StoreError(409, 'The prepared checkout changed after it was pinned. Restore a clean checkout or save a new scope before researching it.')
      }
      return panel
    }
    const revision = fullCommit.test(scope.revision) ? scope.revision : 'HEAD'
    let path: string
    if (isAbsolute(scope.repository)) {
      path = await realpath(scope.repository).catch(() => '')
      if (!path || (await git(path, ['rev-parse', '--show-prefix'], lifetime.signal))) throw new StoreError(409, 'Choose the root of an existing local Git clone.')
      if (await git(path, ['status', '--porcelain', '--untracked-files=normal'], lifetime.signal)) throw new StoreError(409, 'The selected clone has uncommitted files. Use a clean clone so the recorded source matches what agents inspect.')
    } else {
      const remote = publicRepository(scope.repository)
      if (!remote) throw new StoreError(409, 'Automatic checkout supports public HTTPS repositories on GitHub, GitLab, Codeberg and Bitbucket. For another host, select its existing local clone.')
      const parent = await ownedDirectory(scope.workspacePath, '.kraflr', panelId)
      const destination = join(parent, `source-${scope.version}`)
      const staging = join(parent, `checkout-${randomUUID()}`)
      if (await lstat(destination).then(() => true, () => false)) throw new StoreError(409, 'A source directory already exists without a saved binding. Choose a new workspace or save a new scope.')
      await git(parent, ['clone', '--quiet', '--depth', '1', '--no-recurse-submodules', '--', remote, staging], lifetime.signal, true)
      if (revision !== 'HEAD') {
        await git(staging, ['fetch', '--quiet', '--depth', '1', 'origin', revision], lifetime.signal, true)
        await git(staging, ['checkout', '--quiet', '--detach', revision], lifetime.signal)
      }
      const actual = await realpath(staging)
      if (relative(parent, actual).startsWith('..') || (await lstat(staging)).isSymbolicLink()) throw new StoreError(409, 'The managed clone directory could not be verified.')
      store.readSourceScope(panelId, scope.version)
      await rename(staging, destination)
      path = destination
    }
    const commit = await git(path, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], lifetime.signal)
    if (!fullCommit.test(commit)) throw new StoreError(409, 'Git did not return a full source revision.')
    if (await git(path, ['rev-parse', 'HEAD'], lifetime.signal) !== commit) {
      throw new StoreError(409, 'The local clone’s checked-out commit differs from the saved revision. Select a clean clone checked out at that revision, or save a new scope to use its current source.')
    }
    return store.saveCheckout({ panelId, scopeVersion: scope.version, repository: scope.repository, path, commit, preparedAt: new Date().toISOString() })
  }
  return {
    prepare(panelId: string) {
      const key = `${panelId}:${store.readPanel(panelId).scopeVersion}`
      let job = active.get(key)
      if (!job) {
        job = prepare(panelId).catch((error) => {
          if (error instanceof StoreError) throw error
          if((error as NodeJS.ErrnoException).code==='ENOENT')throw new StoreError(503,'Git could not be started. Check that Git is installed and available to Kraflr, then retry. No agent was started.')
          throw new StoreError(422, 'The source checkout could not be prepared. Check the repository, Git installation, network and workspace folder; no research was started.')
        }).finally(() => active.delete(key))
        active.set(key, job)
      }
      return job
    },
    async close() { lifetime.abort(); await Promise.allSettled(active.values()) },
  }
}
