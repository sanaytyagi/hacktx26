import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { CollectionSelection, SourceKind } from '@shared/domain'
import { RelayError } from '../core/errors'
import { DOC_EXTS, readTableFile, unsupportedReason, type Record_, type Table, type Cell } from './parse'
import { applySelection } from './query'

export interface SourceRow {
  id: string
  kind: SourceKind
  name: string
  path: string
  config: string
  origin: string
  status: string
}

export interface SourceItem {
  relPath: string
  kind: 'document' | 'table' | 'unsupported'
  size: number
  mtime: string
  status: 'ok' | 'unsupported'
  detail: string
}

export interface SourceDescription {
  items: SourceItem[]
  tables: { name: string; columns: string[]; rowCount: number }[]
}

const MAX_IMPORT_BYTES = 500 * 1024 * 1024

/** Copy imported files into Relay's managed storage so collection versions are stable. */
export function importIntoStorage(kind: SourceKind, originalPath: string, destDir: string): string {
  if (!existsSync(originalPath)) throw new RelayError('invalid', `Path not found: ${originalPath}`)
  mkdirSync(destDir, { recursive: true })
  const st = statSync(originalPath)
  if (kind === 'folder') {
    if (!st.isDirectory()) throw new RelayError('invalid', 'Choose a folder for a folder source.')
    const target = join(destDir, 'files')
    cpSync(originalPath, target, { recursive: true, filter: (p) => !basename(p).startsWith('.') })
    return target
  }
  if (!st.isFile()) throw new RelayError('invalid', 'Choose a file.')
  if (st.size > MAX_IMPORT_BYTES) throw new RelayError('invalid', 'Files larger than 500 MB are not supported in this prototype.')
  const target = join(destDir, basename(originalPath))
  copyFileSync(originalPath, target)
  return target
}

export function detectKind(path: string): SourceKind {
  if (statSync(path).isDirectory()) return 'folder'
  const ext = extname(path).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') return 'json'
  if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') return 'sqlite'
  const reason = unsupportedReason(path)
  if (reason) throw new RelayError('invalid', reason)
  return 'file'
}

function walk(dir: string, root: string, out: SourceItem[]): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, root, out)
    else {
      const ext = extname(name).toLowerCase()
      const reason = unsupportedReason(full)
      out.push({
        relPath: relative(root, full).split(sep).join('/'),
        kind: reason ? 'unsupported' : DOC_EXTS.has(ext) ? 'document' : 'table',
        size: st.size,
        mtime: st.mtime.toISOString(),
        status: reason ? 'unsupported' : 'ok',
        detail: reason ?? ''
      })
    }
  }
}

export function openSqliteReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function sqliteTables(path: string): { name: string; columns: string[]; rowCount: number }[] {
  const db = openSqliteReadOnly(path)
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    return tables.map((t) => {
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as { name: string }[]
      const cnt = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n: number }
      return { name: t.name, columns: cols.map((c) => c.name), rowCount: Number(cnt.n) }
    })
  } finally {
    db.close()
  }
}

export async function describeSource(src: SourceRow): Promise<SourceDescription> {
  if (src.kind === 'folder') {
    const items: SourceItem[] = []
    walk(src.path, src.path, items)
    return { items, tables: [] }
  }
  const st = statSync(src.path)
  const item: SourceItem = { relPath: basename(src.path), kind: 'document', size: st.size, mtime: st.mtime.toISOString(), status: 'ok', detail: '' }
  if (src.kind === 'file') return { items: [item], tables: [] }
  if (src.kind === 'sqlite') return { items: [{ ...item, kind: 'table' }], tables: sqliteTables(src.path) }
  const t = await readTableFile(src.path)
  return { items: [{ ...item, kind: 'table' }], tables: [{ name: basename(src.path), columns: t.columns, rowCount: t.rows.length }] }
}

const SQLITE_ROW_CAP = 50_000

/**
 * Read the approved subset of a structured source. Row filters and column restrictions are
 * applied here, before any data reaches previews, tools, models, exports, or training.
 */
