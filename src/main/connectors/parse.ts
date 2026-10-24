import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { RelayError } from '../core/errors'

export type Cell = string | number | boolean | null
export type Record_ = Record<string, Cell>

export interface Table {
  columns: string[]
  rows: Record_[]
  warnings: string[]
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines, CRLF). */
export function parseCsv(text: string): Table {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (inQuotes) throw new RelayError('invalid', 'CSV has an unterminated quoted field.')
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (!rows.length) return { columns: [], rows: [], warnings: ['The file is empty.'] }
  const header = rows[0].map((h, i) => h.trim() || `column_${i + 1}`)
  const seen = new Map<string, number>()
  const columns = header.map((h) => {
    const n = seen.get(h) ?? 0
    seen.set(h, n + 1)
    return n ? `${h}_${n + 1}` : h
  })
  const warnings: string[] = []
  let ragged = 0
  const out = rows.slice(1).map((r) => {
    if (r.length !== columns.length) ragged++
    const rec: Record_ = {}
    columns.forEach((c, i) => (rec[c] = coerce(r[i] ?? '')))
    return rec
  })
  if (ragged) warnings.push(`${ragged} row(s) had a different number of fields than the header.`)
  return { columns, rows: out, warnings }
}

function coerce(v: string): Cell {
  const t = v.trim()
  if (t === '') return null
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16 && !/^0\d/.test(t)) return Number(t)
  return v
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n'
}

/** JSON array of objects, an object with a single array property, or JSON Lines. */
export function parseJsonTable(text: string, isJsonl: boolean): Table {
  const warnings: string[] = []
  let items: unknown[]
  if (isJsonl) {
    items = []
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return
      try {
        items.push(JSON.parse(line))
      } catch {
        warnings.push(`Line ${i + 1} is not valid JSON and was skipped.`)
      }
    })
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new RelayError('invalid', `File is not valid JSON: ${(e as Error).message}`)
    }
    if (Array.isArray(parsed)) items = parsed
    else if (parsed && typeof parsed === 'object') {
      const arr = Object.values(parsed).find(Array.isArray)
      if (!arr) throw new RelayError('invalid', 'JSON file must contain an array of records.')
      items = arr as unknown[]
      warnings.push('Used the first array property in the JSON object as the record list.')
    } else throw new RelayError('invalid', 'JSON file must contain an array of records.')
  }
  const columns: string[] = []
  const rows: Record_[] = []
  let nonObjects = 0
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      nonObjects++
      continue
    }
    const rec: Record_ = {}
    for (const [k, v] of Object.entries(it as Record<string, unknown>)) {
      if (!columns.includes(k)) columns.push(k)
      rec[k] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (v as Cell) : JSON.stringify(v)
    }
    rows.push(rec)
  }
  if (nonObjects) warnings.push(`${nonObjects} item(s) were not objects and were skipped.`)
  return { columns, rows, warnings }
}

export const DOC_EXTS = new Set(['.txt', '.md', '.markdown', '.pdf'])
export const TABLE_EXTS = new Set(['.csv', '.json', '.jsonl', '.ndjson'])

const UNSUPPORTED: Record<string, string> = {
  '.docx': 'Word documents are not supported in this build. Save as PDF or plain text and import that.',
  '.doc': 'Word documents are not supported in this build. Save as PDF or plain text and import that.',
  '.xlsx': 'Excel workbooks are not supported in this build. Export the sheet as CSV and import that.',
  '.xls': 'Excel workbooks are not supported in this build. Export the sheet as CSV and import that.',
  '.pptx': 'PowerPoint files are not supported in this build. Export as PDF and import that.',
  '.png': 'Images need OCR, which is not available in this build.',
  '.jpg': 'Images need OCR, which is not available in this build.',
  '.jpeg': 'Images need OCR, which is not available in this build.',
  '.html': 'Saved HTML pages are not supported as documents in this build. Save as PDF or text.',
  '.parquet': 'Parquet is not supported in this build. Export as CSV or JSONL.'
}

export function unsupportedReason(path: string): string | null {
  const ext = extname(path).toLowerCase()
  if (DOC_EXTS.has(ext) || TABLE_EXTS.has(ext) || ext === '.sqlite' || ext === '.db') return null
  return UNSUPPORTED[ext] ?? `Files of type “${ext || 'unknown'}” are not supported in this build.`
}

export interface DocText {
  text: string
  warnings: string[]
  pages?: number
}

export async function readDocumentText(path: string): Promise<DocText> {
  const ext = extname(path).toLowerCase()
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    const text = await readFile(path, 'utf8')
    return { text, warnings: [] }
  }
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const buf = new Uint8Array(await readFile(path))
    let pdf
    try {
      pdf = await getDocumentProxy(buf)
    } catch (e) {
      throw new RelayError('invalid', `Could not open PDF: ${(e as Error).message}`)
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: true })
    const merged = String(text)
    const warnings: string[] = []
    if (merged.replace(/\s/g, '').length < 20 * Math.max(1, totalPages)) {
      throw new RelayError(
        'invalid',
        'This PDF has little or no text layer (it looks scanned). OCR is required to read it and is not available in this build.'
      )
    }
    return { text: merged, warnings, pages: totalPages }
  }
  throw new RelayError('invalid', unsupportedReason(path) ?? 'Unsupported file type.')
}

export async function readTableFile(path: string): Promise<Table> {
  const ext = extname(path).toLowerCase()
  const text = await readFile(path, 'utf8')
  if (ext === '.csv') return parseCsv(text)
  if (ext === '.json') return parseJsonTable(text, false)
  if (ext === '.jsonl' || ext === '.ndjson') return parseJsonTable(text, true)
  throw new RelayError('invalid', unsupportedReason(path) ?? 'Unsupported table file.')
}
