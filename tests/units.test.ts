import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCsv, parseJsonTable, readDocumentText, unsupportedReason } from '../src/main/connectors/parse'
import { runStructuredQuery, applySelection, StructuredQuerySchema } from '../src/main/connectors/query'
import { resolveArgs, evaluateCondition } from '../src/main/engine/templates'
import { makePdf } from '../src/main/db/synthetic'
import { nextRunAt, Scheduler } from '../src/main/services/scheduler'
import { makeRelay, type TestRelay } from './helpers'
import { createAgent } from '../src/main/services/agents'
import { createWorkflow, recommend } from '../src/main/services/workflows'
import { submitFeedback, generateProposals, evaluateProposal, improvementOverview } from '../src/main/services/improvements'
import { AgentSpecSchema, WorkflowDraftSchema } from '../src/shared/domain'

describe('connectors', () => {
  it('parses quoted CSV with embedded commas, quotes and newlines', () => {
    const t = parseCsv('id,text,n\n1,"hello, ""world""\nline two",3\n2,plain,04\n')
    expect(t.columns).toEqual(['id', 'text', 'n'])
    expect(t.rows[0].text).toBe('hello, "world"\nline two')
    expect(t.rows[0].n).toBe(3)
    expect(t.rows[1].n).toBe('04') // leading zeros are kept as text
  })

  it('reads JSON arrays and JSONL, reporting bad lines', () => {
    expect(parseJsonTable('[{"a":1},{"a":2,"b":{"c":1}}]', false).columns).toEqual(['a', 'b'])
    const j = parseJsonTable('{"a":1}\nnot json\n{"a":3}', true)
    expect(j.rows).toHaveLength(2)
    expect(j.warnings[0]).toMatch(/Line 2/)
  })

  it('extracts text PDFs and refuses scanned ones with an OCR message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-'))
    writeFileSync(join(dir, 'a.pdf'), makePdf(['Retention policy: keep tickets for three years.', 'Second line of text here.']))
    writeFileSync(join(dir, 'scan.pdf'), makePdf([]))
    expect((await readDocumentText(join(dir, 'a.pdf'))).text).toMatch(/three years/)
    await expect(readDocumentText(join(dir, 'scan.pdf'))).rejects.toThrow(/OCR/)
  })

  it('explains unsupported formats instead of returning empty text', () => {
    expect(unsupportedReason('x.docx')).toMatch(/Word/)
    expect(unsupportedReason('x.xlsx')).toMatch(/CSV/)
    expect(unsupportedReason('x.csv')).toBeNull()
  })
})

describe('structured queries', () => {
  const table = { columns: ['cat', 'n', 'secret'], rows: [{ cat: 'a', n: 1, secret: 's' }, { cat: 'b', n: 5, secret: 's' }, { cat: 'a', n: 3, secret: 's' }], warnings: [] }
  it('applies row filters and column limits first', () => {
    const sel = applySelection(table, ['cat', 'n'], [{ column: 'n', op: 'gte', value: 3 }])
    expect(sel.columns).toEqual(['cat', 'n'])
    expect(sel.rows).toHaveLength(2)
  })
  it('aggregates and refuses unknown columns', () => {
    const r = runStructuredQuery(table, StructuredQuerySchema.parse({ groupBy: 'cat', aggregate: { fn: 'sum', column: 'n' }, orderBy: { column: 'sum_n', direction: 'desc' } }))
    expect(r.rows).toEqual([{ cat: 'b', sum_n: 5 }, { cat: 'a', sum_n: 4 }])
    const restricted = applySelection(table, ['cat'], [])
    expect(() => runStructuredQuery(restricted, StructuredQuerySchema.parse({ columns: ['secret'] }))).toThrow(/not available/)
  })
})

