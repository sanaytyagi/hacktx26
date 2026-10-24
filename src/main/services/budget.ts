// Centralized transactional ledger. Paid operations reserve their estimated cost before they
// start (atomically checking every applicable hard limit), then reconcile to metered usage.
// Estimates cannot cap a provider invoice exactly: an in-flight call may already be billed.
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now } from '../db/database'
import { RelayError, forbidden, notFound } from '../core/errors'
import { requireCap, sqlIn } from '../core/authz'
import { audit } from '../core/audit'
import { notify } from '../core/notifications'
import { getPolicy, getSetting, setSetting } from '../core/settings'
import { roleHas } from '@shared/permissions'
import type { BudgetKind } from '@shared/domain'

export interface PriceRow {
  id: string
  provider_kind: string
  model: string
  unit: 'per_1m_tokens' | 'per_call' | 'per_hour'
  input_price: number | null
  output_price: number | null
  call_price: number | null
  currency: string
  source: string
  effective_date: string
  notes: string
}

export const PriceInputSchema = z.object({
  id: z.string().optional(),
  providerKind: z.string().min(1),
  model: z.string().min(1),
  unit: z.enum(['per_1m_tokens', 'per_call', 'per_hour']),
  inputPrice: z.number().min(0).nullable(),
  outputPrice: z.number().min(0).nullable(),
  callPrice: z.number().min(0).nullable(),
  currency: z.literal('USD'),
  source: z.string().min(1).max(500),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(1000).default('')
})

export function listPrices(ctx: AppContext) {
  return ctx.db.all<PriceRow>('SELECT * FROM prices ORDER BY provider_kind, model')
}

