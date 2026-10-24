import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import {
  canSeeCollectionListing,
  checkCollectionUse,
  checkDelegation,
  getCollection,
  grantsFor,
  requireCap,
  requireCollectionPreview,
  requireCollectionUse,
  type CollectionRow,
  type GrantRow
} from '../core/authz'
import { audit } from '../core/audit'
import { notify } from '../core/notifications'
import { RelayError, forbidden, notFound, invalid } from '../core/errors'
import { CollectionSelectionSchema, type CollectionSelection, type SourceKind } from '@shared/domain'
import { PURPOSES, roleHas, type Purpose } from '@shared/permissions'
import {
  describeSource,
  detectKind,
  importIntoStorage,
  isDocumentCollection,
  readSelectedTable,
  selectedDocumentPaths,
  ENTERPRISE_ADAPTERS,
  type SourceRow
} from '../connectors/sources'
import { readDocumentText, toCsv, type Table } from '../connectors/parse'
import { runStructuredQuery, type StructuredQuery } from '../connectors/query'

// ---------------- Sources ----------------

export function listSources(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'data.administer', 'manage data sources')
  const sources = ctx.db.all<SourceRow & { created_at: string; refreshed_at: string | null; status_detail: string; owner_id: string }>(
    'SELECT * FROM sources ORDER BY created_at'
  )
  return {
    sources: sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      origin: s.origin,
      status: s.status,
      statusDetail: s.status_detail,
      createdAt: s.created_at,
      refreshedAt: s.refreshed_at,
      originalPath: j<{ originalPath?: string }>(s.config, {}).originalPath ?? null,
      items: ctx.db.all<{ rel_path: string; kind: string; status: string; detail: string; size: number }>(
        'SELECT rel_path, kind, status, detail, size FROM source_items WHERE source_id = ? ORDER BY rel_path',
        s.id
      ),
      collections: ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM collections WHERE source_id = ?', s.id)
    })),
    adapters: ENTERPRISE_ADAPTERS
  }
}

export async function addSource(ctx: AppContext, actor: Actor, input: { path: string; name?: string }) {
  requireCap(ctx, actor, 'data.administer', 'add data sources')
  const kind = detectKind(input.path)
  const id = newId('src')
  const stored = importIntoStorage(kind, input.path, join(ctx.paths.sources, id))
  const name = input.name?.trim() || input.path.split(/[\\/]/).filter(Boolean).pop() || 'Imported source'
  ctx.db.insert('sources', {
    id,
    kind,
    name,
    path: stored,
    config: js({ originalPath: input.path }),
    owner_id: actor.id,
    origin: 'local_import',
    status: 'ready',
    created_at: now(),
    refreshed_at: now()
  })
  await indexSourceItems(ctx, id)
  audit(ctx, actor, 'source.added', { type: 'source', id }, { kind, name, originalPath: input.path })
  ctx.events.emit({ type: 'data.changed' })
  return { id, kind }
}

export function getSourceRow(ctx: AppContext, id: string): SourceRow {
  const s = ctx.db.get<SourceRow>('SELECT * FROM sources WHERE id = ?', id)
  if (!s) throw notFound('Source')
  return s
}

async function indexSourceItems(ctx: AppContext, sourceId: string) {
  const src = getSourceRow(ctx, sourceId)
  try {
    const desc = await describeSource(src)
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM source_items WHERE source_id = ?', sourceId)
      for (const it of desc.items)
        ctx.db.insert('source_items', {
          id: newId('itm'),
          source_id: sourceId,
          rel_path: it.relPath,
          kind: it.kind,
          size: it.size,
          mtime: it.mtime,
          status: it.status,
          detail: it.detail
        })
    })
    ctx.db.update('sources', 'id', sourceId, { status: 'ready', status_detail: '' })
  } catch (e) {
    ctx.db.update('sources', 'id', sourceId, { status: 'error', status_detail: (e as Error).message })
  }
}

