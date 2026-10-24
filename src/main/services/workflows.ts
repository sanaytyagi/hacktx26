import { createWriteStream, existsSync, statSync, copyFileSync, readFileSync, rmSync, type WriteStream } from 'node:fs'
import { extname, join } from 'node:path'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { audit } from '../core/audit'
import { RelayError, forbidden, notFound, invalid, unavailable } from '../core/errors'
import { canSeeOwner, checkCollectionUse, requireCap } from '../core/authz'
import { getPolicy } from '../core/settings'
import {
  WorkflowDraftSchema,
  WorkflowStepSchema,
  STEP_CAPABILITIES,
  CAPABILITY_LABELS,
  AgentSpecSchema,
  type WorkflowDraft,
  type WorkflowStep,
  type AutomationKind,
  type StepCapability,
  type AgentSpec,
  type AgentStep,
  type ToolDeclaration
} from '@shared/domain'
import { getProvider, providerConfig, providerHost, checkEgress, listProviders, adapterFor } from './providers'
import { geminiUploadFile, geminiGenerate } from '../providers/adapters'
import { requirePrice, priceTokens, reserve, reconcile, release, recordUsage, findPrice } from './budget'
import { parseJsonObject } from '../engine/runner'
import { checkToolUse, toolNeeds, getToolRow } from '../tools/registry'

// ---------------- Recordings ----------------

const VIDEO_EXTS: Record<string, string> = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4' }
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
const sessions = new Map<string, { stream: WriteStream; path: string; ownerId: string; bytes: number; mime: string }>()

export function beginRecording(ctx: AppContext, actor: Actor, mime: string) {
  if (!/^video\/(webm|mp4)/.test(mime)) throw invalid('Unsupported recording format.')
  const id = newId('rec')
  const path = join(ctx.paths.recordings, `${id}.${mime.includes('mp4') ? 'mp4' : 'webm'}`)
  sessions.set(id, { stream: createWriteStream(path), path, ownerId: actor.id, bytes: 0, mime: mime.split(';')[0] })
  return { sessionId: id }
}

export function appendRecording(actor: Actor, sessionId: string, chunk: Uint8Array) {
  const s = sessions.get(sessionId)
  if (!s || s.ownerId !== actor.id) throw notFound('Recording session')
  s.bytes += chunk.byteLength
  if (s.bytes > MAX_VIDEO_BYTES) throw invalid('Recording is too large (2 GB limit).')
  s.stream.write(Buffer.from(chunk))
}

export async function finishRecording(ctx: AppContext, actor: Actor, sessionId: string, meta: { title: string; durationSec: number | null; cancel?: boolean }) {
  const s = sessions.get(sessionId)
  if (!s || s.ownerId !== actor.id) throw notFound('Recording session')
  sessions.delete(sessionId)
  await new Promise<void>((r) => s.stream.end(() => r()))
  if (meta.cancel || s.bytes === 0) {
    rmSync(s.path, { force: true })
    return null
  }
  ctx.db.insert('recordings', { id: sessionId, owner_id: actor.id, title: meta.title || 'Screen recording', file_path: s.path, mime: s.mime, size: s.bytes, duration_sec: meta.durationSec, origin: 'screen', created_at: now() })
  audit(ctx, actor, 'recording.saved', { type: 'recording', id: sessionId }, { bytes: s.bytes, origin: 'screen' })
  return { id: sessionId }
}

export function importRecording(ctx: AppContext, actor: Actor, input: { path: string; title?: string; durationSec?: number | null }) {
  const ext = extname(input.path).toLowerCase()
  const mime = VIDEO_EXTS[ext]
  if (!mime) throw invalid(`Video type “${ext}” is not supported. Use MP4, WebM, MOV or MKV.`)
  if (!existsSync(input.path)) throw notFound('Video file')
  const size = statSync(input.path).size
  if (size > MAX_VIDEO_BYTES) throw invalid('Video is too large (2 GB limit).')
  const id = newId('rec')
  const dest = join(ctx.paths.recordings, `${id}${ext}`)
  copyFileSync(input.path, dest)
  ctx.db.insert('recordings', { id, owner_id: actor.id, title: input.title || input.path.split(/[\\/]/).pop()!, file_path: dest, mime, size, duration_sec: input.durationSec ?? null, origin: 'import', created_at: now() })
  audit(ctx, actor, 'recording.imported', { type: 'recording', id }, { bytes: size })
  return { id }
}