export function upsertPrice(ctx: AppContext, actor: Actor, input: z.infer<typeof PriceInputSchema>) {
  requireCap(ctx, actor, 'pricing.edit', 'edit prices')
  const id = input.id ?? newId('prc')
  ctx.db.run(
    `INSERT INTO prices (id, provider_kind, model, unit, input_price, output_price, call_price, currency, source, effective_date, notes, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_kind=excluded.provider_kind, model=excluded.model, unit=excluded.unit,
     input_price=excluded.input_price, output_price=excluded.output_price, call_price=excluded.call_price, source=excluded.source,
     effective_date=excluded.effective_date, notes=excluded.notes, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    id,
    input.providerKind,
    input.model,
    input.unit,
    input.inputPrice,
    input.outputPrice,
    input.callPrice,
    input.currency,
    input.source,
    input.effectiveDate,
    input.notes,
    actor.id,
    now()
  )
  audit(ctx, actor, 'price.updated', { type: 'price', id }, input)
  return { id }
}

export function findPrice(ctx: AppContext, providerKind: string, model: string): PriceRow | null {
  return ctx.db.get<PriceRow>('SELECT * FROM prices WHERE provider_kind = ? AND model = ? ORDER BY effective_date DESC LIMIT 1', providerKind, model) ?? null
}

/** Price a token-metered call. Returns null when no price is configured (never treated as free). */
export function priceTokens(p: PriceRow | null, inputTokens: number, outputTokens: number): number | null {
  if (!p || p.unit !== 'per_1m_tokens' || p.input_price === null || p.output_price === null) return null
  return (inputTokens * p.input_price + outputTokens * p.output_price) / 1_000_000
}

export function requirePrice(ctx: AppContext, providerKind: string, model: string): PriceRow | null {
  const p = findPrice(ctx, providerKind, model)
  if (!p && !getPolicy(ctx).allowUnknownPricing)
    throw new RelayError(
      'budget',
      `No price is configured for ${providerKind} / ${model}. Unknown pricing is not treated as free — an administrator can add it in Budget → Prices.`,
      { providerKind, model }
    )
  return p
}

// ---------------- Budgets ----------------

export interface BudgetRow {
  id: string
  scope: 'workspace' | 'team' | 'agent' | 'job'
  scope_id: string
  kind: BudgetKind
  period: string
  limit_usd: number
  alert_pct: number
  hard_limit: number
}

export interface Attribution {
  kind: BudgetKind
  teamId?: string | null
  agentId?: string | null
  jobId?: string | null
  runId?: string | null
  userId?: string | null
  model?: string | null
  project?: string | null
}

function periodStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

function applicable(ctx: AppContext, a: Attribution): BudgetRow[] {
  const conds: string[] = ["(scope = 'workspace' AND scope_id = 'ws')"]
  const params: string[] = []
  if (a.teamId) {
    conds.push("(scope = 'team' AND scope_id = ?)")
    params.push(a.teamId)
  }
  if (a.agentId) {
    conds.push("(scope = 'agent' AND scope_id = ?)")
    params.push(a.agentId)
  }
  if (a.jobId) {
    conds.push("(scope = 'job' AND scope_id = ?)")
    params.push(a.jobId)
  }
  return ctx.db.all<BudgetRow>(`SELECT * FROM budgets WHERE kind = ? AND (${conds.join(' OR ')})`, a.kind, ...params)
}

function scopeColumn(scope: BudgetRow['scope']): string | null {
  return scope === 'team' ? 'team_id' : scope === 'agent' ? 'agent_id' : scope === 'job' ? 'job_id' : null
}

/** Spend in the current period: final charges plus open reservations. */
export function budgetUsage(ctx: AppContext, b: BudgetRow): { charged: number; reserved: number; estimatedCharged: number } {
  const col = scopeColumn(b.scope)
  const where = `kind = ? AND created_at >= ? ${col ? `AND ${col} = ?` : ''}`
  const params: string[] = [b.kind, b.period === 'monthly' ? periodStart() : '1970-01-01']
  if (col) params.push(b.scope_id)
  const charged = ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(amount_usd),0) s FROM ledger WHERE entry_type='charge' AND status='final' AND ${where}`, ...params)!.s
  const estimatedCharged = ctx.db.get<{ s: number }>(
    `SELECT COALESCE(SUM(amount_usd),0) s FROM ledger WHERE entry_type='charge' AND status='final' AND basis='estimate' AND ${where}`,
    ...params
  )!.s
  const reserved = ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(amount_usd),0) s FROM ledger WHERE entry_type='reservation' AND status='open' AND ${where}`, ...params)!.s
  return { charged, reserved, estimatedCharged }
}

/**
 * Atomically reserve estimated spend against every applicable budget. Throws when any hard
 * limit would be exceeded, so concurrent operations cannot jointly overspend the estimate.
 */
export function reserve(ctx: AppContext, a: Attribution, amountUsd: number, description: string): string {
  const amount = Math.max(0, amountUsd)
  return ctx.db.tx(() => {
    for (const b of applicable(ctx, a)) {
      const u = budgetUsage(ctx, b)
      const after = u.charged + u.reserved + amount
      if (b.hard_limit && after > b.limit_usd + 1e-9) {
        const label = budgetLabel(ctx, b)
        throw new RelayError(
          'budget',
          `${label} would be exceeded: $${(u.charged + u.reserved).toFixed(4)} used or reserved of $${b.limit_usd.toFixed(2)}, this step needs about $${amount.toFixed(4)}.`,
          { budgetId: b.id, scope: b.scope, limit: b.limit_usd, used: u.charged, reserved: u.reserved, requested: amount }
        )
      }
      maybeAlert(ctx, b, after)
    }
    const id = newId('led')
    ctx.db.insert('ledger', {
      id,
      kind: a.kind,
      entry_type: 'reservation',
      status: 'open',
      amount_usd: amount,
      basis: 'estimate',
      team_id: a.teamId,
      agent_id: a.agentId,
      job_id: a.jobId,
      run_id: a.runId,
      model: a.model,
      project: a.project,
      user_id: a.userId,
      description,
      created_at: now(),
      updated_at: now()
    })
    return id
  })
}

/** Close a reservation and record the actual charge (which may exceed the estimate). */
export function reconcile(ctx: AppContext, reservationId: string, actualUsd: number, basis: 'metered' | 'provider_reported' | 'estimate', note = '') {
  ctx.db.tx(() => {
    const r = ctx.db.get<Record<string, string | number | null>>('SELECT * FROM ledger WHERE id = ?', reservationId)
    if (!r || r.status !== 'open') return
    ctx.db.update('ledger', 'id', reservationId, { status: 'reconciled', updated_at: now() })
    ctx.db.insert('ledger', {
      id: newId('led'),
      kind: r.kind as string,
      entry_type: 'charge',
      status: 'final',
      amount_usd: Math.max(0, actualUsd),
      basis,
      team_id: r.team_id as string | null,
      agent_id: r.agent_id as string | null,
      job_id: r.job_id as string | null,
      run_id: r.run_id as string | null,
      model: r.model as string | null,
      project: r.project as string | null,
      user_id: r.user_id as string | null,
      description: note || (r.description as string),
      reservation_id: reservationId,
      created_at: now(),
      updated_at: now()
    })
  })
}

/** Release a reservation when the call never reached the provider. */
export function release(ctx: AppContext, reservationId: string) {
  ctx.db.run("UPDATE ledger SET status = 'released', updated_at = ? WHERE id = ? AND status = 'open'", now(), reservationId)
}

function budgetLabel(ctx: AppContext, b: BudgetRow): string {
  const kind = b.kind === 'operating' ? 'operating' : 'training'
  if (b.scope === 'workspace') return `Workspace ${kind} budget`
  if (b.scope === 'team') return `${ctx.db.get<{ name: string }>('SELECT name FROM teams WHERE id = ?', b.scope_id)?.name ?? 'Team'} ${kind} budget`
  if (b.scope === 'agent') return `${kind[0].toUpperCase()}${kind.slice(1)} budget for “${ctx.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', b.scope_id)?.name ?? b.scope_id}”`
  return `${kind[0].toUpperCase()}${kind.slice(1)} budget for this job`
}