describe('templates', () => {
  it('resolves references, keeps types, and tracks data provenance', () => {
    const scope = { inputs: { q: 'hi' }, steps: { s1: { output: { rows: [1, 2] }, taint: ['col_a'] } }, run: { id: 'r', startedAt: '' } }
    const r = resolveArgs({ rows: '{{steps.s1.output.rows}}', text: 'Q={{inputs.q}} n={{steps.s1.output.rows[1]}}' }, scope)
    expect(r.args.rows).toEqual([1, 2])
    expect(r.args.text).toBe('Q=hi n=2')
    expect(r.taint).toEqual(['col_a'])
    expect(evaluateCondition({ left: '{{steps.s1.output.rows}}', op: 'truthy' }, scope)).toBe(true)
    expect(evaluateCondition({ left: '{{inputs.q}}', op: 'eq', right: 'bye' }, scope)).toBe(false)
  })
})

describe('local schedules', () => {
  let t: TestRelay
  beforeAll(async () => {
    t = await makeRelay()
  })
  afterAll(() => t.cleanup())

  it('computes the next run for daily and weekly schedules', () => {
    const from = new Date(2026, 9, 24, 10, 0)
    expect(new Date(nextRunAt({ kind: 'daily', timeOfDay: '09:00', catchUp: 'run_once', inputs: {} }, from)).getDate()).toBe(25)
    expect(new Date(nextRunAt({ kind: 'weekly', timeOfDay: '09:00', weekday: 1, catchUp: 'run_once', inputs: {} }, from)).getDay()).toBe(1)
  })

  it('records missed runs while closed and starts a single catch-up run', async () => {
    t.ctx.db.run("INSERT INTO schedules (id, agent_id, config, enabled, next_run_at, created_at) VALUES ('sch_t','agt_digest',?,1,?,?)", JSON.stringify({ kind: 'interval', everyMinutes: 60, catchUp: 'run_once', inputs: { since: '2025-06-01' } }), new Date(Date.now() - 5 * 3600_000).toISOString(), new Date().toISOString())
    new Scheduler(t.ctx, t.relay.engine, 30_000).tick(new Date())
    const ev = t.ctx.db.all<{ outcome: string; run_id: string | null }>("SELECT outcome, run_id FROM schedule_events WHERE schedule_id = 'sch_t'")
    expect(ev.filter((e) => e.outcome === 'missed').length).toBeGreaterThanOrEqual(5)
    const catchUp = ev.filter((e) => e.outcome === 'catch_up_run')
    expect(catchUp).toHaveLength(1)
    expect(await t.relay.engine.waitFor(catchUp[0].run_id!)).toBe('succeeded')
  })

  it('with “skip”, records misses without running', () => {
    t.ctx.db.run("INSERT INTO schedules (id, agent_id, config, enabled, next_run_at, created_at) VALUES ('sch_s','agt_digest',?,1,?,?)", JSON.stringify({ kind: 'interval', everyMinutes: 60, catchUp: 'skip', inputs: {} }), new Date(Date.now() - 3 * 3600_000).toISOString(), new Date().toISOString())
    new Scheduler(t.ctx, t.relay.engine, 30_000).tick(new Date())
    const ev = t.ctx.db.all<{ outcome: string }>("SELECT outcome FROM schedule_events WHERE schedule_id = 'sch_s'")
    expect(ev.every((e) => e.outcome === 'missed')).toBe(true)
  })

  it('recommends human or manual steps when no tool can do the work, and adds checkpoints for sending', () => {
    const draft = WorkflowDraftSchema.parse({
      name: 'w',
      frequencyPerWeek: 5,
      minutesPerRun: 30,
      steps: [
        { id: 's1', title: 'Click through the ERP', capability: 'desktop_action' },
        { id: 's2', title: 'Search procedures', capability: 'doc_search', inputsClear: 'yes', successClear: 'yes' },
        { id: 's3', title: 'Email the vendor', capability: 'send_message', inputsClear: 'yes', successClear: 'yes' },
        { id: 's4', title: 'Decide approval', capability: 'generate', decisionPoint: true }
      ]
    })
    createWorkflow(t.ctx, t.alex, { draft })
    const plan = recommend(t.ctx, t.alex, draft)
    expect(plan.steps[0].recommended).toBe('manual')
    expect(plan.steps[0].missingCapability).toMatch(/cannot click/)
    expect(plan.steps[1].recommended).toBe('deterministic')
    expect(plan.steps[2].checkpoint).toBe(true)
    expect(plan.steps[3].recommended).toBe('human_review')
    expect(plan.questions.some((q) => q.id === 'rule:s4')).toBe(true)
    expect(plan.savings.assumptions.join(' ')).toMatch(/projection, not a measurement/)
  })
})

