// Improvement loop for deployed agents. Uses reviewed feedback and run history to propose
// changes, evaluates candidates against a held-out set that proposal generation never sees,
// and requires approval before anything goes live. Nothing is trained automatically.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { canSeeOwner } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, forbidden, notFound, invalid } from '../core/errors'
import { roleHas } from '@shared/permissions'
import { AgentSpecSchema, type AgentSpec } from '@shared/domain'
import { createApproval, registerApprovalHandler } from './approvals'
import { getAgentRow, pinTools, validateSpec } from './agents'
import type { RunEngine } from '../engine/runner'
import { callModel, defaultModelRef } from './providers'

export const FAILURE_CATEGORIES = ['wrong_output', 'missing_information', 'wrong_tool', 'tool_error', 'too_slow', 'unsafe_action', 'other'] as const

export const FeedbackSchema = z.object({
  runId: z.string(),
  stepId: z.string().nullable().default(null),
  kind: z.enum(['accept', 'correct', 'failure', 'eval_example']),
  category: z.enum(FAILURE_CATEGORIES).optional(),
  correctedOutput: z.unknown().optional(),
  comment: z.string().max(2000).default('')
})

function runFor(ctx: AppContext, actor: Actor, runId: string) {
  const r = ctx.db.get<{ id: string; agent_id: string; inputs: string; outputs: string | null; status: string; created_by: string; trigger: string; is_fixture: number }>('SELECT * FROM runs WHERE id = ?', runId)
  if (!r) throw notFound('Run')
  const a = getAgentRow(ctx, r.agent_id)
  if (!canSeeOwner(ctx, actor, a.owner_id) && r.created_by !== actor.id) throw notFound('Run')
  return { run: r, agent: a }
}

/** Held-out assignment is a deterministic function of the inputs, so the same case always lands in the same split. */
function splitFor(inputs: unknown): 'holdout' | 'improvement' {
  const h = createHash('sha256').update(JSON.stringify(inputs)).digest()
  return h[0] % 4 === 0 ? 'holdout' : 'improvement'
}

export function submitFeedback(ctx: AppContext, actor: Actor, raw: z.input<typeof FeedbackSchema>) {
  const input = FeedbackSchema.parse(raw)
  const { run, agent } = runFor(ctx, actor, input.runId)
  if (run.is_fixture) throw invalid('Sample (fixture) runs cannot receive feedback; they did not actually execute.')
  if (input.kind === 'failure' && !input.category) throw invalid('Choose a failure category.')
  if (input.kind === 'correct' && input.correctedOutput === undefined) throw invalid('Provide the corrected output.')
  const id = newId('fb')
  ctx.db.insert('feedback', {
    id,
    run_id: run.id,
    step_id: input.stepId,
    user_id: actor.id,
    kind: input.kind,
    category: input.category ?? null,
    corrected_output: input.correctedOutput === undefined ? null : js(input.correctedOutput),
    comment: input.comment,
    status: 'new',
    created_at: now()
  })
  let evalExampleId: string | null = null
  if (input.kind === 'eval_example' || input.kind === 'correct' || input.kind === 'accept') {
    const expected = input.kind === 'correct' ? input.correctedOutput : j(run.outputs, {})
    if (input.kind !== 'accept' || input.comment.includes('#eval')) {
      evalExampleId = newId('ev')
      ctx.db.insert('eval_examples', {
        id: evalExampleId,
        agent_id: agent.id,
        inputs: run.inputs,
        expected: js(expected),
        split: splitFor(j(run.inputs, {})),
        source: input.kind === 'correct' ? 'correction' : 'reviewed_run',
        feedback_id: id,
        created_by: actor.id,
        created_at: now()
      })
    }
  }
  audit(ctx, actor, 'feedback.submitted', { type: 'run', id: run.id }, { kind: input.kind, category: input.category, evalExampleId })
  return { id, evalExampleId }
}