function maybeAlert(ctx: AppContext, b: BudgetRow, projected: number) {
  if (projected < (b.limit_usd * b.alert_pct) / 100) return
  const key = `budget_alert:${b.id}:${periodStart().slice(0, 7)}`
  if (getSetting(ctx, key, false)) return
  setSetting(ctx, key, true)
  const recipients = new Set<string>(ctx.db.all<{ id: string }>("SELECT id FROM users WHERE role = 'admin'").map((r) => r.id))
  if (b.scope === 'team') {
    const mgr = ctx.db.get<{ manager_id: string }>('SELECT manager_id FROM teams WHERE id = ?', b.scope_id)
    if (mgr?.manager_id) recipients.add(mgr.manager_id)
  }
  if (b.scope === 'agent') {
    const owner = ctx.db.get<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = ?', b.scope_id)
    if (owner) recipients.add(owner.owner_id)
  }
  for (const r of recipients) notify(ctx, r, `${budgetLabel(ctx, b)} reached ${b.alert_pct}%`, `Limit $${b.limit_usd.toFixed(2)} this month.`, 'budget', 'warning')
}

export function recordUsage(
  ctx: AppContext,
  u: { runId?: string | null; jobId?: string | null; provider: string; model: string; inputTokens?: number; outputTokens?: number; calls?: number; costUsd: number | null; basis: string; priceId?: string | null }
) {
  ctx.db.insert('usage', {
    id: newId('use'),
    run_id: u.runId ?? null,
    job_id: u.jobId ?? null,
    provider: u.provider,
    model: u.model,
    input_tokens: u.inputTokens ?? null,
    output_tokens: u.outputTokens ?? null,
    calls: u.calls ?? 1,
    cost_usd: u.costUsd,
    basis: u.basis,
    price_id: u.priceId ?? null,
    created_at: now()
  })
}

// ---------------- Management & reporting ----------------

export const BudgetInputSchema = z.object({
  scope: z.enum(['workspace', 'team', 'agent', 'job']),
  scopeId: z.string(),
  kind: z.enum(['operating', 'training']),
  limitUsd: z.number().min(0).max(1_000_000),
  alertPct: z.number().int().min(1).max(100).default(80),
  hardLimit: z.boolean().default(true)
})

