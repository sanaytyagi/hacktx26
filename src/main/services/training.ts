// Fine-tuning opportunity discovery, dataset preparation, and training jobs.
// Discovery is independent of the agent improvement loop.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap, requireCollectionUse, getCollection } from '../core/authz'
import { audit } from '../core/audit'
import { notify } from '../core/notifications'
import { RelayError, notFound, invalid } from '../core/errors'
import { getPolicy } from '../core/settings'
import { roleHas } from '@shared/permissions'
import { DatasetConfigSchema, TrainingConfigSchema, type DatasetConfig, type TrainingConfig } from '@shared/domain'
import { readCollectionTable, collectionKind } from './data'
import { reserve, reconcile } from './budget'
import { createApproval, registerApprovalHandler } from './approvals'
import { callModel } from './providers'

// ---------------- Profiling & opportunities ----------------

interface ColumnProfile {
  name: string
  kind: string
  missing: number
  missing_pct: number
  unique: number
  avg_length: number
  sensitive: string[]
  top_values: { value: string; count: number }[]
  range?: [string, string]
}

export interface Profile {
  rows: number
  columns: ColumnProfile[]
  exact_duplicate_rows: number
  candidates: { text_inputs: string[]; labels: string[]; groups: string[]; times: string[] }
  text_stats: Record<string, { duplicate_texts: number }>
  label_stats: Record<string, { labeled: number; coverage_pct: number; classes: number; distribution: { label: string; count: number }[]; min_class: number; max_class: number; imbalance_ratio: number; conflicting_duplicates: Record<string, number> }>
  sensitive_columns: string[]
  limitations: string[]
  label_relations?: Record<string, { derived_from: string | null; in_text: Record<string, number> }>
  text_quality?: Record<string, { unique_ratio: number; avg_length: number }>
}

export const BASE_MODEL_CHOICES = [
  { id: 'google/electra-small-discriminator', label: 'Electra small (recommended for laptops)', license: 'Apache-2.0', sizeMb: 54, paramsM: 13.5, tier: 'laptop' },
  { id: 'distilbert-base-uncased', label: 'DistilBERT base (more accurate, slower)', license: 'Apache-2.0', sizeMb: 268, paramsM: 66.4, tier: 'standard' },
  { id: 'prajjwal1/bert-tiny', label: 'BERT tiny (smoke test only)', license: 'MIT', sizeMb: 18, paramsM: 4.4, tier: 'smoke' }
]