export async function readSelectedTable(src: SourceRow, sel: CollectionSelection): Promise<Table> {
  if (src.kind === 'sqlite') {
    const tables = sqliteTables(src.path)
    const t = tables.find((x) => x.name === sel.table)
    if (!t) throw new RelayError('invalid', `Table “${sel.table ?? ''}” was not found in the database.`)
    const db = openSqliteReadOnly(src.path)
    try {
      const rows = db.prepare(`SELECT * FROM ${quoteIdent(t.name)} LIMIT ${SQLITE_ROW_CAP + 1}`).all() as Record_[]
      const warnings = rows.length > SQLITE_ROW_CAP ? [`Only the first ${SQLITE_ROW_CAP} rows are read in this prototype.`] : []
      const normalized = rows.slice(0, SQLITE_ROW_CAP).map((r) => {
        const o: Record_ = {}
        for (const [k, v] of Object.entries(r) as [string, unknown][]) o[k] = typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? '[binary]' : (v as Cell)
        return o
      })
      return applySelection({ columns: t.columns, rows: normalized, warnings }, sel.columns, sel.filters)
    } finally {
      db.close()
    }
  }
  if (src.kind === 'csv' || src.kind === 'json') {
    return applySelection(await readTableFile(src.path), sel.columns, sel.filters)
  }
  if (src.kind === 'folder' && sel.files.length === 1 && /\.(csv|jsonl?|ndjson)$/i.test(sel.files[0])) {
    return applySelection(await readTableFile(safeJoin(src.path, sel.files[0])), sel.columns, sel.filters)
  }
  throw new RelayError('invalid', 'This collection contains documents, not a table.')
}

export function selectedDocumentPaths(src: SourceRow, sel: CollectionSelection): { relPath: string; abs: string }[] {
  if (src.kind === 'file') return [{ relPath: basename(src.path), abs: src.path }]
  if (src.kind !== 'folder') return []
  const items: SourceItem[] = []
  walk(src.path, src.path, items)
  const docs = items.filter((i) => i.kind === 'document')
  const chosen = sel.files.length ? docs.filter((d) => sel.files.some((f) => d.relPath === f || d.relPath.startsWith(f.replace(/\/?$/, '/')))) : docs
  return chosen.map((d) => ({ relPath: d.relPath, abs: safeJoin(src.path, d.relPath) }))
}

export function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(resolve(root) + sep)) throw new RelayError('forbidden', 'Path escapes the source folder.')
  return abs
}

export function isDocumentCollection(src: SourceRow, sel: CollectionSelection): boolean {
  if (src.kind === 'file') return true
  if (src.kind === 'folder') return !(sel.files.length === 1 && /\.(csv|jsonl?|ndjson)$/i.test(sel.files[0]))
  return false
}

/** Enterprise systems: adapter interface + honest catalog. None are live in this build. */
export interface EnterpriseAdapter {
  key: string
  name: string
  category: 'documents' | 'object_storage' | 'database' | 'warehouse' | 'ticketing'
  status: 'not_available'
  explanation: string
  alternative: string
}

export const ENTERPRISE_ADAPTERS: EnterpriseAdapter[] = [
  {
    key: 'sharepoint',
    name: 'SharePoint / OneDrive',
    category: 'documents',
    status: 'not_available',
    explanation: 'Live connection needs Microsoft Graph OAuth and per-user permission sync. Not connected / not available in this build.',
    alternative: 'Download the document library (or a folder) and add it as a Folder source. Relay does not keep SharePoint permissions on exported files — grant access explicitly.'
  },
  {
    key: 'gdrive',
    name: 'Google Drive',
    category: 'documents',
    status: 'not_available',
    explanation: 'Live connection needs Google OAuth and Drive permission sync. Not connected / not available in this build.',
    alternative: 'Use Google Takeout or “Download” to export files (PDF, text, CSV) and add them as a Folder source.'
  },
  {
    key: 's3',
    name: 'Object storage (S3, GCS, Azure Blob)',
    category: 'object_storage',
    status: 'not_available',
    explanation: 'Bucket access with IAM credentials is not implemented. Not connected / not available in this build.',
    alternative: 'Sync the objects you need to a local folder (e.g. aws s3 sync) and add that folder as a source.'
  },
  {
    key: 'postgres',
    name: 'Postgres',
    category: 'database',
    status: 'not_available',
    explanation: 'Live Postgres connections are not implemented. Not connected / not available in this build.',
    alternative: 'Export the approved tables to CSV (\\copy … TO … CSV HEADER) or to a SQLite file, then add it as a source. SQLite files are opened read-only.'
  },
  {
    key: 'snowflake',
    name: 'Snowflake',
    category: 'warehouse',
    status: 'not_available',
    explanation: 'Warehouse connections are not implemented. Not connected / not available in this build.',
    alternative: 'Unload query results to CSV and add them as a source.'
  },
  {
    key: 'ticketing',
    name: 'Ticketing systems (Jira, ServiceNow, Zendesk)',
    category: 'ticketing',
    status: 'not_available',
    explanation: 'No native ticketing data connector in this build. Ticket actions can be added as tools via OpenAPI import or Custom HTTP tools (Tools → Add integration).',
    alternative: 'Export tickets as CSV or JSON and add them as a source for analysis and training.'
  }
]
