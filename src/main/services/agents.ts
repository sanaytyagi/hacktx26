import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { canSeeOwner, checkCollectionUse, visibleOwnerIds, sqlIn, requireCap } from '../core/authz'
import { audit } from '../core/audit'
import { notify } from '../core/notifications'
import { RelayError, forbidden, notFound, invalid } from '../core/errors'
import { getPolicy } from '../core/settings'
import { AgentSpecSchema, ScheduleSchema, type AgentSpec, type ToolDeclaration } from '@shared/domain'
import { roleHas } from '@shared/permissions'
import { checkToolUse, getToolRow, toolNeeds, versionCompatibility, checkHealth } from '../tools/registry'
import { defaultModelRef, getProvider, checkModelAllowed } from './providers'
import { referencedSteps } from '../engine/templates'
import { createApproval } from './approvals'
import type { RunEngine } from '../engine/runner'
import { nextRunAt } from './scheduler'

export interface AgentRow {
  id: string
  owner_id: string
  team_id: string | null
  name: string
  description: string
  status: string
  deployment: string | null
  workflow_id: string | null
  draft_version_id: string | null
  live_version_id: string | null
  kill_switch: number
  notify_on_failure: string
  is_template: number
  created_at: string
  updated_at: string
}

export function getAgentRow(ctx: AppContext, id: string): AgentRow {
  const a = ctx.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', id)
  if (!a) throw notFound('Agent')
  return a
}

function requireView(ctx: AppContext, actor: Actor, a: AgentRow) {
  if (a.is_template) return
  if (!canSeeOwner(ctx, actor, a.owner_id)) throw notFound('Agent')
}

function requireEdit(ctx: AppContext, actor: Actor, a: AgentRow) {
  if (a.owner_id !== actor.id && !roleHas(actor.role, 'agents.manage_all')) throw forbidden('Only the owner or an administrator can change this agent.')
}

function canOversee(ctx: AppContext, actor: Actor, a: AgentRow) {
  return a.owner_id === actor.id || roleHas(actor.role, 'agents.manage_all') || (roleHas(actor.role, 'agents.view_team') && a.team_id === actor.teamId)
}

/** Pin every referenced tool to its current version. */
export function pinTools(ctx: AppContext, spec: AgentSpec): AgentSpec {
  const keys = new Set<string>()
  for (const s of spec.steps) {
    if (s.tool) keys.add(s.tool)
    s.agentTools.forEach((k) => keys.add(k))
  }
  spec.tools.forEach((t) => keys.add(t.key))
  const tools = [...keys].map((key) => {
    const existing = spec.tools.find((t) => t.key === key)
    const row = ctx.db.get<{ version: number }>('SELECT version FROM tools WHERE key = ?', key)
    if (!row) throw invalid(`Tool “${key}” is not registered.`)
    return { key, version: existing?.version ?? row.version }
  })
  return { ...spec, tools }
}

export function validateSpec(spec: AgentSpec): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  spec.steps.forEach((s, idx) => {
    if (ids.has(s.id)) problems.push(`Step id “${s.id}” is used twice.`)
    ids.add(s.id)
    if (s.kind === 'deterministic' && !s.tool) problems.push(`“${s.title}” is an automated step but has no tool.`)
    for (const ref of referencedSteps([s.args, s.forEach, s.condition])) {
      const earlier = spec.steps.slice(0, idx).some((p) => p.id === ref)
      if (!earlier) problems.push(`“${s.title}” refers to step “${ref}”, which does not run before it.`)
    }
  })
  return problems
}

export const AgentCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  spec: AgentSpecSchema,
  workflowId: z.string().optional()
})

