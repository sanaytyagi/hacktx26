import { rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext, Actor } from '../core/context'
import { j } from '../db/database'
import { requireCap, visibleOwnerIds, sqlIn } from '../core/authz'
import { audit } from '../core/audit'
import { notFound, forbidden } from '../core/errors'
import { getPolicy, setSetting, PolicySchema, type Policy } from '../core/settings'
import { roleHas, ROLE_CAPABILITIES, ROLE_NAV } from '@shared/permissions'
import { listAgents } from './agents'
import { listReviewTasks, listRuns } from './runs'
import { listApprovals } from './approvals'
import { budgetOverview } from './budget'

export function session(ctx: AppContext, actor: Actor) {
  const ws = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'workspace'")
  const team = actor.teamId ? ctx.db.get<{ name: string }>('SELECT name FROM teams WHERE id = ?', actor.teamId)?.name : null
  return {
    workspace: j<{ name: string; synthetic: boolean }>(ws?.value, { name: 'Workspace', synthetic: true }),
    actor: { ...actor, teamName: team ?? null, title: ctx.db.get<{ title: string }>('SELECT title FROM users WHERE id = ?', actor.id)?.title ?? '' },
    capabilities: ROLE_CAPABILITIES[actor.role],
    nav: ROLE_NAV[actor.role],
    personas: ctx.db.all<{ id: string; name: string; title: string; role: string; team: string | null }>(
      'SELECT u.id, u.name, u.title, u.role, t.name AS team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.switchable = 1 ORDER BY CASE u.role WHEN \'employee\' THEN 0 WHEN \'manager\' THEN 1 ELSE 2 END'
    ),
    unreadNotifications: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', actor.id)!.n,
    openReviews: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM review_tasks WHERE assignee_id = ? AND status = 'open'", actor.id)!.n,
    secretStorage: ctx.secrets.kind
  }
}

export function home(ctx: AppContext, actor: Actor) {
  const agents = listAgents(ctx, actor).filter((a) => !a.isTemplate)
  const reviews = listReviewTasks(ctx, actor)
  const approvals = listApprovals(ctx, actor)
  const runs = listRuns(ctx, actor, { limit: 8 })
  const budget = budgetOverview(ctx, actor)
  const mine = agents.filter((a) => a.mine)
  const base = {
    myAgents: mine.slice(0, 6),
    templates: listAgents(ctx, actor).filter((a) => a.isTemplate).slice(0, 4),
    tasks: reviews.filter((r) => r.mine).slice(0, 8),
    myRequests: approvals.filter((a) => a.mine).slice(0, 6),
    recentRuns: runs,
    budgets: budget.budgets.filter((b) => b.scope === 'agent' ? mine.some((a) => a.id === b.scopeId) : b.scope === 'team')
  }
  if (actor.role === 'employee') return { role: actor.role, ...base }
  const teamAgents = agents.filter((a) => actor.role === 'admin' || a.teamId === actor.teamId)
  const attention = teamAgents
    .filter((a) => a.failed30d > 0 || a.needsReview > 0 || a.killSwitch || a.status === 'awaiting_approval')
    .map((a) => ({ ...a, reason: a.killSwitch ? 'Kill switch on' : a.needsReview ? `${a.needsReview} run(s) need review` : a.status === 'awaiting_approval' ? 'Awaiting deployment approval' : `${a.failed30d} failed/blocked run(s) in 30 days` }))
  const perf = teamAgents.map((a) => ({ id: a.id, name: a.name, owner: a.ownerName, status: a.status, runs30d: a.runs30d, failed30d: a.failed30d, successRate: a.runs30d ? (a.runs30d - a.failed30d) / a.runs30d : null }))
  const warnings = budget.budgets.filter((b) => b.pct >= b.alertPct)
  const opportunities = ctx.db.all<{ id: string; card: string; collection_id: string; created_at: string }>("SELECT id, card, collection_id, created_at FROM opportunities WHERE status = 'new' ORDER BY created_at DESC LIMIT 4").map((o) => ({ id: o.id, collectionId: o.collection_id, title: j<{ title: string }>(o.card, { title: '' }).title, createdAt: o.created_at }))
  const models = ctx.db.all<{ id: string; name: string; version: number; status: string; review_reason: string | null }>("SELECT id, name, version, status, review_reason FROM models WHERE status IN ('active','needs_review','registered') ORDER BY created_at DESC LIMIT 6")
  const jobs = ctx.db.all<{ id: string; name: string; status: string; progress: number }>("SELECT id, name, status, progress FROM training_jobs ORDER BY created_at DESC LIMIT 4")
  const connectorIssues = roleHas(actor.role, 'tools.administer') ? ctx.db.all<{ id: string; name: string; status: string; status_detail: string }>("SELECT id, name, status, status_detail FROM integrations WHERE status IN ('error','not_connected','not_checked')") : []
  return {
    role: actor.role,
    ...base,
    inbox: approvals.filter((a) => a.status === 'pending' && a.canDecide),
    teamPerformance: perf,
    attention,
    spending: { budgets: budget.budgets, warnings, byAgent: budget.byAgent.slice(0, 6) },
    opportunities,
    models,
    jobs,
    connectorIssues
  }
}

