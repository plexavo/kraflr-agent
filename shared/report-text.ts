/** Agent text is untrusted data. Decode JSON only; never evaluate or execute a report. */
const marker = /^(?:kraflr-result|kraclr-result)\s*$/i
const bounded = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
export function looksLikeReport(value: string) {
  return /^(?:```|~~~|kraflr-result\b|kraclr-result\b|\{\s*"(?:summary|reply|leads|tasks)"\s*:)/i.test(value.trim())
}
export function plainReply(value: string, fallback = 'The detailed reply is saved. Its evidence report needs repair before Kraflr can use it.') {
  if (!value.trim() || looksLikeReport(value)) return fallback
  const narrative = value.replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, '')
    .replace(/^(?:kraflr-result|kraclr-result)\s*\n[\s\S]*$/im, '')
    .replace(/`([^`\n]+)`/g, '$1').replace(/^\s*#{1,6}\s+/gm, '').trim()
  if (!narrative || looksLikeReport(narrative)) return fallback
  return narrative.split(/(?<=[.!?])\s+/u).slice(0, 4).join(' ').slice(0, 1200)
}
export function decodeReport(text: string) {
  const candidates: string[] = []
  for (const match of text.slice(-1_000_000).matchAll(/(?:^|\n)[ \t]*(```|~~~)([^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/g)) {
    const language = match[2]!.trim()
    let body = match[3]!.trim()
    const line = body.split(/\r?\n/, 1)[0] ?? ''
    if (marker.test(line)) body = body.slice(line.length).trim()
    else if (language && !marker.test(language) && language.toLowerCase() !== 'json') continue
    candidates.push(body)
  }
  if (/^\s*\{/.test(text) && /\}\s*$/.test(text)) candidates.push(text.trim())
  for (const candidate of candidates.reverse()) {
    try {
      const data: unknown = JSON.parse(candidate)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const report = data as Record<string, unknown>
      if (typeof report.summary !== 'string' && typeof report.reply !== 'string' && !Array.isArray(report.tasks) && !Array.isArray(report.leads)) continue
      const summary = bounded(report.summary, 6000) || bounded(report.reply, 6000) || 'The agent returned an evidence report.'
      return { data: report, structured: true, summary, reply: plainReply(bounded(report.reply, 1200) || summary) }
    } catch { /* A malformed candidate cannot create evidence or an executable plan. */ }
  }
  const reply = plainReply(text)
  return { data: {} as Record<string, unknown>, structured: false, summary: reply, reply }
}
