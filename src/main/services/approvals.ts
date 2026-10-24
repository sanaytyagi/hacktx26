import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { audit } from '../core/audit'
import { notify } from '../core/notifications'
import { RelayError, forbidden, notFound } from '../core/errors'
import { getPolicy } from '../core/settings'
import { checkDelegation, getCollection } from '../core/authz'
import { roleHas, PURPOSES } from '@shared/permissions'
import { budgetLabel, type BudgetRow } from './budget'

export const APPROVAL_TYPES = ['deployment', 'data_access', 'tool_access', 'budget_increase', 'training_job', 'improvement'] as const
export type ApprovalType = (typeof APPROVAL_TYPES)[number]

export interface ApprovalRow {
  id: string
  type: ApprovalType
  title: string
  reason: string
  requester_id: string
  team_id: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  payload: string
  target_type: string | null
  target_id: string | null
  decided_by: string | null
  decided_at: string | null
  decision_comment: string | null
  created_at: string
  is_fixture: number
}

interface Handler {
  /** Extra authority check for managers. Return a reason string when they cannot decide. */
  managerLimit?: (ctx: AppContext, actor: Actor, a: ApprovalRow) => string | null
  apply: (ctx: AppContext, approver: Actor, a: ApprovalRow) => void | Promise<void>
  onReject?: (ctx: AppContext, approver: Actor, a: ApprovalRow) => void
  adminOnly?: boolean
}

const handlers = new Map<ApprovalType, Handler>()

export function registerApprovalHandler(type: ApprovalType, h: Handler) {
  handlers.set(type, h)
}

export function createApproval(
  ctx: AppContext,
  actor: Actor,
  input: { type: ApprovalType; title: string; reason: string; payload: Record<string, unknown>; targetType?: string; targetId?: string }
) {
  const dup = ctx.db.get<{ id: string }>(
    "SELECT id FROM approvals WHERE type = ? AND requester_id = ? AND status = 'pending' AND payload = ?",
    input.type,
    actor.id,
    js(input.payload)
  )
  if (dup) throw new RelayError('conflict', 'You already have a pending request for this.')
  const id = newId('apr')
  ctx.db.insert('approvals', {
    id,
    type: input.type,
    title: input.title,
    reason: input.reason,
    requester_id: actor.id,
    team_id: actor.teamId,
    status: 'pending',
    payload: js(input.payload),
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    created_at: now()
  })
  const approvers = new Set<string>(ctx.db.all<{ id: string }>("SELECT id FROM users WHERE role = 'admin'").map((r) => r.id))
  const mgr = actor.teamId ? ctx.db.get<{ manager_id: string }>('SELECT manager_id FROM teams WHERE id = ?', actor.teamId)?.manager_id : null
  if (mgr && !handlers.get(input.type)?.adminOnly) approvers.add(mgr)
  approvers.delete(actor.id)
  for (const u of approvers) notify(ctx, u, `Needs your review: ${input.title}`, `Requested by ${actor.name}. ${input.reason}`.slice(0, 300), `approvals/${id}`, 'info')
  audit(ctx, actor, 'approval.requested', { type: 'approval', id }, { type: input.type, title: input.title, payload: input.payload })
  ctx.events.emit({ type: 'approvals.changed' })
  return { id }
}

export function canDecide(ctx: AppContext, actor: Actor, a: ApprovalRow): { allowed: boolean; reason: string } {
  if (a.status !== 'pending') return { allowed: false, reason: `Already ${a.status}.` }
  if (a.requester_id === actor.id) return { allowed: false, reason: 'You cannot approve your own request.' }
  if (roleHas(actor.role, 'approvals.decide_all')) return { allowed: true, reason: 'Administrator' }
  if (!roleHas(actor.role, 'approvals.decide_team')) return { allowed: false, reason: 'Your role cannot approve requests.' }
  const h = handlers.get(a.type)
  if (h?.adminOnly) return { allowed: false, reason: 'Only an administrator can approve this kind of request.' }
  if (!actor.teamId || a.team_id !== actor.teamId) return { allowed: false, reason: 'This request is from another team.' }
  const limit = h?.managerLimit?.(ctx, actor, a)
  if (limit) return { allowed: false, reason: limit }
  return { allowed: true, reason: 'Team manager within delegated authority' }
}

