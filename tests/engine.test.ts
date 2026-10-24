import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeRelay, testSecrets, type TestRelay } from './helpers'
import { startMockAnthropic, type MockLlm } from './mock-llm'
import { createRelay } from '../src/main/bootstrap'
import { createAgent, deployAgent, rollback, saveDraft } from '../src/main/services/agents'
import { upsertProvider, callModel } from '../src/main/services/providers'
import { getPolicy, setSetting } from '../src/main/core/settings'
import { reserve, reconcile } from '../src/main/services/budget'
import { actorFor } from '../src/main/core/authz'
import { AgentSpecSchema, type AgentSpec } from '../src/shared/domain'
import { invokeTool } from '../src/main/tools/registry'
import { newId } from '../src/main/db/database'

let t: TestRelay
let llm: MockLlm
let providerId: string

beforeAll(async () => {
  t = await makeRelay()
  llm = await startMockAnthropic(() => JSON.stringify({ summary: 'ok', recommendation: 'approve' }))
  const p = getPolicy(t.ctx)
  setSetting(t.ctx, 'policy', { ...p, allowedExternalDestinations: [...p.allowedExternalDestinations, '127.0.0.1'] })
  providerId = upsertProvider(t.ctx, t.sam, { kind: 'anthropic', name: 'Mock Claude', baseUrl: llm.url, apiKey: 'sk-test-key-123456', models: ['claude-haiku-5-5'], enabled: true }).id
})
afterAll(async () => {
  await llm.close()
  await t.cleanup()
})

function spec(steps: Record<string, unknown>[], extra: Partial<AgentSpec> = {}): AgentSpec {
  return AgentSpecSchema.parse({
    schemaVersion: 1,
    inputs: [{ key: 'topic', label: 'Topic', type: 'string', required: false, description: '' }],
    steps: steps.map((s) => ({ description: '', args: {}, prompt: '', agentTools: [], outputFields: [], approvalBefore: false, onError: 'fail', maxRetries: 1, ...s })),
    ...extra
  })
}

async function run(agentId: string, env: 'test' | 'live' = 'test', inputs: Record<string, unknown> = { topic: 'x' }) {
  const id = t.relay.engine.start(t.alex, { agentId, environment: env, inputs })
  const status = await t.relay.engine.waitFor(id)
  return { id, status, run: t.relay.engine.run(id) }
}

describe('data egress', () => {
  it('blocks sending a local-only collection to an external provider', async () => {
    await expect(
      callModel(t.ctx, {
        actor: t.alex,
        providerId,
        request: { model: 'claude-haiku-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 50 },
        attribution: { kind: 'operating', userId: t.alex.id },
        taint: [t.ids.cIncidents],
        purpose: 'test'
      })
    ).rejects.toThrow(/local-only/)
    expect(llm.calls).toHaveLength(0)
  })

  it('blocks an agent run when local-only data flows into an external model step', async () => {
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Egress test',
      spec: spec(
        [
          { id: 'read', title: 'Read incidents', kind: 'deterministic', tool: 'data.query', args: { collectionId: t.ids.cIncidents, query: { limit: 3 } } },
          { id: 'summarize', title: 'Summarize', kind: 'agent', prompt: 'Summarize', args: { rows: '{{steps.read.output.rows}}' }, model: { providerId, model: 'claude-haiku-5-5' } }
        ],
        { collections: [t.ids.cIncidents] }
      )
    })
    const r = await run(id)
    expect(r.status).toBe('blocked')
    expect(r.run.error).toMatch(/local-only/)
    expect(llm.calls).toHaveLength(0)
  })

  it('blocks web tools from receiving local-only data', async () => {
    const tc = { ctx: t.ctx, actor: t.alex, runId: null, agentId: null, teamId: t.alex.teamId, allowedCollections: null, idempotencyKey: newId('t'), inputTaint: [t.ids.cIncidents], signal: new AbortController().signal, environment: 'test' as const, log: () => undefined }
    await expect(invokeTool(t.ctx, 'web.extract', { url: 'https://example.com/' }, tc)).rejects.toThrow(/local-only/)
  })

  it('allows data that may leave and meters provider-reported usage', async () => {
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Allowed egress',
      spec: spec(
        [
          { id: 'find', title: 'Search procedures', kind: 'deterministic', tool: 'docs.search', args: { query: 'vendor security review' } },
          { id: 'summarize', title: 'Summarize', kind: 'agent', prompt: 'Summarize', args: { hits: '{{steps.find.output.results}}' }, outputFields: [{ key: 'summary', type: 'string', description: '' }], model: { providerId, model: 'claude-haiku-5-5' } }
        ],
        { collections: [t.ids.cProcedures] }
      )
    })
    const r = await run(id)
    expect(r.run.error).toBeNull()
    expect(r.status).toBe('succeeded')
    expect(llm.calls.length).toBe(1)
    // 1000 input + 200 output tokens at $0.10 / $0.50 per 1M = $0.0002, metered (not estimated).
    expect(r.run.cost_metered).toBeCloseTo(0.0002, 6)
    // Retrieved content is passed as data with an explicit instruction not to follow it.
    expect(JSON.stringify(llm.calls[0].body)).toMatch(/untrusted data/)
  })
})

