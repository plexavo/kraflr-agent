import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentPermission, AgentPermissionDecision } from '../shared/agent-terminal.ts'
import { StoreError } from './db.ts'
import { secretRedactor } from './secrets.ts'

export function createPermissionGuard(sessionId: string, secrets: (string | undefined)[] = []) {
  const key = randomBytes(32)
  const redactor = secretRedactor(secrets)
  const deciding = new Set<string>()
  const consumed = new Set<string>()
  return {
    snapshot(input: Omit<AgentPermission, 'fingerprint'>): AgentPermission {
      const action = redactor.redact(input.action)
      const description = input.description && redactor.redact(input.description)
      const resources = input.resources.map(redactor.redact)
      const changed = action !== input.action || description !== input.description || resources.some((item, index) => item !== input.resources[index])
      const unreadable = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
      const canApprove = input.canApprove && !changed && !unreadable.test([action, description, ...resources].join('\n'))
      const fingerprint = createHmac('sha256', key).update(JSON.stringify({ sessionId, id: input.id,
        action, description, resources, canApprove })).digest('hex')
      return { id: input.id, action, description, resources, canApprove, fingerprint }
    },
    async decide(id: string, fingerprint: string, decision: AgentPermissionDecision,
      read: () => Promise<AgentPermission | undefined>, checkCurrent: () => void, perform: () => Promise<void>) {
      if (deciding.has(id) || consumed.has(id)) throw new StoreError(409, 'This permission decision was already submitted.')
      if (consumed.size >= 4096) throw new StoreError(409, 'Start a fresh agent session before submitting more decisions.')
      deciding.add(id)
      try {
        const request = await read()
        if (!request) throw new StoreError(409, 'This permission request is no longer pending.')
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !timingSafeEqual(Buffer.from(request.fingerprint, 'hex'), Buffer.from(fingerprint, 'hex'))) {
          throw new StoreError(409, 'The permission details changed. Review the refreshed request before deciding.')
        }
        if (decision === 'once' && !request.canApprove) throw new StoreError(409, 'The full request cannot be approved from this card.')
        checkCurrent()
        // A timeout may happen after the engine received the decision. Never retry it silently.
        consumed.add(id)
        await perform()
      } finally { deciding.delete(id) }
    },
  }
}