async function writeRowsJsonl(ctx: AppContext, rows: Record<string, unknown>[], name: string) {
  const dir = join(ctx.paths.tmp, newId('prof'))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

export async function findOpportunities(ctx: AppContext, actor: Actor, collectionId: string) {
  requireCap(ctx, actor, 'opportunities.explore', 'explore model opportunities')
  const c = requireCollectionUse(ctx, actor, collectionId, 'analysis', 'opportunity analysis')
  if (collectionKind(ctx, c) === 'documents') {
    const card = {
      kind: 'retrieval',
      title: `Answer questions from “${c.name}” with search, not fine-tuning`,
      businessTask: 'Look up facts and procedures in these documents.',
      intendedUsers: 'Anyone with retrieval access to this collection',
      evidence: [{ label: 'Collection type', value: 'Documents (no labels)' }],
      inputs: [],
      output: null,
      cleanup: [],
      approach: { recommended: 'retrieval', options: [{ approach: 'retrieval', why: 'Facts change and must be cited; searching the current documents keeps answers up to date and traceable.' }, { approach: 'fine_tune', why: 'Not recommended: fine-tuning does not reliably store facts and cannot be updated when a document changes.' }] },
      evaluation: ['Spot-check answers against the cited document passages.'],
      compute: null,
      worth: { for: ['Search tools already work on this collection.'], against: ['No labeled examples to learn from.'] },
      sensitiveExcluded: [],
      limitations: ['This is a document collection; supervised training needs labeled examples.']
    }
    const id = newId('opp')
    ctx.db.insert('opportunities', { id, collection_id: c.id, collection_version: c.version, created_by: actor.id, profile: js({ rows: 0 }), card: js(card), status: 'new', created_at: now() })
    return { profile: null, opportunities: [{ id, ...card }] }
  }
  const t = await readCollectionTable(ctx, actor, collectionId, 'analysis', 'opportunity analysis')
  const path = await writeRowsJsonl(ctx, t.rows, 'rows.jsonl')
  const profile = await ctx.python.call<Profile>('profile', { path, columns: t.columns }, { timeoutMs: 300_000 })
  const cards = buildCards(ctx, c.name, profile)
  ctx.db.run("UPDATE opportunities SET status = 'superseded' WHERE collection_id = ? AND status = 'new'", c.id)
  const out = cards.map((card) => {
    const id = newId('opp')
    ctx.db.insert('opportunities', { id, collection_id: c.id, collection_version: c.version, created_by: actor.id, profile: js(profile), card: js(card), status: 'new', created_at: now() })
    return { id, ...card }
  })
  audit(ctx, actor, 'opportunities.analyzed', { type: 'collection', id: c.id }, { rows: profile.rows, cards: cards.length })
  return { profile, opportunities: out }
}

function buildCards(ctx: AppContext, collectionName: string, p: Profile) {
  const cards: Record<string, unknown>[] = []
  const policy = getPolicy(ctx)
  const col = (n: string) => p.columns.find((c) => c.name === n)
  const sensitive = p.sensitive_columns
  // Rank candidate labels on evidence: name hints, label coverage, derived labels, and leakage into text.
  const textRank = [...p.candidates.text_inputs].sort((a, b) => {
    const qa = p.text_quality?.[a] ?? { unique_ratio: 0, avg_length: 0 }
    const qb = p.text_quality?.[b] ?? { unique_ratio: 0, avg_length: 0 }
    return qb.unique_ratio * Math.log(1 + qb.avg_length) - qa.unique_ratio * Math.log(1 + qa.avg_length)
  })
  const skipped: string[] = []
  const ranked = p.candidates.labels
    .map((label) => {
      const ls = p.label_stats[label]
      const rel = p.label_relations?.[label]
      const text = textRank[0]
      const leak = rel?.in_text[text] ?? 0
      let score = Math.log(1 + ls.labeled) + (/(category|label|class|type|route|routing|topic|reason|cause)/i.test(label) ? 3 : 0) - (ls.classes <= 2 ? 2 : 0)
      if (rel?.derived_from) {
        skipped.push(`“${label}” is fully determined by “${rel.derived_from}”; predict “${rel.derived_from}” instead.`)
        return null
      }
      if (leak > 0.5) score -= 4
      return { label, text, score, leak }
    })
    .filter((x): x is { label: string; text: string; score: number; leak: number } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  for (const { label, text, leak } of ranked) {
      const ls = p.label_stats[label]
      const conflicts = ls.conflicting_duplicates[text] ?? 0
      const rare = ls.distribution.filter((d) => d.count < 20)
      const enough = ls.labeled >= 200 && ls.classes <= 30
      const tooFew = ls.labeled < 60 || ls.min_class < 5
      const estSec = Math.round((ls.labeled * 0.7 * 4) / 180 + 40)
      const rate = policy.localComputeRateUsdPerHour
      const cleanup: string[] = []
      if (ls.coverage_pct < 100) cleanup.push(`${p.rows - ls.labeled} rows (${(100 - ls.coverage_pct).toFixed(1)}%) have no “${label}” and will be excluded.`)
      if (conflicts) cleanup.push(`${conflicts} duplicate texts carry conflicting labels; they are dropped during preparation.`)
      if (p.text_stats[text]?.duplicate_texts) cleanup.push(`${p.text_stats[text].duplicate_texts} duplicate texts are merged before splitting so they cannot leak into the test set.`)
      if (rare.length) cleanup.push(`Rare classes (<20 examples): ${rare.map((r) => `${r.label} (${r.count})`).join(', ')}. Consider merging or relabeling.`)
      if (ls.imbalance_ratio > 5) cleanup.push(`Classes are imbalanced (largest/smallest = ${ls.imbalance_ratio}); report per-class recall, not just accuracy.`)
      const sens = sensitive.filter((s) => s !== text)
      if (leak > 0.5) cleanup.push(`The label value appears word-for-word in “${text}” for ${Math.round(leak * 100)}% of rows. A model would mostly copy it; simple rules may be enough.`)
      if (textRank.length > 1) cleanup.push(`Other text fields you could add as inputs: ${textRank.slice(1).join(', ')}.`)
      if (col(text)?.sensitive.length) cleanup.push(`“${text}” may contain personal data (${col(text)!.sensitive.join(', ')}); enable masking during preparation.`)
      cards.push({
        kind: 'classification',
        title: `Classify ${collectionName.replace(/\(.*?\)/g, '').trim()} by ${label.replace(/_/g, ' ')}`,
        businessTask: `Predict “${label}” from “${text}” so new records are routed or categorized automatically.`,
        intendedUsers: 'People who triage or route these records; agents that need a consistent category.',
        evidence: [
          { label: 'Rows', value: String(p.rows) },
          { label: `Rows with “${label}”`, value: `${ls.labeled} (${ls.coverage_pct}%)` },
          { label: 'Classes', value: `${ls.classes}: ${ls.distribution.slice(0, 8).map((d) => `${d.label} ${d.count}`).join(', ')}${ls.distribution.length > 8 ? ', …' : ''}` },
          { label: `Average “${text}” length`, value: `${col(text)?.avg_length ?? 0} characters` },
          { label: 'Conflicting duplicate labels', value: String(conflicts) },
          { label: 'Exact duplicate rows', value: String(p.exact_duplicate_rows) }
        ],
        inputs: [text],
        output: label,
        labelColumn: label,
        textColumn: text,
        groupCandidates: p.candidates.groups,
        timeCandidates: p.candidates.times,
        stats: ls,
        cleanup,
        approach: {
          recommended: tooFew || leak > 0.5 ? 'rules' : enough ? 'fine_tune' : 'baseline',
          options: [
            { approach: 'rules', why: tooFew ? 'Too few labeled examples per class to learn reliably; start with keyword rules or label more examples.' : 'Keyword rules are transparent but brittle for varied wording.' },
            { approach: 'baseline', why: 'A TF-IDF + logistic regression baseline is cheap and often strong; Relay trains it automatically for comparison.' },
            { approach: 'fine_tune', why: enough ? `${ls.labeled} labeled examples across ${ls.classes} classes is enough for a small fine-tuned classifier to be worth comparing against the baseline.` : 'Possible, but expect limited gains over the baseline with this little data.' },
            { approach: 'retrieval', why: 'Not suited: this is a labeling task, not fact lookup.' }
          ]
        },
        evaluation: [
          'Macro F1 on a held-out test split that is never used for training or tuning.',
          `Per-class recall, especially for small classes${rare.length ? ` (${rare.map((r) => r.label).join(', ')})` : ''}.`,
          'Must beat the TF-IDF baseline on the same test split to justify the extra complexity.',
          'Latency per prediction on this computer.'
        ],
        compute: {
          baseModel: 'google/electra-small-discriminator',
          license: 'Apache-2.0',
          downloadMb: 54,
          estTrainMinutes: Math.max(1, Math.round(estSec / 60)),
          device: 'Apple Silicon GPU, CUDA, or CPU (preflight checks before training)',
          trainingCostUsd: rate > 0 ? Math.round(((estSec / 3600) * rate) * 100) / 100 : null,
          trainingCostNote: rate > 0 ? `At the configured local compute rate of $${rate}/hour.` : 'Runs locally: no API charges. Shown as time only (no local compute rate configured).',
          inferenceCost: 'Runs locally; no per-call API cost.'
        },
        worth: {
          for: [`${ls.labeled} historical records already carry this label.`, 'A local model keeps this data on this computer.'].concat(ls.classes > 2 ? ['Multi-class routing is tedious to do by hand.'] : []),
          against: [tooFew ? 'Too few examples per class.' : '', leak > 0.5 ? 'The answer is usually written in the text already.' : '', conflicts > 20 ? 'Many conflicting labels suggest the categories are not applied consistently.' : '', 'A simple baseline may already be good enough — check the comparison before deploying.'].filter(Boolean)
        },
        sensitiveExcluded: sens,
        limitations: [...p.limitations, ...skipped]
      })
  }
  if (!p.candidates.labels.length && p.candidates.text_inputs.length) {
    cards.push({
      kind: 'not_recommended',
      title: `No labels found in ${collectionName}`,
      businessTask: 'Supervised classification or error detection',
      intendedUsers: '',
      evidence: [{ label: 'Text columns', value: p.candidates.text_inputs.join(', ') }, { label: 'Label-like columns', value: 'none (2–50 distinct values)' }],
      inputs: p.candidates.text_inputs,
      output: null,
      cleanup: ['Add a reviewed label column (e.g. category or root cause) to a sample of records.'],
      approach: { recommended: 'rules', options: [{ approach: 'retrieval', why: 'Search can find similar past records without labels.' }, { approach: 'fine_tune', why: 'Not possible yet: unlabeled data does not support supervised training or error detection.' }] },
      evaluation: [],
      compute: null,
      worth: { for: [], against: ['Unlabeled data cannot train a supervised classifier.'] },
      sensitiveExcluded: sensitive,
      limitations: p.limitations
    })
  }
  return cards.sort((a, b) => (b.kind === 'classification' ? 1 : 0) - (a.kind === 'classification' ? 1 : 0))
}

export function listOpportunities(ctx: AppContext, actor: Actor, collectionId?: string) {
  requireCap(ctx, actor, 'opportunities.explore', 'explore model opportunities')
  const rows = ctx.db.all<{ id: string; collection_id: string; card: string; profile: string; status: string; created_at: string }>(
    `SELECT * FROM opportunities WHERE status != 'superseded' ${collectionId ? 'AND collection_id = ?' : ''} ORDER BY created_at DESC LIMIT 50`,
    ...(collectionId ? [collectionId] : [])
  )
  return rows
    .filter((r) => roleHas(actor.role, 'data.administer') || requireUseQuiet(ctx, actor, r.collection_id))
    .map((r) => ({ id: r.id, collectionId: r.collection_id, collectionName: getCollection(ctx, r.collection_id).name, status: r.status, createdAt: r.created_at, ...j<Record<string, unknown>>(r.card, {}) }))
}

function requireUseQuiet(ctx: AppContext, actor: Actor, cid: string) {
  try {
    requireCollectionUse(ctx, actor, cid, 'analysis', 'list opportunities')
    return true
  } catch {
    return false
  }
}

/** Optional generative explanation. Sends only the profile summary, and only if egress policy allows. */
export async function explainOpportunity(ctx: AppContext, actor: Actor, id: string, providerId: string, model: string) {
  const o = ctx.db.get<{ collection_id: string; card: string }>('SELECT collection_id, card FROM opportunities WHERE id = ?', id)
  if (!o) throw notFound('Opportunity')
  requireCollectionUse(ctx, actor, o.collection_id, 'analysis', 'explain opportunity')
  const card = j<Record<string, unknown>>(o.card, {})
  const r = await callModel(ctx, {
    actor,
    providerId,
    request: {
      model,
      system: 'You explain machine-learning opportunities to business managers in plain language. Be candid about limitations. Use only the facts provided.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `Explain in under 180 words whether this is worth doing and what to watch out for:\n<data>${JSON.stringify({ title: card.title, evidence: card.evidence, cleanup: card.cleanup, approach: card.approach, worth: card.worth })}</data>` }] }],
      maxTokens: 600
    },
    attribution: { kind: 'operating', teamId: actor.teamId, userId: actor.id, project: 'opportunity-explanations' },
    taint: [o.collection_id],
    purpose: 'Explain opportunity'
  })
  return { text: r.text, model, costUsd: r.costUsd }
}

// ---------------- Datasets ----------------

export const PrepareDatasetSchema = z.object({
  collectionId: z.string(),
  opportunityId: z.string().optional(),
  name: z.string().min(1).max(100),
  config: DatasetConfigSchema,
  maskPersonalData: z.boolean().default(true),
  allowSensitiveFields: z.boolean().default(false)
})

const MASKS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]']
]

