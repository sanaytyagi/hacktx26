// Example Relay plugin: computes SLA due times for incidents by severity, counting business
// hours (Mon–Fri, 09:00–17:00 UTC) for lower severities. Pure computation; no side effects.
import type { RelayPlugin, RelayPluginTool } from '../../relay-plugin'

const TARGET_HOURS: Record<string, { hours: number; businessHours: boolean }> = {
  SEV1: { hours: 4, businessHours: false },
  SEV2: { hours: 8, businessHours: false },
  SEV3: { hours: 16, businessHours: true },
  SEV4: { hours: 40, businessHours: true }
}

function addBusinessHours(start: Date, hours: number): Date {
  const d = new Date(start)
  let remaining = hours * 60
  while (remaining > 0) {
    d.setUTCMinutes(d.getUTCMinutes() + 1)
    const day = d.getUTCDay()
    const h = d.getUTCHours()
    if (day !== 0 && day !== 6 && h >= 9 && h < 17) remaining--
  }
  return d
}

const slaDue: RelayPluginTool<{ severity: string; opened_at: string; now?: string }> = {
  name: 'sla_due',
  description: 'Compute the SLA due time and whether an incident has breached it, from severity and open time.',
  category: 'workflow',
  access: 'read',
  sideEffects: 'None (pure calculation).',
  inputSchema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['SEV1', 'SEV2', 'SEV3', 'SEV4'] },
      opened_at: { type: 'string', description: 'ISO timestamp' },
      now: { type: 'string', description: 'Optional ISO timestamp to evaluate against' }
    },
    required: ['severity', 'opened_at']
  },
  outputSchema: {
    type: 'object',
    properties: { due_at: { type: 'string' }, breached: { type: 'boolean' }, rule: { type: 'string' } },
    required: ['due_at', 'breached']
  },
  async execute(args, ctx) {
    const rule = TARGET_HOURS[args.severity]
    if (!rule) throw new Error(`Unknown severity ${args.severity}`)
    const opened = new Date(args.opened_at)
    if (Number.isNaN(opened.getTime())) throw new Error('opened_at is not a valid timestamp')
    const due = rule.businessHours ? addBusinessHours(opened, rule.hours) : new Date(opened.getTime() + rule.hours * 3600_000)
    const now = args.now ? new Date(args.now) : new Date()
    ctx.log(`${args.severity}: ${rule.hours}h ${rule.businessHours ? 'business' : 'calendar'} hours`)
    return { due_at: due.toISOString(), breached: now > due, rule: `${rule.hours} ${rule.businessHours ? 'business' : 'calendar'} hours` }
  }
}

const plugin: RelayPlugin = { id: 'sla-calculator', name: 'SLA calculator (example plugin)', version: '1.0.0', tools: [slaDue as RelayPluginTool] }
export default plugin