export function getRecording(ctx: AppContext, actor: Actor, id: string) {
  const r = ctx.db.get<{ id: string; owner_id: string; title: string; file_path: string; mime: string; size: number; duration_sec: number | null; origin: string; created_at: string }>(
    'SELECT * FROM recordings WHERE id = ?',
    id
  )
  if (!r || !canSeeOwner(ctx, actor, r.owner_id)) throw notFound('Recording')
  return r
}

export function setRecordingDuration(ctx: AppContext, actor: Actor, id: string, durationSec: number) {
  const r = getRecording(ctx, actor, id)
  if (r.owner_id !== actor.id) throw forbidden('Not your recording.')
  ctx.db.update('recordings', 'id', id, { duration_sec: durationSec })
}

export function deleteRecording(ctx: AppContext, actor: Actor, id: string) {
  const r = getRecording(ctx, actor, id)
  if (r.owner_id !== actor.id && actor.role !== 'admin') throw forbidden('Not your recording.')
  rmSync(r.file_path, { force: true })
  ctx.db.run('DELETE FROM recordings WHERE id = ?', id)
  ctx.db.run('UPDATE workflows SET recording_id = NULL WHERE recording_id = ?', id)
  audit(ctx, actor, 'recording.deleted', { type: 'recording', id }, {})
}

// ---------------- Workflow drafts ----------------

interface WorkflowRow {
  id: string
  owner_id: string
  recording_id: string | null
  draft: string
  analysis: string
  status: string
  agent_id: string | null
  created_at: string
  updated_at: string
}

export function createWorkflow(ctx: AppContext, actor: Actor, input: { recordingId?: string | null; draft: Partial<WorkflowDraft> }) {
  requireCap(ctx, actor, 'agents.create', 'capture workflows')
  if (input.recordingId) getRecording(ctx, actor, input.recordingId)
  const draft = WorkflowDraftSchema.parse({ name: 'Untitled workflow', ...input.draft })
  const id = newId('wf')
  ctx.db.insert('workflows', { id, owner_id: actor.id, recording_id: input.recordingId ?? null, draft: js(draft), analysis: '{}', status: 'draft', created_at: now(), updated_at: now() })
  return { id }
}

function wfRow(ctx: AppContext, actor: Actor, id: string): WorkflowRow {
  const w = ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id)
  if (!w || !canSeeOwner(ctx, actor, w.owner_id)) throw notFound('Workflow')
  return w
}

export function getWorkflow(ctx: AppContext, actor: Actor, id: string) {
  const w = wfRow(ctx, actor, id)
  const draft = WorkflowDraftSchema.parse(j(w.draft, {}))
  return {
    id: w.id,
    recording: w.recording_id ? getRecording(ctx, actor, w.recording_id) : null,
    draft,
    analysis: j<Record<string, unknown>>(w.analysis, {}),
    status: w.status,
    agentId: w.agent_id,
    plan: recommend(ctx, actor, draft)
  }
}

export function listWorkflows(ctx: AppContext, actor: Actor) {
  return ctx.db
    .all<WorkflowRow>('SELECT * FROM workflows WHERE owner_id = ? ORDER BY updated_at DESC', actor.id)
    .map((w) => ({ id: w.id, name: WorkflowDraftSchema.parse(j(w.draft, {})).name, status: w.status, agentId: w.agent_id, updatedAt: w.updated_at, hasRecording: !!w.recording_id }))
}

export function updateWorkflow(ctx: AppContext, actor: Actor, id: string, draft: WorkflowDraft) {
  const w = wfRow(ctx, actor, id)
  if (w.owner_id !== actor.id) throw forbidden('Only the owner can edit this workflow.')
  const parsed = WorkflowDraftSchema.parse(draft)
  for (const s of parsed.steps) if (s.override) checkOverride(ctx, actor, s)
  ctx.db.update('workflows', 'id', id, { draft: js(parsed), updated_at: now() })
  return getWorkflow(ctx, actor, id)
}

// ---------------- Analysis via a configured provider ----------------