export function createAgent(ctx: AppContext, actor: Actor, raw: z.input<typeof AgentCreateSchema>) {
  requireCap(ctx, actor, 'agents.create', 'create agents')
  const input = AgentCreateSchema.parse(raw)
  const spec = pinTools(ctx, input.spec)
  const problems = validateSpec(spec)
  if (problems.length) throw invalid(problems.join(' '))
  const id = newId('agt')
  const vid = newId('agv')
  ctx.db.tx(() => {
    ctx.db.insert('agents', {
      id,
      owner_id: actor.id,
      team_id: actor.teamId,
      name: input.name,
      description: input.description,
      status: 'draft',
      workflow_id: input.workflowId ?? null,
      draft_version_id: vid,
      notify_on_failure: '[]',
      created_at: now(),
      updated_at: now()
    })
    ctx.db.insert('agent_versions', { id: vid, agent_id: id, version: 1, spec: js(spec), created_by: actor.id, created_at: now(), note: 'Created', source: input.workflowId ? 'workflow' : 'edit' })
    if (input.workflowId) ctx.db.update('workflows', 'id', input.workflowId, { agent_id: id, status: 'agent_created', updated_at: now() })
    const budget = getPolicy(ctx).defaultAgentMonthlyBudgetUsd
    ctx.db.insert('budgets', { id: newId('bud'), scope: 'agent', scope_id: id, kind: 'operating', period: 'monthly', limit_usd: budget, alert_pct: 80, hard_limit: 1, created_at: now(), updated_at: now() })
  })
  audit(ctx, actor, 'agent.created', { type: 'agent', id }, { name: input.name })
  return { id, versionId: vid }
}

export function copyTemplate(ctx: AppContext, actor: Actor, templateId: string, name?: string) {
  const t = getAgentRow(ctx, templateId)
  if (!t.is_template) throw invalid('Not a template.')
  const v = ctx.db.get<{ spec: string }>('SELECT spec FROM agent_versions WHERE id = ?', t.draft_version_id)!
  const spec = AgentSpecSchema.parse(JSON.parse(v.spec))
  return createAgent(ctx, actor, { name: name ?? t.name.replace(/^Template: /, ''), description: t.description, spec: { ...spec, tools: [] } })
}

export function saveDraft(ctx: AppContext, actor: Actor, agentId: string, input: { name?: string; description?: string; spec: AgentSpec; note?: string }) {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  if (a.is_template) throw invalid('Templates are read-only. Use the template to create your own agent.')
  const spec = pinTools(ctx, AgentSpecSchema.parse(input.spec))
  const problems = validateSpec(spec)
  if (problems.length) throw invalid(problems.join(' '))
  const cur = ctx.db.get<{ id: string; version: number; tested_run_id: string | null; spec: string }>('SELECT * FROM agent_versions WHERE id = ?', a.draft_version_id)!
  const everLive = !!ctx.db.get("SELECT 1 FROM audit_events WHERE action = 'agent.deployed' AND json_extract(details, '$.versionId') = ?", cur.id)
  let versionId = cur.id
  if (JSON.stringify(spec) !== JSON.stringify(JSON.parse(cur.spec))) {
    if (cur.tested_run_id || everLive || cur.id === a.live_version_id) {
      const max = ctx.db.get<{ v: number }>('SELECT MAX(version) v FROM agent_versions WHERE agent_id = ?', agentId)!.v
      versionId = newId('agv')
      ctx.db.insert('agent_versions', { id: versionId, agent_id: agentId, version: max + 1, spec: js(spec), created_by: actor.id, created_at: now(), note: input.note ?? 'Edited', source: 'edit' })
    } else ctx.db.update('agent_versions', 'id', cur.id, { spec: js(spec), note: input.note ?? 'Edited' })
  }
  const status = a.status === 'tested' && versionId !== cur.id ? 'draft' : a.status
  ctx.db.update('agents', 'id', agentId, { name: input.name ?? a.name, description: input.description ?? a.description, draft_version_id: versionId, status, updated_at: now() })
  audit(ctx, actor, 'agent.saved', { type: 'agent', id: agentId }, { versionId, newVersion: versionId !== cur.id })
  return { versionId }
}

