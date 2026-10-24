import type { AppContext, Actor } from '../core/context'
import { newId, j } from '../db/database'
import { canSeeOwner, visibleOwnerIds, sqlIn } from '../core/authz'
import { notFound } from '../core/errors'
import { roleHas } from '@shared/permissions'
import { AgentSpecSchema } from '@shared/domain'
import { invokeTool } from '../tools/registry'

export function listRuns(ctx: AppContext, actor: Actor, filter: { agentId?: string; status?: string; limit?: number } = {}) {
  const owners = visibleOwnerIds(ctx, actor)
  const where: string[] = []
  const params: string[] = []
  if (owners !== 'all') {
    where.push(`(a.owner_id IN (${sqlIn(owners)}) OR r.created_by = ?)`)
    params.push(...owners, actor.id)
  }
  if (filter.agentId) {
    where.push('r.agent_id = ?')
    params.push(filter.agentId)
  }
  if (filter.status) {
    where.push('r.status = ?')
    params.push(filter.status)
  }
  where.push("r.trigger != 'eval'")
  return ctx.db
    .all<Record<string, unknown>>(
      `SELECT r.id, r.agent_id, a.name AS agent_name, v.version, r.environment, r.trigger, r.status, r.error, r.created_at, r.started_at, r.finished_at,
              r.tool_calls, r.tokens_in, r.tokens_out, r.cost_metered, r.cost_estimated, r.is_fixture, u.name AS created_by_name
       FROM runs r JOIN agents a ON a.id = r.agent_id JOIN agent_versions v ON v.id = r.agent_version_id JOIN users u ON u.id = r.created_by
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT ?`,
      ...params,
      String(filter.limit ?? 100)
    )
    .map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      version: r.version as number,
      environment: r.environment as string,
      trigger: r.trigger as string,
      status: r.status as string,
      error: r.error as string | null,
      createdAt: r.created_at as string,
      startedAt: r.started_at as string | null,
      finishedAt: r.finished_at as string | null,
      toolCalls: r.tool_calls as number,
      tokens: (r.tokens_in as number) + (r.tokens_out as number),
      costMetered: r.cost_metered as number,
      costEstimated: r.cost_estimated as number,
      isFixture: !!r.is_fixture,
      createdBy: r.created_by_name as string
    }))
}

export function getRun(ctx: AppContext, actor: Actor, id: string) {
  const r = ctx.db.get<Record<string, unknown>>('SELECT r.*, a.owner_id, a.name AS agent_name, a.team_id, v.version, v.spec FROM runs r JOIN agents a ON a.id = r.agent_id JOIN agent_versions v ON v.id = r.agent_version_id WHERE r.id = ?', id)
  if (!r || (!canSeeOwner(ctx, actor, r.owner_id as string) && r.created_by !== actor.id)) throw notFound('Run')
  const spec = AgentSpecSchema.parse(JSON.parse(r.spec as string))
  const steps = ctx.db.all<{ step_id: string; iteration: number; status: string; attempts: number; output: string | null; error: string | null; explanation: string; taint: string; started_at: string | null; finished_at: string | null }>(
    'SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at',
    id
  )
  const isOwner = r.owner_id === actor.id || r.created_by === actor.id
  return {
    id,
    agentId: r.agent_id as string,
    agentName: r.agent_name as string,
    version: r.version as number,
    versionId: r.agent_version_id as string,
    environment: r.environment as string,
    trigger: r.trigger as string,
    status: r.status as string,
    error: r.error as string | null,
    inputs: j(r.inputs, {}),
    outputs: j(r.outputs, null),
    createdAt: r.created_at as string,
    startedAt: r.started_at as string | null,
    finishedAt: r.finished_at as string | null,
    isFixture: !!r.is_fixture,
    toolCalls: r.tool_calls as number,
    retries: r.retries as number,
    tokensIn: r.tokens_in as number,
    tokensOut: r.tokens_out as number,
    costMetered: r.cost_metered as number,
    costEstimated: r.cost_estimated as number,
    parentRunId: r.parent_run_id as string | null,
    plan: spec.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, tool: s.tool ?? null, forEach: !!s.forEach, approvalBefore: s.approvalBefore })),
    limits: spec.limits,
    steps: steps.map((s) => ({ stepId: s.step_id, iteration: s.iteration, status: s.status, attempts: s.attempts, output: j(s.output, null), error: s.error, explanation: s.explanation, taint: j<string[]>(s.taint, []), startedAt: s.started_at, finishedAt: s.finished_at })),
    events: ctx.db.all<{ id: number; ts: string; type: string; step_id: string | null; message: string; data: string }>('SELECT * FROM run_events WHERE run_id = ? ORDER BY id', id).map((e) => ({ id: e.id, ts: e.ts, type: e.type, stepId: e.step_id, message: e.message, data: j(e.data, {}) })),
    reviews: ctx.db
      .all<{ id: string; step_id: string; iteration: number; kind: string; status: string; title: string; prompt: string; payload: string; response: string | null; created_at: string; resolved_at: string | null }>('SELECT * FROM review_tasks WHERE run_id = ? ORDER BY created_at', id)
      .map((t) => ({ id: t.id, stepId: t.step_id, iteration: t.iteration, kind: t.kind, status: t.status, title: t.title, prompt: t.prompt, payload: j(t.payload, {}), response: j(t.response, null), createdAt: t.created_at, resolvedAt: t.resolved_at })),
    feedback: ctx.db.all<{ id: string; kind: string; category: string | null; comment: string; created_at: string }>('SELECT id, kind, category, comment, created_at FROM feedback WHERE run_id = ? ORDER BY created_at', id),
    usage: ctx.db.all<{ provider: string; model: string; input_tokens: number | null; output_tokens: number | null; calls: number; cost_usd: number | null; basis: string }>('SELECT provider, model, input_tokens, output_tokens, calls, cost_usd, basis FROM usage WHERE run_id = ?', id),
    canManage: isOwner || roleHas(actor.role, 'agents.manage_all') || (roleHas(actor.role, 'agents.view_team') && r.team_id === actor.teamId),
    canGiveFeedback: isOwner
  }
}