const ANALYSIS_INSTRUCTIONS = `You analyze a screen recording (and/or written description) of an employee's work task to help decide what to automate.
Describe only what is actually visible or stated. Screen recordings do not show hidden application state, clicks you cannot see, or DOM events: if you cannot tell what happened in a step, set "uncertain": true and say what is unclear.
Return a single JSON object:
{
  "summary": string,
  "applications": string[],
  "steps": [{
    "title": string, "description": string, "application": string,
    "inputs": string, "outputs": string,
    "timestamp": "MM:SS" or "",
    "repeated": boolean, "decisionPoint": boolean, "decisionRule": string,
    "capability": one of ${JSON.stringify(STEP_CAPABILITIES)},
    "uncertain": boolean
  }],
  "unsupportedOrUnclear": string[]
}`

function stepsFromAnalysis(raw: Record<string, unknown>): WorkflowStep[] {
  const steps = Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : []
  return steps.slice(0, 40).map((s, i) =>
    WorkflowStepSchema.parse({
      id: `s${i + 1}`,
      title: String(s.title ?? `Step ${i + 1}`).slice(0, 200),
      description: String(s.description ?? '').slice(0, 4000),
      application: String(s.application ?? '').slice(0, 200),
      inputs: String(s.inputs ?? '').slice(0, 1000),
      outputs: String(s.outputs ?? '').slice(0, 1000),
      timestamp: String(s.timestamp ?? '').slice(0, 20),
      repeated: !!s.repeated,
      decisionPoint: !!s.decisionPoint,
      decisionRule: String(s.decisionRule ?? '').slice(0, 2000),
      capability: (STEP_CAPABILITIES as readonly string[]).includes(String(s.capability)) ? s.capability : 'unknown',
      uncertain: !!s.uncertain
    })
  )
}

/** What would be sent, and to whom, before the user confirms. */
export function analysisPreview(ctx: AppContext, actor: Actor, workflowId: string) {
  const w = wfRow(ctx, actor, workflowId)
  const draft = WorkflowDraftSchema.parse(j(w.draft, {}))
  const rec = w.recording_id ? getRecording(ctx, actor, w.recording_id) : null
  const providers = listProviders(ctx, actor).filter((p) => p.enabled && p.configured)
  const video = providers.filter((p) => p.kind === 'gemini')
  return {
    recording: rec ? { title: rec.title, sizeBytes: rec.size, durationSec: rec.duration_sec } : null,
    textChars: (draft.goal + draft.narration + draft.rules + draft.exceptions + draft.desiredOutput).length,
    videoProviders: video.map((p) => ({ id: p.id, name: p.name, destination: p.destination, models: p.models })),
    textProviders: providers.map((p) => ({ id: p.id, name: p.name, destination: p.destination, models: p.models, external: p.external })),
    videoAnalysisAvailable: video.length > 0,
    explanation: video.length
      ? 'Automatic video analysis sends the selected recording to the provider shown. Review the recording first; nothing is sent until you confirm.'
      : 'Automatic video analysis is unavailable: no multimodal provider (Gemini) is configured. Describe the steps yourself, or ask an administrator to add a Gemini key.'
  }
}

export const AnalyzeSchema = z.object({
  workflowId: z.string(),
  providerId: z.string(),
  model: z.string(),
  includeVideo: z.boolean(),
  confirmSend: z.literal(true)
})