export async function describeSourceForAdmin(ctx: AppContext, actor: Actor, sourceId: string) {
  requireCap(ctx, actor, 'data.administer', 'inspect data sources')
  return describeSource(getSourceRow(ctx, sourceId))
}

export async function refreshSource(ctx: AppContext, actor: Actor, sourceId: string) {
  requireCap(ctx, actor, 'data.administer', 'refresh data sources')
  const src = getSourceRow(ctx, sourceId)
  const original = j<{ originalPath?: string }>(src.config, {}).originalPath
  if (!original || !existsSync(original))
    throw new RelayError('unavailable', 'The original file or folder is no longer available. Import a new export to refresh.')
  rmSync(join(ctx.paths.sources, sourceId), { recursive: true, force: true })
  const stored = importIntoStorage(src.kind, original, join(ctx.paths.sources, sourceId))
  ctx.db.update('sources', 'id', sourceId, { path: stored, refreshed_at: now() })
  await indexSourceItems(ctx, sourceId)
  // Data changed underneath: bump each dependent collection to a new version.
  for (const c of ctx.db.all<CollectionRow>('SELECT * FROM collections WHERE source_id = ?', sourceId)) {
    bumpCollectionVersion(ctx, actor, c, j(c.selection, CollectionSelectionSchema.parse({})), j(c.purposes, []), !!c.allow_external, 'Source refreshed')
  }
  audit(ctx, actor, 'source.refreshed', { type: 'source', id: sourceId }, {})
  ctx.events.emit({ type: 'data.changed' })
}

// ---------------- Collections ----------------

const tableCache = new Map<string, Table>()

function invalidateCollectionCaches(ctx: AppContext, collectionId: string) {
  for (const k of [...tableCache.keys()]) if (k.startsWith(collectionId + ':')) tableCache.delete(k)
  ctx.db.run('DELETE FROM doc_chunks WHERE collection_id = ?', collectionId)
  ctx.db.run('DELETE FROM doc_index_state WHERE collection_id = ?', collectionId)
}

export const CollectionInputSchema = z.object({
  sourceId: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  selection: CollectionSelectionSchema,
  purposes: z.array(z.enum(PURPOSES)).min(1),
  allowExternal: z.boolean(),
  visibility: z.enum(['discoverable', 'hidden']).default('discoverable'),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
  ownerTeamId: z.string().nullable().default(null)
})

export function collectionKind(ctx: AppContext, c: CollectionRow): 'documents' | 'table' {
  const src = getSourceRow(ctx, c.source_id)
  return isDocumentCollection(src, j(c.selection, CollectionSelectionSchema.parse({}))) ? 'documents' : 'table'
}

export function listCollections(ctx: AppContext, actor: Actor) {
  const rows = ctx.db.all<CollectionRow & { source_name: string; source_kind: string }>(
    `SELECT c.*, s.name AS source_name, s.kind AS source_kind FROM collections c JOIN sources s ON s.id = c.source_id
     WHERE c.status != 'deleted' ORDER BY c.name`
  )
  return rows
    .filter((c) => canSeeCollectionListing(ctx, actor, c))
    .map((c) => {
      const grants = grantsFor(ctx, actor, c.id)
      const myPurposes = [...new Set(grants.flatMap((g) => j<string[]>(g.purposes, [])))]
      const delegable = [...new Set(grants.filter((g) => g.can_delegate).flatMap((g) => j<string[]>(g.purposes, [])))]
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        sourceName: c.source_name,
        sourceKind: c.source_kind,
        kind: collectionKind(ctx, c),
        purposes: j<string[]>(c.purposes, []),
        myPurposes,
        delegablePurposes: roleHas(actor.role, 'data.administer') ? j<string[]>(c.purposes, []) : delegable,
        allowExternal: !!c.allow_external,
        visibility: c.visibility,
        sensitivity: c.sensitivity,
        status: c.status,
        version: c.version,
        ownerTeamId: c.owner_team_id,
        refreshedAt: c.refreshed_at,
        isSynthetic: !!c.is_synthetic,
        hasAccess: myPurposes.length > 0
      }
    })
}