export async function prepareDataset(ctx: AppContext, actor: Actor, input: z.infer<typeof PrepareDatasetSchema>) {
  requireCap(ctx, actor, 'training.run', 'prepare training datasets')
  const c = requireCollectionUse(ctx, actor, input.collectionId, 'training', 'dataset preparation')
  const cfg = input.config
  const t = await readCollectionTable(ctx, actor, input.collectionId, 'training', 'dataset preparation')
  const needed = [...cfg.textFields, cfg.labelField, cfg.split.groupField, cfg.split.timeField].filter(Boolean) as string[]
  for (const f of needed) if (!t.columns.includes(f)) throw invalid(`Column “${f}” is not available in this collection.`)
  const overlap = cfg.textFields.filter((f) => cfg.excludedFields.includes(f) || f === cfg.labelField)
  if (overlap.length) throw invalid(`Fields cannot be both input and excluded/label: ${overlap.join(', ')}.`)
  // Sensitive fields: profile flags are re-checked here; using one as input needs explicit acknowledgement.
  const profilePath = await writeRowsJsonl(ctx, t.rows.slice(0, 3000), 'sample.jsonl')
  const prof = await ctx.python.call<Profile>('profile', { path: profilePath, columns: cfg.textFields }, { timeoutMs: 120_000 })
  const flagged = prof.sensitive_columns.filter((s) => cfg.textFields.includes(s))
  if (flagged.length && !input.allowSensitiveFields && !input.maskPersonalData)
    throw new RelayError('policy', `Input fields may contain personal data: ${flagged.join(', ')}. Turn on masking or acknowledge the sensitive fields.`)
  // Only the mapped fields are written; excluded and unrelated columns never reach the training files.
  const rows = t.rows.map((r) => {
    const o: Record<string, unknown> = {}
    for (const f of needed) {
      let v = r[f]
      if (input.maskPersonalData && cfg.textFields.includes(f) && typeof v === 'string') for (const [re, rep] of MASKS) v = (v as string).replace(re, rep)
      o[f] = v
    }
    return o
  })
  const version = (ctx.db.get<{ v: number | null }>('SELECT MAX(version) v FROM datasets WHERE name = ? AND collection_id = ?', input.name, c.id)?.v ?? 0) + 1
  const parent = ctx.db.get<{ id: string }>('SELECT id FROM datasets WHERE name = ? AND collection_id = ? ORDER BY version DESC', input.name, c.id)
  const id = newId('ds')
  const dir = join(ctx.paths.datasets, id)
  mkdirSync(dir, { recursive: true })
  const src = join(dir, 'source.jsonl')
  writeFileSync(src, rows.map((r) => JSON.stringify(r)).join('\n'))
  const stats = await ctx.python.call<Record<string, unknown>>('prepare_dataset', { input_path: src, out_dir: dir, config: { text_fields: cfg.textFields, label_field: cfg.labelField, label_map: cfg.labelMap, drop_labels: cfg.dropLabels, min_examples_per_label: cfg.minExamplesPerLabel, split: { strategy: cfg.split.strategy, group_field: cfg.split.groupField, time_field: cfg.split.timeField, train: cfg.split.train, validation: cfg.split.validation, seed: cfg.split.seed } } }, { timeoutMs: 300_000 })
  ctx.db.insert('datasets', {
    id,
    name: input.name,
    collection_id: c.id,
    collection_version: c.version,
    opportunity_id: input.opportunityId ?? null,
    version,
    parent_id: parent?.id ?? null,
    config: js({ ...cfg, maskPersonalData: input.maskPersonalData, sensitiveAcknowledged: input.allowSensitiveFields ? flagged : [] }),
    stats: js(stats),
    path: dir,
    status: 'ready',
    created_by: actor.id,
    created_at: now()
  })
  audit(ctx, actor, 'dataset.prepared', { type: 'dataset', id }, { collectionId: c.id, collectionVersion: c.version, version, splits: (stats as { splits?: unknown }).splits, masked: input.maskPersonalData, sensitiveAcknowledged: input.allowSensitiveFields ? flagged : [] })
  return { id, version, stats }
}