export async function analyzeWorkflow(ctx: AppContext, actor: Actor, input: z.infer<typeof AnalyzeSchema>) {
  const w = wfRow(ctx, actor, input.workflowId)
  if (w.owner_id !== actor.id) throw forbidden('Only the owner can analyze this workflow.')
  const draft = WorkflowDraftSchema.parse(j(w.draft, {}))
  const p = getProvider(ctx, input.providerId)
  if (!p.enabled) throw unavailable(`${p.name} is disabled.`)
  if (input.includeVideo && p.kind !== 'gemini') throw unavailable('Video analysis needs a Gemini provider in this build.')
  if (input.includeVideo && !w.recording_id) throw invalid('This workflow has no recording.')
  checkEgress(ctx, { external: !!p.external, host: providerHost(p), label: p.name }, [])
  const cfg = providerConfig(ctx, p)
  const description = [
    `Task name: ${draft.name}`,
    draft.goal && `Goal: ${draft.goal}`,
    draft.narration && `Narration / explanation: ${draft.narration}`,
    `Frequency: ${draft.frequencyPerWeek} times per week, about ${draft.minutesPerRun} minutes each`,
    draft.rules && `Rules: ${draft.rules}`,
    draft.exceptions && `Exceptions: ${draft.exceptions}`,
    draft.desiredOutput && `Desired output: ${draft.desiredOutput}`
  ]
    .filter(Boolean)
    .join('\n')
  const rec = w.recording_id ? getRecording(ctx, actor, w.recording_id) : null
  const price = p.external ? requirePrice(ctx, p.kind, input.model) : findPrice(ctx, p.kind, input.model)
  const estIn = Math.ceil(description.length / 3.2) + 1500 + (input.includeVideo ? Math.ceil((rec?.duration_sec ?? 300) * 300) : 0)
  const estimate = p.external ? (priceTokens(price, estIn, 6000) ?? 0) : 0
  const resId = reserve(ctx, { kind: 'operating', teamId: actor.teamId, userId: actor.id, model: input.model, project: 'workflow-analysis' }, estimate, `Workflow analysis: ${draft.name} (estimate)`)
  audit(ctx, actor, 'workflow.sent_for_analysis', { type: 'workflow', id: w.id }, { provider: p.name, destination: providerHost(p), includeVideo: input.includeVideo, recordingBytes: rec?.size ?? 0 })
  let result
  try {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: `${ANALYSIS_INSTRUCTIONS}\n\n<description>\n${description}\n</description>` }] }]
    if (input.includeVideo && rec) {
      const file = await geminiUploadFile(cfg, readFileSync(rec.file_path), rec.mime, rec.title)
      result = await geminiGenerate(cfg, { model: input.model, system: 'You extract workflow steps from recordings. Output JSON only.', messages, maxTokens: 6000, json: true }, [{ file_data: { mime_type: rec.mime, file_uri: file.uri } }])
    } else {
      result = await adapterFor(ctx, p.kind).generate(cfg, { model: input.model, system: 'You extract workflow steps from task descriptions. Output JSON only.', messages, maxTokens: 6000, json: p.kind !== 'local' })
    }
  } catch (e) {
    const err = e as RelayError
    if (err.details?.httpStatus || err.code === 'unavailable') release(ctx, resId)
    else reconcile(ctx, resId, estimate, 'estimate', 'Workflow analysis: outcome unknown after network error')
    throw e
  }
  const metered = p.external ? priceTokens(price, result.usage.inputTokens, result.usage.outputTokens) : 0
  reconcile(ctx, resId, metered ?? estimate, metered === null ? 'estimate' : 'metered', `Workflow analysis: ${draft.name}`)
  recordUsage(ctx, { provider: p.kind, model: input.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: metered, basis: p.external ? 'metered' : 'local', priceId: price?.id })
  const parsed = parseJsonObject(result.text)
  if (!parsed) throw new RelayError('failed', 'The provider’s response could not be read as a workflow. Try again, or write the steps yourself.')
  const steps = stepsFromAnalysis(parsed)
  const analysis = {
    provider: p.name,
    model: input.model,
    includedVideo: input.includeVideo,
    at: now(),
    summary: String(parsed.summary ?? ''),
    applications: Array.isArray(parsed.applications) ? parsed.applications.map(String) : [],
    unsupportedOrUnclear: Array.isArray(parsed.unsupportedOrUnclear) ? parsed.unsupportedOrUnclear.map(String) : [],
    tokens: result.usage
  }
  ctx.db.update('workflows', 'id', w.id, { draft: js({ ...draft, steps }), analysis: js(analysis), status: 'analyzed', updated_at: now() })
  return getWorkflow(ctx, actor, w.id)
}

// ---------------- Recommendations ----------------

const CAP_TOOLS: Record<StepCapability, string[]> = {
  web_search: ['web.search'],
  page_extract: ['web.extract'],
  source_compare: ['web.compare', 'model.generate'],
  doc_search: ['docs.search', 'docs.read'],
  data_read: ['data.query'],
  db_query: ['db.query', 'db.schema'],
  transform: ['data.transform'],
  classify: ['text.classify_keywords', 'model.generate'],
  extract_fields: ['text.extract_fields', 'model.generate'],
  generate: ['model.generate', 'docs.summarize'],
  write_table: ['table.write'],
  export: ['table.export', 'files.write'],
  notify: ['notify.user'],
  send_message: ['message.draft'],
  ticket_update: [],
  human_judgment: ['human.review'],
  desktop_action: [],
  unknown: []
}