describe('budget reservations', () => {
  it('never lets concurrent reservations exceed a hard limit', async () => {
    t.ctx.db.run("INSERT INTO budgets (id, scope, scope_id, kind, period, limit_usd, alert_pct, hard_limit, created_at, updated_at) VALUES ('bud_conc','agent','agt_conc','operating','monthly',1.0,80,1,'x','x')")
    const attempt = async () => {
      let resId: string
      try {
        resId = reserve(t.ctx, { kind: 'operating', agentId: 'agt_conc' }, 0.3, 'concurrent test')
      } catch {
        return false
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 20))
      reconcile(t.ctx, resId, 0.3, 'metered')
      return true
    }
    const results = await Promise.all(Array.from({ length: 10 }, attempt))
    expect(results.filter(Boolean)).toHaveLength(3)
    const total = t.ctx.db.get<{ s: number }>("SELECT SUM(amount_usd) s FROM ledger WHERE agent_id = 'agt_conc' AND entry_type = 'charge'")!.s
    expect(total).toBeLessThanOrEqual(1.0)
  })

  it('blocks concurrent agent runs once their reserved estimates fill the agent budget', async () => {
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Budget test',
      spec: spec([{ id: 'ask', title: 'Ask', kind: 'agent', prompt: 'Say hi', model: { providerId, model: 'claude-haiku-5-5' } }], { collections: [] })
    })
    // Each model call reserves ~ (input estimate + 4000 output tokens) × price ≈ $0.0021. Allow room for two.
    t.ctx.db.run("UPDATE budgets SET limit_usd = 0.0045 WHERE scope = 'agent' AND scope_id = ?", id)
    const ids = Array.from({ length: 5 }, () => t.relay.engine.start(t.alex, { agentId: id, environment: 'test', inputs: {} }))
    const statuses = await Promise.all(ids.map((r) => t.relay.engine.waitFor(r)))
    expect(statuses.filter((s) => s === 'succeeded').length).toBe(2)
    expect(statuses.filter((s) => s === 'blocked').length).toBe(3)
    const blocked = ids.map((r) => t.relay.engine.run(r)).find((r) => r.status === 'blocked')!
    expect(blocked.error).toMatch(/budget/)
  })

  it('refuses paid calls with unknown pricing instead of treating them as free', async () => {
    upsertProvider(t.ctx, t.sam, { id: providerId, kind: 'anthropic', name: 'Mock Claude', baseUrl: llm.url, models: ['claude-haiku-5-5', 'claude-unpriced'], enabled: true })
    await expect(
      callModel(t.ctx, { actor: t.alex, providerId, request: { model: 'claude-unpriced', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 10 }, attribution: { kind: 'operating' }, taint: [], purpose: 't' })
    ).rejects.toThrow(/No price is configured/)
  })
})

describe('human review handoffs', () => {
  it('pauses for review and resumes with the reviewer’s edits', async () => {
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Review test',
      spec: spec([
        { id: 'draft', title: 'Draft', kind: 'deterministic', tool: 'text.extract_fields', args: { text: 'Contact a@b.co about {{inputs.topic}}', fields: [{ name: 'emails', kind: 'email' }] } },
        { id: 'check', title: 'Check', kind: 'human_review', args: { data: '{{steps.draft.output.fields}}' } },
        { id: 'save', title: 'Save', kind: 'deterministic', tool: 'table.write', args: { table: 'Reviewed', row: { data: '{{steps.check.output.data}}' } } }
      ])
    })
    const runId = t.relay.engine.start(t.alex, { agentId: id, environment: 'test', inputs: { topic: 'x' } })
    expect(await t.relay.engine.waitFor(runId)).toBe('needs_review')
    const task = t.ctx.db.get<{ id: string }>("SELECT id FROM review_tasks WHERE run_id = ? AND status = 'open'", runId)!
    // Someone outside the team cannot resolve it.
    expect(() => t.relay.engine.resolveReview(t.mei, task.id, { decision: 'approve' })).toThrow(/assigned/)
    t.relay.engine.resolveReview(t.alex, task.id, { decision: 'edit', data: { emails: ['edited@example.com'] } })
    expect(await t.relay.engine.waitFor(runId)).toBe('succeeded')
    const row = t.ctx.db.get<{ data: string }>("SELECT r.data FROM output_rows r JOIN output_tables tb ON tb.id = r.table_id WHERE tb.name = 'Reviewed'")!
    expect(row.data).toContain('edited@example.com')
  })

  it('stops at an approval checkpoint until approved', async () => {
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Checkpoint test',
      spec: spec([{ id: 'note', title: 'Notify', kind: 'deterministic', tool: 'notify.user', args: { title: 'Hello' }, approvalBefore: true }])
    })
    const runId = t.relay.engine.start(t.alex, { agentId: id, environment: 'test', inputs: {} })
    expect(await t.relay.engine.waitFor(runId)).toBe('needs_review')
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM run_steps WHERE run_id = ? AND step_id = 'note' AND status = 'succeeded'", runId)!.n).toBe(0)
    const task = t.ctx.db.get<{ id: string }>("SELECT id FROM review_tasks WHERE run_id = ? AND status = 'open'", runId)!
    t.relay.engine.resolveReview(t.alex, task.id, { decision: 'approve' })
    expect(await t.relay.engine.waitFor(runId)).toBe('succeeded')
  })
})

