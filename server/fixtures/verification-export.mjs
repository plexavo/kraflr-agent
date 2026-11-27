import { createServer } from 'node:http'
import { once } from 'node:events'

const variant = process.argv[1]
if (!['vulnerable', 'patched'].includes(variant)) throw new Error('Unknown fixture version.')

const exports = new Map([
  ['a', { owner: 'alice', value: 'fixture-alice' }],
  ['b', { owner: 'bob', value: 'fixture-bob' }],
])
const server = createServer((request, reply) => {
  const item = exports.get(request.url?.match(/^\/exports\/([ab])$/)?.[1])
  if (request.method !== 'GET' || !item) return reply.writeHead(404).end()
  if (variant === 'patched' && item.owner !== request.headers['x-fixture-user']) {
    return reply.writeHead(403).end()
  }
  return reply.writeHead(200, { 'Content-Type': 'text/plain' }).end(item.value)
})
server.listen(0, '127.0.0.1')
try {
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const options = { headers: { 'x-fixture-user': 'alice' }, signal: AbortSignal.timeout(4000) }
  const owner = await fetch(origin + '/exports/a', options)
  const foreign = await fetch(origin + '/exports/b', options)
  console.log(JSON.stringify({
    ownerStatus: owner.status,
    ownerRecordReturned: (await owner.text()) === 'fixture-alice',
    foreignStatus: foreign.status,
    foreignRecordReturned: (await foreign.text()) === 'fixture-bob',
  }))
} finally {
  server.closeAllConnections()
  server.close()
}
