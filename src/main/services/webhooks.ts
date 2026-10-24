import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, notFound } from '../core/errors'
import { safeFetch, checkUrl } from '../core/netguard'
import { storeCredential, resolveSecret } from './credentials'

export const WEBHOOK_EVENTS = ['run.completed', 'run.failed', 'review.requested', 'approval.decided'] as const

interface WebhookRow {
  id: string
  direction: 'inbound' | 'outbound'
  name: string
  agent_id: string | null
  url: string | null
  events: string
  credential_id: string | null
  enabled: number
  allow_private: number
  last_status: string | null
}

export const WebhookInputSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  name: z.string().min(1).max(100),
  agentId: z.string().nullable().default(null),
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).default([]),
  allowPrivateNetwork: z.boolean().default(false)
})

export function listWebhooks(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'tools.administer', 'manage webhooks')
  return ctx.db.all<WebhookRow & { agent_name: string | null }>('SELECT w.*, a.name AS agent_name FROM webhooks w LEFT JOIN agents a ON a.id = w.agent_id ORDER BY w.created_at').map((w) => ({
    id: w.id,
    direction: w.direction,
    name: w.name,
    agentId: w.agent_id,
    agentName: w.agent_name,
    url: w.url,
    events: j<string[]>(w.events, []),
    enabled: !!w.enabled,
    lastStatus: w.last_status
  }))
}

/** Creates a webhook and returns its signing secret once. */
export function createWebhook(ctx: AppContext, actor: Actor, input: z.infer<typeof WebhookInputSchema>) {
  requireCap(ctx, actor, 'tools.administer', 'manage webhooks')
  if (input.direction === 'outbound') {
    if (!input.url) throw new RelayError('invalid', 'Outbound webhooks need a destination URL.')
    checkUrl(input.url, { allowPrivateNetwork: input.allowPrivateNetwork })
    if (!input.events.length) throw new RelayError('invalid', 'Choose at least one event.')
  } else if (!input.agentId) throw new RelayError('invalid', 'Inbound webhooks start a specific agent; choose one.')
  const secret = randomBytes(24).toString('hex')
  const credId = storeCredential(ctx, actor, { name: `Webhook ${input.name} signing secret`, kind: 'webhook_secret', service: 'relay-webhook', secret })
  const id = newId('whk')
  ctx.db.insert('webhooks', {
    id,
    direction: input.direction,
    name: input.name,
    agent_id: input.agentId,
    url: input.url ?? null,
    events: js(input.events),
    credential_id: credId,
    enabled: 1,
    created_by: actor.id,
    allow_private: input.allowPrivateNetwork,
    created_at: now()
  })
  audit(ctx, actor, 'webhook.created', { type: 'webhook', id }, { direction: input.direction, name: input.name, url: input.url, events: input.events })
  return { id, secret }
}

export function deleteWebhook(ctx: AppContext, actor: Actor, id: string) {
  requireCap(ctx, actor, 'tools.administer', 'manage webhooks')
  if (!ctx.db.run('DELETE FROM webhooks WHERE id = ?', id).changes) throw notFound('Webhook')
  audit(ctx, actor, 'webhook.deleted', { type: 'webhook', id }, {})
}

export function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

/** Fire-and-forget delivery of an event to subscribed outbound webhooks. */
export function emitWebhook(ctx: AppContext, event: (typeof WEBHOOK_EVENTS)[number], payload: Record<string, unknown>, agentId?: string) {
  const hooks = ctx.db.all<WebhookRow>("SELECT * FROM webhooks WHERE direction = 'outbound' AND enabled = 1")
  for (const h of hooks) {
    if (!j<string[]>(h.events, []).includes(event)) continue
    if (h.agent_id && h.agent_id !== agentId) continue
    const body = JSON.stringify({ event, at: now(), ...payload })
    let secret: string
    try {
      secret = resolveSecret(ctx, h.credential_id)
    } catch {
      continue
    }
    const host = new URL(h.url!).hostname
    safeFetch(h.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-event': event, 'x-relay-signature': sign(secret, body) },
      body,
      timeoutMs: 10_000,
      allowedHosts: [host],
      allowPrivateNetwork: !!h.allow_private
    })
      .then((r) => ctx.db.update('webhooks', 'id', h.id, { last_status: `HTTP ${r.status} at ${now()}` }))
      .catch((e) => ctx.db.update('webhooks', 'id', h.id, { last_status: `failed: ${(e as Error).message}` }))
  }
}

export function verifyInbound(ctx: AppContext, id: string, rawBody: string, signature: string | undefined): WebhookRow {
  const h = ctx.db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = ? AND direction = 'inbound' AND enabled = 1", id)
  if (!h) throw notFound('Webhook')
  const expected = sign(resolveSecret(ctx, h.credential_id), rawBody)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature ?? '')
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new RelayError('forbidden', 'Invalid webhook signature.')
  return h
}
