// Local schedules run only while Relay is open and the computer is awake.
// Catch-up policy: every scheduled time that passes while Relay is closed or the computer is
// asleep is recorded as “missed”. With “run_once” (default) a single catch-up run starts at the
// next opportunity, no matter how many times were missed; with “skip” Relay waits for the next
// scheduled time.
import type { AppContext } from '../core/context'
import { newId, now, j } from '../db/database'
import { ScheduleSchema, type Schedule } from '@shared/domain'
import { actorFor } from '../core/authz'
import type { RunEngine } from '../engine/runner'

const LATE_TOLERANCE_MS = 2 * 60 * 1000

export function nextRunAt(s: Schedule, from: Date): string {
  if (s.kind === 'interval') return new Date(from.getTime() + (s.everyMinutes ?? 60) * 60_000).toISOString()
  const [hh, mm] = (s.timeOfDay ?? '09:00').split(':').map(Number)
  const d = new Date(from)
  d.setHours(hh, mm, 0, 0)
  if (s.kind === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1)
    return d.toISOString()
  }
  const target = s.weekday ?? 1
  let add = (target - d.getDay() + 7) % 7
  if (add === 0 && d <= from) add = 7
  d.setDate(d.getDate() + add)
  return d.toISOString()
}

function occurrencesBetween(s: Schedule, firstDue: Date, until: Date): Date[] {
  const out: Date[] = []
  let cur = firstDue
  while (cur <= until && out.length < 100) {
    out.push(cur)
    cur = new Date(nextRunAt(s, cur))
  }
  return out
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private lastTick = Date.now()

  constructor(
    private ctx: AppContext,
    private engine: RunEngine,
    private tickMs = 30_000
  ) {}

  start() {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.tickMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  tick(at = new Date()) {
    const gap = at.getTime() - this.lastTick
    this.lastTick = at.getTime()
    const due = this.ctx.db.all<{ id: string; agent_id: string; config: string; next_run_at: string }>(
      'SELECT id, agent_id, config, next_run_at FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
      at.toISOString()
    )
    for (const s of due) {
      const cfg = ScheduleSchema.parse(j(s.config, {}))
      const occ = occurrencesBetween(cfg, new Date(s.next_run_at), at)
      const late = at.getTime() - new Date(s.next_run_at).getTime() > Math.max(LATE_TOLERANCE_MS, this.tickMs * 2)
      const missed = late || occ.length > 1 || gap > this.tickMs * 4
      const agent = this.ctx.db.get<{ status: string; owner_id: string; kill_switch: number }>('SELECT status, owner_id, kill_switch FROM agents WHERE id = ?', s.agent_id)
      const record = (dueAt: string, outcome: string, runId: string | null = null) =>
        this.ctx.db.insert('schedule_events', { schedule_id: s.id, due_at: dueAt, outcome, run_id: runId, recorded_at: now() })
      if (missed) for (const o of occ) record(o.toISOString(), 'missed')
      const shouldRun = !missed || cfg.catchUp === 'run_once'
      if (shouldRun) {
        if (!agent || agent.status !== 'live' || agent.kill_switch) record(at.toISOString(), `not_run: agent ${!agent ? 'missing' : agent.kill_switch ? 'kill switch on' : agent.status}`)
        else {
          try {
            const runId = this.engine.start(actorFor(this.ctx, agent.owner_id), { agentId: s.agent_id, environment: 'live', inputs: cfg.inputs, trigger: 'schedule', scheduleId: s.id })
            record(at.toISOString(), missed ? 'catch_up_run' : 'ran', runId)
          } catch (e) {
            record(at.toISOString(), `not_run: ${(e as Error).message}`.slice(0, 300))
          }
        }
      }
      this.ctx.db.update('schedules', 'id', s.id, { next_run_at: nextRunAt(cfg, at), last_run_at: at.toISOString() })
    }
  }
}

export function scheduleId() {
  return newId('sch')
}