export function listReviewTasks(ctx: AppContext, actor: Actor) {
  const owners = visibleOwnerIds(ctx, actor)
  return ctx.db
    .all<Record<string, unknown>>(
      `SELECT t.*, a.name AS agent_name, u.name AS assignee_name FROM review_tasks t JOIN runs r ON r.id = t.run_id JOIN agents a ON a.id = r.agent_id JOIN users u ON u.id = t.assignee_id
       WHERE t.status = 'open' AND ${owners === 'all' ? '1=1' : `(t.assignee_id = ? OR a.owner_id IN (${sqlIn(owners)}))`} ORDER BY t.created_at DESC`,
      ...(owners === 'all' ? [] : [actor.id, ...owners])
    )
    .map((t) => ({ id: t.id as string, runId: t.run_id as string, agentName: t.agent_name as string, kind: t.kind as string, title: t.title as string, prompt: t.prompt as string, createdAt: t.created_at as string, assignee: t.assignee_name as string, mine: t.assignee_id === actor.id }))
}

export function listOutputTables(ctx: AppContext, actor: Actor) {
  return ctx.db.all<{ id: string; name: string; columns: string; created_at: string }>('SELECT * FROM output_tables WHERE owner_id = ? ORDER BY name', actor.id).map((t) => ({
    id: t.id,
    name: t.name,
    columns: j<string[]>(t.columns, []),
    rows: ctx.db.all<{ id: string; data: string; run_id: string | null; created_at: string }>('SELECT * FROM output_rows WHERE table_id = ? ORDER BY created_at DESC LIMIT 200', t.id).map((r) => ({ id: r.id, runId: r.run_id, createdAt: r.created_at, data: j<Record<string, unknown>>(r.data, {}) })),
    exports: ctx.db.all<{ path: string; format: string; rows: number; created_at: string }>("SELECT path, format, rows, created_at FROM exports WHERE owner_id = ? AND path LIKE ? ORDER BY created_at DESC LIMIT 5", actor.id, `%${t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}%`)
  }))
}

/** Manual export from the Results page goes through the same tool path and export checks as agents. */
export async function exportOutputTable(ctx: AppContext, actor: Actor, table: string, format: 'csv' | 'json') {
  const r = await invokeTool(ctx, 'table.export', { table, format }, {
    ctx,
    actor,
    runId: null,
    agentId: null,
    teamId: actor.teamId,
    allowedCollections: null,
    idempotencyKey: newId('manual-export'),
    inputTaint: [],
    signal: new AbortController().signal,
    environment: 'live',
    log: () => undefined
  })
  return r.output as { path: string; rows: number }
}
