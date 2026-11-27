import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { fullCommit, sourceLineLimit } from '../shared/source-review.ts'
import type { SourceSelection, SourceExcerpt } from '../shared/source-review.ts'
import type { ScopeRevision } from '../shared/research.ts'
import { StoreError } from './db.ts'

const execute = promisify(execFile)
const blobLimit = 256 * 1024
const excerptLimit = 14_000
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function localPath(path: string) {
  return isAbsolute(path) && (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(path))
}

async function git(root: string, args: string[], failure: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)))
  try {
    const { stdout } = await execute('git', [
      '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '-C', root, ...args,
    ], {
      encoding: 'buffer', timeout: 5000, maxBuffer: blobLimit + 1024, windowsHide: true,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
    })
    return stdout
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StoreError(503, 'Install a current Git CLI and make it available on PATH.')
    }
    throw new StoreError(422, failure)
  }
}

export async function readPinnedSource(scope: ScopeRevision, selection: SourceSelection): Promise<SourceExcerpt> {
  const repository = scope.checkoutPath ?? scope.repository
  if (scope.repositoryMode !== 'known' || !localPath(repository)) {
    throw new StoreError(409, 'Save the absolute path to the authorized local Git clone in Research scope.')
  }
  const commit = (scope.resolvedCommit ?? scope.revision).toLowerCase()
  if (!fullCommit.test(commit)) throw new StoreError(409, 'Save the full Git commit hash in Research scope.')
  const { path, startLine, endLine } = selection
  const segments = path.split('/')
  if (/[\\:\u0000-\u001f\u007f]/u.test(path) ||
      segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new StoreError(400, 'Use a repository-relative file path with forward slashes.')
  }
  if (endLine !== undefined && (endLine < startLine || endLine - startLine >= sourceLineLimit)) {
    throw new StoreError(400, `Choose a range of up to ${sourceLineLimit} lines.`)
  }
  const root = await realpath(repository).catch(() => '')
  if (!localPath(root)) throw new StoreError(422, 'Kraflr could not open the saved local clone.')
  const prefix = await git(root, ['rev-parse', '--show-prefix'],
    'Open the root of a local Git clone and use a recent Git version.')
  if (prefix.toString('utf8').trim()) throw new StoreError(422, 'Save the root of the Git clone in Research scope.')
  const resolved = await git(root, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`],
    'That commit is unavailable in the local clone.')
  if (resolved.toString('utf8').trim() !== commit) throw new StoreError(422, 'The saved hash must identify the exact Git commit.')
  const entry = await git(root, ['ls-tree', '-z', commit, '--', path], 'Git could not read that path from the saved commit.')
  const blob = /^100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(entry.toString('utf8'))
  if (!blob?.[1] || blob[2] !== path) {
    throw new StoreError(422, 'Choose a regular tracked file from the saved commit. Links and submodules are excluded.')
  }
  const bytes = await git(root, ['cat-file', 'blob', blob[1]], 'Git could not read the file within the 256 KiB limit.')
  if (bytes.length > blobLimit) throw new StoreError(422, 'Choose a committed file under 256 KiB.')
  let contents: string
  try {
    contents = text.decode(bytes)
  } catch {
    throw new StoreError(422, 'Choose a UTF-8 text file.')
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(contents)) {
    throw new StoreError(422, 'Choose a UTF-8 text file without binary control characters.')
  }
  const fileLines = contents.split(/\r\n|\n|\r/u)
  if (fileLines.at(-1) === '') fileLines.pop()
  const last = endLine ?? Math.min(startLine + sourceLineLimit - 1, fileLines.length)
  if (last < startLine || last > fileLines.length) {
    throw new StoreError(422, `Choose a range within the file’s ${fileLines.length} lines.`)
  }
  const lines = fileLines.slice(startLine - 1, last)
  if (lines.join('\n').length > excerptLimit) throw new StoreError(422, 'Choose a shorter line range.')
  return { commit, path, startLine, lines }
}
