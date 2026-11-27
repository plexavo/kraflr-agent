import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { StoreError } from './db.ts'
import { stopWindowsProcessTree } from './process-tree.ts'

async function readJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new StoreError(502, 'OpenCode returned an empty response.')
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(text + decoder.decode()) as unknown
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new StoreError(502, 'OpenCode returned a response above the size limit.')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function startPrivateOpenCode(executable: string, cwd: string, env: NodeJS.ProcessEnv,
  signal: AbortSignal = AbortSignal.timeout(12_000)) {
  signal.throwIfAborted()
  const username = 'opencode'
  const password = randomBytes(24).toString('hex')
  const credentials = { OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password }
  const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, ...credentials },
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const startup = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  let closing: Promise<void> | undefined
  function close() {
    return closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32' && child.pid) {
          await stopWindowsProcessTree(child.pid).catch((error) => {
            if (child.exitCode === null && child.signalCode === null) throw error
          })
        } else child.kill()
      }
      await closed
    })()
  }

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const onAbort = () => reject(startup.reason)
      const onData = (chunk: string) => {
        output = (output + chunk).slice(-8192)
        const match = /(?:^|\r?\n)server listening on (http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})\r?\n/.exec(output)
        if (!match) return
        startup.removeEventListener('abort', onAbort)
        child.stdout.off('data', onData)
        child.stdout.resume()
        resolve(match[1]!)
      }
      child.once('error', reject)
      void closed.then(() => reject(new StoreError(502, 'OpenCode could not start a private server.')))
      child.stdout.setEncoding('utf8').on('data', onData)
      startup.addEventListener('abort', onAbort, { once: true })
      if (startup.aborted) onAbort()
    })

    async function request(path: string, options: { method?: 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal;
      errorMessage?: string } = {}): Promise<unknown> {
      const response = await fetch(url + path, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        signal: options.signal ?? AbortSignal.timeout(5000), redirect: 'error',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new StoreError(response.status === 404 || response.status === 409 ? 409 : 502,
          options.errorMessage ?? 'OpenCode rejected the request. Check the session in its terminal.')
      }
      return response.status === 204 ? undefined : readJson(response)
    }

    const info = await request('/api/info', { signal: startup }) as { pid?: number; version?: string } | null
    if (!info || info.pid !== child.pid || typeof info.version !== 'string' || !/^2\./.test(info.version)) {
      throw new StoreError(502, 'The OpenCode CLI could not verify a compatible private server.')
    }
    const unauthenticated = await fetch(`${url}/api/info`, { signal: startup, redirect: 'error' })
    await unauthenticated.body?.cancel()
    if (unauthenticated.status !== 401) throw new StoreError(502, 'OpenCode did not protect its private server.')
    return { url, credentials, request, close }
  } catch (error) {
    await close()
    throw error
  }
}

export type PrivateOpenCode = Awaited<ReturnType<typeof startPrivateOpenCode>>