export function getCollectionDetail(ctx: AppContext, actor: Actor, id: string) {
  const c = getCollection(ctx, id)
  if (!canSeeCollectionListing(ctx, actor, c)) throw notFound('Collection')
  const listing = listCollections(ctx, actor).find((x) => x.id === id)!
  const canManageGrants = roleHas(actor.role, 'data.administer') || listing.delegablePurposes.length > 0
  const grants = canManageGrants
    ? ctx.db.all<GrantRow & { principal_name: string; granted_by_name: string }>(
        `SELECT g.*, COALESCE(u.name, t.name) AS principal_name, gb.name AS granted_by_name FROM grants g
         LEFT JOIN users u ON g.principal_type = 'user' AND u.id = g.principal_id
         LEFT JOIN teams t ON g.principal_type = 'team' AND t.id = g.principal_id
         LEFT JOIN users gb ON gb.id = g.granted_by
         WHERE g.collection_id = ? ORDER BY g.created_at DESC`,
        id
      )
    : []
  const visibleGrants = roleHas(actor.role, 'data.administer')
    ? grants
    : grants.filter((g) => g.principal_id === actor.teamId || ctx.db.get('SELECT 1 FROM users WHERE id = ? AND team_id = ?', g.principal_id, actor.teamId))
  const models = ctx.db.all<{ id: string; name: string; version: number; status: string }>(
    "SELECT id, name, version, status FROM models WHERE collection_ids LIKE ? ORDER BY created_at DESC",
    `%"${id}"%`
  )
  const isAdmin = roleHas(actor.role, 'data.administer')
  return {
    ...listing,
    sourceId: c.source_id,
    selection: isAdmin || listing.hasAccess ? j<CollectionSelection>(c.selection, CollectionSelectionSchema.parse({})) : null,
    grants: visibleGrants.map((g) => ({
      id: g.id,
      principalType: g.principal_type,
      principalId: g.principal_id,
      principalName: g.principal_name,
      purposes: j<string[]>(g.purposes, []),
      canDelegate: !!g.can_delegate,
      grantedBy: g.granted_by_name,
      createdAt: g.created_at,
      revokedAt: g.revoked_at,
      canRevoke: !g.revoked_at && (isAdmin || g.granted_by === actor.id)
    })),
    versions: isAdmin
      ? ctx.db.all<{ version: number; created_at: string; note: string }>(
          'SELECT version, created_at, note FROM collection_versions WHERE collection_id = ? ORDER BY version DESC',
          id
        )
      : [],
    models,
    canManageGrants,
    isAdmin
  }
}

export function createCollection(ctx: AppContext, actor: Actor, input: z.infer<typeof CollectionInputSchema>) {
  requireCap(ctx, actor, 'data.administer', 'publish collections')
  const src = getSourceRow(ctx, input.sourceId)
  if (src.kind === 'sqlite' && !input.selection.table) throw invalid('Choose a table for a database collection.')
  const id = newId('col')
  ctx.db.tx(() => {
    ctx.db.insert('collections', {
      id,
      source_id: input.sourceId,
      name: input.name,
      description: input.description,
      owner_id: actor.id,
      owner_team_id: input.ownerTeamId,
      selection: js(input.selection),
      purposes: js(input.purposes),
      allow_external: input.allowExternal,
      visibility: input.visibility,
      sensitivity: input.sensitivity,
      status: 'published',
      version: 1,
      created_at: now(),
      refreshed_at: now()
    })
    ctx.db.insert('collection_versions', {
      id: newId('cv'),
      collection_id: id,
      version: 1,
      selection: js(input.selection),
      purposes: js(input.purposes),
      allow_external: input.allowExternal,
      created_by: actor.id,
      created_at: now(),
      note: 'Published'
    })
  })
  audit(ctx, actor, 'collection.published', { type: 'collection', id }, { name: input.name, purposes: input.purposes, allowExternal: input.allowExternal })
  ctx.events.emit({ type: 'data.changed' })
  return { id }
}

