import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap, checkCollectionUse } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, forbidden, notFound, invalid } from '../core/errors'
import { roleHas } from '@shared/permissions'
import type { ToolDeclaration } from '@shared/domain'
import type { ToolCallContext } from '../tools/types'

export interface ModelRow {
  id: string
  name: string
  version: number
  task: string
  base_model: string
  job_id: string | null
  dataset_id: string | null
  dataset_version: number | null
  collection_ids: string
  artifact_dir: string
  labels: string
  metrics: string
  config: string
  status: 'registered' | 'active' | 'replaced' | 'retired' | 'needs_review'
  review_reason: string | null
  is_smoke: number
  created_by: string | null
  created_at: string
  activated_at: string | null
  activated_by: string | null
}

export function toolKeyForModel(name: string) {
  return `model.${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

function present(ctx: AppContext, m: ModelRow) {
  const job = m.job_id ? ctx.db.get<{ name: string; config: string; dataset_id: string; finished_at: string; elapsed_sec: number; hardware: string }>('SELECT * FROM training_jobs WHERE id = ?', m.job_id) : null
  const ds = m.dataset_id ? ctx.db.get<{ name: string; version: number; collection_id: string; collection_version: number; config: string; stats: string }>('SELECT * FROM datasets WHERE id = ?', m.dataset_id) : null
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    task: m.task,
    baseModel: m.base_model,
    status: m.status,
    reviewReason: m.review_reason,
    isSmoke: !!m.is_smoke,
    labels: j<string[]>(m.labels, []),
    metrics: j<Record<string, unknown>>(m.metrics, {}),
    config: j<Record<string, unknown>>(m.config, {}),
    toolKey: toolKeyForModel(m.name),
    createdAt: m.created_at,
    activatedAt: m.activated_at,
    artifactDir: m.artifact_dir,
    artifactPresent: existsSync(join(m.artifact_dir, 'model', 'relay.json')),
    lineage: {
      jobId: m.job_id,
      jobName: job?.name ?? null,
      trainedAt: job?.finished_at ?? null,
      elapsedSec: job?.elapsed_sec ?? null,
      hardware: job ? j(job.hardware, {}) : null,
      datasetId: m.dataset_id,
      datasetName: ds?.name ?? null,
      datasetVersion: m.dataset_version,
      datasetConfig: ds ? j(ds.config, {}) : null,
      collections: j<string[]>(m.collection_ids, []).map((cid) => ({
        id: cid,
        name: ctx.db.get<{ name: string }>('SELECT name FROM collections WHERE id = ?', cid)?.name ?? cid,
        version: ds?.collection_id === cid ? ds.collection_version : null
      }))
    }
  }
}

export function listModels(ctx: AppContext, actor: Actor) {
  const rows = ctx.db.all<ModelRow>('SELECT * FROM models ORDER BY name, version DESC')
  const visible = roleHas(actor.role, 'models.activate') ? rows : rows.filter((m) => m.status === 'active')
  return visible.map((m) => present(ctx, m))
}

export function getModel(ctx: AppContext, actor: Actor, id: string) {
  const m = ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id)
  if (!m) throw notFound('Model')
  if (!roleHas(actor.role, 'models.activate') && m.status !== 'active') throw notFound('Model')
  return present(ctx, m)
}

/** Register a successful training job's artifact as a new model version. */
export function registerModel(ctx: AppContext, actor: Actor, input: { jobId: string; name: string }) {
  requireCap(ctx, actor, 'models.activate', 'register models')
  const job = ctx.db.get<{ id: string; status: string; dataset_id: string; dir: string; metrics: string; config: string; created_by: string }>('SELECT * FROM training_jobs WHERE id = ?', input.jobId)
  if (!job) throw notFound('Training job')
  if (job.status !== 'succeeded') throw new RelayError('conflict', 'Only a successfully completed training job can be registered.')
  if (!existsSync(join(job.dir, 'model', 'relay.json'))) throw new RelayError('conflict', 'The trained model files are missing on disk.')
  if (ctx.db.get('SELECT 1 FROM models WHERE job_id = ?', job.id)) throw new RelayError('conflict', 'This job is already registered.')
  const name = input.name.trim()
  if (!/^[A-Za-z][\w -]{1,60}$/.test(name)) throw invalid('Use 2–60 letters, numbers, spaces, dashes or underscores for the model name.')
  const ds = ctx.db.get<{ id: string; version: number; collection_id: string }>('SELECT id, version, collection_id FROM datasets WHERE id = ?', job.dataset_id)!
  const metrics = j<{ labels: string[]; smoke_test: boolean }>(job.metrics, { labels: [], smoke_test: false })
  const version = (ctx.db.get<{ v: number | null }>('SELECT MAX(version) v FROM models WHERE name = ?', name)?.v ?? 0) + 1
  const id = newId('mdl')
  const cfg = j<{ baseModel: string }>(job.config, { baseModel: '' })
  ctx.db.insert('models', {
    id,
    name,
    version,
    task: 'text_classification',
    base_model: cfg.baseModel,
    job_id: job.id,
    dataset_id: ds.id,
    dataset_version: ds.version,
    collection_ids: js([ds.collection_id]),
    artifact_dir: job.dir,
    labels: js(metrics.labels),
    metrics: job.metrics,
    config: job.config,
    status: 'registered',
    is_smoke: metrics.smoke_test,
    created_by: actor.id,
    created_at: now()
  })
  ensureModelTool(ctx, name, metrics.labels)
  audit(ctx, actor, 'model.registered', { type: 'model', id }, { name, version, jobId: job.id, datasetId: ds.id })
  return { id, version }
}

function ensureModelTool(ctx: AppContext, name: string, labels: string[]) {
  const key = toolKeyForModel(name)
  const decl: ToolDeclaration = {
    key,
    name: `Classifier: ${name}`,
    description: `Fine-tuned local model that assigns one of: ${labels.join(', ')}. Runs on this computer; uses the active version.`,
    category: 'models',
    kind: 'model',
    version: 1,
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to classify', minLength: 1 }, texts: { type: 'array', items: { type: 'string' } } }, required: [] },
    outputSchema: { type: 'object', properties: { label: { type: 'string' }, confidence: { type: 'number' } } },
    auth: { type: 'none' },
    access: 'read',
    sideEffects: 'None.',
    dataDestinations: ['local'],
    external: false,
    cost: { kind: 'local_compute', note: 'Runs locally; no API cost.' },
    timeoutMs: 120_000,
    retry: { max: 1, safe: true },
    requiresApproval: false,
    capabilities: ['classify']
  }
  if (!ctx.db.get('SELECT 1 FROM tools WHERE key = ?', key)) {
    ctx.db.insert('tools', { key, version: 1, kind: 'model', category: 'models', declaration: js(decl), impl: js({ modelName: name }), enabled: 1, created_at: now(), updated_at: now() })
    ctx.db.insert('tool_versions', { key, version: 1, declaration: js(decl), impl: js({ modelName: name }), created_at: now() })
  }
}

/** Activate a version: the previously active version of the same model becomes “replaced”. */
export function activateModel(ctx: AppContext, actor: Actor, id: string, grantTeam = true) {
  requireCap(ctx, actor, 'models.activate', 'activate models')
  const m = ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id)
  if (!m) throw notFound('Model')
  if (m.status === 'retired') throw new RelayError('conflict', 'Retired models cannot be activated.')
  if (m.status === 'needs_review') throw new RelayError('conflict', `This model needs review first: ${m.review_reason}`)
  // The activator must still hold training access to the data it was trained on.
  for (const cid of j<string[]>(m.collection_ids, [])) {
    const d = checkCollectionUse(ctx, actor, cid, 'training')
    if (!d.allowed && !roleHas(actor.role, 'models.administer')) throw forbidden(`You cannot activate a model trained on data you no longer have training access to. ${d.reason}`)
  }
  const prev = ctx.db.get<ModelRow>("SELECT * FROM models WHERE name = ? AND status = 'active'", m.name)
  ctx.db.tx(() => {
    if (prev && prev.id !== id) ctx.db.update('models', 'id', prev.id, { status: 'replaced' })
    ctx.db.update('models', 'id', id, { status: 'active', activated_at: now(), activated_by: actor.id })
  })
  const key = toolKeyForModel(m.name)
  if (grantTeam && actor.teamId && !ctx.db.get("SELECT 1 FROM tool_grants WHERE tool_key = ? AND principal_type = 'team' AND principal_id = ? AND revoked_at IS NULL", key, actor.teamId))
    ctx.db.insert('tool_grants', { id: newId('tg'), tool_key: key, principal_type: 'team', principal_id: actor.teamId, granted_by: actor.id, created_at: now() })
  audit(ctx, actor, prev && prev.version > m.version ? 'model.rolled_back' : 'model.activated', { type: 'model', id }, { name: m.name, version: m.version, previous: prev ? `${prev.name} v${prev.version}` : null })
  ctx.events.emit({ type: 'tools.changed' })
  return { previousVersion: prev?.version ?? null }
}

export function setModelStatus(ctx: AppContext, actor: Actor, id: string, status: 'retired' | 'registered', note = '') {
  requireCap(ctx, actor, 'models.activate', 'change model status')
  const m = ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id)
  if (!m) throw notFound('Model')
  if (status === 'registered' && m.status === 'needs_review' && !roleHas(actor.role, 'models.administer'))
    throw forbidden('Only an administrator can clear a review flag.')
  ctx.db.update('models', 'id', id, { status, review_reason: status === 'registered' ? null : m.review_reason })
  audit(ctx, actor, status === 'retired' ? 'model.retired' : 'model.review_cleared', { type: 'model', id }, { note })
}

/** Runs the active version of a registered model in the local Python worker. */
export async function invokeRegisteredModel(ctx: AppContext, actor: Actor, name: string, args: Record<string, unknown>, tc?: Pick<ToolCallContext, 'signal'>) {
  const m = ctx.db.get<ModelRow>("SELECT * FROM models WHERE name = ? AND status = 'active'", name)
  if (!m) {
    const flagged = ctx.db.get<ModelRow>("SELECT * FROM models WHERE name = ? AND status = 'needs_review'", name)
    throw new RelayError('unavailable', flagged ? `Model ${name} is flagged for review: ${flagged.review_reason}` : `Model ${name} has no active version.`)
  }
  const texts = Array.isArray(args.texts) ? (args.texts as unknown[]).map(String) : args.text !== undefined ? [String(args.text)] : []
  if (!texts.length) throw invalid('Provide “text” or “texts” to classify.')
  const r = await ctx.python.call<{ predictions: { label: string; confidence: number; scores: { label: string; p: number }[] }[]; latency_ms: number; device: string }>(
    'predict',
    { model_dir: join(m.artifact_dir, 'model'), texts },
    { timeoutMs: 120_000, signal: tc?.signal }
  )
  const meta = { model: `${m.name} v${m.version}`, smokeTest: !!m.is_smoke, latencyMs: r.latency_ms, device: r.device }
  return Array.isArray(args.texts) ? { predictions: r.predictions, ...meta } : { ...r.predictions[0], ...meta }
}

export async function tryModel(ctx: AppContext, actor: Actor, id: string, text: string) {
  requireCap(ctx, actor, 'models.activate', 'test models')
  const m = ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id)
  if (!m) throw notFound('Model')
  const r = await ctx.python.call<{ predictions: unknown[]; latency_ms: number; device: string }>('predict', { model_dir: join(m.artifact_dir, 'model'), texts: [text] }, { timeoutMs: 120_000 })
  return { prediction: r.predictions[0], latencyMs: r.latency_ms, device: r.device, model: `${m.name} v${m.version}` }
}