describe('restart recovery and idempotency', () => {
  it('resumes after a restart without repeating completed writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-restart-'))
    const open = () => createRelay({ dataDir: dir, resourcesDir: resolve('resources'), pythonDir: resolve('python'), secrets: testSecrets })
    let relay = await open()
    const alex = actorFor(relay.ctx, 'u_alex')
    const { id } = createAgent(relay.ctx, alex, {
      name: 'Restart test',
      spec: spec([
        { id: 'write', title: 'Write', kind: 'deterministic', tool: 'table.write', args: { table: 'Restart', rows: [{ n: 1 }, { n: 2 }] } },
        { id: 'check', title: 'Check', kind: 'human_review', args: { data: 'ok' } },
        { id: 'write2', title: 'Write again', kind: 'deterministic', tool: 'table.write', args: { table: 'Restart', row: { n: 3 } } }
      ])
    })
    const runId = relay.engine.start(alex, { agentId: id, environment: 'test', inputs: {} })
    expect(await relay.engine.waitFor(runId)).toBe('needs_review')
    // Simulate a crash after the first write's side effect but before its checkpoint was saved.
    relay.ctx.db.run("DELETE FROM run_steps WHERE run_id = ? AND step_id = 'write'", runId)
    relay.ctx.db.run("UPDATE review_tasks SET status = 'cancelled' WHERE run_id = ?", runId)
    relay.ctx.db.run("UPDATE runs SET status = 'running' WHERE id = ?", runId)
    await relay.stop()

    relay = await open()
    await relay.start()
    expect(await relay.engine.waitFor(runId)).toBe('needs_review')
    const events = relay.ctx.db.all<{ type: string }>('SELECT type FROM run_events WHERE run_id = ?', runId).map((e) => e.type)
    expect(events).toContain('interrupted')
    const task = relay.ctx.db.get<{ id: string }>("SELECT id FROM review_tasks WHERE run_id = ? AND status = 'open'", runId)!
    relay.engine.resolveReview(actorFor(relay.ctx, 'u_alex'), task.id, { decision: 'approve' })
    expect(await relay.engine.waitFor(runId)).toBe('succeeded')
    const rows = relay.ctx.db.all<{ data: string }>("SELECT r.data FROM output_rows r JOIN output_tables tb ON tb.id = r.table_id WHERE tb.name = 'Restart'")
    expect(rows.map((r) => JSON.parse(r.data).n).sort()).toEqual([1, 2, 3])
    await relay.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('re-checks data grants when a run resumes', async () => {
    const g = await t.ipc<{ id: string }>('u_sam', 'data.grant', { collectionId: t.ids.cVendors, principalType: 'user', principalId: 'u_alex', purposes: ['retrieval'], canDelegate: false, note: '' })
    expect(g.ok).toBe(true)
    const { id } = createAgent(t.ctx, t.alex, {
      name: 'Grant recheck',
      spec: spec(
        [
          { id: 'check', title: 'Check', kind: 'human_review', args: { data: 'x' } },
          { id: 'read', title: 'Read vendors', kind: 'deterministic', tool: 'db.query', args: { collectionId: t.ids.cVendors, query: { limit: 2 } } }
        ],
        { collections: [t.ids.cVendors] }
      )
    })
    const runId = t.relay.engine.start(t.alex, { agentId: id, environment: 'test', inputs: {} })
    expect(await t.relay.engine.waitFor(runId)).toBe('needs_review')
    for (const gr of t.ctx.db.all<{ id: string }>("SELECT id FROM grants WHERE collection_id = ? AND principal_id = 'u_alex' AND revoked_at IS NULL", t.ids.cVendors)) await t.ipc('u_sam', 'data.revoke', { id: gr.id })
    const task = t.ctx.db.get<{ id: string }>("SELECT id FROM review_tasks WHERE run_id = ? AND status = 'open'", runId)!
    t.relay.engine.resolveReview(t.alex, task.id, { decision: 'approve' })
    expect(await t.relay.engine.waitFor(runId)).toBe('blocked')
    expect(t.relay.engine.run(runId).error).toMatch(/Data access changed/)
  })
})