function bumpCollectionVersion(
  ctx: AppContext,
  actor: Actor,
  c: CollectionRow,
  selection: CollectionSelection,
  purposes: string[],
  allowExternal: boolean,
  note: string
) {
  const version = c.version + 1
  ctx.db.tx(() => {
    ctx.db.update('collections', 'id', c.id, {
      selection: js(selection),
      purposes: js(purposes),
      allow_external: allowExternal,
      version,
      refreshed_at: now()
    })
    ctx.db.insert('collection_versions', {
      id: newId('cv'),
      collection_id: c.id,
      version,
      selection: js(selection),
      purposes: js(purposes),
      allow_external: allowExternal,
      created_by: actor.id,
      created_at: now(),
      note
    })
  })
  invalidateCollectionCaches(ctx, c.id)
}

export function updateCollection(
  ctx: AppContext,
  actor: Actor,
  id: string,
  patch: Partial<Pick<z.infer<typeof CollectionInputSchema>, 'name' | 'description' | 'selection' | 'purposes' | 'allowExternal' | 'visibility' | 'sensitivity'>> & {
    status?: 'published' | 'retired'
  }
) {
  requireCap(ctx, actor, 'data.administer', 'edit collections')
  const c = getCollection(ctx, id)
  const before = { purposes: j<string[]>(c.purposes, []), allowExternal: !!c.allow_external }
  ctx.db.update('collections', 'id', id, {
    name: patch.name ?? c.name,
    description: patch.description ?? c.description,
    visibility: patch.visibility ?? c.visibility,
    sensitivity: patch.sensitivity ?? c.sensitivity,
    status: patch.status ?? c.status
  })
  const accessChanged = patch.selection !== undefined || patch.purposes !== undefined || patch.allowExternal !== undefined
  if (accessChanged) {
    bumpCollectionVersion(
      ctx,
      actor,
      c,
      patch.selection ?? j(c.selection, CollectionSelectionSchema.parse({})),
      patch.purposes ?? before.purposes,
      patch.allowExternal ?? before.allowExternal,
      'Edited by administrator'
    )
  }
  if ((patch.purposes && before.purposes.includes('training') && !patch.purposes.includes('training')) || patch.status === 'retired') {
    flagModelsForCollection(ctx, actor, id, patch.status === 'retired' ? 'Source collection retired' : 'Training permission removed from source collection')
  }
  if (patch.status === 'retired') invalidateCollectionCaches(ctx, id)
  audit(ctx, actor, 'collection.updated', { type: 'collection', id }, { patch, before })
  ctx.events.emit({ type: 'data.changed' })
}

/** Revocation does not untrain a model; flag affected models so a human reviews or retires them. */
function flagModelsForCollection(ctx: AppContext, actor: Actor, collectionId: string, reason: string) {
  const affected = ctx.db.all<{ id: string; name: string; version: number; created_by: string }>(
    "SELECT id, name, version, created_by FROM models WHERE collection_ids LIKE ? AND status IN ('registered','active')",
    `%"${collectionId}"%`
  )
  for (const m of affected) {
    ctx.db.update('models', 'id', m.id, { status: 'needs_review', review_reason: reason })
    audit(ctx, actor, 'model.flagged_for_review', { type: 'model', id: m.id }, { reason, collectionId })
    if (m.created_by) notify(ctx, m.created_by, `Model ${m.name} v${m.version} needs review`, reason, `models/${m.id}`, 'warning')
  }
}

// ---------------- Grants ----------------

export const GrantInputSchema = z.object({
  collectionId: z.string(),
  principalType: z.enum(['user', 'team']),
  principalId: z.string(),
  purposes: z.array(z.enum(PURPOSES)).min(1),
  canDelegate: z.boolean().default(false),
  note: z.string().max(500).default('')
})

