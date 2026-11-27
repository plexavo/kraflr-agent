export function secretRedactor(values: (string | undefined)[]) {
  const secrets = [...new Set(values.filter((value): value is string => Boolean(value && value.length >= 8)))]
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length)
  let pending = ''
  const redact = (text: string) => secrets.reduce((result, value) => result.replaceAll(value, '[REDACTED]'), text)
  return {
    redact,
    write(chunk: string) {
      const text = redact(pending + chunk)
      let held = 0
      for (const secret of secrets) {
        for (let size = Math.min(secret.length - 1, text.length); size > held; size--) {
          if (text.endsWith(secret.slice(0, size))) { held = size; break }
        }
      }
      pending = held ? text.slice(-held) : ''
      return held ? text.slice(0, -held) : text
    },
    flush() { const text = pending ? '[REDACTED]' : ''; pending = ''; return text },
  }
}