export function getSettingsView(ctx: AppContext, actor: Actor) {
  return { policy: getPolicy(ctx), canEdit: roleHas(actor.role, 'policies.edit'), canManageRetention: roleHas(actor.role, 'retention.manage') }
}

export function updatePolicy(ctx: AppContext, actor: Actor, policy: Policy) {
  requireCap(ctx, actor, 'policies.edit', 'edit company policies')
  const before = getPolicy(ctx)
  const parsed = PolicySchema.parse(policy)
  setSetting(ctx, 'policy', parsed)
  audit(ctx, actor, 'policy.updated', { type: 'policy', id: 'workspace' }, { before, after: parsed })
}

export function listAudit(ctx: AppContext, actor: Actor, filter: { action?: string; limit?: number } = {}) {
  if (!roleHas(actor.role, 'audit.view_team')) throw forbidden('Your role cannot view the audit log.')
  const all = roleHas(actor.role, 'audit.view_all')
  const where: string[] = []
  const params: (string | number)[] = []
  if (!all) {
    const owners = visibleOwnerIds(ctx, actor)
    const ids = owners === 'all' ? [] : owners
    where.push(`actor_id IN (${sqlIn(ids)})`)
    params.push(...ids)
  }
  if (filter.action) {
    where.push('action LIKE ?')
    params.push(`${filter.action}%`)
  }
  return ctx.db
    .all<{ id: number; ts: string; actor_id: string; actor_role: string; action: string; target_type: string | null; target_id: string | null; outcome: string; details: string; actor_name: string | null }>(
      `SELECT e.*, u.name AS actor_name FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`,
      ...params,
      filter.limit ?? 300
    )
    .map((e) => ({ ...e, details: j(e.details, {}) }))
}

export function listNotifications(ctx: AppContext, actor: Actor) {
  return ctx.db.all<{ id: string; title: string; body: string; link: string | null; kind: string; read: number; created_at: string }>('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', actor.id)
}

export function markNotificationsRead(ctx: AppContext, actor: Actor, ids: string[] | 'all') {
  if (ids === 'all') ctx.db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', actor.id)
  else for (const id of ids) ctx.db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', id, actor.id)
}

// ---------------- Retention & targeted deletion ----------------

function dirSize(p: string): number {
  if (!existsSync(p)) return 0
  const st = statSync(p)
  if (!st.isDirectory()) return st.size
  return readdirSync(p).reduce((s, n) => s + dirSize(join(p, n)), 0)
}

