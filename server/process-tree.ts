import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Only pass a PID obtained from a process Kraflr launched and still owns.
export async function stopWindowsProcessTree(pid: number) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error('Invalid managed Windows process.')
  }
  await execute(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 })
}
