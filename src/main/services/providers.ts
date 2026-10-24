import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap, getCollection } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, notFound } from '../core/errors'
import { getPolicy } from '../core/settings'
import { roleHas } from '@shared/permissions'
import { storeCredential, resolveSecret, hasCredential } from './credentials'
import { anthropicAdapter, geminiAdapter, openaiAdapter, localAdapter, isLoopbackUrl } from '../providers/adapters'
import type { GenerateRequest, GenerateResult, ProviderAdapter, ProviderConfig } from '../providers/types'
import { findPrice, priceTokens, recordUsage, reconcile, release, requirePrice, reserve, type Attribution } from './budget'

export interface ProviderRow {
  id: string
  kind: ProviderConfig['kind']
  name: string
  base_url: string | null
  credential_id: string | null
  enabled: number
  external: number
  models: string
  status: string
  status_detail: string
}

const DEFAULT_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com'
}

export function providerHost(p: ProviderRow): string {
  if (p.kind === 'local') return 'this computer'
  if (p.base_url) {
    try {
      return new URL(p.base_url).hostname
    } catch {
      return p.base_url
    }
  }
  return DEFAULT_HOSTS[p.kind] ?? p.kind
}

export function listProviders(ctx: AppContext, actor: Actor) {
  const rows = ctx.db.all<ProviderRow>('SELECT * FROM providers ORDER BY name')
  const admin = roleHas(actor.role, 'credentials.manage')
  return rows.map((p) => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseUrl: admin ? p.base_url : null,
    models: j<string[]>(p.models, []),
    enabled: !!p.enabled,
    external: !!p.external,
    destination: providerHost(p),
    configured: p.kind === 'local' || (p.kind === 'openai_compatible' && !!p.base_url && (!p.external || hasCredential(ctx, p.credential_id))) || hasCredential(ctx, p.credential_id),
    status: p.status,
    statusDetail: p.status_detail
  }))
}

export const ProviderInputSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['anthropic', 'gemini', 'openai_compatible', 'local']),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url().nullable().default(null),
  apiKey: z.string().max(4000).optional(),
  models: z.array(z.string().min(1)).min(1).max(30),
  enabled: z.boolean().default(true)
})

export function upsertProvider(ctx: AppContext, actor: Actor, input: z.infer<typeof ProviderInputSchema>) {
  requireCap(ctx, actor, 'credentials.manage', 'configure model providers')
  const id = input.id ?? newId('prv')
  const existing = ctx.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
  let credentialId = existing?.credential_id ?? null
  if (input.apiKey) credentialId = storeCredential(ctx, actor, { name: `${input.name} API key`, kind: 'api_key', service: input.kind, secret: input.apiKey }, credentialId ?? undefined)
  // External/local is derived from the endpoint, never claimed by configuration.
  const external = input.kind === 'local' ? false : input.kind === 'openai_compatible' ? !isLoopbackUrl(input.baseUrl) : true
  ctx.db.run(
    `INSERT INTO providers (id, kind, name, base_url, credential_id, enabled, external, models, status, status_detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, base_url=excluded.base_url, credential_id=excluded.credential_id,
     enabled=excluded.enabled, external=excluded.external, models=excluded.models, status='unchecked', status_detail=''`,
    id,
    input.kind,
    input.name,
    input.baseUrl,
    credentialId,
    input.enabled,
    external,
    js(input.models),
    'unchecked',
    '',
    now()
  )
  audit(ctx, actor, existing ? 'provider.updated' : 'provider.added', { type: 'provider', id }, { kind: input.kind, name: input.name, models: input.models, external, keyChanged: !!input.apiKey })
  return { id }
}

export function getProvider(ctx: AppContext, id: string): ProviderRow {
  const p = ctx.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
  if (!p) throw notFound('Model provider')
  return p
}

export function adapterFor(ctx: AppContext, kind: ProviderConfig['kind']): ProviderAdapter {
  return kind === 'anthropic' ? anthropicAdapter : kind === 'gemini' ? geminiAdapter : kind === 'openai_compatible' ? openaiAdapter : localAdapter(ctx)
}

export function providerConfig(ctx: AppContext, p: ProviderRow): ProviderConfig {
  const needsKey = p.kind === 'anthropic' || p.kind === 'gemini' || (p.kind === 'openai_compatible' && p.external)
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseUrl: p.base_url,
    apiKey: needsKey || p.credential_id ? (p.credential_id ? resolveSecret(ctx, p.credential_id) : null) : null,
    external: !!p.external
  }
}

/** Egress policy: data from a local-only collection may never reach an external destination. */
export function checkEgress(ctx: AppContext, destination: { external: boolean; host: string; label: string }, taint: string[]) {
  if (!destination.external) return
  const policy = getPolicy(ctx)
  const allowedHosts = policy.allowedExternalDestinations
  const hostAllowed =
    allowedHosts.includes(destination.host) || (destination.host === 'public-web' && allowedHosts.includes('*.public-web'))
  if (!hostAllowed)
    throw new RelayError('policy', `Company policy does not allow sending data to ${destination.host}. An administrator can add it under Settings → Policies.`)
  for (const cid of [...new Set(taint)]) {
    const c = ctx.db.get<{ name: string; allow_external: number }>('SELECT name, allow_external FROM collections WHERE id = ?', cid)
    if (c && !c.allow_external)
      throw new RelayError(
        'policy',
        `Blocked: this step would send data from “${c.name}” to ${destination.label} (${destination.host}). That collection is marked local-only.`,
        { collectionId: cid, destination: destination.host }
      )
  }
}

