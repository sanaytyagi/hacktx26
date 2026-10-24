// Resolves {{inputs.x}}, {{steps.id.output.path}}, {{item}}, {{item.path}} references in step
// arguments. A whole-string reference keeps the value's type; embedded references are
// stringified. Each resolution reports which collections the referenced data came from.
import type { Condition } from '@shared/domain'

export interface TemplateScope {
  inputs: Record<string, unknown>
  steps: Record<string, { output: unknown; taint: string[] }>
  item?: unknown
  itemTaint?: string[]
  run: { id: string; startedAt: string }
}

const REF = /\{\{\s*([a-zA-Z_][\w]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}/g
const WHOLE = /^\{\{\s*([a-zA-Z_][\w]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}$/

function getPath(root: unknown, parts: string[]): unknown {
  let cur = root
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function lookup(expr: string, scope: TemplateScope, taint: Set<string>): unknown {
  const parts = expr.replace(/\[(\d+)\]/g, '.$1').split('.')
  const [head, ...rest] = parts
  if (head === 'inputs') return getPath(scope.inputs, rest)
  if (head === 'item') {
    scope.itemTaint?.forEach((t) => taint.add(t))
    return getPath(scope.item, rest)
  }
  if (head === 'run') return getPath(scope.run, rest)
  if (head === 'now') return new Date().toISOString()
  if (head === 'steps') {
    const [stepId, ...after] = rest
    const s = scope.steps[stepId]
    if (!s) return undefined
    s.taint.forEach((t) => taint.add(t))
    return getPath(after[0] === 'output' ? s.output : s, after[0] === 'output' ? after.slice(1) : after)
  }
  return undefined
}

export function resolveValue(value: unknown, scope: TemplateScope, taint: Set<string>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE)
    if (whole) return lookup(whole[1], scope, taint)
    return value.replace(REF, (_m, expr: string) => {
      const v = lookup(expr, scope, taint)
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope, taint))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope, taint)]))
  return value
}

export function resolveArgs(args: Record<string, unknown>, scope: TemplateScope): { args: Record<string, unknown>; taint: string[] } {
  const taint = new Set<string>()
  const out = resolveValue(args, scope, taint) as Record<string, unknown>
  // Drop empty optional values produced by unresolved references.
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k]
  return { args: out, taint: [...taint] }
}

export function referencedSteps(value: unknown): string[] {
  const s = JSON.stringify(value ?? '')
  return [...s.matchAll(/\{\{\s*steps\.([a-zA-Z_]\w*)/g)].map((m) => m[1])
}

export function evaluateCondition(c: Condition, scope: TemplateScope): boolean {
  const taint = new Set<string>()
  const left = resolveValue(c.left, scope, taint)
  const right = c.right !== undefined ? resolveValue(c.right, scope, taint) : undefined
  const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0))
  switch (c.op) {
    case 'truthy':
      return truthy(left)
    case 'falsy':
      return !truthy(left)
    case 'eq':
      return String(left) === String(right)
    case 'neq':
      return String(left) !== String(right)
    case 'gt':
      return Number(left) > Number(right)
    case 'lt':
      return Number(left) < Number(right)
    case 'contains':
      return Array.isArray(left) ? left.map(String).includes(String(right)) : String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase())
  }
}