export function listDatasets(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'training.run', 'view training datasets')
  return ctx.db
    .all<{ id: string; name: string; version: number; collection_id: string; collection_version: number; stats: string; created_at: string; config: string }>('SELECT * FROM datasets ORDER BY created_at DESC')
    .map((d) => ({ id: d.id, name: d.name, version: d.version, collectionId: d.collection_id, collectionVersion: d.collection_version, collectionName: getCollection(ctx, d.collection_id).name, stats: j(d.stats, {}), config: j(d.config, {}), createdAt: d.created_at }))
}

export function previewDataset(ctx: AppContext, actor: Actor, id: string) {
  requireCap(ctx, actor, 'training.run', 'view training datasets')
  const d = ctx.db.get<{ path: string; collection_id: string }>('SELECT path, collection_id FROM datasets WHERE id = ?', id)
  if (!d) throw notFound('Dataset')
  requireCollectionUse(ctx, actor, d.collection_id, 'training', 'dataset preview')
  const read = (name: string) =>
    existsSync(join(d.path, `${name}.jsonl`))
      ? readFileSync(join(d.path, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).slice(0, 15).map((l) => JSON.parse(l))
      : []
  return { train: read('train'), validation: read('validation'), test: read('test') }
}

// ---------------- Training jobs ----------------

const running = new Map<string, ChildProcess>()

export async function reviewTraining(ctx: AppContext, actor: Actor, input: { datasetId: string; config: TrainingConfig }) {
  requireCap(ctx, actor, 'training.run', 'train models')
  const ds = ctx.db.get<{ id: string; path: string; collection_id: string; stats: string; name: string; version: number }>('SELECT * FROM datasets WHERE id = ?', input.datasetId)
  if (!ds) throw notFound('Dataset')
  const cfg = TrainingConfigSchema.parse(input.config)
  const checks: { label: string; status: 'ok' | 'warn' | 'block'; detail: string }[] = []
  let collectionOk = true
  try {
    requireCollectionUse(ctx, actor, ds.collection_id, 'training', 'training review')
    checks.push({ label: 'Training permission', status: 'ok', detail: `You hold training access to “${getCollection(ctx, ds.collection_id).name}”.` })
  } catch (e) {
    collectionOk = false
    checks.push({ label: 'Training permission', status: 'block', detail: (e as Error).message })
  }
  const stats = j<{ splits: { train: number; validation: number; test: number }; leakage: { text_overlap: number; group_overlap: number }; warnings: string[] }>(ds.stats, { splits: { train: 0, validation: 0, test: 0 }, leakage: { text_overlap: 0, group_overlap: 0 }, warnings: [] })
  const trainN = cfg.smokeTest ? Math.min(64, stats.splits.train) : Math.min(stats.splits.train, cfg.maxTrainExamples ?? Infinity)
  checks.push({ label: 'Held-out test set', status: stats.splits.test >= 10 ? 'ok' : 'block', detail: `${stats.splits.test} test examples, never used for training (${stats.leakage.text_overlap} text overlaps across splits).` })
  if (stats.leakage.text_overlap || stats.leakage.group_overlap) checks.push({ label: 'Leakage', status: 'block', detail: 'Splits overlap; re-prepare the dataset.' })
  let pre: { device: string; model: { license?: string; size_bytes?: number; cached: boolean; note?: string }; estimate_seconds: number; estimate_basis: string; warnings: string[]; blockers: string[]; env: Record<string, unknown> }
  try {
    pre = await ctx.python.call('preflight', { base_model: cfg.baseModel, device: cfg.device, train_examples: trainN, epochs: cfg.smokeTest ? 1 : cfg.epochs }, { timeoutMs: 120_000 })
  } catch (e) {
    checks.push({ label: 'Python worker', status: 'block', detail: `${(e as Error).message} — run “npm run setup:python -- --train”.` })
    return { checks, ready: false, estimate: null, hardware: null, model: null }
  }
  for (const b of pre.blockers) checks.push({ label: 'Preflight', status: 'block', detail: b })
  for (const w of pre.warnings) checks.push({ label: 'Download', status: 'warn', detail: w })
  checks.push({ label: 'Hardware', status: 'ok', detail: `Will train on ${pre.device.toUpperCase()}.` })
  if (cfg.smokeTest) checks.push({ label: 'Smoke test', status: 'warn', detail: 'Trains 1 epoch on at most 64 examples to check the pipeline. Results do not indicate business-quality performance.' })
  const rate = getPolicy(ctx).localComputeRateUsdPerHour
  const costUsd = rate > 0 ? Math.round(((pre.estimate_seconds / 3600) * rate) * 10000) / 10000 : 0
  const ceiling = getPolicy(ctx).managerApprovalCeilingUsd
  const needsApproval = costUsd > ceiling && !roleHas(actor.role, 'approvals.decide_all')
  if (needsApproval) checks.push({ label: 'Budget approval', status: 'warn', detail: `Estimated $${costUsd} exceeds your $${ceiling} approval ceiling; an administrator must approve.` })
  return {
    checks,
    ready: collectionOk && !checks.some((c) => c.status === 'block'),
    needsApproval,
    estimate: { seconds: pre.estimate_seconds, basis: pre.estimate_basis, costUsd, costNote: rate > 0 ? `Local compute at $${rate}/hour (configured rate).` : 'Local compute: no API charges; no local compute rate configured, so cost is shown as time only.', trainExamples: trainN },
    hardware: pre.env,
    model: { id: cfg.baseModel, ...pre.model }
  }
}

export const StartTrainingSchema = z.object({ datasetId: z.string(), opportunityId: z.string().optional(), name: z.string().min(1).max(100), config: TrainingConfigSchema })

export async function startTraining(ctx: AppContext, actor: Actor, input: z.infer<typeof StartTrainingSchema>) {
  const review = await reviewTraining(ctx, actor, { datasetId: input.datasetId, config: input.config })
  if (!review.ready) throw new RelayError('policy', `Training cannot start: ${review.checks.filter((c) => c.status === 'block').map((c) => c.detail).join(' ')}`)
  const id = newId('job')
  const dir = join(ctx.paths.jobs, id)
  mkdirSync(dir, { recursive: true })
  ctx.db.insert('training_jobs', {
    id,
    dataset_id: input.datasetId,
    opportunity_id: input.opportunityId ?? null,
    name: input.name,
    config: js(input.config),
    status: review.needsApproval ? 'awaiting_approval' : 'queued',
    phase: '',
    progress: 0,
    dir,
    hardware: js(review.hardware),
    created_by: actor.id,
    created_at: now()
  })
  audit(ctx, actor, 'training.job_created', { type: 'training_job', id }, { datasetId: input.datasetId, config: input.config, estimate: review.estimate })
  if (review.needsApproval) {
    const a = createApproval(ctx, actor, { type: 'training_job', title: `Training job: ${input.name}`, reason: `Estimated local compute cost $${review.estimate!.costUsd}.`, payload: { jobId: id, costUsd: review.estimate!.costUsd }, targetType: 'training_job', targetId: id })
    ctx.db.update('training_jobs', 'id', id, { approval_id: a.id })
    return { id, status: 'awaiting_approval' }
  }
  launch(ctx, actor, id, review.estimate!.costUsd)
  return { id, status: 'running' }
}

function event(ctx: AppContext, jobId: string, type: string, data: Record<string, unknown>) {
  ctx.db.insert('training_events', { job_id: jobId, ts: now(), type, data: js(data) })
  ctx.events.emit({ type: 'job.event', jobId, event: { type, ts: now(), ...data } })
}

function launch(ctx: AppContext, actor: Actor, jobId: string, estimateUsd: number) {
  const job = ctx.db.get<{ id: string; dataset_id: string; dir: string; config: string; name: string }>('SELECT * FROM training_jobs WHERE id = ?', jobId)!
  const ds = ctx.db.get<{ path: string; collection_id: string }>('SELECT path, collection_id FROM datasets WHERE id = ?', job.dataset_id)!
  // Grants are re-checked at launch.
  requireCollectionUse(ctx, actor, ds.collection_id, 'training', 'training launch')
  let reservationId: string
  try {
    reservationId = reserve(ctx, { kind: 'training', teamId: actor.teamId, jobId, userId: actor.id, model: j<TrainingConfig>(job.config, {} as TrainingConfig).baseModel, project: job.name }, estimateUsd, `Training: ${job.name} (estimate)`)
  } catch (e) {
    ctx.db.update('training_jobs', 'id', jobId, { status: 'failed', error: (e as Error).message, finished_at: now() })
    throw e
  }
  const jobFile = join(job.dir, 'job.json')
  writeFileSync(jobFile, JSON.stringify({ dataset_dir: ds.path, out_dir: job.dir, config: j(job.config, {}), seed: 13 }))
  const started = Date.now()
  ctx.db.update('training_jobs', 'id', jobId, { status: 'running', phase: 'starting', started_at: now() })
  ctx.events.emit({ type: 'job.updated', jobId, status: 'running', progress: 0, phase: 'starting' })
  let result: Record<string, unknown> | null = null
  let errorMsg: string | null = null
  let lastProgressWrite = 0
  const proc = ctx.python.spawnJob(
    'relay_worker.train',
    ['--job', jobFile],
    (e) => {
      const type = String(e.type)
      if (type === 'progress') {
        const progress = Number(e.step) / Math.max(1, Number(e.total_steps))
        ctx.db.update('training_jobs', 'id', jobId, { progress, phase: 'training' })
        ctx.events.emit({ type: 'job.updated', jobId, status: 'running', progress, phase: 'training' })
        if (Date.now() - lastProgressWrite > 500 || progress >= 1) {
          lastProgressWrite = Date.now()
          event(ctx, jobId, type, e)
        }
        return
      }
      if (type === 'phase') {
        ctx.db.update('training_jobs', 'id', jobId, { phase: String(e.phase) })
        ctx.events.emit({ type: 'job.updated', jobId, status: 'running', progress: ctx.db.get<{ progress: number }>('SELECT progress FROM training_jobs WHERE id = ?', jobId)!.progress, phase: String(e.phase) })
      }
      if (type === 'baseline') ctx.db.update('training_jobs', 'id', jobId, { baseline_metrics: js(e.metrics) })
      if (type === 'result') result = e
      if (type === 'error') errorMsg = String(e.message)
      event(ctx, jobId, type, type === 'result' ? { message: 'Training finished; metrics recorded.' } : e)
    },
    (code, signal, stderr) => {
      running.delete(jobId)
      const elapsed = (Date.now() - started) / 1000
      const cur = ctx.db.get<{ status: string }>('SELECT status FROM training_jobs WHERE id = ?', jobId)!
      const rate = getPolicy(ctx).localComputeRateUsdPerHour
      reconcile(ctx, reservationId, rate > 0 ? (elapsed / 3600) * rate : 0, 'metered', `Training: ${job.name} (${Math.round(elapsed)}s local compute)`)
      const res = result as Record<string, unknown> | null
      if (cur.status === 'cancelled') {
        ctx.db.update('training_jobs', 'id', jobId, { elapsed_sec: elapsed, finished_at: now() })
      } else if (code === 0 && res && existsSync(join(job.dir, 'model', 'relay.json'))) {
        ctx.db.update('training_jobs', 'id', jobId, { status: 'succeeded', progress: 1, phase: 'done', metrics: js(res), elapsed_sec: elapsed, finished_at: now() })
        notify(ctx, actor.id, `Training finished: ${job.name}`, 'Review the evaluation before registering the model.', `models/jobs/${jobId}`, 'success')
      } else {
        const msg = errorMsg ?? (signal ? `Training process ended by signal ${signal}.` : `Training process exited with code ${code}. ${stderr.split('\n').slice(-3).join(' ')}`)
        ctx.db.update('training_jobs', 'id', jobId, { status: 'failed', error: msg, elapsed_sec: elapsed, finished_at: now() })
        notify(ctx, actor.id, `Training failed: ${job.name}`, msg.slice(0, 300), `models/jobs/${jobId}`, 'error')
      }
      const final = ctx.db.get<{ status: string; progress: number; phase: string }>('SELECT status, progress, phase FROM training_jobs WHERE id = ?', jobId)!
      audit(ctx, actor, `training.job_${final.status}`, { type: 'training_job', id: jobId }, { elapsedSec: Math.round(elapsed), exitCode: code })
      ctx.events.emit({ type: 'job.updated', jobId, status: final.status, progress: final.progress, phase: final.phase })
    }
  )
  ctx.db.update('training_jobs', 'id', jobId, { pid: proc.pid ?? null })
  running.set(jobId, proc)
}

export function cancelTraining(ctx: AppContext, actor: Actor, jobId: string) {
  const job = ctx.db.get<{ status: string; created_by: string }>('SELECT status, created_by FROM training_jobs WHERE id = ?', jobId)
  if (!job) throw notFound('Training job')
  if (job.created_by !== actor.id && !roleHas(actor.role, 'models.administer')) throw new RelayError('forbidden', 'Only the person who started this job or an administrator can cancel it.')
  if (!['queued', 'running', 'awaiting_approval'].includes(job.status)) throw new RelayError('conflict', `A ${job.status} job cannot be cancelled.`)
  ctx.db.update('training_jobs', 'id', jobId, { status: 'cancelled', error: `Cancelled by ${actor.name}`, finished_at: now() })
  const proc = running.get(jobId)
  if (proc) {
    proc.kill('SIGTERM')
    setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 5000)
  }
  event(ctx, jobId, 'cancelled', { message: `Cancelled by ${actor.name}` })
  audit(ctx, actor, 'training.job_cancelled', { type: 'training_job', id: jobId }, {})
  ctx.events.emit({ type: 'job.updated', jobId, status: 'cancelled', progress: 0, phase: 'cancelled' })
}

