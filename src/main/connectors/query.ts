import { z } from 'zod'
import { RowFilterSchema, type RowFilter } from '@shared/domain'
import { RelayError } from '../core/errors'
import type { Record_, Table } from './parse'

export function matches(row: Record_, f: RowFilter): boolean {
  const v = row[f.column]
  const s = v === null || v === undefined ? '' : String(v)
  switch (f.op) {
    case 'eq':
      return s === String(f.value ?? '')
    case 'neq':
      return s !== String(f.value ?? '')
    case 'in':
      return (Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',')).map((x) => x.trim()).includes(s)
    case 'not_in':
      return !(Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',')).map((x) => x.trim()).includes(s)
    case 'contains':
      return s.toLowerCase().includes(String(f.value ?? '').toLowerCase())
    case 'gte':
      return compare(v, f.value) >= 0
    case 'lte':
      return compare(v, f.value) <= 0
    case 'is_empty':
      return s === ''
    case 'not_empty':
      return s !== ''
  }
}

function compare(a: unknown, b: unknown): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== null && a !== '') return na - nb
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/** Apply a collection's approved subset: row filters first, then column projection. */
export function applySelection(table: Table, columns: string[], filters: RowFilter[]): Table {
  for (const f of filters)
    if (!table.columns.includes(f.column)) throw new RelayError('invalid', `Filter column “${f.column}” does not exist in the source.`)
  const allowed = columns.length ? table.columns.filter((c) => columns.includes(c)) : table.columns
  const rows = table.rows
    .filter((r) => filters.every((f) => matches(r, f)))
    .map((r) => Object.fromEntries(allowed.map((c) => [c, r[c] ?? null])) as Record_)
  return { columns: allowed, rows, warnings: table.warnings }
}

export const StructuredQuerySchema = z.object({
  columns: z.array(z.string()).max(100).optional(),
  filters: z.array(RowFilterSchema).max(20).default([]),
  groupBy: z.string().optional(),
  aggregate: z.object({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max']), column: z.string().optional() }).optional(),
  orderBy: z.object({ column: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }).optional(),
  limit: z.number().int().min(1).max(1000).default(50)
})
export type StructuredQuery = z.infer<typeof StructuredQuerySchema>

/** Read-only structured query over an already-authorized, already-filtered table. */
export function runStructuredQuery(table: Table, q: StructuredQuery): { columns: string[]; rows: Record_[]; matched: number } {
  const known = new Set(table.columns)
  const check = (c: string | undefined) => {
    if (c && !known.has(c)) throw new RelayError('forbidden', `Column “${c}” is not available in this collection.`)
  }
  q.columns?.forEach(check)
  q.filters.forEach((f) => check(f.column))
  check(q.groupBy)
  check(q.aggregate?.column)
  if (!q.groupBy && !q.aggregate) check(q.orderBy?.column)
  let rows = table.rows.filter((r) => q.filters.every((f) => matches(r, f)))
  const matched = rows.length
  if (q.groupBy || q.aggregate) {
    const fn = q.aggregate?.fn ?? 'count'
    const col = q.aggregate?.column
    const groups = new Map<string, Record_[]>()
    for (const r of rows) {
      const k = q.groupBy ? String(r[q.groupBy] ?? '') : '__all__'
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    const out: Record_[] = []
    for (const [k, rs] of groups) {
      const nums = col ? rs.map((r) => Number(r[col])).filter((n) => !Number.isNaN(n)) : []
      let value: number
      if (fn === 'count') value = rs.length
      else if (!nums.length) value = 0
      else if (fn === 'sum') value = nums.reduce((a, b) => a + b, 0)
      else if (fn === 'avg') value = nums.reduce((a, b) => a + b, 0) / nums.length
      else if (fn === 'min') value = Math.min(...nums)
      else value = Math.max(...nums)
      const rec: Record_ = {}
      if (q.groupBy) rec[q.groupBy] = k
      rec[col ? `${fn}_${col}` : fn] = Math.round(value * 1000) / 1000
      out.push(rec)
    }
    rows = out
  } else if (q.columns?.length) {
    rows = rows.map((r) => Object.fromEntries(q.columns!.map((c) => [c, r[c] ?? null])) as Record_)
  }
  if (q.orderBy) {
    const { column, direction } = q.orderBy
    if (rows.length && !(column in rows[0])) throw new RelayError('invalid', `Cannot sort by “${column}”; it is not in the result.`)
    rows = [...rows].sort((a, b) => (direction === 'asc' ? 1 : -1) * compare(a[column], b[column]))
  }
  const columns = rows.length ? Object.keys(rows[0]) : (q.columns ?? table.columns)
  return { columns, rows: rows.slice(0, q.limit), matched }
}
