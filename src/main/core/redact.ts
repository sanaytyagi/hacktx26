// Removes secrets from anything written to logs, audit events, run events, or errors.
const known = new Set<string>()

/** Register a secret value (e.g. after decrypting a credential) so it is masked wherever it appears. */
export function registerSecret(value: string): void {
  if (value && value.length >= 6) known.add(value)
}

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\b(?:ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /([?&](?:api_key|apikey|key|token|access_token)=)[^&\s"']+/gi
]

export function redactString(s: string): string {
  let out = s
  for (const secret of known) if (out.includes(secret)) out = out.split(secret).join('[REDACTED]')
  for (const re of PATTERNS) out = out.replace(re, (_m, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'))
  return out
}

const SECRET_KEYS = /^(authorization|api[_-]?key|apikey|secret|password|token|access_token|x-api-key|x-goog-api-key)$/i

export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)
    return out as T
  }
  return value
}
