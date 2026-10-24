import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now } from '../db/database'
import { requireCap } from '../core/authz'
import { audit } from '../core/audit'
import { notFound, RelayError } from '../core/errors'
import { registerSecret } from '../core/redact'

export const CredentialInputSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(['api_key', 'bearer', 'basic', 'oauth_token', 'webhook_secret']),
  service: z.string().min(1).max(100),
  secret: z.string().min(1).max(10_000)
})

/** Metadata only. Secret values never leave the main process. */
export function listCredentials(ctx: AppContext, actor: Actor) {
  requireCap(ctx, actor, 'credentials.manage', 'view credentials')
  return ctx.db.all<{ id: string; name: string; kind: string; service: string; storage: string; hint: string; created_at: string; last_used_at: string | null }>(
    'SELECT id, name, kind, service, storage, hint, created_at, last_used_at FROM credentials ORDER BY created_at'
  )
}

export function storeCredential(ctx: AppContext, actor: Actor | null, input: z.infer<typeof CredentialInputSchema>, id?: string): string {
  if (actor) requireCap(ctx, actor, 'credentials.manage', 'store credentials')
  const credId = id ?? newId('cred')
  const blob = ctx.secrets.encrypt(input.secret)
  const hint = input.secret.length > 8 ? `…${input.secret.slice(-4)}` : '••••'
  ctx.db.run(
    `INSERT INTO credentials (id, name, kind, service, secret, storage, hint, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, service=excluded.service, secret=excluded.secret, storage=excluded.storage, hint=excluded.hint`,
    credId,
    input.name,
    input.kind,
    input.service,
    blob,
    ctx.secrets.kind,
    hint,
    actor?.id ?? 'system',
    now()
  )
  registerSecret(input.secret)
  audit(ctx, actor, 'credential.stored', { type: 'credential', id: credId }, { name: input.name, service: input.service, storage: ctx.secrets.kind })
  return credId
}

export function deleteCredential(ctx: AppContext, actor: Actor, id: string) {
  requireCap(ctx, actor, 'credentials.manage', 'delete credentials')
  const n = ctx.db.run('DELETE FROM credentials WHERE id = ?', id).changes
  if (!n) throw notFound('Credential')
  audit(ctx, actor, 'credential.deleted', { type: 'credential', id }, {})
}

/** Internal use only (tool and provider adapters in the main process). */
export function resolveSecret(ctx: AppContext, credentialId: string | null | undefined): string {
  if (!credentialId) throw new RelayError('unavailable', 'No credential is configured for this connection.')
  const row = ctx.db.get<{ secret: Uint8Array }>('SELECT secret FROM credentials WHERE id = ?', credentialId)
  if (!row) throw new RelayError('unavailable', 'The configured credential was deleted. An administrator needs to add it again.')
  const value = ctx.secrets.decrypt(Buffer.from(row.secret))
  registerSecret(value)
  ctx.db.run('UPDATE credentials SET last_used_at = ? WHERE id = ?', now(), credentialId)
  return value
}

export function hasCredential(ctx: AppContext, credentialId: string | null | undefined): boolean {
  return !!credentialId && !!ctx.db.get('SELECT 1 FROM credentials WHERE id = ?', credentialId)
}
