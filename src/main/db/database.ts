import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { MIGRATIONS } from './schema'

export type Row = Record<string, unknown>
type Param = SQLInputValue | boolean | undefined

function norm(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p))
}

/** Thin synchronous wrapper. All access happens on the main process; writes are serialized. */
export class Db {
  readonly raw: DatabaseSync
  private depth = 0

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version))
    MIGRATIONS.forEach((sql, i) => {
      if (applied.has(i + 1)) return
      this.tx(() => {
        this.raw.exec(sql)
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', i + 1, now())
      })
    })
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...norm(params)) as T[]
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...norm(params)) as T | undefined
  }
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...norm(params))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }
  insert(table: string, values: Record<string, Param>): void {
    const keys = Object.keys(values)
    this.run(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ...keys.map((k) => values[k])
    )
  }
  update(table: string, idCol: string, idVal: string, values: Record<string, Param>): number {
    const keys = Object.keys(values)
    if (!keys.length) return 0
    return this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, ...keys.map((k) => values[k]), idVal).changes
  }

  /** Run fn atomically. Nested calls use savepoints. fn must be synchronous. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const out = fn()
      this.depth--
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
      return out
    } catch (e) {
      this.depth--
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw e
    }
  }

  close(): void {
    this.raw.close()
  }
}

export function now(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function j<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

export function js(value: unknown): string {
  return JSON.stringify(value ?? null)
}