export function grantAccess(ctx: AppContext, actor: Actor, input: z.infer<typeof GrantInputSchema>) {
  const principalExists =
    input.principalType === 'user'
      ? ctx.db.get('SELECT 1 FROM users WHERE id = ?', input.principalId)
      : ctx.db.get('SELECT 1 FROM teams WHERE id = ?', input.principalId)
  if (!principalExists) throw notFound(input.principalType === 'user' ? 'Person' : 'Team')
  const d = checkDelegation(ctx, actor, input.collectionId, { type: input.principalType, id: input.principalId }, input.purposes, input.canDelegate)
  if (!d.allowed) {
    audit(ctx, actor, 'grant.denied', { type: 'collection', id: input.collectionId }, { ...input, reason: d.reason }, 'denied')
    throw forbidden(d.reason)
  }
  const id = newId('grt')
  ctx.db.insert('grants', {
    id,
    collection_id: input.collectionId,
    principal_type: input.principalType,
    principal_id: input.principalId,
    purposes: js(input.purposes),
    can_delegate: input.canDelegate,
    granted_by: actor.id,
    created_at: now(),
    note: input.note
  })
  const c = getCollection(ctx, input.collectionId)
  audit(ctx, actor, 'grant.created', { type: 'collection', id: input.collectionId }, { grantId: id, ...input, basis: d.reason })
  const recipients =
    input.principalType === 'user'
      ? [input.principalId]
      : ctx.db.all<{ id: string }>('SELECT id FROM users WHERE team_id = ?', input.principalId).map((r) => r.id)
  for (const r of recipients) if (r !== actor.id) notify(ctx, r, `You now have access to ${c.name}`, `Purposes: ${input.purposes.join(', ')}`, `data/${c.id}`, 'success')
  ctx.events.emit({ type: 'data.changed' })
  return { id }
}

export function revokeGrant(ctx: AppContext, actor: Actor, grantId: string) {
  const g = ctx.db.get<GrantRow>('SELECT * FROM grants WHERE id = ?', grantId)
  if (!g || g.revoked_at) throw notFound('Active grant')
  const isAdmin = roleHas(actor.role, 'data.administer')
  if (!isAdmin && g.granted_by !== actor.id) throw forbidden('Only an administrator or the person who granted this access can revoke it.')
  ctx.db.update('grants', 'id', grantId, { revoked_at: now(), revoked_by: actor.id })
  invalidateCollectionCaches(ctx, g.collection_id)
  // Models trained by a principal whose training grant was revoked are flagged for review.
  if (j<string[]>(g.purposes, []).includes('training')) {
    const affectedUsers =
      g.principal_type === 'user' ? [g.principal_id] : ctx.db.all<{ id: string }>('SELECT id FROM users WHERE team_id = ?', g.principal_id).map((r) => r.id)
    const models = ctx.db.all<{ id: string; name: string; version: number; created_by: string }>(
      "SELECT id, name, version, created_by FROM models WHERE collection_ids LIKE ? AND status IN ('registered','active')",
      `%"${g.collection_id}"%`
    )
    for (const m of models.filter((m) => affectedUsers.includes(m.created_by))) {
      const creator = ctx.db.get<{ id: string; name: string; role: 'employee' | 'manager' | 'admin'; team_id: string | null }>(
        'SELECT id, name, role, team_id FROM users WHERE id = ?',
        m.created_by
      )
      const stillAllowed = creator && checkCollectionUse(ctx, { id: creator.id, name: creator.name, role: creator.role, teamId: creator.team_id }, g.collection_id, 'training').allowed
      if (!stillAllowed) {
        ctx.db.update('models', 'id', m.id, { status: 'needs_review', review_reason: 'Training access to a source collection was revoked' })
        audit(ctx, actor, 'model.flagged_for_review', { type: 'model', id: m.id }, { grantId })
      }
    }
  }
  audit(ctx, actor, 'grant.revoked', { type: 'collection', id: g.collection_id }, { grantId, principal: `${g.principal_type}:${g.principal_id}` })
  ctx.events.emit({ type: 'data.changed' })
}