/** Admins edit any budget. Managers may set agent budgets for their team within the approval ceiling. */
export function upsertBudget(ctx: AppContext, actor: Actor, input: z.infer<typeof BudgetInputSchema>, viaApproval = false) {
  if (!viaApproval && !roleHas(actor.role, 'budgets.edit')) {
    const policy = getPolicy(ctx)
    const agentTeam = input.scope === 'agent' ? ctx.db.get<{ team_id: string }>('SELECT team_id FROM agents WHERE id = ?', input.scopeId)?.team_id : null
    if (!(actor.role === 'manager' && input.scope === 'agent' && agentTeam === actor.teamId && input.limitUsd <= policy.managerApprovalCeilingUsd))
      throw forbidden(`Managers can set budgets only for their team's agents, up to $${policy.managerApprovalCeilingUsd}. Larger changes need an administrator.`)
  }
  const existing = ctx.db.get<BudgetRow>('SELECT * FROM budgets WHERE scope = ? AND scope_id = ? AND kind = ?', input.scope, input.scopeId, input.kind)
  if (existing) ctx.db.update('budgets', 'id', existing.id, { limit_usd: input.limitUsd, alert_pct: input.alertPct, hard_limit: input.hardLimit, updated_at: now() })
  else
    ctx.db.insert('budgets', {
      id: newId('bud'),
      scope: input.scope,
      scope_id: input.scopeId,
      kind: input.kind,
      period: 'monthly',
      limit_usd: input.limitUsd,
      alert_pct: input.alertPct,
      hard_limit: input.hardLimit,
      created_at: now(),
      updated_at: now()
    })
  audit(ctx, actor, 'budget.updated', { type: 'budget', id: existing?.id ?? `${input.scope}:${input.scopeId}` }, { ...input, before: existing?.limit_usd ?? null, viaApproval })
}

