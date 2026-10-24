// Service-layer authorization. Every IPC handler, tool call, export, and training path goes
// through these checks; hiding UI controls is only a convenience.
import type { AppContext, Actor } from './context'
import { forbidden, notFound } from './errors'
import { j } from '../db/database'
import { roleHas, type Capability, type Purpose } from '@shared/permissions'
import { audit } from './audit'

export function requireCap(ctx: AppContext, actor: Actor, cap: Capability, what?: string): void {
  if (!roleHas(actor.role, cap)) {
    audit(ctx, actor, 'authz.denied', {}, { capability: cap, what }, 'denied')
    throw forbidden(`Your role (${actor.role}) cannot ${what ?? cap}.`)
  }
}

export interface UserRow {
  id: string
  name: string
  title: string
  role: 'employee' | 'manager' | 'admin'
  team_id: string | null
}

export function getUser(ctx: AppContext, id: string): UserRow {
  const u = ctx.db.get<UserRow>('SELECT id, name, title, role, team_id FROM users WHERE id = ?', id)
  if (!u) throw notFound('User')
  return u
}

export function actorFor(ctx: AppContext, userId: string): Actor {
  const u = getUser(ctx, userId)
  return { id: u.id, name: u.name, role: u.role, teamId: u.team_id }
}

export interface CollectionRow {
  id: string
  source_id: string
  name: string
  description: string
  owner_id: string | null
  owner_team_id: string | null
  selection: string
  purposes: string
  allow_external: number
  visibility: string
  sensitivity: string
  status: string
  version: number
  created_at: string
  refreshed_at: string | null
  is_synthetic: number
}

export interface GrantRow {
  id: string
  collection_id: string
  principal_type: 'user' | 'team'
  principal_id: string
  purposes: string
  can_delegate: number
  granted_by: string | null
  created_at: string
  revoked_at: string | null
}

export function getCollection(ctx: AppContext, id: string): CollectionRow {
  const c = ctx.db.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id)
  if (!c) throw notFound('Collection')
  return c
}

/** Active grants that apply to this user directly or through their team. */
export function grantsFor(ctx: AppContext, actor: Actor, collectionId: string): GrantRow[] {
  return ctx.db.all<GrantRow>(
    `SELECT * FROM grants WHERE collection_id = ? AND revoked_at IS NULL AND
       ((principal_type = 'user' AND principal_id = ?) OR (principal_type = 'team' AND principal_id = ?))`,
    collectionId,
    actor.id,
    actor.teamId ?? '__none__'
  )
}

export interface AccessDecision {
  allowed: boolean
  reason: string
}

/**
 * Can this actor use the collection for the purpose? Requires: collection published,
 * purpose allowed on the collection, and an active grant (user or team) that includes the purpose.
 * Administrators are NOT exempt: they configure collections but must grant themselves to use them.
 */
export function checkCollectionUse(ctx: AppContext, actor: Actor, collectionId: string, purpose: Purpose): AccessDecision {
  const c = ctx.db.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', collectionId)
  if (!c) return { allowed: false, reason: 'Collection does not exist.' }
  if (c.status !== 'published') return { allowed: false, reason: `Collection “${c.name}” is ${c.status}.` }
  const allowedPurposes = j<string[]>(c.purposes, [])
  if (!allowedPurposes.includes(purpose))
    return { allowed: false, reason: `Collection “${c.name}” is not approved for ${purpose}.` }
  const grants = grantsFor(ctx, actor, collectionId)
  if (!grants.some((g) => j<string[]>(g.purposes, []).includes(purpose)))
    return { allowed: false, reason: `You do not have ${purpose} access to “${c.name}”.` }
  return { allowed: true, reason: 'Granted' }
}

export function requireCollectionUse(ctx: AppContext, actor: Actor, collectionId: string, purpose: Purpose, via: string): CollectionRow {
  const d = checkCollectionUse(ctx, actor, collectionId, purpose)
  if (!d.allowed) {
    audit(ctx, actor, 'data.access_denied', { type: 'collection', id: collectionId }, { purpose, via, reason: d.reason }, 'denied')
    throw forbidden(d.reason, { collectionId, purpose })
  }
  return getCollection(ctx, collectionId)
}