export function listJobs(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'training.run', 'view training jobs')
  return ctx.db.all<Record<string, unknown>>('SELECT j.*, u.name AS created_by_name, d.name AS dataset_name, d.version AS dataset_version FROM training_jobs j JOIN users u ON u.id = j.created_by JOIN datasets d ON d.id = j.dataset_id ORDER BY j.created_at DESC').map(presentJob(ctx))
}

const presentJob = (ctx: AppContext) => (r: Record<string, unknown>) => ({
  id: r.id as string,
  name: r.name as string,
  status: r.status as string,
  phase: r.phase as string,
  progress: r.progress as number,
  config: j<TrainingConfig>(r.config, {} as TrainingConfig),
  metrics: j<Record<string, unknown> | null>(r.metrics, null),
  baselineMetrics: j<Record<string, unknown> | null>(r.baseline_metrics, null),
  hardware: j<Record<string, unknown>>(r.hardware, {}),
  error: r.error as string | null,
  createdBy: r.created_by_name as string,
  datasetId: r.dataset_id as string,
  datasetName: `${r.dataset_name} v${r.dataset_version}`,
  createdAt: r.created_at as string,
  startedAt: r.started_at as string | null,
  finishedAt: r.finished_at as string | null,
  elapsedSec: r.elapsed_sec as number | null,
  registeredModel: ctx.db.get<{ id: string; name: string; version: number; status: string }>('SELECT id, name, version, status FROM models WHERE job_id = ?', r.id as string) ?? null
})

