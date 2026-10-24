import type { JsonSchema } from '@shared/domain'

/** Validates the JSON-schema subset Relay uses for tool contracts. Returns error strings. */
export function validate(schema: JsonSchema | undefined, value: unknown, path = '$'): string[] {
  if (!schema || Object.keys(schema).length === 0) return []
  const errs: string[] = []
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    return errs
  }
  const t = schema.type
  if (!t) return errs
  if (value === undefined || value === null) {
    if (t !== 'null') errs.push(`${path} is required (${t})`)
    return errs
  }
  switch (t) {
    case 'string':
      if (typeof value !== 'string') errs.push(`${path} must be a string`)
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} must have at least ${schema.minLength} characters`)
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} must have at most ${schema.maxLength} characters`)
      }
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || Number.isNaN(value) || (t === 'integer' && !Number.isInteger(value))) errs.push(`${path} must be a${t === 'integer' ? 'n integer' : ' number'}`)
      else {
        if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} must be ≥ ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} must be ≤ ${schema.maximum}`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${path} must be true or false`)
      break
    case 'array':
      if (!Array.isArray(value)) errs.push(`${path} must be a list`)
      else value.slice(0, 500).forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)))
      break
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errs.push(`${path} must be an object`)
        break
      }
      const obj = value as Record<string, unknown>
      for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errs.push(`${path}.${r} is required`)
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k]
        if (sub) {
          if (v !== undefined && v !== null) errs.push(...validate(sub, v, `${path}.${k}`))
        } else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not an allowed field`)
        else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`))
      }
      break
    }
  }
  return errs.slice(0, 20)
}

/** Best-effort coercion of string inputs produced by templates (e.g. "5" for a number field). */
export function coerceArgs(schema: JsonSchema, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    const v = out[k]
    if (typeof v !== 'string') continue
    if ((sub.type === 'number' || sub.type === 'integer') && v.trim() !== '' && !Number.isNaN(Number(v))) out[k] = Number(v)
    else if (sub.type === 'boolean' && (v === 'true' || v === 'false')) out[k] = v === 'true'
    else if ((sub.type === 'array' || sub.type === 'object') && /^[[{]/.test(v.trim())) {
      try {
        out[k] = JSON.parse(v)
      } catch {
        /* leave as-is; validation will report it */
      }
    }
  }
  return out
}

export function stableHash(v: unknown): string {
  const s = JSON.stringify(v, Object.keys(flatten(v)).sort())
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

function flatten(v: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    acc[k] = true
    flatten(x, acc)
  }
  return acc
}
