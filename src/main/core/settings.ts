import { z } from 'zod'
import type { AppContext } from './context'
import { js, now } from '../db/database'
import { TOOL_ACCESS } from '@shared/permissions'

export const PolicySchema = z.object({
  personalDeploy: z.object({
    allowed: z.boolean(),
    /** Tool access levels an employee may use in a personal live agent without approval. */
    allowedToolAccess: z.array(z.enum(TOOL_ACCESS)),
    requireSuccessfulTest: z.boolean()
  }),
  sharedDeployRequiresApproval: z.boolean(),
  /** Tools that send/delete always pause for a human checkpoint before executing. */
  checkpointForSendAndDelete: z.boolean(),
  /** Models agents may call. "*" allows any configured model of that provider kind. */
  allowedModels: z.array(z.object({ providerKind: z.string(), model: z.string() })),
  /** Hostnames that tools and providers may send workspace data to. */
  allowedExternalDestinations: z.array(z.string()),
  /** Unknown pricing blocks paid calls unless explicitly allowed. */
  allowUnknownPricing: z.boolean(),
  runCaps: z.object({
    maxToolCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxRuntimeSec: z.number().int().positive(),
    maxRetries: z.number().int().min(0),
    maxCostUsd: z.number().positive()
  }),
  /** Managers can approve budget increases and training jobs up to this amount. */
  managerApprovalCeilingUsd: z.number().min(0),
  defaultAgentMonthlyBudgetUsd: z.number().min(0),
  /** Local compute rate in USD per hour; 0 means local compute is shown as time only. */
  localComputeRateUsdPerHour: z.number().min(0),
  retention: z.object({
    runHistoryDays: z.number().int().min(1),
    recordingsDays: z.number().int().min(1),
    exportsDays: z.number().int().min(1)
  })
})
export type Policy = z.infer<typeof PolicySchema>

export const DEFAULT_POLICY: Policy = {
  personalDeploy: { allowed: true, allowedToolAccess: ['read', 'write'], requireSuccessfulTest: true },
  sharedDeployRequiresApproval: true,
  checkpointForSendAndDelete: true,
  allowedModels: [
    { providerKind: 'anthropic', model: '*' },
    { providerKind: 'gemini', model: '*' },
    { providerKind: 'openai_compatible', model: '*' },
    { providerKind: 'local', model: '*' }
  ],
  allowedExternalDestinations: [
    'serpapi.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'api.openai.com',
    '*.public-web'
  ],
  allowUnknownPricing: false,
  runCaps: { maxToolCalls: 100, maxTokens: 200_000, maxRuntimeSec: 1800, maxRetries: 10, maxCostUsd: 5 },
  managerApprovalCeilingUsd: 250,
  defaultAgentMonthlyBudgetUsd: 20,
  localComputeRateUsdPerHour: 0,
  retention: { runHistoryDays: 90, recordingsDays: 30, exportsDays: 30 }
}

export function getSetting<T>(ctx: AppContext, key: string, fallback: T): T {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(ctx: AppContext, key: string, value: unknown): void {
  ctx.db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    js(value)
  )
}

export function getPolicy(ctx: AppContext): Policy {
  const parsed = PolicySchema.safeParse(getSetting(ctx, 'policy', DEFAULT_POLICY))
  return parsed.success ? parsed.data : DEFAULT_POLICY
}

export function touchSetting(ctx: AppContext, key: string): void {
  setSetting(ctx, key, now())
}