export function getJob(ctx: AppContext, actor: Actor, id: string) {
  requireCap(ctx, actor, 'training.run', 'view training jobs')
  const r = ctx.db.get<Record<string, unknown>>('SELECT j.*, u.name AS created_by_name, d.name AS dataset_name, d.version AS dataset_version FROM training_jobs j JOIN users u ON u.id = j.created_by JOIN datasets d ON d.id = j.dataset_id WHERE j.id = ?', id)
  if (!r) throw notFound('Training job')
  return {
    ...presentJob(ctx)(r),
    events: ctx.db.all<{ ts: string; type: string; data: string }>('SELECT ts, type, data FROM training_events WHERE job_id = ? ORDER BY id', id).map((e) => ({ ...j<Record<string, unknown>>(e.data, {}), ts: e.ts, type: e.type }) as { ts: string; type: string; [k: string]: unknown })
  }
}

/** Jobs cannot resume after the app closes; mark them failed rather than pretending they finished. */
export function recoverTrainingJobs(ctx: AppContext) {
  for (const jb of ctx.db.all<{ id: string }>("SELECT id FROM training_jobs WHERE status IN ('running','queued')")) {
    ctx.db.update('training_jobs', 'id', jb.id, { status: 'failed', error: 'Interrupted: Relay closed during training. Training is not resumable in this build; start a new job.', finished_at: now() })
    ctx.db.run("UPDATE ledger SET status = 'released', updated_at = ? WHERE job_id = ? AND status = 'open'", now(), jb.id)
  }
}