export function budgetOverview(ctx: AppContext, actor: Actor) {
  const all = roleHas(actor.role, 'budgets.view_all')
  const team = roleHas(actor.role, 'budgets.view_team')
  const myAgentIds = ctx.db.all<{ id: string }>('SELECT id FROM agents WHERE owner_id = ?', actor.id).map((r) => r.id)
  const teamAgentIds = actor.teamId ? ctx.db.all<{ id: string }>('SELECT id FROM agents WHERE team_id = ?', actor.teamId).map((r) => r.id) : []
  const budgets = ctx.db.all<BudgetRow>('SELECT * FROM budgets ORDER BY scope, kind').filter((b) => {
    if (all) return true
    if (b.scope === 'workspace') return team
    if (b.scope === 'team') return b.scope_id === actor.teamId
    if (b.scope === 'agent') return myAgentIds.includes(b.scope_id) || (team && teamAgentIds.includes(b.scope_id))
    return team
  })
  const rows = budgets.map((b) => {
    const u = budgetUsage(ctx, b)
    return {
      id: b.id,
      scope: b.scope,
      scopeId: b.scope_id,
      label: budgetLabel(ctx, b),
      kind: b.kind,
      limitUsd: b.limit_usd,
      alertPct: b.alert_pct,
      hardLimit: !!b.hard_limit,
      chargedUsd: u.charged,
      estimatedChargedUsd: u.estimatedCharged,
      reservedUsd: u.reserved,
      remainingUsd: Math.max(0, b.limit_usd - u.charged - u.reserved),
      pct: b.limit_usd ? ((u.charged + u.reserved) / b.limit_usd) * 100 : 0,
      canEdit: roleHas(actor.role, 'budgets.edit') || (actor.role === 'manager' && b.scope === 'agent' && teamAgentIds.includes(b.scope_id))
    }
  })
  // Attribution (scoped like the budgets above).
  const agentScope = all ? null : team ? teamAgentIds : myAgentIds
  const scopeSql = agentScope ? `AND l.agent_id IN (${sqlIn(agentScope)})` : ''
  const byAgent = ctx.db.all<{ agent_id: string; name: string; total: number; metered: number; estimate: number }>(
    `SELECT l.agent_id, a.name, SUM(l.amount_usd) total, SUM(CASE WHEN basis IN ('metered','provider_reported') THEN amount_usd ELSE 0 END) metered,
            SUM(CASE WHEN basis = 'estimate' THEN amount_usd ELSE 0 END) estimate
     FROM ledger l JOIN agents a ON a.id = l.agent_id WHERE l.entry_type='charge' AND l.created_at >= ? ${scopeSql} GROUP BY l.agent_id ORDER BY total DESC`,
    periodStart(),
    ...(agentScope ?? [])
  )
  const byModel = ctx.db.all<{ model: string; total: number }>(
    `SELECT COALESCE(l.model,'(tool)') model, SUM(l.amount_usd) total FROM ledger l WHERE l.entry_type='charge' AND l.created_at >= ? ${scopeSql} GROUP BY l.model ORDER BY total DESC`,
    periodStart(),
    ...(agentScope ?? [])
  )
  const byTeam = all || team
    ? ctx.db.all<{ team: string; kind: string; total: number }>(
        `SELECT COALESCE(t.name,'(none)') team, l.kind, SUM(l.amount_usd) total FROM ledger l LEFT JOIN teams t ON t.id = l.team_id
         WHERE l.entry_type='charge' AND l.created_at >= ? ${all ? '' : 'AND l.team_id = ?'} GROUP BY t.name, l.kind`,
        periodStart(),
        ...(all ? [] : [actor.teamId ?? ''])
      )
    : []
  const byProject = ctx.db.all<{ project: string; total: number }>(
    `SELECT COALESCE(l.project,'(unassigned)') project, SUM(l.amount_usd) total FROM ledger l WHERE l.entry_type='charge' AND l.created_at >= ? ${scopeSql} GROUP BY l.project ORDER BY total DESC`,
    periodStart(),
    ...(agentScope ?? [])
  )
  const runAgentFilter = agentScope ? `AND r.agent_id IN (${sqlIn(agentScope)})` : ''
  const effectiveness = ctx.db.all<{ agent_id: string; name: string; runs: number; succeeded: number; failed: number; reviewed: number; cost: number }>(
    `SELECT r.agent_id, a.name, COUNT(*) runs, SUM(r.status = 'succeeded') succeeded, SUM(r.status = 'failed') failed,
            SUM(EXISTS(SELECT 1 FROM review_tasks t WHERE t.run_id = r.id)) reviewed, SUM(r.cost_metered + r.cost_estimated) cost
     FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.is_fixture = 0 AND r.created_at >= ? ${runAgentFilter} GROUP BY r.agent_id`,
    periodStart(),
    ...(agentScope ?? [])
  ).map((e) => ({
    ...e,
    costPerSuccess: e.succeeded ? e.cost / e.succeeded : null,
    failureRate: e.runs ? e.failed / e.runs : 0,
    reviewRate: e.runs ? e.reviewed / e.runs : 0
  }))
  const localCompute = ctx.db.all<{ name: string; elapsed_sec: number; status: string }>(
    'SELECT name, elapsed_sec, status FROM training_jobs WHERE elapsed_sec IS NOT NULL ORDER BY created_at DESC LIMIT 20'
  )
  const recentLedger = ctx.db.all<Record<string, unknown>>(
    `SELECT l.*, a.name AS agent_name FROM ledger l LEFT JOIN agents a ON a.id = l.agent_id
     WHERE ${agentScope ? `(l.agent_id IS NULL OR l.agent_id IN (${sqlIn(agentScope)}))` : '1=1'}
     ORDER BY l.created_at DESC LIMIT 100`,
    ...(agentScope ?? [])
  )
  return {
    budgets: rows,
    byAgent,
    byModel,
    byTeam,
    byProject,
    effectiveness,
    localCompute,
    localComputeRateUsdPerHour: getPolicy(ctx).localComputeRateUsdPerHour,
    ledger: all || team ? recentLedger : recentLedger.filter((l) => l.user_id === actor.id || myAgentIds.includes(String(l.agent_id))),
    prices: listPrices(ctx),
    canEditPrices: roleHas(actor.role, 'pricing.edit'),
    periodStart: periodStart()
  }
}

export function getBudget(ctx: AppContext, id: string): BudgetRow {
  const b = ctx.db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ?', id)
  if (!b) throw notFound('Budget')
  return b
}

export { budgetLabel }
