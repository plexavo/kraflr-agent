import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { acquireWorkspaceLock } from '../server/workspace-lock.ts'

test('only one process can own a data folder; separate folders and a released lock remain available', async (t) => {
  const base = await realpath(tmpdir())
  const roots = await Promise.all([mkdtemp(join(base, 'kraflr-lock-')), mkdtemp(join(base, 'kraflr-lock-'))])
  const releases: (() => Promise<void>)[] = []
  t.after(async () => {
    await Promise.all(releases.map((release) => release()))
    for (const root of roots) {
      const resolved = await realpath(root)
      if (/^kraflr-lock-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
    }
  })
  const release = await acquireWorkspaceLock(roots[0]!)
  releases.push(release)
  await assert.rejects(acquireWorkspaceLock(roots[0]!), /already in use/)
  if (process.platform === 'win32') await assert.rejects(acquireWorkspaceLock(roots[0]!.toUpperCase()), /already in use/)
  releases.push(await acquireWorkspaceLock(roots[1]!))
  await release()
  releases.push(await acquireWorkspaceLock(roots[0]!))
})