describe('improvement loop', () => {
  let t: TestRelay
  beforeAll(async () => {
    t = await makeRelay()
  })
  afterAll(() => t.cleanup())

  it('proposes from reviewed feedback, evaluates on a held-out set, and needs approval to deploy', async () => {
    const spec = AgentSpecSchema.parse({
      schemaVersion: 1,
      inputs: [{ key: 'url', label: 'URL', type: 'string', required: true }],
      steps: [{ id: 'extract', title: 'Extract emails', kind: 'deterministic', tool: 'text.extract_fields', args: { text: '{{inputs.url}}', fields: [{ name: 'e', kind: 'email' }] } }],
      outputs: [{ key: 'emails', label: 'Emails', from: '{{steps.extract.output.fields.e}}' }]
    })
    const { id } = createAgent(t.ctx, t.alex, { name: 'Improve me', spec })
    t.ctx.db.run("UPDATE agents SET status = 'live', live_version_id = draft_version_id WHERE id = ?", id)
    const runIds: string[] = []
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = t.relay.engine.start(t.alex, { agentId: id, environment: 'live', inputs: { url: `write to p${i}@x.example` } })
      await t.relay.engine.waitFor(r)
      runIds.push(r)
      submitFeedback(t.ctx, t.alex, { runId: r, kind: 'eval_example', comment: '' })
    }
    // Make two step failures so a tool-selection proposal has evidence.
    for (const r of runIds.slice(0, 2)) t.ctx.db.run("INSERT INTO run_steps (id, run_id, step_id, iteration, status, error, started_at) VALUES (?, ?, 'extract', 5, 'failed', 'Timed out', ?)", `rs_${r}`, r, new Date().toISOString())
    const ov = improvementOverview(t.ctx, t.alex, id)
    expect(ov.counts.holdout + ov.counts.improvement).toBe(8)
    // Fixture runs cannot be used as evidence.
    expect(() => submitFeedback(t.ctx, t.alex, { runId: 'run_fixture_1', kind: 'accept' })).toThrow(/fixture/)
    if (ov.counts.holdout === 0) t.ctx.db.run("UPDATE eval_examples SET split = 'holdout' WHERE agent_id = ? AND rowid IN (SELECT rowid FROM eval_examples WHERE agent_id = ? LIMIT 2)", id, id)
    const g = await generateProposals(t.ctx, t.alex, id)
    expect(g.created).toBeGreaterThan(0)
    const p = improvementOverview(t.ctx, t.alex, id).proposals[0]
    const ev = await evaluateProposal(t.ctx, t.alex, t.relay.engine, p.id)
    expect(ev.current.results.length).toBe(ev.candidate.results.length)
    expect(ev.current.meanScore).toBe(1)
    const sub = await t.ipc<{ id: string }>('u_alex', 'agents.submitProposal', { id: p.id, reason: 'Fewer failed runs' })
    expect(sub.ok).toBe(true)
    // Live version unchanged until the manager approves.
    const before = t.ctx.db.get<{ live_version_id: string }>('SELECT live_version_id FROM agents WHERE id = ?', id)!.live_version_id
    if (sub.ok) expect((await t.ipc('u_priya', 'approvals.decide', { id: sub.data.id, decision: 'approve' })).ok).toBe(true)
    const after = t.ctx.db.get<{ live_version_id: string }>('SELECT live_version_id FROM agents WHERE id = ?', id)!.live_version_id
    expect(after).not.toBe(before)
  }, 60_000)
})
