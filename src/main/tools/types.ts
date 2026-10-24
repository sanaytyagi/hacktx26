import type { AppContext, Actor } from '../core/context'
import type { ToolDeclaration } from '@shared/domain'

export interface ToolCallContext {
  ctx: AppContext
  /** The person the agent acts for. Data and tool permissions are checked against them. */
  actor: Actor
  runId: string | null
  agentId: string | null
  teamId: string | null
  /** Collections the agent version is configured to use; null in the admin tool tester. */
  allowedCollections: string[] | null
  idempotencyKey: string
  /** Collections whose data flows into this call's arguments (for egress and export checks). */
  inputTaint: string[]
  signal: AbortSignal
  environment: 'test' | 'live'
  log: (message: string, data?: Record<string, unknown>) => void
}

export interface ToolResult {
  output: unknown
  /** Collections whose data is contained in the output (for egress checks downstream). */
  taint?: string[]
  note?: string
}

export type ToolImpl = (args: Record<string, unknown>, tc: ToolCallContext) => Promise<ToolResult>

export interface BuiltinTool {
  declaration: ToolDeclaration
  impl: ToolImpl
  /** What must be configured before this tool works (shown in the catalog). */
  needs?: (ctx: AppContext) => string | null
}