export function listAgents(ctx: AppContext, actor: Actor) {
  const owners = visibleOwnerIds(ctx, actor)
  const rows = ctx.db.all<AgentRow & { owner_name: string; draft_version: number; live_version: number | null }>(
    `SELECT a.*, u.name AS owner_name, dv.version AS draft_version, lv.version AS live_version FROM agents a
     JOIN users u ON u.id = a.owner_id LEFT JOIN agent_versions dv ON dv.id = a.draft_version_id LEFT JOIN agent_versions lv ON lv.id = a.live_version_id
     WHERE a.status != 'archived' AND (a.is_template = 1 ${owners === 'all' ? 'OR 1=1' : `OR a.owner_id IN (${sqlIn(owners)})`}) ORDER BY a.updated_at DESC`,
    ...(owners === 'all' ? [] : owners)
  )
  return rows.map((a) => {
    const stats = ctx.db.get<{ runs: number; failed: number; last: string | null; review: number }>(
      `SELECT COUNT(*) runs, SUM(status IN ('failed','blocked')) failed, MAX(created_at) last, SUM(status = 'needs_review') review FROM runs WHERE agent_id = ? AND is_fixture = 0 AND trigger != 'eval' AND created_at >= datetime('now','-30 days')`,
      a.id
    )!
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status,
      deployment: a.deployment,
      ownerId: a.owner_id,
      ownerName: a.owner_name,
      teamId: a.team_id,
      isTemplate: !!a.is_template,
      killSwitch: !!a.kill_switch,
      draftVersion: a.draft_version,
      liveVersion: a.live_version,
      runs30d: stats.runs,
      failed30d: stats.failed ?? 0,
      needsReview: stats.review ?? 0,
      lastRunAt: stats.last,
      updatedAt: a.updated_at,
      mine: a.owner_id === actor.id
    }
  })
}

export function getAgent(ctx: AppContext, actor: Actor, id: string) {
  const a = getAgentRow(ctx, id)
  requireView(ctx, actor, a)
  const versions = ctx.db.all<{ id: string; version: number; spec: string; created_at: string; note: string; tested_run_id: string | null; source: string; created_by: string }>(
    'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC',
    id
  )
  const draft = versions.find((v) => v.id === a.draft_version_id)
  const schedule = ctx.db.get<{ id: string; config: string; enabled: number; next_run_at: string | null; last_run_at: string | null }>('SELECT * FROM schedules WHERE agent_id = ?', id)
  const missed = schedule
    ? ctx.db.all<{ due_at: string; outcome: string; run_id: string | null; recorded_at: string }>('SELECT due_at, outcome, run_id, recorded_at FROM schedule_events WHERE schedule_id = ? ORDER BY id DESC LIMIT 20', schedule.id)
    : []
  const trigger = ctx.db.get<{ id: string; enabled: number }>('SELECT id, enabled FROM api_triggers WHERE agent_id = ?', id)
  const owner = ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', a.owner_id)
  const pendingApproval = ctx.db.get<{ id: string; type: string; status: string }>(
    "SELECT id, type, status FROM approvals WHERE target_type = 'agent' AND target_id = ? AND status = 'pending' ORDER BY created_at DESC",
    id
  )
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    deployment: a.deployment,
    ownerId: a.owner_id,
    ownerName: owner?.name ?? '',
    teamId: a.team_id,
    workflowId: a.workflow_id,
    isTemplate: !!a.is_template,
    killSwitch: !!a.kill_switch,
    notifyOnFailure: j<string[]>(a.notify_on_failure, []),
    draftVersionId: a.draft_version_id,
    liveVersionId: a.live_version_id,
    draft: draft ? { id: draft.id, version: draft.version, spec: AgentSpecSchema.parse(JSON.parse(draft.spec)), testedRunId: draft.tested_run_id } : null,
    versions: versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.created_at, note: v.note, testedRunId: v.tested_run_id, source: v.source, isLive: v.id === a.live_version_id, isDraft: v.id === a.draft_version_id })),
    schedule: schedule ? { id: schedule.id, config: ScheduleSchema.parse(JSON.parse(schedule.config)), enabled: !!schedule.enabled, nextRunAt: schedule.next_run_at, lastRunAt: schedule.last_run_at, events: missed } : null,
    apiTrigger: trigger ? { id: trigger.id, enabled: !!trigger.enabled } : null,
    pendingApproval: pendingApproval ?? null,
    canEdit: !a.is_template && (a.owner_id === actor.id || roleHas(actor.role, 'agents.manage_all')),
    canOversee: canOversee(ctx, actor, a)
  }
}