export function improvementOverview(ctx: AppContext, actor: Actor, agentId: string) {
  const a = getAgentRow(ctx, agentId)
  if (!canSeeOwner(ctx, actor, a.owner_id)) throw notFound('Agent')
  const feedback = ctx.db.all<{ id: string; run_id: string; step_id: string | null; kind: string; category: string | null; comment: string; status: string; created_at: string; user: string; corrected_output: string | null }>(
    'SELECT f.*, u.name AS user FROM feedback f JOIN runs r ON r.id = f.run_id JOIN users u ON u.id = f.user_id WHERE r.agent_id = ? ORDER BY f.created_at DESC',
    agentId
  )
  const examples = ctx.db.all<{ id: string; inputs: string; expected: string; split: string; source: string; created_at: string }>('SELECT * FROM eval_examples WHERE agent_id = ? ORDER BY created_at DESC', agentId)
  const proposals = ctx.db.all<Record<string, unknown>>('SELECT * FROM improvement_proposals WHERE agent_id = ? ORDER BY created_at DESC', agentId)
  return {
    feedback: feedback.map((f) => ({ ...f, correctedOutput: j(f.corrected_output, null) })),
    examples: examples.map((e) => ({ id: e.id, inputs: j(e.inputs, {}), expected: j(e.expected, null), split: e.split, source: e.source, createdAt: e.created_at })),
    counts: { holdout: examples.filter((e) => e.split === 'holdout').length, improvement: examples.filter((e) => e.split === 'improvement').length },
    proposals: proposals.map((p) => ({
      id: p.id as string,
      kind: p.kind as string,
      title: p.title as string,
      rationale: p.rationale as string,
      change: j(p.change, {}),
      evidence: j(p.evidence, []),
      expectedEffect: p.expected_effect as string,
      status: p.status as string,
      evaluation: j(p.evaluation, null),
      candidateVersionId: p.candidate_version_id as string | null,
      approvalId: p.approval_id as string | null,
      createdAt: p.created_at as string
    }))
  }
}

export function setExampleSplit(ctx: AppContext, actor: Actor, exampleId: string, split: 'holdout' | 'improvement') {
  const e = ctx.db.get<{ agent_id: string }>('SELECT agent_id FROM eval_examples WHERE id = ?', exampleId)
  if (!e) throw notFound('Example')
  const a = getAgentRow(ctx, e.agent_id)
  if (a.owner_id !== actor.id && !roleHas(actor.role, 'agents.view_team')) throw forbidden('Not allowed.')
  ctx.db.update('eval_examples', 'id', exampleId, { split })
}

interface Evidence {
  runId: string
  feedbackId?: string
  summary: string
}