const MODEL_CAPS: StepCapability[] = ['generate', 'classify', 'source_compare']
const DETERMINISTIC_CAPS: StepCapability[] = ['web_search', 'page_extract', 'doc_search', 'data_read', 'db_query', 'transform', 'write_table', 'export', 'notify', 'send_message', 'ticket_update']
const CHECKPOINT_CAPS: StepCapability[] = ['send_message', 'ticket_update']

export interface ToolOption {
  key: string
  name: string
  status: 'available' | 'needs_connection' | 'requires_permission'
  detail: string
  access: string
  external: boolean
  purpose: string
}

/** Tools that can perform a capability, from the registry, with this person's status for each. */
export function toolOptionsFor(ctx: AppContext, actor: Actor, cap: StepCapability): ToolOption[] {
  const rows = ctx.db.all<{ key: string; declaration: string; enabled: number }>('SELECT key, declaration, enabled FROM tools WHERE enabled = 1')
  const keys = new Set(CAP_TOOLS[cap])
  for (const r of rows) if (j<ToolDeclaration>(r.declaration, {} as ToolDeclaration).capabilities?.includes(cap)) keys.add(r.key)
  // Registered specialized models can classify.
  if (cap === 'classify') for (const r of rows) if (r.key.startsWith('model.') && r.key !== 'model.generate') keys.add(r.key)
  const out: ToolOption[] = []
  for (const key of keys) {
    const r = rows.find((x) => x.key === key)
    if (!r) continue
    const d = j<ToolDeclaration>(r.declaration, {} as ToolDeclaration)
    const needs = toolNeeds(ctx, getToolRow(ctx, key))
    const use = checkToolUse(ctx, actor, key)
    out.push({
      key,
      name: d.name,
      status: needs ? 'needs_connection' : use.allowed ? 'available' : 'requires_permission',
      detail: needs ?? use.reason,
      access: d.access,
      external: d.external,
      purpose: `${CAPABILITY_LABELS[cap]}: ${d.description}`
    })
  }
  const rank = { available: 0, requires_permission: 1, needs_connection: 2 }
  return out.sort((a, b) => rank[a.status] - rank[b.status])
}

function checkOverride(ctx: AppContext, actor: Actor, s: WorkflowStep) {
  if (!s.override || s.override === 'manual' || s.override === 'human_review') return
  const opts = toolOptionsFor(ctx, actor, s.capability)
  if (!opts.length) throw new RelayError('policy', `“${s.title}” cannot be automated: no installed tool can ${CAPABILITY_LABELS[s.capability].toLowerCase()}. Keep it as a human step.`)
}

export interface StepPlan {
  stepId: string
  recommended: AutomationKind
  effective: AutomationKind
  confidence: 'high' | 'medium' | 'low'
  reasons: { factor: string; text: string; effect: 'favors' | 'against' | 'neutral' }[]
  checkpoint: boolean
  policyNotes: string[]
  tools: ToolOption[]
  missingCapability: string | null
  minutesPerRun: number
}