// ---------------- Reads (all authorized) ----------------

async function loadTable(ctx: AppContext, c: CollectionRow): Promise<Table> {
  const key = `${c.id}:${c.version}`
  const cached = tableCache.get(key)
  if (cached) return cached
  const src = getSourceRow(ctx, c.source_id)
  const t = await readSelectedTable(src, j(c.selection, CollectionSelectionSchema.parse({})))
  tableCache.set(key, t)
  return t
}

/** Structured read for tools, profiling, and training. Purpose-checked on every call. */
export async function readCollectionTable(ctx: AppContext, actor: Actor, collectionId: string, purpose: Purpose, via: string): Promise<Table> {
  const c = requireCollectionUse(ctx, actor, collectionId, purpose, via)
  if (collectionKind(ctx, c) !== 'table') throw invalid(`“${c.name}” is a document collection; use document search instead.`)
  return loadTable(ctx, c)
}

export async function queryCollection(ctx: AppContext, actor: Actor, collectionId: string, q: StructuredQuery, via: string) {
  const t = await readCollectionTable(ctx, actor, collectionId, 'retrieval', via)
  return runStructuredQuery(t, q)
}

export async function previewCollection(ctx: AppContext, actor: Actor, id: string, limit = 50) {
  const c = requireCollectionPreview(ctx, actor, id)
  const src = getSourceRow(ctx, c.source_id)
  const sel = j<CollectionSelection>(c.selection, CollectionSelectionSchema.parse({}))
  if (isDocumentCollection(src, sel)) return previewDocs(src, sel)
  const t = await loadTable(ctx, c)
  return { kind: 'table' as const, columns: t.columns, rows: t.rows.slice(0, limit), totalRows: t.rows.length, warnings: t.warnings }
}

/** Admin-only preview of a proposed selection before it is published. */
export async function previewSelection(ctx: AppContext, actor: Actor, sourceId: string, selection: CollectionSelection, limit = 50) {
  requireCap(ctx, actor, 'data.administer', 'preview unpublished selections')
  const src = getSourceRow(ctx, sourceId)
  if (isDocumentCollection(src, selection)) return previewDocs(src, selection)
  const t = await readSelectedTable(src, selection)
  return { kind: 'table' as const, columns: t.columns, rows: t.rows.slice(0, limit), totalRows: t.rows.length, warnings: t.warnings }
}

async function previewDocs(src: SourceRow, sel: CollectionSelection) {
  const docs = selectedDocumentPaths(src, sel)
  const files = []
  for (const d of docs.slice(0, 30)) {
    try {
      const t = await readDocumentText(d.abs)
      files.push({ relPath: d.relPath, excerpt: t.text.slice(0, 600), chars: t.text.length, error: null as string | null })
    } catch (e) {
      files.push({ relPath: d.relPath, excerpt: '', chars: 0, error: (e as Error).message })
    }
  }
  return { kind: 'documents' as const, files, totalFiles: docs.length, warnings: [] as string[] }
}

function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ')
  const out: string[] = []
  for (let i = 0; i < clean.length; i += size - overlap) {
    out.push(clean.slice(i, i + size))
    if (i + size >= clean.length) break
  }
  return out
}

