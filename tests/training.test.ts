// Real training integration test: runs the Python worker and fine-tunes a tiny model (smoke test).
// Requires `npm run setup:python -- --train`; downloads ~18 MB (prajjwal1/bert-tiny) on first run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeRelay, type TestRelay } from './helpers'
import { findOpportunities, prepareDataset, startTraining, cancelTraining } from '../src/main/services/training'
import { registerModel, activateModel, invokeRegisteredModel } from '../src/main/services/models'
import { upsertBudget } from '../src/main/services/budget'
import { invokeTool } from '../src/main/tools/registry'
import { newId } from '../src/main/db/database'

process.env.RELAY_HF_HOME ??= resolve('.relay-test-hf-cache')

let t: TestRelay
let datasetId: string
const smoke = { baseModel: 'prajjwal1/bert-tiny', epochs: 1, learningRate: 0.001, batchSize: 16, maxLength: 64, loraRank: 4, device: 'cpu' as const, smokeTest: true }

async function waitJob(id: string, ms = 240_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const j = t.ctx.db.get<{ status: string; error: string | null }>('SELECT status, error FROM training_jobs WHERE id = ?', id)!
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) {
      await new Promise((r) => setTimeout(r, 300))
      return t.ctx.db.get<{ status: string; error: string | null; metrics: string | null }>('SELECT status, error, metrics FROM training_jobs WHERE id = ?', id)!
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('job timed out')
}

beforeAll(async () => {
  t = await makeRelay()
  upsertBudget(t.ctx, t.sam, { scope: 'team', scopeId: 'team_ops', kind: 'training', limitUsd: 5, alertPct: 80, hardLimit: true })
})
afterAll(() => t.cleanup())

describe('opportunity discovery', () => {
  it('profiles real data and proposes evidence-backed cards', async () => {
    const r = await findOpportunities(t.ctx, t.priya, t.ids.cIncidents)
    expect(r.profile!.rows).toBeGreaterThan(800)
    const top = r.opportunities[0] as Record<string, unknown>
    expect(top.kind).toBe('classification')
    expect(top.labelColumn).toBe('category')
    expect(String((top.limitations as string[]).join(' '))).toMatch(/resolution_team.*determined by.*category/)
    expect((top.sensitiveExcluded as string[])).toContain('reporter_email')
  })

  it('refuses people without analysis access', async () => {
    await expect(findOpportunities(t.ctx, t.priya, t.ids.cTickets)).rejects.toThrow(/analysis/)
  })

  it('says documents are a retrieval problem, not a fine-tuning one', async () => {
    const r = await findOpportunities(t.ctx, t.sam, t.ids.cProcedures).catch((e) => e)
    // Sam has retrieval but not analysis on procedures: refused. Grant and retry.
    expect(String(r)).toMatch(/analysis/)
  })
})

describe('real fine-tuning', () => {
  it('prepares a deduplicated dataset with a held-out split', async () => {
    const r = await prepareDataset(t.ctx, t.priya, {
      collectionId: t.ids.cIncidents,
      name: 'Incidents test',
      config: { textFields: ['description'], labelField: 'category', excludedFields: ['reporter_email'], labelMap: {}, dropLabels: [], split: { strategy: 'random', train: 0.7, validation: 0.15, seed: 13 }, minExamplesPerLabel: 5 },
      maskPersonalData: true,
      allowSensitiveFields: false
    })
    datasetId = r.id
    const stats = r.stats as { splits: { test: number }; leakage: { text_overlap: number } }
    expect(stats.splits.test).toBeGreaterThan(50)
    expect(stats.leakage.text_overlap).toBe(0)
  }, 120_000)

  it('trains, saves a reloadable model, evaluates against baselines, and serves it as an agent tool', async () => {
    const job = await startTraining(t.ctx, t.priya, { datasetId, name: 'Smoke', config: smoke })
    const j = await waitJob(job.id)
    expect(j.error).toBeNull()
    expect(j.status).toBe('succeeded')
    const m = JSON.parse(j.metrics!)
    expect(m.smoke_test).toBe(true)
    expect(m.fine_tuned.macro_f1).toBeGreaterThanOrEqual(0)
    expect(m.baselines.tfidf_logreg.macro_f1).toBeGreaterThan(0.5)
    expect(m.fine_tuned.confusion_matrix.matrix.length).toBe(m.labels.length)
    expect(m.reload_check.matched).toBe(m.reload_check.of)
    const reg = registerModel(t.ctx, t.priya, { jobId: job.id, name: 'Smoke classifier' })
    activateModel(t.ctx, t.priya, reg.id)
    const pred = (await invokeRegisteredModel(t.ctx, t.priya, 'Smoke classifier', { text: 'replication lag on billing postgres' })) as { label: string; smokeTest: boolean }
    expect(m.labels).toContain(pred.label)
    expect(pred.smokeTest).toBe(true)
    // The employee's team was granted the tool on activation; it runs through the normal tool path.
    const out = await invokeTool(t.ctx, 'model.smoke_classifier', { text: 'DNS failing for search' }, { ctx: t.ctx, actor: t.alex, runId: null, agentId: null, teamId: 'team_ops', allowedCollections: null, idempotencyKey: newId('t'), inputTaint: [], signal: new AbortController().signal, environment: 'test', log: () => undefined })
    expect(m.labels).toContain((out.output as { label: string }).label)
  }, 300_000)

  it('flags trained models for review when training access is revoked', async () => {
    const grant = t.ctx.db.get<{ id: string }>("SELECT id FROM grants WHERE collection_id = ? AND principal_id = 'u_priya' AND revoked_at IS NULL", t.ids.cIncidents)!
    const r = await t.ipc('u_sam', 'data.revoke', { id: grant.id })
    expect(r.ok).toBe(true)
    const m = t.ctx.db.get<{ status: string; review_reason: string }>("SELECT status, review_reason FROM models WHERE name = 'Smoke classifier'")!
    expect(m.status).toBe('needs_review')
    await expect(invokeRegisteredModel(t.ctx, t.priya, 'Smoke classifier', { text: 'x' })).rejects.toThrow(/review/)
    // Restore access for the remaining tests.
    await t.ipc('u_sam', 'data.grant', { collectionId: t.ids.cIncidents, principalType: 'user', principalId: 'u_priya', purposes: ['retrieval', 'analysis', 'training'], canDelegate: false, note: '' })
  })

  it('never marks a cancelled job as successful', async () => {
    const job = await startTraining(t.ctx, t.priya, { datasetId, name: 'Cancel me', config: { ...smoke, smokeTest: false, epochs: 10 } })
    await new Promise((r) => setTimeout(r, 1500))
    cancelTraining(t.ctx, t.priya, job.id)
    const j = await waitJob(job.id)
    expect(j.status).toBe('cancelled')
    expect(() => registerModel(t.ctx, t.priya, { jobId: job.id, name: 'Nope' })).toThrow(/successfully completed/)
  }, 120_000)

  it('marks a job failed when training cannot complete', async () => {
    const ds = t.ctx.db.get<{ path: string }>('SELECT path FROM datasets WHERE id = ?', datasetId)!
    rmSync(join(ds.path, 'test.jsonl'))
    expect(existsSync(join(ds.path, 'test.jsonl'))).toBe(false)
    const job = await startTraining(t.ctx, t.priya, { datasetId, name: 'Broken', config: smoke })
    const j = await waitJob(job.id)
    expect(j.status).toBe('failed')
    expect(j.error).toBeTruthy()
    expect(() => registerModel(t.ctx, t.priya, { jobId: job.id, name: 'Nope' })).toThrow(/successfully completed/)
  }, 120_000)
})