export function checkModelAllowed(ctx: AppContext, p: ProviderRow, model: string) {
  const ok = getPolicy(ctx).allowedModels.some((m) => m.providerKind === p.kind && (m.model === '*' || m.model === model))
  if (!ok) throw new RelayError('policy', `Model ${model} on ${p.name} is not on the company's allowed model list.`)
  if (!j<string[]>(p.models, []).includes(model)) throw new RelayError('policy', `Model ${model} is not enabled for ${p.name}.`)
}

export interface ModelCallInput {
  actor: Actor
  providerId: string
  request: Omit<GenerateRequest, 'model'> & { model: string }
  attribution: Attribution
  taint: string[]
  purpose: string
}

export interface ModelCallResult extends GenerateResult {
  costUsd: number
  costBasis: 'metered' | 'local'
  estimateUsd: number
}

/**
 * Single choke point for general model calls: provider availability, allowed-model policy,
 * data egress, budget reservation, usage metering, and reconciliation.
 */
export async function callModel(ctx: AppContext, input: ModelCallInput): Promise<ModelCallResult> {
  const p = getProvider(ctx, input.providerId)
  if (!p.enabled) throw new RelayError('unavailable', `${p.name} is disabled by an administrator.`)
  checkModelAllowed(ctx, p, input.request.model)
  checkEgress(ctx, { external: !!p.external, host: providerHost(p), label: p.name }, input.taint)
  const cfg = providerConfig(ctx, p)
  const adapter = adapterFor(ctx, p.kind)
  const chars = input.request.system.length + JSON.stringify(input.request.messages).length + JSON.stringify(input.request.tools ?? []).length
  const estIn = Math.ceil(chars / 3.2)
  const isLocal = p.kind === 'local' || !p.external
  const price = isLocal ? findPrice(ctx, p.kind, input.request.model) : requirePrice(ctx, p.kind, input.request.model)
  const estimate = isLocal ? 0 : (priceTokens(price, estIn, input.request.maxTokens) ?? 0)
  const reservationId = reserve(ctx, { ...input.attribution, model: input.request.model }, estimate, `${input.purpose}: ${p.name} ${input.request.model} (estimate)`)
  let res: GenerateResult
  try {
    res = await adapter.generate(cfg, input.request)
  } catch (e) {
    const err = e as RelayError
    // An HTTP error response means the provider rejected the call; a network failure leaves the
    // outcome unknown, so the reserved estimate is kept as an estimated charge.
    if (err.details?.httpStatus || err.code === 'unavailable' || err.code === 'forbidden' || err.code === 'policy') release(ctx, reservationId)
    else reconcile(ctx, reservationId, estimate, 'estimate', `${input.purpose}: outcome unknown after network error — estimate kept`)
    throw e
  }
  const metered = isLocal ? 0 : priceTokens(price, res.usage.inputTokens, res.usage.outputTokens)
  const cost = metered ?? estimate
  reconcile(ctx, reservationId, cost, metered === null ? 'estimate' : 'metered', `${input.purpose}: ${p.name} ${input.request.model}`)
  recordUsage(ctx, {
    runId: input.attribution.runId,
    jobId: input.attribution.jobId,
    provider: p.kind,
    model: input.request.model,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: isLocal ? 0 : metered,
    basis: isLocal ? 'local' : metered === null ? 'unpriced' : 'metered',
    priceId: price?.id
  })
  return { ...res, costUsd: cost, costBasis: isLocal ? 'local' : 'metered', estimateUsd: estimate }
}

export async function checkProvider(ctx: AppContext, actor: Actor, id: string) {
  requireCap(ctx, actor, 'credentials.manage', 'test model providers')
  const p = getProvider(ctx, id)
  const model = j<string[]>(p.models, [])[0]
  try {
    if (p.kind === 'local') {
      const env = await ctx.python.call<{ packages: Record<string, boolean> }>('env_check', {}, { timeoutMs: 60_000 })
      if (!env.packages.transformers) throw new RelayError('unavailable', 'Transformers is not installed in the Python worker. Run: npm run setup:python -- --train')
      ctx.db.update('providers', 'id', id, { status: 'ok', status_detail: 'Python worker ready. The model downloads on first use.' })
    } else {
      await callModel(ctx, {
        actor,
        providerId: id,
        request: { model, system: 'Reply with the single word: ok', messages: [{ role: 'user', content: [{ type: 'text', text: 'Connection test' }] }], maxTokens: 16 },
        attribution: { kind: 'operating', userId: actor.id, project: 'connection-test' },
        taint: [],
        purpose: 'Provider connection test'
      })
      ctx.db.update('providers', 'id', id, { status: 'ok', status_detail: `Test call to ${model} succeeded at ${now()}` })
    }
  } catch (e) {
    ctx.db.update('providers', 'id', id, { status: 'error', status_detail: (e as Error).message })
  }
  audit(ctx, actor, 'provider.checked', { type: 'provider', id }, {})
  return listProviders(ctx, actor).find((x) => x.id === id)
}

/** Default general-model provider used when an agent does not pin one. */
export function defaultModelRef(ctx: AppContext): { providerId: string; model: string } | null {
  for (const p of ctx.db.all<ProviderRow>('SELECT * FROM providers WHERE enabled = 1 ORDER BY CASE kind WHEN \'anthropic\' THEN 0 WHEN \'gemini\' THEN 1 WHEN \'openai_compatible\' THEN 2 ELSE 3 END')) {
    const configured = p.kind === 'local' || hasCredential(ctx, p.credential_id) || (p.kind === 'openai_compatible' && !p.external && !!p.base_url)
    if (configured) return { providerId: p.id, model: j<string[]>(p.models, [])[0] }
  }
  return null
}

export function collectionNames(ctx: AppContext, ids: string[]) {
  return ids.map((id) => {
    try {
      return getCollection(ctx, id).name
    } catch {
      return id
    }
  })
}
