import type { AppContext } from './context'
import { newId, now } from '../db/database'

export function notify(
  ctx: AppContext,
  userId: string,
  title: string,
  body = '',
  link?: string,
  kind: 'info' | 'warning' | 'error' | 'success' = 'info'
): void {
  ctx.db.insert('notifications', { id: newId('ntf'), user_id: userId, title, body, link: link ?? null, kind, read: 0, created_at: now() })
  ctx.events.emit({ type: 'notification', userId })
}