describe('versions and rollback', () => {
  it('keeps runs on their version and rolls back only to previously live versions', async () => {
    const s1 = spec([{ id: 'a', title: 'v1 step', kind: 'deterministic', tool: 'text.classify_keywords', args: { text: '{{inputs.topic}}', categories: { one: ['x'] } } }], { outputs: [{ key: 'label', label: 'Label', from: '{{steps.a.output.label}}' }] })
    const { id, versionId: v1 } = createAgent(t.ctx, t.alex, { name: 'Versioned', spec: s1 })
    expect((await run(id)).status).toBe('succeeded')
    expect((await deployAgent(t.ctx, t.alex, id, 'personal')).status).toBe('live')
    const s2 = { ...s1, steps: [{ ...s1.steps[0], title: 'v2 step', args: { ...s1.steps[0].args, categories: { two: ['x'] } } }] }
    const { versionId: v2 } = saveDraft(t.ctx, t.alex, id, { spec: s2 })
    expect(v2).not.toBe(v1)
    // Live still runs v1 until v2 is tested and deployed.
    const live1 = await run(id, 'live')
    expect(live1.run.agent_version_id).toBe(v1)
    expect(JSON.parse(live1.run.outputs!).label).toBe('one')
    expect((await run(id)).status).toBe('succeeded')
    await deployAgent(t.ctx, t.alex, id, 'personal')
    const live2 = await run(id, 'live')
    expect(JSON.parse(live2.run.outputs!).label).toBe('two')
    const rb = rollback(t.ctx, t.alex, id, v1)
    expect(rb.note).toMatch(/does not undo/)
    const live3 = await run(id, 'live')
    expect(live3.run.agent_version_id).toBe(v1)
    // The earlier run keeps its own version record.
    expect(t.relay.engine.run(live2.id).agent_version_id).toBe(v2)
    const { versionId: v3 } = saveDraft(t.ctx, t.alex, id, { spec: { ...s2, instructions: 'never deployed' } })
    expect(() => rollback(t.ctx, t.alex, id, v3)).toThrow(/previously live/)
  })

  it('kill switch stops live runs and blocks new ones', async () => {
    const { id } = createAgent(t.ctx, t.alex, { name: 'Killable', spec: spec([{ id: 'c', title: 'Check', kind: 'human_review', args: { data: 'x' } }]) })
    expect((await run(id)).status).toBe('needs_review')
    t.ctx.db.run("UPDATE agents SET status = 'live', live_version_id = draft_version_id WHERE id = ?", id)
    const live = t.relay.engine.start(t.alex, { agentId: id, environment: 'live', inputs: {} })
    expect(await t.relay.engine.waitFor(live)).toBe('needs_review')
    const r = await t.ipc('u_priya', 'agents.state', { id, action: 'kill_on' })
    expect(r.ok).toBe(true)
    expect(t.relay.engine.run(live).status).toBe('cancelled')
    expect(() => t.relay.engine.start(t.alex, { agentId: id, environment: 'live', inputs: {} })).toThrow(/kill switch/i)
  })
})

describe('approvals for deployment', () => {
  it('routes team deployment through the manager and applies it on approval', async () => {
    const { id } = createAgent(t.ctx, t.alex, { name: 'Team agent', spec: spec([{ id: 'a', title: 'A', kind: 'deterministic', tool: 'text.extract_fields', args: { text: 'x', fields: [{ name: 'e', kind: 'email' }] } }]) })
    expect((await run(id)).status).toBe('succeeded')
    const d = await deployAgent(t.ctx, t.alex, id, 'team', 'Share with ops')
    expect(d.status).toBe('awaiting_approval')
    const omarTry = await t.ipc('u_omar', 'approvals.decide', { id: d.approvalId, decision: 'approve' })
    expect(!omarTry.ok && omarTry.error.code).toBe('forbidden')
    const ok = await t.ipc('u_priya', 'approvals.decide', { id: d.approvalId, decision: 'approve' })
    expect(ok.ok).toBe(true)
    const a = t.ctx.db.get<{ status: string; deployment: string }>('SELECT status, deployment FROM agents WHERE id = ?', id)!
    expect(a).toEqual({ status: 'live', deployment: 'team' })
  })
})
