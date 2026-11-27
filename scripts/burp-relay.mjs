// Lets Kraflr in WSL reach the MCP server of Burp Suite running on Windows.
//
// Burp rejects a request whose Host header is not 127.0.0.1 or localhost on Burp's own port, and from WSL the Windows host is only reachable at
// the virtual network's gateway address. This relay listens on WSL's loopback, forwards each request to that gateway (looked up every time, since
// it can change across reboots) and names Burp's port in the Host header.
//
// It must NOT listen on Burp's port: WSL mirrors a port opened in WSL onto Windows loopback (wslrelay.exe), so a relay on 9876 takes the port
// Burp needs and Burp fails with "Address already in use" whenever WSL started first. See docs/guide.md, "Burp Suite on Windows, Kraflr in WSL".
// Usage: node burp-relay.mjs <listenPort> <fallbackHost> <burpPort>     for example: node burp-relay.mjs 9877 172.17.0.1 9876
import http from 'node:http'
import { execSync } from 'node:child_process'

// Only this machine's own names are relayed. Rewriting the Host header must not undo Burp's guard against a web page that points its own
// domain at loopback, which arrives with that domain as its Host.
const local = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i

// A closed Burp does not refuse the connection, because Windows drops it, so the relay gives up itself. Kraflr's status check waits 5 seconds.
export function createRelay({ targetPort, host, connectTimeoutMs = 3000 }) {
  const server = http.createServer((request, response) => {
    const refuse = (status, message) => response.writeHead(status, { 'content-type': 'text/plain' }).end(message + '\n')
    if (!local.test(request.headers.host ?? '')) return refuse(403, 'The relay only answers requests addressed to 127.0.0.1 or localhost.')
    const { connection: _client, ...headers } = request.headers
    const upstream = http.request({ host: host(), port: targetPort, method: request.method, path: request.url, agent: false,
      headers: { ...headers, host: `127.0.0.1:${targetPort}` } }, (reply) => {
      const { connection: _server, ...passed } = reply.headers
      response.writeHead(reply.statusCode ?? 502, passed)
      // An event stream may stay quiet for a long time, so its headers go out at once.
      response.flushHeaders()
      reply.pipe(response)
      reply.on('error', () => response.destroy())
    })
    // Only reaching Burp is timed: an open event stream or a long-running tool call may stay quiet as long as it likes.
    upstream.on('socket', (socket) => {
      if (!socket.connecting) return
      const timer = setTimeout(() => upstream.destroy(new Error(`no answer within ${connectTimeoutMs / 1000} seconds`)), connectTimeoutMs)
      const stop = () => clearTimeout(timer)
      socket.once('connect', stop); socket.once('close', stop)
    })
    upstream.on('error', (error) => {
      if (response.headersSent) response.destroy()
      else refuse(502, 'Burp is not reachable from the relay (' + error.message + '). Check that Burp is open with its MCP server enabled on host 0.0.0.0 and that Windows Firewall allows the WSL subnet.')
    })
    response.on('close', () => { if (!response.writableFinished) upstream.destroy() })
    request.pipe(upstream)
  })
  server.requestTimeout = 0
  return server
}

if (import.meta.main) {
  const [, , listenPort, fallbackHost, targetPort] = process.argv
  if (!listenPort || !fallbackHost || !targetPort) {
    console.error('Usage: node burp-relay.mjs <listenPort> <fallbackHost> <burpPort>   for example: node burp-relay.mjs 9877 172.17.0.1 9876')
    process.exit(1)
  }
  if (listenPort === targetPort) console.warn(`Listening on Burp's own port ${targetPort} blocks Burp on Windows. Use another listen port, such as 9877.`)
  const gateway = () => {
    try { return execSync('ip route show default').toString().trim().split(/\s+/)[2] || fallbackHost }
    catch { return fallbackHost }
  }
  createRelay({ targetPort: Number(targetPort), host: gateway }).listen(Number(listenPort), '127.0.0.1', () => {
    console.log(`relay up: 127.0.0.1:${listenPort} -> (resolved default gateway):${targetPort}`)
  })
}
