import { createConnection, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface RuntimeAddress { socket: string; token: string; pid: number; version: number }
export const maxFrame = 2 * 1024 * 1024
export async function address(dataDir: string): Promise<RuntimeAddress> {
  const value = JSON.parse(await readFile(join(dataDir, 'terminal-runtime.json'), 'utf8')) as RuntimeAddress
  if (value.version !== 1 || !value.socket || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.pid)) throw new Error('Invalid terminal runtime address.')
  return value
}
export class RpcClient {
  readonly target: { socket: string; token: string; agent?: string }
  socket: Socket
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  events = new Set<(event: any) => void>()
  connected: Promise<void>
  constructor(target: { socket: string; token: string; agent?: string }) {
    this.target = target
    this.socket = createConnection(target.socket)
    this.connected = new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject) })
    let buffer = ''
    this.socket.setEncoding('utf8')
    this.socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > maxFrame) { this.socket.destroy(new Error('Runtime frame is too large.')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try {
          const message = JSON.parse(line)
          if (message.event) { for (const listener of this.events) listener(message); continue }
          const request = this.pending.get(message.id)
          if (!request) continue
          clearTimeout(request.timer); this.pending.delete(message.id)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.result)
        } catch { this.socket.destroy(new Error('Invalid runtime response.')); return }
      }
    })
    const fail = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Kraflr runtime disconnected.')) }; this.pending.clear() }
    this.socket.on('close', fail); this.socket.on('error', fail)
  }
  async call(method: string, params: unknown = {}, timeout = 180_000): Promise<any> {
    await this.connected
    const id = randomUUID()
    const message = JSON.stringify({ id, token: this.target.token, agent: this.target.agent, method, params }) + '\n'
    if (Buffer.byteLength(message) > maxFrame) throw new Error('Request is too large.')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime request timed out; check its state before retrying.')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(message, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) } })
    })
  }
  close() { this.socket.destroy() }
}