export function registerTrainingApprovalHandler() {
  registerApprovalHandler('training_job', {
    managerLimit: (ctx, _actor, a) => {
      const p = j<{ costUsd: number }>(a.payload, { costUsd: 0 })
      return p.costUsd > getPolicy(ctx).managerApprovalCeilingUsd ? 'Above your approval ceiling; an administrator must decide.' : null
    },
    apply: (ctx, approver, a) => {
      const p = j<{ jobId: string; costUsd: number }>(a.payload, { jobId: '', costUsd: 0 })
      const job = ctx.db.get<{ status: string; created_by: string }>('SELECT status, created_by FROM training_jobs WHERE id = ?', p.jobId)
      if (!job || job.status !== 'awaiting_approval') throw new RelayError('conflict', 'This job is no longer waiting for approval.')
      const requester = ctx.db.get<{ id: string; name: string; role: Actor['role']; team_id: string | null }>('SELECT * FROM users WHERE id = ?', job.created_by)!
      ctx.db.update('training_jobs', 'id', p.jobId, { status: 'queued' })
      launch(ctx, { id: requester.id, name: requester.name, role: requester.role, teamId: requester.team_id }, p.jobId, p.costUsd)
      audit(ctx, approver, 'training.job_approved', { type: 'training_job', id: p.jobId }, {})
    },
    onReject: (ctx, _a, a) => {
      const p = j<{ jobId: string }>(a.payload, { jobId: '' })
      ctx.db.update('training_jobs', 'id', p.jobId, { status: 'cancelled', error: 'Approval rejected', finished_at: now() })
    }
  })
}

export type { DatasetConfig }