// ---------------- Readiness ----------------

export interface ReadinessCheck {
  stepId: string | null
  area: 'data' | 'action' | 'verification' | 'model' | 'budget' | 'policy' | 'test'
  status: 'ok' | 'warn' | 'block'
  label: string
  detail: string
  fix?: { kind: 'request_tool' | 'request_data' | 'human_handoff' | 'alternative' | 'configure' | 'test'; toolKey?: string; collectionId?: string; alternatives?: string[] }
}

/**
 * “Can this agent access the required data, perform each action, and verify its output?”
 * Blocking checks prevent deployment; unattended (scheduled/API) use additionally requires
 * that no step depends on an unavailable tool.
 */
export async function readiness(ctx: AppContext, actor: Actor, agentId: string, opts: { versionId?: string; runConnectionChecks?: boolean } = {}) {
  const a = getAgentRow(ctx, agentId)
  requireView(ctx, actor, a)
  const v = ctx.db.get<{ id: string; spec: string; tested_run_id: string | null }>('SELECT * FROM agent_versions WHERE id = ?', opts.versionId ?? a.draft_version_id)
  if (!v) throw notFound('Agent version')
  const spec = AgentSpecSchema.parse(JSON.parse(v.spec))
  const owner = { id: a.owner_id, name: '', role: ctx.db.get<{ role: Actor['role'] }>('SELECT role FROM users WHERE id = ?', a.owner_id)!.role, teamId: a.team_id }
  const checks: ReadinessCheck[] = []
  const policy = getPolicy(ctx)
  if (opts.runConnectionChecks) {
    const integrations = new Set<string>()
    for (const t of spec.tools) {
      const row = ctx.db.get<{ integration_id: string | null }>('SELECT integration_id FROM tools WHERE key = ?', t.key)
      if (row?.integration_id) integrations.add(row.integration_id)
    }
    for (const iid of integrations) await checkHealth(ctx, null, iid).catch(() => undefined)
  }
  // Data
  for (const cid of spec.collections) {
    const d = checkCollectionUse(ctx, owner, cid, 'retrieval')
    const name = ctx.db.get<{ name: string; allow_external: number }>('SELECT name, allow_external FROM collections WHERE id = ?', cid)
    checks.push({
      stepId: null,
      area: 'data',
      status: d.allowed ? 'ok' : 'block',
      label: `Data access: ${name?.name ?? cid}`,
      detail: d.allowed ? `Granted for use in agents${name && !name.allow_external ? ' (local-only: cannot be sent to external providers)' : ''}.` : d.reason,
      fix: d.allowed ? undefined : { kind: 'request_data', collectionId: cid }
    })
  }
  const toolCheck = (stepId: string, key: string, pinned?: number) => {
    const row = ctx.db.get<{ declaration: string; enabled: number }>('SELECT declaration, enabled FROM tools WHERE key = ?', key)
    if (!row) {
      checks.push({ stepId, area: 'action', status: 'block', label: `Tool ${key}`, detail: 'This tool is not registered in this workspace.', fix: { kind: 'human_handoff' } })
      return
    }
    const d = j<ToolDeclaration>(row.declaration, {} as ToolDeclaration)
    const use = checkToolUse(ctx, owner, key)
    const needs = toolNeeds(ctx, getToolRow(ctx, key))
    const compat = pinned ? versionCompatibility(ctx, key, pinned) : { ok: true, reason: '' }
    const alternatives = ctx.db
      .all<{ key: string; declaration: string }>('SELECT key, declaration FROM tools WHERE category = ? AND key != ? AND enabled = 1', d.category, key)
      .filter((t) => checkToolUse(ctx, owner, t.key).allowed)
      .map((t) => t.key)
      .slice(0, 4)
    if (!use.allowed) checks.push({ stepId, area: 'action', status: 'block', label: d.name, detail: use.reason, fix: { kind: 'request_tool', toolKey: key, alternatives } })
    else if (needs) checks.push({ stepId, area: 'action', status: 'block', label: d.name, detail: `Not connected: ${needs}.`, fix: { kind: alternatives.length ? 'alternative' : 'configure', toolKey: key, alternatives } })
    else if (!compat.ok) checks.push({ stepId, area: 'action', status: 'block', label: d.name, detail: compat.reason, fix: { kind: 'test' } })
    else
      checks.push({
        stepId,
        area: 'action',
        status: d.access === 'read' ? 'ok' : 'warn',
        label: d.name,
        detail: d.access === 'read' ? 'Available (read-only).' : `Available. Changes data (${d.access})${d.requiresApproval ? '; each live call needs approval' : ''}.`
      })
    if (!policy.personalDeploy.allowedToolAccess.includes(d.access))
      checks.push({ stepId, area: 'policy', status: 'warn', label: `${d.name} is a ${d.access} tool`, detail: 'Personal deployment of agents using this tool needs approval. Request a team deployment instead.' })
  }
  let hasVerification = false
  for (const s of spec.steps) {
    if (s.approvalBefore || s.kind === 'human_review') hasVerification = true
    if (s.kind === 'deterministic') {
      if (!s.tool) checks.push({ stepId: s.id, area: 'action', status: 'block', label: s.title, detail: 'No tool can perform this step.', fix: { kind: 'human_handoff' } })
      else toolCheck(s.id, s.tool, spec.tools.find((t) => t.key === s.tool)?.version)
    } else if (s.kind === 'agent') {
      const ref = s.model ?? spec.defaultModel ?? defaultModelRef(ctx)
      if (!ref) checks.push({ stepId: s.id, area: 'model', status: 'block', label: s.title, detail: 'Needs a general model, and none is configured.', fix: { kind: 'configure' } })
      else {
        try {
          const p = getProvider(ctx, ref.providerId)
          checkModelAllowed(ctx, p, ref.model)
          const localOnly = spec.collections.filter((c) => !ctx.db.get<{ allow_external: number }>('SELECT allow_external FROM collections WHERE id = ?', c)?.allow_external)
          if (p.external && localOnly.length)
            checks.push({
              stepId: s.id,
              area: 'policy',
              status: 'warn',
              label: `${s.title}: external model`,
              detail: `${p.name} is an external provider. If data from a local-only collection reaches this step, the run will be blocked. Use a local model for that data.`
            })
          else checks.push({ stepId: s.id, area: 'model', status: 'ok', label: s.title, detail: `Uses ${ref.model} (${p.external ? 'external provider' : 'runs locally'}).` })
        } catch (e) {
          checks.push({ stepId: s.id, area: 'model', status: 'block', label: s.title, detail: (e as Error).message, fix: { kind: 'configure' } })
        }
      }
      for (const k of s.agentTools) toolCheck(s.id, k, spec.tools.find((t) => t.key === k)?.version)
      if (s.outputFields.length) hasVerification = true
      else checks.push({ stepId: s.id, area: 'verification', status: 'warn', label: s.title, detail: 'Free-text output is harder to check automatically. Define output fields or add a review step.' })
    } else if (s.kind === 'manual') {
      checks.push({ stepId: s.id, area: 'action', status: 'warn', label: s.title, detail: 'A person must do this step in every run. The run pauses until they mark it done.' })
    } else checks.push({ stepId: s.id, area: 'verification', status: 'ok', label: s.title, detail: 'A person reviews this result before the run continues.' })
  }
  checks.push({
    stepId: null,
    area: 'verification',
    status: hasVerification ? 'ok' : 'warn',
    label: 'Output can be verified',
    detail: hasVerification ? 'Structured outputs or human review points let you check results.' : 'No structured outputs or review points. Add one so mistakes are caught.'
  })
  checks.push({
    stepId: null,
    area: 'test',
    status: v.tested_run_id ? 'ok' : policy.personalDeploy.requireSuccessfulTest ? 'block' : 'warn',
    label: 'Successful test run',
    detail: v.tested_run_id ? 'This version passed a test run.' : 'Run this version in Test and get a successful result before going live.',
    fix: v.tested_run_id ? undefined : { kind: 'test' }
  })
  const blocking = checks.filter((c) => c.status === 'block')
  const unattendedBlocking = blocking.length > 0 || spec.steps.some((s) => s.kind !== 'human_review' && s.kind !== 'manual' && s.kind === 'deterministic' && !s.tool)
  return {
    versionId: v.id,
    ready: blocking.length === 0,
    unattendedReady: !unattendedBlocking,
    summary: blocking.length
      ? `${blocking.length} issue(s) must be fixed before this agent can go live.`
      : checks.some((c) => c.status === 'warn')
        ? 'Ready, with warnings to review.'
        : 'Ready: it can access its data, perform each action, and its output can be verified.',
    checks
  }
}