export function storageReport(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'retention.manage', 'manage retention')
  const p = ctx.paths
  return {
    root: p.root,
    usage: [
      { key: 'recordings', label: 'Recordings', bytes: dirSize(p.recordings), items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM recordings')!.n },
      { key: 'exports', label: 'Exports', bytes: dirSize(p.exports), items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM exports')!.n },
      { key: 'datasets', label: 'Prepared datasets', bytes: dirSize(p.datasets), items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM datasets')!.n },
      { key: 'jobs', label: 'Training job artifacts', bytes: dirSize(p.jobs), items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM training_jobs')!.n },
      { key: 'sources', label: 'Imported source files', bytes: dirSize(p.sources), items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM sources')!.n },
      { key: 'hfCache', label: 'Downloaded base models', bytes: dirSize(p.hfCache), items: 0 },
      { key: 'runs', label: 'Run history (events)', bytes: 0, items: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM run_events')!.n }
    ],
    recordings: ctx.db.all<{ id: string; title: string; size: number; created_at: string; owner: string }>('SELECT r.id, r.title, r.size, r.created_at, u.name AS owner FROM recordings r JOIN users u ON u.id = r.owner_id ORDER BY r.created_at DESC'),
    exports: ctx.db.all<{ id: string; path: string; rows: number; created_at: string }>('SELECT id, path, rows, created_at FROM exports ORDER BY created_at DESC LIMIT 100'),
    datasets: ctx.db.all<{ id: string; name: string; version: number; created_at: string }>('SELECT id, name, version, created_at FROM datasets ORDER BY created_at DESC'),
    policy: getPolicy(ctx).retention
  }
}

/** Apply the retention policy now. Deletes local files and detailed history; keeps run summaries and audit events. */
export function applyRetention(ctx: AppContext, actor: Actor | null) {
  if (actor) requireCap(ctx, actor, 'retention.manage', 'apply retention')
  const r = getPolicy(ctx).retention
  const cutoff = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()
  const recs = ctx.db.all<{ id: string; file_path: string }>('SELECT id, file_path FROM recordings WHERE created_at < ?', cutoff(r.recordingsDays))
  for (const x of recs) rmSync(x.file_path, { force: true })
  ctx.db.run('DELETE FROM recordings WHERE created_at < ?', cutoff(r.recordingsDays))
  const exps = ctx.db.all<{ path: string }>('SELECT path FROM exports WHERE created_at < ?', cutoff(r.exportsDays))
  for (const x of exps) rmSync(x.path, { force: true })
  ctx.db.run('DELETE FROM exports WHERE created_at < ?', cutoff(r.exportsDays))
  const old = cutoff(r.runHistoryDays)
  const ev = ctx.db.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE created_at < ? AND is_fixture = 0)', old).changes
  ctx.db.run("UPDATE run_steps SET output = NULL WHERE run_id IN (SELECT id FROM runs WHERE created_at < ? AND is_fixture = 0)", old)
  const summary = { recordings: recs.length, exports: exps.length, runEvents: ev }
  audit(ctx, actor, 'retention.applied', {}, summary)
  return summary
}

export function deleteArtifact(ctx: AppContext, actor: Actor, kind: 'export' | 'dataset' | 'run_history' | 'model_files', id: string) {
  requireCap(ctx, actor, 'retention.manage', 'delete local artifacts')
  if (kind === 'export') {
    const e = ctx.db.get<{ path: string }>('SELECT path FROM exports WHERE id = ?', id)
    if (!e) throw notFound('Export')
    rmSync(e.path, { force: true })
    ctx.db.run('DELETE FROM exports WHERE id = ?', id)
  } else if (kind === 'dataset') {
    const d = ctx.db.get<{ path: string }>('SELECT path FROM datasets WHERE id = ?', id)
    if (!d) throw notFound('Dataset')
    rmSync(d.path, { recursive: true, force: true })
    ctx.db.update('datasets', 'id', id, { status: 'deleted', stats: '{}' })
  } else if (kind === 'run_history') {
    ctx.db.run('DELETE FROM run_events WHERE run_id = ?', id)
    ctx.db.run('UPDATE run_steps SET output = NULL WHERE run_id = ?', id)
    ctx.db.run("UPDATE runs SET inputs = '{}', outputs = NULL WHERE id = ?", id)
  } else {
    const m = ctx.db.get<{ artifact_dir: string; status: string }>('SELECT artifact_dir, status FROM models WHERE id = ?', id)
    if (!m) throw notFound('Model')
    rmSync(join(m.artifact_dir, 'model'), { recursive: true, force: true })
    rmSync(join(m.artifact_dir, 'adapter'), { recursive: true, force: true })
    ctx.db.update('models', 'id', id, { status: 'retired', review_reason: 'Model files deleted' })
  }
  audit(ctx, actor, 'artifact.deleted', { type: kind, id }, {})
}

