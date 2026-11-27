import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { StoreError } from './db.ts'

// An OS-owned listener is released even after a crash; there is no stale lock file to delete.
export async function acquireWorkspaceLock(directory: string) {
  const path = realpathSync(directory)
  const key = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex')
  const server = createServer((socket) => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      if (process.platform === 'win32') server.listen(`\\\\.\\pipe\\kraflr-workspace-${key}`, resolve)
      else server.listen({ host: '127.0.0.1', port: 49152 + Number.parseInt(key.slice(0, 4), 16) % 16384, exclusive: true }, resolve)
    })
  } catch {
    throw new StoreError(409, 'This Kraflr data folder is already in use, or its local workspace lock is unavailable. Close the other Kraflr process before retrying.')
  }
  let closing: Promise<void> | undefined
  return () => closing ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