/** Administrators may inspect any collection while configuring it (audited). Others need a grant. */
export function requireCollectionPreview(ctx: AppContext, actor: Actor, collectionId: string): CollectionRow {
  if (roleHas(actor.role, 'data.administer')) {
    const c = getCollection(ctx, collectionId)
    audit(ctx, actor, 'data.admin_preview', { type: 'collection', id: collectionId }, {})
    return c
  }
  for (const p of ['retrieval', 'analysis'] as const) {
    if (checkCollectionUse(ctx, actor, collectionId, p).allowed) return getCollection(ctx, collectionId)
  }
  return requireCollectionUse(ctx, actor, collectionId, 'retrieval', 'preview')
}

/** Can the collection be listed (name/description only) for this actor? */
export function canSeeCollectionListing(ctx: AppContext, actor: Actor, c: CollectionRow): boolean {
  if (roleHas(actor.role, 'data.administer')) return true
  if (grantsFor(ctx, actor, c.id).length > 0) return true
  return c.visibility === 'discoverable' && c.status === 'published'
}

/**
 * Delegation: admins can grant anything the collection allows. Managers may grant only
 * (a) purposes they themselves hold with can_delegate, (b) to their own team or its members,
 * (c) within the purposes the collection allows. Employees cannot grant.
 */
export function checkDelegation(
  ctx: AppContext,
  actor: Actor,
  collectionId: string,
  principal: { type: 'user' | 'team'; id: string },
  purposes: Purpose[],
  canDelegate: boolean
): AccessDecision {
  const c = getCollection(ctx, collectionId)
  const allowed = j<string[]>(c.purposes, [])
  const notAllowed = purposes.filter((p) => !allowed.includes(p))
  if (notAllowed.length) return { allowed: false, reason: `Collection is not approved for: ${notAllowed.join(', ')}.` }
  if (roleHas(actor.role, 'data.administer')) return { allowed: true, reason: 'Administrator' }
  if (!roleHas(actor.role, 'data.delegate')) return { allowed: false, reason: 'Your role cannot grant data access.' }
  if (canDelegate) return { allowed: false, reason: 'Only administrators can grant re-delegation rights.' }
  const principalTeam =
    principal.type === 'team' ? principal.id : (ctx.db.get<{ team_id: string }>('SELECT team_id FROM users WHERE id = ?', principal.id)?.team_id ?? null)
  if (!actor.teamId || principalTeam !== actor.teamId) return { allowed: false, reason: 'Managers can only grant access within their own team.' }
  const delegable = new Set<string>()
  for (const g of grantsFor(ctx, actor, collectionId)) if (g.can_delegate) j<string[]>(g.purposes, []).forEach((p) => delegable.add(p))
  const missing = purposes.filter((p) => !delegable.has(p))
  if (missing.length) return { allowed: false, reason: `You are not authorized to delegate ${missing.join(', ')} access to “${c.name}”.` }
  return { allowed: true, reason: 'Delegated by manager within authority' }
}

/** Ids of users the actor may oversee (self, plus own team for managers, everyone for admins). */
export function visibleOwnerIds(ctx: AppContext, actor: Actor): string[] | 'all' {
  if (roleHas(actor.role, 'agents.manage_all')) return 'all'
  if (roleHas(actor.role, 'agents.view_team') && actor.teamId)
    return ctx.db.all<{ id: string }>('SELECT id FROM users WHERE team_id = ?', actor.teamId).map((r) => r.id)
  return [actor.id]
}

export function canSeeOwner(ctx: AppContext, actor: Actor, ownerId: string): boolean {
  const v = visibleOwnerIds(ctx, actor)
  return v === 'all' || v.includes(ownerId)
}

export function sqlIn(ids: string[]): string {
  return ids.length ? ids.map(() => '?').join(',') : "'__none__'"
}
