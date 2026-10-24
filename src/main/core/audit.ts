import type { AppContext, Actor } from './context'
import { js, now } from '../db/database'
import { redact } from './redact'

/**
 * Local application audit log. This is an append-only table in the local SQLite database,
 * useful for review and troubleshooting. It is not tamper-proof compliance infrastructure.
 */
export function audit(
  ctx: AppContext,
  actor: Actor | null,
  action: string,
  target: { type?: string; id?: string } = {},
  details: Record<string, unknown> = {},
  outcome: 'ok' | 'denied' | 'error' = 'ok'
): void {
  ctx.db.insert('audit_events', {
    ts: now(),
    actor_id: actor?.id ?? 'system',
    actor_role: actor?.role ?? 'system',
    action,
    target_type: target.type ?? null,
    target_id: target.id ?? null,
    team_id: actor?.teamId ?? null,
    outcome,
    details: js(redact(details))
  })
}