export function recommend(ctx: AppContext, actor: Actor, draft: WorkflowDraft) {
  const n = Math.max(1, draft.steps.length)
  const perStep = draft.minutesPerRun / n
  const policy = getPolicy(ctx)
  const plans: StepPlan[] = draft.steps.map((s) => {
    const reasons: StepPlan['reasons'] = []
    const tools = toolOptionsFor(ctx, actor, s.capability).filter((t) => t.key !== 'human.review')
    const available = tools.filter((t) => t.status === 'available')
    const weekly = perStep * draft.frequencyPerWeek
    reasons.push({
      factor: 'Frequency & time',
      text: `Done ${draft.frequencyPerWeek}×/week; this step is ~${perStep.toFixed(1)} min each time (≈${weekly.toFixed(0)} min/week, assuming time is split evenly across steps).`,
      effect: weekly >= 30 ? 'favors' : weekly >= 10 ? 'neutral' : 'against'
    })
    reasons.push({
      factor: 'Clear inputs & success criteria',
      text: `Inputs are ${s.inputsClear === 'yes' ? 'clear' : s.inputsClear === 'partly' ? 'partly clear' : 'unclear'}; success is ${s.successClear === 'yes' ? 'well defined' : s.successClear === 'partly' ? 'partly defined' : 'not defined'}.`,
      effect: s.inputsClear === 'yes' && s.successClear === 'yes' ? 'favors' : s.inputsClear === 'no' || s.successClear === 'no' ? 'against' : 'neutral'
    })
    reasons.push({
      factor: 'Tool availability',
      text: available.length
        ? `Available: ${available.map((t) => t.name).join(', ')}.`
        : tools.length
          ? `Possible with ${tools.map((t) => `${t.name} (${t.status === 'requires_permission' ? 'needs your access approved' : 'needs connection'})`).join(', ')}.`
          : `No installed tool can ${CAPABILITY_LABELS[s.capability].toLowerCase()}.`,
      effect: available.length ? 'favors' : 'against'
    })
    reasons.push({
      factor: 'Verifying output',
      text: s.verification === 'easy' ? 'Output is easy to check.' : s.verification === 'moderate' ? 'Output takes some effort to check.' : 'Output is hard to check.',
      effect: s.verification === 'easy' ? 'favors' : s.verification === 'hard' ? 'against' : 'neutral'
    })
    reasons.push({
      factor: 'Impact of a mistake',
      text: s.impact === 'high' ? 'A wrong action would have high impact.' : s.impact === 'medium' ? 'A wrong action would have moderate impact.' : 'A mistake would be low impact.',
      effect: s.impact === 'high' ? 'against' : s.impact === 'low' ? 'favors' : 'neutral'
    })
    const restricted = s.collectionIds.filter((c) => !checkCollectionUse(ctx, actor, c, 'retrieval').allowed)
    const localOnly = s.collectionIds.filter((c) => !ctx.db.get<{ allow_external: number }>('SELECT allow_external FROM collections WHERE id = ?', c)?.allow_external)
    if (s.collectionIds.length)
      reasons.push({
        factor: 'Data restrictions',
        text: restricted.length
          ? `You don't yet have access to ${restricted.length} required collection(s).`
          : localOnly.length
            ? 'Uses local-only data: it can be processed only by tools and models that run on this computer.'
            : 'Uses data you are allowed to use.',
        effect: restricted.length ? 'against' : 'neutral'
      })
    let kind: AutomationKind
    let confidence: StepPlan['confidence'] = 'medium'
    let missing: string | null = null
    if (s.capability === 'human_judgment') {
      kind = 'human_review'
      confidence = 'high'
    } else if (s.capability === 'desktop_action' || s.capability === 'unknown' || (!tools.length && !MODEL_CAPS.includes(s.capability))) {
      kind = 'manual'
      confidence = 'high'
      missing = s.capability === 'desktop_action' ? 'Relay cannot click or type in desktop apps or websites.' : s.capability === 'unknown' ? 'It is unclear what this step does.' : `No installed tool can ${CAPABILITY_LABELS[s.capability].toLowerCase()}.`
    } else if (s.impact === 'high' && s.verification === 'hard') {
      kind = 'human_review'
      reasons.push({ factor: 'Risk', text: 'High impact and hard to verify: a person should make this call.', effect: 'against' })
    } else if (s.decisionPoint && !s.decisionRule.trim()) {
      kind = 'human_review'
      confidence = 'low'
      reasons.push({ factor: 'Business rule', text: 'This is a decision point without a written rule. Answer the question below to automate it.', effect: 'against' })
    } else if (DETERMINISTIC_CAPS.includes(s.capability) && s.inputsClear === 'yes' && s.successClear !== 'no') {
      kind = 'deterministic'
      confidence = available.length ? 'high' : 'medium'
    } else if (s.capability === 'extract_fields' && s.inputsClear === 'yes' && s.successClear === 'yes') {
      kind = 'deterministic'
    } else {
      kind = 'agent'
      confidence = s.inputsClear === 'no' ? 'low' : 'medium'
    }
    if (!available.length && tools.length && kind !== 'manual' && kind !== 'human_review') missing = `Needs access or a connection: ${tools[0].name}.`
    const policyNotes: string[] = []
    const checkpoint = (CHECKPOINT_CAPS.includes(s.capability) && policy.checkpointForSendAndDelete) || (s.impact === 'high' && kind !== 'human_review' && kind !== 'manual')
    if (checkpoint) policyNotes.push(CHECKPOINT_CAPS.includes(s.capability) ? 'Company policy: actions that send or change records pause for approval first.' : 'High-impact step: a review checkpoint is added before it runs.')
    if (restricted.length) policyNotes.push('Request data access before this step can run.')
    let effective = s.override ?? kind
    if (s.override && (s.override === 'agent' || s.override === 'deterministic') && !tools.length && !MODEL_CAPS.includes(s.capability)) {
      effective = kind
      policyNotes.push('Override not applied: no tool can perform this step.')
    }
    return { stepId: s.id, recommended: kind, effective, confidence, reasons, checkpoint, policyNotes, tools, missingCapability: missing, minutesPerRun: perStep }
  })
  const factor: Record<AutomationKind, number> = { deterministic: 0.9, agent: 0.7, human_review: 0.4, manual: 0 }
  const savedPerRun = plans.reduce((a, p) => a + p.minutesPerRun * factor[p.effective], 0)
  const questions: { id: string; stepId: string | null; question: string }[] = []
  for (const s of draft.steps) {
    if (s.decisionPoint && !s.decisionRule.trim()) questions.push({ id: `rule:${s.id}`, stepId: s.id, question: `In “${s.title}”, what rule decides the outcome? (e.g. “if X then Y, otherwise Z”)` })
    if (s.successClear !== 'yes') questions.push({ id: `success:${s.id}`, stepId: s.id, question: `How do you know “${s.title}” was done correctly?` })
    if (s.inputsClear === 'no') questions.push({ id: `inputs:${s.id}`, stepId: s.id, question: `Where do the inputs for “${s.title}” come from?` })
    if (s.uncertain) questions.push({ id: `unclear:${s.id}`, stepId: s.id, question: `The recording didn't make “${s.title}” clear. What happens in this step?` })
  }
  if (!draft.desiredOutput.trim()) questions.push({ id: 'output', stepId: null, question: 'What should the finished result look like (fields, format, where it goes)?' })
  if (!draft.exceptions.trim()) questions.push({ id: 'exceptions', stepId: null, question: 'What unusual cases come up, and what should happen in each?' })
  return {
    steps: plans,
    questions: questions.filter((q) => !draft.answers[q.id]),
    savings: {
      minutesPerRunBefore: draft.minutesPerRun,
      minutesSavedPerRun: Math.round(savedPerRun * 10) / 10,
      hoursSavedPerMonth: Math.round(((savedPerRun * draft.frequencyPerWeek * 52) / 12 / 60) * 10) / 10,
      assumptions: [
        `Uses your estimates: ${draft.frequencyPerWeek} runs/week × ${draft.minutesPerRun} min/run.`,
        'Time is assumed to be split evenly across steps.',
        'Assumed time saved per step: deterministic 90%, agent 70%, human review 40% (reviewing is faster than doing), manual 0%.',
        'This is a projection, not a measurement. Actual savings appear in run history once the agent is live.'
      ]
    }
  }
}