/** Generate proposals from reviewed feedback and run history (improvement split only). */
export async function generateProposals(ctx: AppContext, actor: Actor, agentId: string, opts: { useModel?: boolean } = {}) {
  const a = getAgentRow(ctx, agentId)
  if (a.owner_id !== actor.id && !(roleHas(actor.role, 'agents.view_team') && a.team_id === actor.teamId) && !roleHas(actor.role, 'agents.manage_all')) throw forbidden('You cannot propose changes to this agent.')
  const baseId = a.live_version_id ?? a.draft_version_id!
  const base = AgentSpecSchema.parse(JSON.parse(ctx.db.get<{ spec: string }>('SELECT spec FROM agent_versions WHERE id = ?', baseId)!.spec))
  const holdoutInputs = new Set(ctx.db.all<{ inputs: string }>("SELECT inputs FROM eval_examples WHERE agent_id = ? AND split = 'holdout'", agentId).map((e) => e.inputs))
  const fb = ctx.db
    .all<{ id: string; run_id: string; step_id: string | null; kind: string; category: string | null; comment: string; corrected_output: string | null; inputs: string }>(
      "SELECT f.*, r.inputs FROM feedback f JOIN runs r ON r.id = f.run_id WHERE r.agent_id = ? AND f.status IN ('new','reviewed') AND f.kind != 'accept'",
      agentId
    )
    .filter((f) => !holdoutInputs.has(f.inputs)) // held-out cases never inform proposals
  const failedSteps = ctx.db.all<{ step_id: string; error: string; run_id: string }>(
    "SELECT s.step_id, s.error, s.run_id FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.agent_id = ? AND r.is_fixture = 0 AND s.status = 'failed' AND s.error IS NOT NULL ORDER BY s.started_at DESC LIMIT 200",
    agentId
  )
  const proposals: { kind: string; title: string; rationale: string; spec: AgentSpec; evidence: Evidence[]; expectedEffect: string }[] = []
  const clone = (): AgentSpec => JSON.parse(JSON.stringify(base))

  // 1. Repeated tool failures on one step → tolerate & route to review instead of failing the run.
  const byStep = new Map<string, { error: string; run_id: string }[]>()
  for (const f of failedSteps) byStep.set(f.step_id, [...(byStep.get(f.step_id) ?? []), f])
  for (const [stepId, fails] of byStep) {
    const step = base.steps.find((s) => s.id === stepId)
    if (!step || fails.length < 2 || step.onError !== 'fail') continue
    const spec = clone()
    spec.steps.find((s) => s.id === stepId)!.onError = step.kind === 'deterministic' && step.forEach ? 'skip' : 'review'
    proposals.push({
      kind: 'tool_selection',
      title: `Handle failures in “${step.title}” without failing the whole run`,
      rationale: `“${step.title}” failed in ${fails.length} recent runs (e.g. “${fails[0].error.slice(0, 140)}”).`,
      spec,
      evidence: fails.slice(0, 5).map((f) => ({ runId: f.run_id, summary: f.error.slice(0, 200) })),
      expectedEffect: step.forEach ? 'Skips individual items that fail (e.g. one unreachable page) and continues with the rest.' : 'Pauses for a person to retry, skip or supply the result instead of failing.'
    })
  }
  // 2. Corrections on a model step → add explicit guidance distilled from reviewer comments.
  const corrections = fb.filter((f) => f.kind === 'correct' || (f.kind === 'failure' && f.category === 'wrong_output'))
  const agentSteps = base.steps.filter((s) => s.kind === 'agent')
  if (corrections.length >= 1 && agentSteps.length) {
    const target = agentSteps.find((s) => corrections.some((c) => c.step_id === s.id)) ?? agentSteps[agentSteps.length - 1]
    const notes = corrections.map((c) => c.comment.trim()).filter(Boolean).slice(0, 8)
    let guidance = notes.length ? notes.map((n) => `- ${n}`).join('\n') : '- Match the corrected examples reviewers provided.'
    let drafted = false
    const ref = opts.useModel ? defaultModelRef(ctx) : null
    if (ref && notes.length) {
      try {
        const r = await callModel(ctx, {
          actor,
          providerId: ref.providerId,
          request: { model: ref.model, system: 'You rewrite reviewer feedback into short, specific instructions for an AI workflow step. Output only bullet points.', messages: [{ role: 'user', content: [{ type: 'text', text: `Step: ${target.title}\nCurrent instructions: ${target.prompt}\nReviewer feedback:\n${notes.join('\n')}` }] }], maxTokens: 400 },
          attribution: { kind: 'operating', teamId: a.team_id, agentId, userId: actor.id, project: 'improvements' },
          taint: base.collections,
          purpose: 'Draft instruction change'
        })
        guidance = r.text.trim()
        drafted = true
      } catch {
        /* fall back to the reviewer comments verbatim */
      }
    }
    const spec = clone()
    const s = spec.steps.find((x) => x.id === target.id)!
    s.prompt = `${s.prompt}\n\nReviewer guidance:\n${guidance}`.trim()
    proposals.push({
      kind: 'instruction_change',
      title: `Add reviewer guidance to “${target.title}”`,
      rationale: `${corrections.length} correction(s) or wrong-output reports.${drafted ? ' Guidance drafted by the configured model from reviewer comments.' : ' Guidance uses reviewer comments verbatim.'}`,
      spec,
      evidence: corrections.slice(0, 6).map((c) => ({ runId: c.run_id, feedbackId: c.id, summary: c.comment || 'Corrected output' })),
      expectedEffect: 'Fewer corrections on this step. Verify on the held-out set before deploying.'
    })
  }
  // 3. Unsafe actions or high-impact mistakes → human checkpoint.
  const unsafe = fb.filter((f) => f.kind === 'failure' && (f.category === 'unsafe_action' || f.category === 'wrong_tool'))
  if (unsafe.length) {
    const spec = clone()
    const risky = spec.steps.find((s) => s.kind === 'deterministic' && s.tool && !['web.search', 'web.extract', 'docs.search', 'data.query', 'web.compare', 'text.extract_fields'].includes(s.tool) && !s.approvalBefore)
    if (risky) {
      risky.approvalBefore = true
      proposals.push({ kind: 'human_checkpoint', title: `Add a checkpoint before “${risky.title}”`, rationale: `${unsafe.length} report(s) of unsafe or wrong actions.`, spec, evidence: unsafe.slice(0, 5).map((f) => ({ runId: f.run_id, feedbackId: f.id, summary: f.comment || f.category || '' })), expectedEffect: 'A person approves this action before it runs.' })
    }
  }
  // 4. Missing information → add a document search step before the first model step.
  const missing = fb.filter((f) => f.kind === 'failure' && f.category === 'missing_information')
  const docCollections = base.collections.filter((cid) => ctx.db.get<{ source_id: string }>('SELECT source_id FROM collections WHERE id = ?', cid))
  if (missing.length && !base.steps.some((s) => s.tool === 'docs.search') && docCollections.length) {
    const spec = clone()
    const idx = spec.steps.findIndex((s) => s.kind === 'agent')
    const firstInput = spec.inputs[0]?.key ?? 'topic'
    spec.steps.splice(Math.max(0, idx), 0, { id: 'search_procedures', title: 'Search company procedures', description: 'Find relevant internal guidance.', kind: 'deterministic', tool: 'docs.search', args: { query: `{{inputs.${firstInput}}}`, limit: 5 }, prompt: '', agentTools: [], outputFields: [], approvalBefore: false, onError: 'skip', maxRetries: 1 })
    if (idx >= 0) {
      const ag = spec.steps[idx + 1]
      ag.args = { ...ag.args, procedures: '{{steps.search_procedures.output.results}}' }
    }
    proposals.push({ kind: 'workflow_change', title: 'Search company procedures before drafting', rationale: `${missing.length} report(s) of missing information.`, spec, evidence: missing.slice(0, 5).map((f) => ({ runId: f.run_id, feedbackId: f.id, summary: f.comment || 'Missing information' })), expectedEffect: 'The model sees relevant internal guidance.' })
  }
  // 5. Another model: a registered classifier exists and outputs were wrong on a classification step.
  const activeModels = ctx.db.all<{ name: string; labels: string }>("SELECT name, labels FROM models WHERE status = 'active'")
  const wrong = fb.filter((f) => f.kind === 'failure' && f.category === 'wrong_output')
  const classifyStep = base.steps.find((s) => s.kind === 'agent' && /classif|categor|route|label/i.test(`${s.title} ${s.prompt}`))
  if (activeModels.length && wrong.length && classifyStep) {
    const m = activeModels[0]
    const spec = clone()
    const st = spec.steps.find((s) => s.id === classifyStep.id)!
    const key = `model.${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    if (!st.agentTools.includes(key)) st.agentTools = [...st.agentTools, key]
    st.prompt = `${st.prompt}\n\nUse the ${m.name} classifier tool to choose the category, then explain the choice.`
    proposals.push({ kind: 'another_model', title: `Use the fine-tuned “${m.name}” classifier in “${classifyStep.title}”`, rationale: `${wrong.length} wrong-output report(s) on a categorization step; a specialized model trained on labeled history is available.`, spec, evidence: wrong.slice(0, 5).map((f) => ({ runId: f.run_id, feedbackId: f.id, summary: f.comment || 'Wrong output' })), expectedEffect: 'Consistent categories that match historical labels. Compare on the held-out set.' })
  }
  // 6. Candidate training dataset: only proposed, never trained automatically.
  if (corrections.length >= 20) {
    proposals.push({ kind: 'training_dataset', title: 'Collect corrections as a candidate training dataset', rationale: `${corrections.length} corrected outputs could become labeled training data. Training would need a collection approved for training and a manager’s approval.`, spec: clone(), evidence: corrections.slice(0, 5).map((c) => ({ runId: c.run_id, feedbackId: c.id, summary: c.comment })), expectedEffect: 'A labeled dataset for a future specialized model. No training happens automatically.' })
  }
  const created = []
  for (const p of proposals) {
    const id = newId('imp')
    ctx.db.insert('improvement_proposals', { id, agent_id: agentId, base_version_id: baseId, kind: p.kind, title: p.title, rationale: p.rationale, change: js(p.spec), evidence: js(p.evidence), expected_effect: p.expectedEffect, status: 'proposed', created_by: actor.id, created_at: now() })
    created.push(id)
  }
  if (fb.length) ctx.db.run(`UPDATE feedback SET status = 'reviewed' WHERE id IN (${fb.map(() => '?').join(',')})`, ...fb.map((f) => f.id))
  audit(ctx, actor, 'improvements.generated', { type: 'agent', id: agentId }, { proposals: created.length, feedbackUsed: fb.length })
  return { created: created.length, note: proposals.length ? undefined : 'Not enough reviewed feedback or run history to propose changes yet.' }
}

function score(expected: unknown, actual: unknown): number {
  if (expected === null || expected === undefined) return actual ? 1 : 0
  if (typeof expected !== 'object') return normalize(expected) === normalize(actual) || normalize(actual).includes(normalize(expected)) ? 1 : 0
  const keys = Object.keys(expected as object)
  if (!keys.length) return 1
  const act = (actual && typeof actual === 'object' ? actual : {}) as Record<string, unknown>
  return keys.reduce((s, k) => s + score((expected as Record<string, unknown>)[k], act[k] ?? findDeep(act, k)), 0) / keys.length
}

function findDeep(o: unknown, key: string): unknown {
  if (!o || typeof o !== 'object') return undefined
  for (const [k, v] of Object.entries(o)) {
    if (k === key) return v
    const d = findDeep(v, key)
    if (d !== undefined) return d
  }
  return undefined
}

function normalize(v: unknown) {
  return String(typeof v === 'object' ? JSON.stringify(v) : (v ?? '')).toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Run the current version and the candidate on the held-out examples and compare. */
export async function evaluateProposal(ctx: AppContext, actor: Actor, engine: RunEngine, proposalId: string) {
  const p = ctx.db.get<{ id: string; agent_id: string; base_version_id: string; change: string; candidate_version_id: string | null; status: string; kind: string }>('SELECT * FROM improvement_proposals WHERE id = ?', proposalId)
  if (!p) throw notFound('Proposal')
  const a = getAgentRow(ctx, p.agent_id)
  if (a.owner_id !== actor.id && !roleHas(actor.role, 'agents.manage_all')) throw forbidden('Only the agent owner (or an administrator) runs evaluations, because evaluation runs act with the owner’s access.')
  const holdout = ctx.db.all<{ id: string; inputs: string; expected: string }>("SELECT * FROM eval_examples WHERE agent_id = ? AND split = 'holdout' LIMIT 10", p.agent_id)
  if (!holdout.length) throw new RelayError('conflict', 'Add held-out evaluation examples first (use “Add as evaluation example” on reviewed runs).')
  let candidateId = p.candidate_version_id
  if (!candidateId) {
    const spec = pinTools(ctx, AgentSpecSchema.parse(JSON.parse(p.change)))
    const problems = validateSpec(spec)
    if (problems.length) throw invalid(problems.join(' '))
    const max = ctx.db.get<{ v: number }>('SELECT MAX(version) v FROM agent_versions WHERE agent_id = ?', p.agent_id)!.v
    candidateId = newId('agv')
    ctx.db.insert('agent_versions', { id: candidateId, agent_id: p.agent_id, version: max + 1, spec: js(spec), created_by: actor.id, created_at: now(), note: `Candidate from proposal ${p.id}`, source: 'proposal' })
    ctx.db.update('improvement_proposals', 'id', p.id, { candidate_version_id: candidateId })
  }
  ctx.db.update('improvement_proposals', 'id', p.id, { status: 'evaluating' })
  const evalVersion = async (versionId: string) => {
    const results = []
    for (const ex of holdout) {
      const runId = engine.start(actor, { agentId: p.agent_id, versionId, environment: 'test', inputs: j(ex.inputs, {}), trigger: 'eval' })
      const status = await engine.waitFor(runId, 600_000)
      const r = engine.run(runId)
      results.push({ exampleId: ex.id, runId, status, score: status === 'succeeded' ? score(j(ex.expected, null), j(r.outputs, null)) : 0, costUsd: r.cost_metered + r.cost_estimated })
    }
    const n = results.length
    return { results, meanScore: results.reduce((s, r) => s + r.score, 0) / n, successRate: results.filter((r) => r.status === 'succeeded').length / n, costUsd: results.reduce((s, r) => s + r.costUsd, 0) }
  }
  const current = await evalVersion(p.base_version_id)
  const candidate = await evalVersion(candidateId)
  const evaluation = { at: now(), examples: holdout.length, current, candidate, note: 'Scores compare run outputs with the reviewed expected outputs on held-out examples that proposal generation never used. Writes and human checkpoints are skipped in evaluation runs.' }
  ctx.db.update('improvement_proposals', 'id', p.id, { status: 'evaluated', evaluation: js(evaluation) })
  audit(ctx, actor, 'improvement.evaluated', { type: 'proposal', id: p.id }, { current: current.meanScore, candidate: candidate.meanScore })
  return evaluation
}

export async function submitProposal(ctx: AppContext, actor: Actor, proposalId: string, reason: string) {
  const p = ctx.db.get<{ id: string; agent_id: string; title: string; status: string; candidate_version_id: string | null; evaluation: string | null; kind: string }>('SELECT * FROM improvement_proposals WHERE id = ?', proposalId)
  if (!p) throw notFound('Proposal')
  if (p.kind === 'training_dataset') throw new RelayError('policy', 'Training datasets are created from approved collections in Data → Find model opportunities; this proposal is informational.')
  if (p.status !== 'evaluated' || !p.candidate_version_id) throw new RelayError('conflict', 'Evaluate the proposal on the held-out set before requesting deployment.')
  const a = getAgentRow(ctx, p.agent_id)
  const approval = createApproval(ctx, actor, { type: 'improvement', title: `Improvement for ${a.name}: ${p.title}`, reason, payload: { proposalId: p.id, agentId: a.id, versionId: p.candidate_version_id, evaluation: j(p.evaluation, null) }, targetType: 'agent', targetId: a.id })
  ctx.db.update('improvement_proposals', 'id', p.id, { status: 'approval_pending', approval_id: approval.id })
  return approval
}

export function rejectProposal(ctx: AppContext, actor: Actor, proposalId: string) {
  const p = ctx.db.get<{ agent_id: string }>('SELECT agent_id FROM improvement_proposals WHERE id = ?', proposalId)
  if (!p) throw notFound('Proposal')
  const a = getAgentRow(ctx, p.agent_id)
  if (a.owner_id !== actor.id && !roleHas(actor.role, 'agents.view_team')) throw forbidden('Not allowed.')
  ctx.db.update('improvement_proposals', 'id', proposalId, { status: 'dismissed' })
}

export function registerImprovementApprovalHandler() {
  registerApprovalHandler('improvement', {
    apply: (ctx, approver, a) => {
      const p = j<{ proposalId: string; agentId: string; versionId: string }>(a.payload, { proposalId: '', agentId: '', versionId: '' })
      const agent = getAgentRow(ctx, p.agentId)
      ctx.db.update('agents', 'id', p.agentId, { draft_version_id: p.versionId, ...(agent.status === 'live' || agent.status === 'paused' ? { live_version_id: p.versionId } : {}), updated_at: now() })
      ctx.db.update('improvement_proposals', 'id', p.proposalId, { status: 'applied' })
      audit(ctx, approver, 'agent.deployed', { type: 'agent', id: p.agentId }, { versionId: p.versionId, mode: agent.deployment ?? 'personal', viaApproval: true, source: 'improvement' })
    },
    onReject: (ctx, _a, a) => {
      const p = j<{ proposalId: string }>(a.payload, { proposalId: '' })
      ctx.db.update('improvement_proposals', 'id', p.proposalId, { status: 'rejected' })
    }
  })
}