async function ensureDocIndex(ctx: AppContext, c: CollectionRow): Promise<string[]> {
  const state = ctx.db.get<{ version: number; warnings: string }>('SELECT version, warnings FROM doc_index_state WHERE collection_id = ?', c.id)
  if (state && state.version === c.version) return j<string[]>(state.warnings, [])
  const src = getSourceRow(ctx, c.source_id)
  const docs = selectedDocumentPaths(src, j(c.selection, CollectionSelectionSchema.parse({})))
  const warnings: string[] = []
  const chunks: { rel: string; i: number; body: string }[] = []
  for (const d of docs) {
    try {
      const t = await readDocumentText(d.abs)
      chunkText(t.text).forEach((body, i) => chunks.push({ rel: d.relPath, i, body }))
    } catch (e) {
      warnings.push(`${d.relPath}: ${(e as Error).message}`)
    }
  }
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM doc_chunks WHERE collection_id = ?', c.id)
    for (const ch of chunks) ctx.db.run('INSERT INTO doc_chunks (collection_id, version, rel_path, chunk, body) VALUES (?,?,?,?,?)', c.id, c.version, ch.rel, ch.i, ch.body)
    ctx.db.run(
      'INSERT INTO doc_index_state (collection_id, version, indexed_at, files, chunks, warnings) VALUES (?,?,?,?,?,?) ON CONFLICT(collection_id) DO UPDATE SET version=excluded.version, indexed_at=excluded.indexed_at, files=excluded.files, chunks=excluded.chunks, warnings=excluded.warnings',
      c.id,
      c.version,
      now(),
      docs.length,
      chunks.length,
      js(warnings)
    )
  })
  return warnings
}

const STOP = new Set('a an and are as at be by for from how in is it of on or that the to was what when where which who why with our we you your do does'.split(' '))

export function ftsQuery(q: string): string | null {
  const toks = (q.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((t) => !STOP.has(t)).slice(0, 12)
  if (!toks.length) return null
  return toks.map((t) => `"${t}"`).join(' OR ')
}

export interface DocHit {
  collectionId: string
  collectionName: string
  relPath: string
  snippet: string
  text: string
  score: number
}

/** Search approved document collections. Each collection is authorized for retrieval at call time. */
export async function searchDocuments(
  ctx: AppContext,
  actor: Actor,
  collectionIds: string[],
  query: string,
  limit: number,
  via: string
): Promise<{ hits: DocHit[]; warnings: string[] }> {
  const fts = ftsQuery(query)
  const warnings: string[] = []
  const hits: DocHit[] = []
  for (const id of collectionIds) {
    const c = requireCollectionUse(ctx, actor, id, 'retrieval', via)
    if (collectionKind(ctx, c) !== 'documents') {
      warnings.push(`“${c.name}” is a table; use the dataset tools to read it.`)
      continue
    }
    warnings.push(...(await ensureDocIndex(ctx, c)))
    if (!fts) continue
    const rows = ctx.db.all<{ rel_path: string; body: string; score: number; snip: string }>(
      `SELECT rel_path, body, bm25(doc_chunks) AS score, snippet(doc_chunks, 4, '«', '»', '…', 24) AS snip
       FROM doc_chunks WHERE doc_chunks MATCH ? AND collection_id = ? ORDER BY score LIMIT ?`,
      fts,
      id,
      limit
    )
    for (const r of rows) hits.push({ collectionId: id, collectionName: c.name, relPath: r.rel_path, snippet: r.snip, text: r.body, score: -r.score })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, limit), warnings }
}

export async function exportCollection(ctx: AppContext, actor: Actor, id: string, format: 'csv' | 'json') {
  const t = await readCollectionTable(ctx, actor, id, 'export', 'export')
  const c = getCollection(ctx, id)
  const file = join(ctx.paths.exports, `${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-v${c.version}-${Date.now()}.${format}`)
  await writeFile(file, format === 'csv' ? toCsv(t.columns, t.rows) : JSON.stringify(t.rows, null, 2))
  ctx.db.insert('exports', { id: newId('exp'), owner_id: actor.id, run_id: null, path: file, format, rows: t.rows.length, created_at: now() })
  audit(ctx, actor, 'collection.exported', { type: 'collection', id }, { format, rows: t.rows.length, file })
  return { path: file, rows: t.rows.length }
}

export function directory(ctx: AppContext) {
  return {
    users: ctx.db.all<{ id: string; name: string; title: string; role: string; team_id: string | null }>(
      'SELECT id, name, title, role, team_id FROM users ORDER BY name'
    ),
    teams: ctx.db.all<{ id: string; name: string; manager_id: string | null }>('SELECT * FROM teams ORDER BY name')
  }
}

export type { SourceKind }