// ---------------- Agent spec generation ----------------

function slug(s: string, fallback: string) {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
  return /^[a-z_]/.test(t) ? t : fallback
}

function fieldsFrom(text: string): { key: string; type: 'string'; description: string }[] {
  const parts = text.split(/[,;\n]| and /).map((p) => p.trim()).filter(Boolean).slice(0, 8)
  const seen = new Set<string>()
  return parts
    .map((p, i) => ({ key: slug(p, `field_${i + 1}`), type: 'string' as const, description: p.slice(0, 200) }))
    .filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)))
}

/**
 * Turns the reviewed workflow into a structured, validated agent specification. This is a
 * starting draft the user reviews and edits; it is never executable code.
 */
export function buildSpec(ctx: AppContext, actor: Actor, workflowId: string, choices: Record<string, string | null> = {}): { spec: AgentSpec; notes: string[] } {
  const wf = getWorkflow(ctx, actor, workflowId)
  const d = wf.draft
  const notes: string[] = []
  const firstInputs = d.steps[0]?.inputs || 'topic'
  const inputs = fieldsFrom(firstInputs)
    .slice(0, 3)
    .map((f) => ({ key: f.key, label: f.description.slice(0, 60) || f.key, type: 'string' as const, required: true, description: '' }))
  if (!inputs.length) inputs.push({ key: 'topic', label: 'Topic', type: 'string', required: true, description: '' })
  const firstInput = `{{inputs.${inputs[0].key}}}`
  const steps: AgentStep[] = []
  const collections = new Set<string>()
  const tableName = d.name.slice(0, 60)
  for (const s of d.steps) {
    const plan = wf.plan.steps.find((p) => p.stepId === s.id)!
    s.collectionIds.forEach((c) => collections.add(c))
    const id = slug(s.title, s.id)
    const uniqueId = steps.some((x) => x.id === id) ? `${id}_${s.id}` : id
    const prev = steps[steps.length - 1]
    const prevRef = prev ? `{{steps.${prev.id}.output}}` : firstInput
    const rules = [d.rules && `Rules: ${d.rules}`, s.decisionRule && `Decision rule: ${s.decisionRule}`, d.exceptions && `Exceptions: ${d.exceptions}`].filter(Boolean).join('\n')
    const base = { id: uniqueId, title: s.title, description: s.description, approvalBefore: plan.checkpoint, onError: 'fail' as const, maxRetries: 1, agentTools: [] as string[], outputFields: [] as { key: string; type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description: string }[], prompt: '', args: {} as Record<string, unknown> }
    const chosen = choices[s.id] ?? plan.tools.find((t) => t.status === 'available')?.key ?? plan.tools[0]?.key ?? null
    if (plan.effective === 'manual') {
      steps.push({ ...base, kind: 'manual', prompt: s.description || s.title })
      continue
    }
    if (plan.effective === 'human_review') {
      steps.push({ ...base, kind: 'human_review', approvalBefore: false, prompt: `${s.description || s.title}${rules ? `\n${rules}` : ''}`, args: { data: prevRef } })
      continue
    }
    if (plan.effective === 'agent' || !chosen || chosen === 'model.generate') {
      const outputFields = fieldsFrom(s.outputs || 'result')
      steps.push({
        ...base,
        kind: 'agent',
        prompt: `${s.description || s.title}${rules ? `\n\n${rules}` : ''}`,
        args: { inputs: '{{inputs}}', previous: prevRef },
        outputFields,
        agentTools: plan.tools.filter((t) => t.status === 'available' && t.access === 'read' && t.key !== 'model.generate').map((t) => t.key).slice(0, 3)
      })
      if (plan.missingCapability) notes.push(`“${s.title}”: ${plan.missingCapability}`)
      continue
    }
    const args: Record<string, unknown> = (() => {
      switch (chosen) {
        case 'web.search':
          return { query: `${firstInput} ${s.title}`.slice(0, 200), limit: 5 }
        case 'web.extract':
          return prev && steps.find((x) => x.tool === 'web.search') ? { url: '{{item.url}}', maxChars: 8000 } : { url: firstInput }
        case 'docs.search':
          return { query: firstInput, collectionIds: s.collectionIds, limit: 5 }
        case 'data.query':
        case 'db.query':
          return { collectionId: s.collectionIds[0] ?? '', query: { limit: 50 } }
        case 'table.write':
          return { table: tableName, row: { input: firstInput, result: prevRef, recorded_at: '{{now}}' } }
        case 'table.export':
          return { table: tableName, format: 'csv' }
        case 'notify.user':
          return { to: 'owner', title: `${d.name} finished`, body: prevRef }
        case 'message.draft':
          return { to: '', subject: d.name, body: prevRef }
        case 'text.extract_fields':
          return { text: prevRef, fields: [{ name: 'emails', kind: 'email' }, { name: 'dates', kind: 'date' }] }
        case 'data.transform':
          return { rows: prevRef, operations: [{ op: 'dedupe' }] }
        default:
          return {}
      }
    })()
    const searchStep = steps.find((x) => x.tool === 'web.search')
    steps.push({
      ...base,
      kind: 'deterministic',
      tool: chosen,
      args,
      forEach: chosen === 'web.extract' && searchStep ? `{{steps.${searchStep.id}.output.results}}` : undefined,
      onError: chosen === 'web.extract' ? 'skip' : 'fail'
    })
    if (chosen === 'data.query' && !s.collectionIds.length) notes.push(`“${s.title}”: choose which dataset to read.`)
  }
  const spec = AgentSpecSchema.parse({
    schemaVersion: 1,
    instructions: [d.goal && `Goal: ${d.goal}`, d.rules && `Rules: ${d.rules}`, d.exceptions && `Exceptions: ${d.exceptions}`, d.desiredOutput && `Desired output: ${d.desiredOutput}`].filter(Boolean).join('\n'),
    inputs,
    outputs: steps.length ? [{ key: 'result', label: 'Result', from: `{{steps.${steps[steps.length - 1].id}.output}}` }] : [],
    steps,
    tools: [],
    collections: [...collections],
    limits: {}
  })
  return { spec, notes }
}