export function listApprovals(ctx: AppContext, actor: Actor) {
  const rows = ctx.db.all<ApprovalRow & { requester_name: string; decider_name: string | null }>(
    `SELECT a.*, u.name AS requester_name, d.name AS decider_name FROM approvals a JOIN users u ON u.id = a.requester_id
     LEFT JOIN users d ON d.id = a.decided_by ORDER BY a.status = 'pending' DESC, a.created_at DESC`
  )
  const visible = rows.filter(
    (a) => a.requester_id === actor.id || roleHas(actor.role, 'approvals.decide_all') || (roleHas(actor.role, 'approvals.decide_team') && a.team_id === actor.teamId)
  )
  return visible.map((a) => {
    const d = canDecide(ctx, actor, a)
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      reason: a.reason,
      requesterId: a.requester_id,
      requesterName: a.requester_name,
      status: a.status,
      payload: j<Record<string, unknown>>(a.payload, {}),
      targetType: a.target_type,
      targetId: a.target_id,
      decidedBy: a.decider_name,
      decidedAt: a.decided_at,
      decisionComment: a.decision_comment,
      createdAt: a.created_at,
      isFixture: !!a.is_fixture,
      mine: a.requester_id === actor.id,
      canDecide: d.allowed,
      cannotDecideReason: d.allowed ? null : d.reason,
      comments: ctx.db.all<{ id: string; author: string; body: string; created_at: string }>(
        'SELECT c.id, u.name AS author, c.body, c.created_at FROM approval_comments c JOIN users u ON u.id = c.author_id WHERE approval_id = ? ORDER BY c.created_at',
        a.id
      )
    }
  })
}

export async function decide(ctx: AppContext, actor: Actor, id: string, decision: 'approve' | 'reject', comment = '') {
  const a = ctx.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)
  if (!a) throw notFound('Request')
  const d = canDecide(ctx, actor, a)
  if (!d.allowed) {
    audit(ctx, actor, 'approval.decision_denied', { type: 'approval', id }, { reason: d.reason }, 'denied')
    throw forbidden(d.reason)
  }
  if (decision === 'reject' && !comment.trim()) throw new RelayError('invalid', 'Add a short reason when rejecting so the requester knows what to change.')
  const h = handlers.get(a.type)
  if (decision === 'approve') {
    if (!h) throw new RelayError('unavailable', `No handler for ${a.type} requests.`)
    await h.apply(ctx, actor, a) // throws if the approver lacks authority (e.g. delegation limits)
  } else h?.onReject?.(ctx, actor, a)
  ctx.db.update('approvals', 'id', id, { status: decision === 'approve' ? 'approved' : 'rejected', decided_by: actor.id, decided_at: now(), decision_comment: comment })
  notify(ctx, a.requester_id, `${decision === 'approve' ? 'Approved' : 'Not approved'}: ${a.title}`, comment ? `${actor.name}: ${comment}` : `Decided by ${actor.name}.`, `approvals/${id}`, decision === 'approve' ? 'success' : 'warning')
  audit(ctx, actor, `approval.${decision === 'approve' ? 'approved' : 'rejected'}`, { type: 'approval', id }, { type: a.type, comment, basis: d.reason })
  const { emitWebhook } = await import('./webhooks')
  emitWebhook(ctx, 'approval.decided', { approvalId: id, type: a.type, decision })
  ctx.events.emit({ type: 'approvals.changed' })
}

