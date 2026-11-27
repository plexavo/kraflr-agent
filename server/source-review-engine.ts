import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEnvironment, resolveAgent } from './agent-terminals.ts'
import { StoreError } from './db.ts'
import { startPrivateOpenCode } from './private-opencode.ts'

export interface SourceReviewEngine {
  available(): boolean
  generate(prompt: string, model: string, signal: AbortSignal, beforeSend: () => void): Promise<string>
}

export const openCodeSourceEngine: SourceReviewEngine = {
  available: () => Boolean(resolveAgent('opencode')),
  async generate(prompt, model, signal, beforeSend) {
    const executable = resolveAgent('opencode')
    if (!executable) throw new StoreError(409, 'Install the OpenCode CLI to run a source review.')
    const cwd = await mkdtemp(join(tmpdir(), 'kraflr-review-'))
    try {
      const server = await startPrivateOpenCode(executable, cwd, agentEnvironment('opencode'), signal)
      try {
        const slash = model.indexOf('/')
        beforeSend()
        signal.throwIfAborted()
        const result = await server.request('/api/experimental/generate/text', {
          body: { prompt, model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) } },
          signal,
          errorMessage: 'OpenCode could not complete the review. Check the model and provider sign-in in OpenCode.',
        }) as { data?: { text?: unknown } } | null
        if (typeof result?.data?.text !== 'string') throw new StoreError(502, 'OpenCode returned an invalid text response.')
        return result.data.text
      } finally {
        await server.close()
      }
    } finally {
      await rmdir(cwd).catch(() => {})
    }
  },
}