// ---------------- Lifecycle ----------------

export async function deployAgent(ctx: AppContext, actor: Actor, agentId: string, mode: 'personal' | 'team', reason = '') {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  const r = await readiness(ctx, actor, agentId, { runConnectionChecks: true })
  if (!r.ready) throw new RelayError('policy', `Not ready to go live: ${r.checks.filter((c) => c.status === 'block').map((c) => `${c.label} — ${c.detail}`).join('; ')}`)
  const policy = getPolicy(ctx)
  const needsApprovalForTools = r.checks.some((c) => c.area === 'policy' && c.label.includes(' tool'))
  if (mode === 'personal' && policy.personalDeploy.allowed && !needsApprovalForTools) {
    ctx.db.update('agents', 'id', agentId, { status: 'live', deployment: 'personal', live_version_id: r.versionId, updated_at: now() })
    audit(ctx, actor, 'agent.deployed', { type: 'agent', id: agentId }, { versionId: r.versionId, mode })
    return { status: 'live' as const }
  }
  const vnum = ctx.db.get<{ version: number }>('SELECT version FROM agent_versions WHERE id = ?', r.versionId)!.version
  const approval = createApproval(ctx, actor, {
    type: 'deployment',
    title: `${mode === 'team' ? 'Team' : 'Personal'} deployment: ${a.name} v${vnum}`,
    reason: reason || (needsApprovalForTools ? 'Uses tools that change or send data beyond personal-use policy.' : 'Share this agent with my team.'),
    payload: { agentId, versionId: r.versionId, mode, warnings: r.checks.filter((c) => c.status === 'warn').map((c) => `${c.label}: ${c.detail}`) },
    targetType: 'agent',
    targetId: agentId
  })
  ctx.db.update('agents', 'id', agentId, { status: 'awaiting_approval', updated_at: now() })
  return { status: 'awaiting_approval' as const, approvalId: approval.id }
}