export function cancelRequest(ctx: AppContext, actor: Actor, id: string) {
  const a = ctx.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)
  if (!a) throw notFound('Request')
  if (a.requester_id !== actor.id) throw forbidden('Only the requester can withdraw a request.')
  if (a.status !== 'pending') throw new RelayError('conflict', 'Only pending requests can be withdrawn.')
  handlers.get(a.type)?.onReject?.(ctx, actor, a)
  ctx.db.update('approvals', 'id', id, { status: 'cancelled', decided_at: now() })
  audit(ctx, actor, 'approval.withdrawn', { type: 'approval', id }, {})
  ctx.events.emit({ type: 'approvals.changed' })
}

export function addComment(ctx: AppContext, actor: Actor, id: string, body: string) {
  const a = ctx.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)
  if (!a) throw notFound('Request')
  const visible = a.requester_id === actor.id || roleHas(actor.role, 'approvals.decide_all') || (roleHas(actor.role, 'approvals.decide_team') && a.team_id === actor.teamId)
  if (!visible) throw notFound('Request')
  ctx.db.insert('approval_comments', { id: newId('cmt'), approval_id: id, author_id: actor.id, body: body.slice(0, 2000), created_at: now() })
  if (a.requester_id !== actor.id) notify(ctx, a.requester_id, `New comment on: ${a.title}`, `${actor.name}: ${body}`.slice(0, 300), `approvals/${id}`)
  ctx.events.emit({ type: 'approvals.changed' })
}

// ---------------- Request helpers used by employees ----------------

export const DataAccessRequestSchema = z.object({ collectionId: z.string(), purposes: z.array(z.enum(PURPOSES)).min(1), reason: z.string().min(3).max(1000) })

export function requestDataAccess(ctx: AppContext, actor: Actor, input: z.infer<typeof DataAccessRequestSchema>) {
  const c = getCollection(ctx, input.collectionId)
  if (c.visibility === 'hidden' && !roleHas(actor.role, 'data.administer')) throw notFound('Collection')
  return createApproval(ctx, actor, {
    type: 'data_access',
    title: `Data access: ${c.name} (${input.purposes.join(', ')})`,
    reason: input.reason,
    payload: { collectionId: c.id, purposes: input.purposes, principalType: 'user', principalId: actor.id },
    targetType: 'collection',
    targetId: c.id
  })
}

/** Registers the built-in approval handlers that do not depend on later services. */
export function registerCoreApprovalHandlers() {
  registerApprovalHandler('data_access', {
    managerLimit: (ctx, actor, a) => {
      const p = j<{ collectionId: string; purposes: (typeof PURPOSES)[number][]; principalType: 'user' | 'team'; principalId: string }>(a.payload, {} as never)
      const d = checkDelegation(ctx, actor, p.collectionId, { type: p.principalType, id: p.principalId }, p.purposes, false)
      return d.allowed ? null : `${d.reason} An administrator must decide this request.`
    },
    apply: async (ctx, approver, a) => {
      const p = j<{ collectionId: string; purposes: (typeof PURPOSES)[number][]; principalType: 'user' | 'team'; principalId: string }>(a.payload, {} as never)
      const { grantAccess } = await import('./data')
      grantAccess(ctx, approver, { collectionId: p.collectionId, principalType: p.principalType, principalId: p.principalId, purposes: p.purposes, canDelegate: false, note: `Approved request ${a.id}` })
    }
  })
  registerApprovalHandler('tool_access', {
    adminOnly: true,
    apply: async (ctx, approver, a) => {
      const p = j<{ toolKey: string }>(a.payload, { toolKey: '' })
      const { grantTool } = await import('../tools/registry')
      grantTool(ctx, approver, { toolKey: p.toolKey, principalType: 'user', principalId: a.requester_id }, true)
    }
  })
  registerApprovalHandler('budget_increase', {
    managerLimit: (ctx, actor, a) => {
      const p = j<{ budgetId: string; newLimitUsd: number }>(a.payload, { budgetId: '', newLimitUsd: 0 })
      const b = ctx.db.get<{ scope: string; scope_id: string; limit_usd: number }>('SELECT scope, scope_id, limit_usd FROM budgets WHERE id = ?', p.budgetId)
      if (!b) return 'Budget no longer exists.'
      const ceiling = getPolicy(ctx).managerApprovalCeilingUsd
      if (b.scope !== 'agent') return 'Only administrators can change team or workspace budgets.'
      const team = ctx.db.get<{ team_id: string }>('SELECT team_id FROM agents WHERE id = ?', b.scope_id)?.team_id
      if (team !== actor.teamId) return 'This agent is not on your team.'
      if (p.newLimitUsd > ceiling) return `Above your approval ceiling of $${ceiling}. An administrator must decide.`
      return null
    },
    apply: async (ctx, approver, a) => {
      const p = j<{ budgetId: string; newLimitUsd: number }>(a.payload, { budgetId: '', newLimitUsd: 0 })
      const b = ctx.db.get<{ scope: 'workspace' | 'team' | 'agent' | 'job'; scope_id: string; kind: 'operating' | 'training'; alert_pct: number; hard_limit: number }>('SELECT * FROM budgets WHERE id = ?', p.budgetId)
      if (!b) throw notFound('Budget')
      const { upsertBudget } = await import('./budget')
      upsertBudget(ctx, approver, { scope: b.scope, scopeId: b.scope_id, kind: b.kind, limitUsd: p.newLimitUsd, alertPct: b.alert_pct, hardLimit: !!b.hard_limit }, true)
    }
  })
  registerApprovalHandler('deployment', {
    apply: async (ctx, approver, a) => {
      const p = j<{ agentId: string; versionId: string; mode: string }>(a.payload, { agentId: '', versionId: '', mode: 'team' })
      const { applyDeployment } = await import('./agents')
      applyDeployment(ctx, approver, p.agentId, p.versionId, p.mode)
    },
    onReject: (ctx, _approver, a) => {
      const p = j<{ agentId: string }>(a.payload, { agentId: '' })
      const agent = ctx.db.get<{ status: string; live_version_id: string | null }>('SELECT status, live_version_id FROM agents WHERE id = ?', p.agentId)
      if (agent?.status === 'awaiting_approval') ctx.db.update('agents', 'id', p.agentId, { status: agent.live_version_id ? 'live' : 'tested', updated_at: now() })
    }
  })
}

export function requestBudgetIncrease(ctx: AppContext, actor: Actor, input: { budgetId: string; newLimitUsd: number; reason: string }) {
  const b = ctx.db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ?', input.budgetId)
  if (!b) throw notFound('Budget')
  if (input.newLimitUsd <= b.limit_usd) throw new RelayError('invalid', 'The new limit must be higher than the current limit.')
  const label = budgetLabel(ctx, b as BudgetRow)
  return createApproval(ctx, actor, {
    type: 'budget_increase',
    title: `${label}: $${b.limit_usd.toFixed(2)} → $${input.newLimitUsd.toFixed(2)}`,
    reason: input.reason,
    payload: { budgetId: b.id, currentLimitUsd: b.limit_usd, newLimitUsd: input.newLimitUsd },
    targetType: 'budget',
    targetId: b.id
  })
}

export function requestToolAccess(ctx: AppContext, actor: Actor, input: { toolKey: string; reason: string }) {
  const t = ctx.db.get<{ declaration: string }>('SELECT declaration FROM tools WHERE key = ?', input.toolKey)
  if (!t) throw notFound('Tool')
  const d = j<{ name: string; access: string }>(t.declaration, { name: input.toolKey, access: 'read' })
  return createApproval(ctx, actor, {
    type: 'tool_access',
    title: `Tool access: ${d.name} (${d.access})`,
    reason: input.reason,
    payload: { toolKey: input.toolKey },
    targetType: 'tool',
    targetId: input.toolKey
  })
}