/** Applied when a deployment approval is granted. */
export function applyDeployment(ctx: AppContext, approver: Actor, agentId: string, versionId: string, mode: string) {
  ctx.db.update('agents', 'id', agentId, { status: 'live', deployment: mode, live_version_id: versionId, updated_at: now() })
  audit(ctx, approver, 'agent.deployed', { type: 'agent', id: agentId }, { versionId, mode, viaApproval: true })
}

export function setAgentState(ctx: AppContext, actor: Actor, agentId: string, action: 'pause' | 'resume' | 'archive' | 'kill_on' | 'kill_off', engine: RunEngine) {
  const a = getAgentRow(ctx, agentId)
  if (!canOversee(ctx, actor, a)) throw forbidden('You cannot manage this agent.')
  if (action === 'pause') {
    if (a.status !== 'live') throw new RelayError('conflict', 'Only live agents can be paused.')
    ctx.db.update('agents', 'id', agentId, { status: 'paused', updated_at: now() })
  } else if (action === 'resume') {
    if (a.status !== 'paused') throw new RelayError('conflict', 'Only paused agents can be resumed.')
    ctx.db.update('agents', 'id', agentId, { status: 'live', updated_at: now() })
  } else if (action === 'archive') {
    ctx.db.update('agents', 'id', agentId, { status: 'archived', updated_at: now() })
    ctx.db.run('UPDATE schedules SET enabled = 0 WHERE agent_id = ?', agentId)
  } else {
    ctx.db.update('agents', 'id', agentId, { kill_switch: action === 'kill_on' ? 1 : 0, updated_at: now() })
    if (action === 'kill_on') {
      for (const r of ctx.db.all<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND environment = 'live' AND status IN ('queued','running','needs_review','paused','interrupted')", agentId))
        engine.cancel(actor, r.id)
      if (a.owner_id !== actor.id) notify(ctx, a.owner_id, `Kill switch turned on for ${a.name}`, `By ${actor.name}. Live runs were stopped.`, `agents/${agentId}`, 'warning')
    }
  }
  audit(ctx, actor, `agent.${action}`, { type: 'agent', id: agentId }, {})
}

/** Point the live deployment at an earlier version. Does not undo side effects of runs already made. */
export function rollback(ctx: AppContext, actor: Actor, agentId: string, versionId: string) {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  const v = ctx.db.get<{ id: string; version: number; tested_run_id: string | null }>('SELECT id, version, tested_run_id FROM agent_versions WHERE id = ? AND agent_id = ?', versionId, agentId)
  if (!v) throw notFound('Version')
  const wasLive = ctx.db.get("SELECT 1 FROM audit_events WHERE action = 'agent.deployed' AND target_id = ? AND json_extract(details, '$.versionId') = ?", agentId, versionId)
  if (!wasLive) throw new RelayError('policy', 'You can roll back only to a version that was previously live.')
  ctx.db.update('agents', 'id', agentId, { live_version_id: versionId, status: a.status === 'awaiting_approval' ? 'live' : a.status, updated_at: now() })
  audit(ctx, actor, 'agent.rolled_back', { type: 'agent', id: agentId }, { toVersionId: versionId, fromVersionId: a.live_version_id })
  return { liveVersion: v.version, note: 'Rollback changes which version runs next. It does not undo rows written, files exported, or messages sent by earlier runs.' }
}

/** Start editing from an earlier version (creates a new draft version with that spec). */
export function restoreDraft(ctx: AppContext, actor: Actor, agentId: string, versionId: string) {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  const v = ctx.db.get<{ spec: string; version: number }>('SELECT spec, version FROM agent_versions WHERE id = ? AND agent_id = ?', versionId, agentId)
  if (!v) throw notFound('Version')
  const max = ctx.db.get<{ v: number }>('SELECT MAX(version) v FROM agent_versions WHERE agent_id = ?', agentId)!.v
  const id = newId('agv')
  ctx.db.insert('agent_versions', { id, agent_id: agentId, version: max + 1, spec: v.spec, created_by: actor.id, created_at: now(), note: `Restored from v${v.version}`, source: 'restore' })
  ctx.db.update('agents', 'id', agentId, { draft_version_id: id, status: a.status === 'tested' ? 'draft' : a.status, updated_at: now() })
  return { versionId: id }
}

export function updateAgentSettings(ctx: AppContext, actor: Actor, agentId: string, input: { notifyOnFailure?: string[]; ownerId?: string }) {
  const a = getAgentRow(ctx, agentId)
  if (input.ownerId && input.ownerId !== a.owner_id) {
    if (!canOversee(ctx, actor, a) || actor.id === a.owner_id && !roleHas(actor.role, 'agents.view_team')) throw forbidden('Only a manager or administrator can reassign ownership.')
    const target = ctx.db.get<{ team_id: string }>('SELECT team_id FROM users WHERE id = ?', input.ownerId)
    if (!target) throw notFound('Person')
    if (!roleHas(actor.role, 'agents.manage_all') && target.team_id !== actor.teamId) throw forbidden('Managers can assign ownership only within their team.')
    ctx.db.update('agents', 'id', agentId, { owner_id: input.ownerId, team_id: target.team_id })
    notify(ctx, input.ownerId, `You now own ${a.name}`, `Assigned by ${actor.name}.`, `agents/${agentId}`)
  }
  if (input.notifyOnFailure) {
    requireEdit(ctx, actor, a)
    ctx.db.update('agents', 'id', agentId, { notify_on_failure: js(input.notifyOnFailure) })
  }
  audit(ctx, actor, 'agent.settings_updated', { type: 'agent', id: agentId }, input)
}

export function setSchedule(ctx: AppContext, actor: Actor, agentId: string, config: z.infer<typeof ScheduleSchema> | null) {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  const existing = ctx.db.get<{ id: string }>('SELECT id FROM schedules WHERE agent_id = ?', agentId)
  if (!config) {
    if (existing) ctx.db.update('schedules', 'id', existing.id, { enabled: 0, next_run_at: null })
    audit(ctx, actor, 'schedule.disabled', { type: 'agent', id: agentId }, {})
    return
  }
  const parsed = ScheduleSchema.parse(config)
  const next = nextRunAt(parsed, new Date())
  if (existing) ctx.db.update('schedules', 'id', existing.id, { config: js(parsed), enabled: 1, next_run_at: next })
  else ctx.db.insert('schedules', { id: newId('sch'), agent_id: agentId, config: js(parsed), enabled: 1, next_run_at: next, created_by: actor.id, created_at: now() })
  audit(ctx, actor, 'schedule.set', { type: 'agent', id: agentId }, parsed)
}

export function setApiTrigger(ctx: AppContext, actor: Actor, agentId: string, enabled: boolean) {
  const a = getAgentRow(ctx, agentId)
  requireEdit(ctx, actor, a)
  const existing = ctx.db.get<{ id: string }>('SELECT id FROM api_triggers WHERE agent_id = ?', agentId)
  if (existing) ctx.db.update('api_triggers', 'id', existing.id, { enabled })
  else ctx.db.insert('api_triggers', { id: newId('trg'), agent_id: agentId, enabled, created_by: actor.id, created_at: now() })
  audit(ctx, actor, enabled ? 'api_trigger.enabled' : 'api_trigger.disabled', { type: 'agent', id: agentId }, {})
}

export function versionDiff(ctx: AppContext, actor: Actor, agentId: string, fromId: string, toId: string) {
  const a = getAgentRow(ctx, agentId)
  requireView(ctx, actor, a)
  const load = (id: string) => AgentSpecSchema.parse(JSON.parse(ctx.db.get<{ spec: string }>('SELECT spec FROM agent_versions WHERE id = ? AND agent_id = ?', id, agentId)?.spec ?? 'null'))
  const x = load(fromId)
  const y = load(toId)
  const changes: string[] = []
  if (x.instructions !== y.instructions) changes.push('Instructions changed')
  const xs = new Map(x.steps.map((s) => [s.id, s]))
  const ys = new Map(y.steps.map((s) => [s.id, s]))
  for (const [id, s] of ys) if (!xs.has(id)) changes.push(`Added step “${s.title}”`)
  for (const [id, s] of xs) if (!ys.has(id)) changes.push(`Removed step “${s.title}”`)
  for (const [id, s] of ys) {
    const o = xs.get(id)
    if (o && JSON.stringify(o) !== JSON.stringify(s)) changes.push(`Changed step “${s.title}”${o.kind !== s.kind ? ` (${o.kind} → ${s.kind})` : ''}${o.approvalBefore !== s.approvalBefore ? ' (checkpoint changed)' : ''}`)
  }
  const tx = x.tools.map((t) => `${t.key}@v${t.version}`).sort().join(',')
  const ty = y.tools.map((t) => `${t.key}@v${t.version}`).sort().join(',')
  if (tx !== ty) changes.push(`Tools: ${tx || 'none'} → ${ty || 'none'}`)
  if (JSON.stringify(x.collections) !== JSON.stringify(y.collections)) changes.push('Data collections changed')
  if (JSON.stringify(x.defaultModel) !== JSON.stringify(y.defaultModel)) changes.push('Default model changed')
  if (JSON.stringify(x.limits) !== JSON.stringify(y.limits)) changes.push('Limits changed')
  return changes
}


