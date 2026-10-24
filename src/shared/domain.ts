// Domain schemas shared by the main process (validation at the IPC boundary and before
// persistence) and the renderer (form validation). Keep these free of Node/DOM imports.
import { z } from 'zod'
import { PURPOSES, TOOL_ACCESS } from './permissions'

export const id = z.string().min(1).max(200)

// ---------- Data ----------

export const RowFilterSchema = z.object({
  column: z.string().min(1),
  op: z.enum(['eq', 'neq', 'in', 'not_in', 'contains', 'gte', 'lte', 'is_empty', 'not_empty']),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional()
})
export type RowFilter = z.infer<typeof RowFilterSchema>

export const CollectionSelectionSchema = z.object({
  /** Relative paths inside a folder source. Empty means all supported files. */
  files: z.array(z.string()).default([]),
  /** Table name for database sources. CSV/JSON sources have a single implicit table. */
  table: z.string().optional(),
  /** Allowed columns. Empty means every column. */
  columns: z.array(z.string()).default([]),
  filters: z.array(RowFilterSchema).default([])
})
export type CollectionSelection = z.infer<typeof CollectionSelectionSchema>

export const PurposeSchema = z.enum(PURPOSES)

export const SOURCE_KINDS = ['folder', 'file', 'csv', 'json', 'sqlite'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

// ---------- Tools ----------

export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  format?: string
  default?: unknown
  additionalProperties?: boolean | JsonSchema
}

export const JsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.object({
    type: z.enum(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']).optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), JsonSchemaSchema).optional(),
    required: z.array(z.string()).optional(),
    items: JsonSchemaSchema.optional(),
    enum: z.array(z.unknown()).optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    format: z.string().optional(),
    default: z.unknown().optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaSchema]).optional()
  })
)

export const TOOL_CATEGORIES = [
  'research',
  'documents',
  'structured_data',
  'databases',
  'communication',
  'business_systems',
  'files',
  'models',
  'workflow',
  'browser_automation'
] as const
export type ToolCategory = (typeof TOOL_CATEGORIES)[number]

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  research: 'Research',
  documents: 'Documents',
  structured_data: 'Structured data',
  databases: 'Databases',
  communication: 'Communication',
  business_systems: 'Business systems',
  files: 'Files',
  models: 'Models',
  workflow: 'Workflow',
  browser_automation: 'Browser automation'
}

export const ToolDeclarationSchema = z.object({
  key: z.string().regex(/^[a-z0-9_.:-]+$/i),
  name: z.string().min(1),
  description: z.string(),
  category: z.enum(TOOL_CATEGORIES),
  kind: z.enum(['builtin', 'http', 'openapi', 'mcp', 'plugin', 'model']),
  version: z.number().int().positive(),
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  auth: z.object({
    type: z.enum(['none', 'api_key', 'bearer', 'basic', 'oauth']),
    credentialId: z.string().optional(),
    headerName: z.string().optional(),
    queryParam: z.string().optional()
  }),
  access: z.enum(TOOL_ACCESS),
  sideEffects: z.string(),
  dataDestinations: z.array(z.string()),
  /** True when arguments leave this computer (web APIs, external model providers). */
  external: z.boolean(),
  cost: z.object({
    kind: z.enum(['free', 'per_call', 'per_token', 'unknown', 'local_compute']),
    pricingId: z.string().optional(),
    note: z.string().optional()
  }),
  timeoutMs: z.number().int().positive().max(600_000),
  retry: z.object({ max: z.number().int().min(0).max(5), safe: z.boolean() }),
  rateLimitPerMin: z.number().int().positive().optional(),
  requiresApproval: z.boolean(),
  capabilities: z.array(z.string()).default([])
})
export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>

// ---------- Workflows ----------

export const STEP_CAPABILITIES = [
  'web_search',
  'page_extract',
  'source_compare',
  'doc_search',
  'data_read',
  'db_query',
  'transform',
  'classify',
  'extract_fields',
  'generate',
  'write_table',
  'export',
  'notify',
  'send_message',
  'ticket_update',
  'human_judgment',
  'desktop_action',
  'unknown'
] as const
export type StepCapability = (typeof STEP_CAPABILITIES)[number]

export const CAPABILITY_LABELS: Record<StepCapability, string> = {
  web_search: 'Search the web',
  page_extract: 'Read a web page',
  source_compare: 'Compare sources',
  doc_search: 'Search company documents',
  data_read: 'Read a dataset',
  db_query: 'Query a database',
  transform: 'Filter or reshape data',
  classify: 'Classify / label',
  extract_fields: 'Extract fields from text',
  generate: 'Write or summarize text',
  write_table: 'Record results in a table',
  export: 'Export a file',
  notify: 'Notify someone in Relay',
  send_message: 'Send a message or email',
  ticket_update: 'Create or update a ticket',
  human_judgment: 'Human judgment',
  desktop_action: 'Click/type in a desktop app',
  unknown: 'Unclear step'
}

export const AUTOMATION_KINDS = ['agent', 'deterministic', 'human_review', 'manual'] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]
export const AUTOMATION_LABELS: Record<AutomationKind, string> = {
  agent: 'Agent',
  deterministic: 'Deterministic automation',
  human_review: 'Human review',
  manual: 'Manual'
}

const level3 = z.enum(['yes', 'partly', 'no'])

export const WorkflowStepSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  application: z.string().max(200).default(''),
  inputs: z.string().max(1000).default(''),
  outputs: z.string().max(1000).default(''),
  timestamp: z.string().max(20).default(''),
  repeated: z.boolean().default(false),
  decisionPoint: z.boolean().default(false),
  decisionRule: z.string().max(2000).default(''),
  capability: z.enum(STEP_CAPABILITIES).default('unknown'),
  inputsClear: level3.default('partly'),
  successClear: level3.default('partly'),
  impact: z.enum(['low', 'medium', 'high']).default('medium'),
  verification: z.enum(['easy', 'moderate', 'hard']).default('moderate'),
  collectionIds: z.array(z.string()).default([]),
  override: z.enum(AUTOMATION_KINDS).optional(),
  overrideReason: z.string().max(1000).optional(),
  /** Set by video analysis: the model could not determine what happened. */
  uncertain: z.boolean().default(false)
})
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const WorkflowDraftSchema = z.object({
  name: z.string().min(1).max(200),
  goal: z.string().max(4000).default(''),
  narration: z.string().max(20000).default(''),
  frequencyPerWeek: z.number().min(0).max(1000).default(1),
  minutesPerRun: z.number().min(0).max(10000).default(10),
  rules: z.string().max(10000).default(''),
  exceptions: z.string().max(10000).default(''),
  desiredOutput: z.string().max(4000).default(''),
  steps: z.array(WorkflowStepSchema).default([]),
  answers: z.record(z.string(), z.string()).default({})
})
export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>

// ---------- Agents ----------

export const ConditionSchema = z.object({
  left: z.string(),
  op: z.enum(['truthy', 'falsy', 'eq', 'neq', 'gt', 'lt', 'contains']),
  right: z.string().optional()
})
export type Condition = z.infer<typeof ConditionSchema>

export const OutputFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().default('')
})

export const ModelRefSchema = z.object({ providerId: z.string(), model: z.string() })
export type ModelRef = z.infer<typeof ModelRefSchema>

export const AgentStepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Step ids use letters, numbers and underscores'),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  kind: z.enum(AUTOMATION_KINDS),
  /** Deterministic steps call exactly this tool. */
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Agent steps: instructions for the model for this step. */
  prompt: z.string().max(20000).default(''),
  /** Agent steps: tools the model may call (bounded loop). */
  agentTools: z.array(z.string()).default([]),
  model: ModelRefSchema.optional(),
  outputFields: z.array(OutputFieldSchema).default([]),
  forEach: z.string().optional(),
  condition: ConditionSchema.optional(),
  /** Human checkpoint: pause for approval before this step executes. */
  approvalBefore: z.boolean().default(false),
  onError: z.enum(['fail', 'skip', 'review']).default('fail'),
  maxRetries: z.number().int().min(0).max(3).default(1)
})
export type AgentStep = z.infer<typeof AgentStepSchema>

export const InputFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['string', 'text', 'number', 'url', 'boolean']),
  required: z.boolean().default(true),
  description: z.string().default(''),
  default: z.union([z.string(), z.number(), z.boolean()]).optional()
})
export type InputField = z.infer<typeof InputFieldSchema>

export const AgentLimitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(500).default(40),
  maxTokens: z.number().int().min(100).max(2_000_000).default(60_000),
  maxRuntimeSec: z.number().int().min(5).max(7200).default(600),
  maxRetries: z.number().int().min(0).max(20).default(4),
  maxCostUsd: z.number().min(0).max(1000).default(1)
})
export type AgentLimits = z.infer<typeof AgentLimitsSchema>

export const AgentSpecSchema = z.object({
  schemaVersion: z.literal(1),
  instructions: z.string().max(20000).default(''),
  inputs: z.array(InputFieldSchema).default([]),
  outputs: z.array(z.object({ key: z.string(), label: z.string(), from: z.string() })).default([]),
  steps: z.array(AgentStepSchema).max(60),
  /** Pinned tool versions this agent may use. */
  tools: z.array(z.object({ key: z.string(), version: z.number().int() })).default([]),
  /** Collections the agent reads, with purpose (always retrieval for runs). */
  collections: z.array(z.string()).default([]),
  defaultModel: ModelRefSchema.optional(),
  limits: AgentLimitsSchema.default(AgentLimitsSchema.parse({}))
})
export type AgentSpec = z.infer<typeof AgentSpecSchema>

export const AGENT_STATUSES = ['draft', 'tested', 'awaiting_approval', 'live', 'paused', 'archived'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const RUN_STATUSES = [
  'queued',
  'running',
  'needs_review',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
  'interrupted'
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const ScheduleSchema = z.object({
  kind: z.enum(['interval', 'daily', 'weekly']),
  everyMinutes: z.number().int().min(5).max(10080).optional(),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  catchUp: z.enum(['run_once', 'skip']).default('run_once'),
  inputs: z.record(z.string(), z.unknown()).default({})
})
export type Schedule = z.infer<typeof ScheduleSchema>

// ---------- Budgets ----------

export const BUDGET_KINDS = ['operating', 'training'] as const
export type BudgetKind = (typeof BUDGET_KINDS)[number]

// ---------- Training ----------

export const DatasetConfigSchema = z.object({
  textFields: z.array(z.string()).min(1),
  labelField: z.string().min(1),
  excludedFields: z.array(z.string()).default([]),
  labelMap: z.record(z.string(), z.string()).default({}),
  dropLabels: z.array(z.string()).default([]),
  split: z.object({
    strategy: z.enum(['random', 'group', 'time']),
    groupField: z.string().optional(),
    timeField: z.string().optional(),
    train: z.number().min(0.5).max(0.9).default(0.7),
    validation: z.number().min(0.05).max(0.25).default(0.15),
    seed: z.number().int().default(13)
  }),
  minExamplesPerLabel: z.number().int().min(1).default(5)
})
export type DatasetConfig = z.infer<typeof DatasetConfigSchema>

export const TrainingConfigSchema = z.object({
  baseModel: z.string(),
  epochs: z.number().int().min(1).max(20).default(3),
  learningRate: z.number().min(1e-6).max(1e-2).default(5e-4),
  batchSize: z.number().int().min(1).max(128).default(16),
  maxLength: z.number().int().min(16).max(512).default(128),
  loraRank: z.number().int().min(1).max(64).default(8),
  device: z.enum(['auto', 'cpu', 'mps', 'cuda']).default('auto'),
  maxTrainExamples: z.number().int().min(10).max(100000).optional(),
  smokeTest: z.boolean().default(false)
})
export type TrainingConfig = z.infer<typeof TrainingConfigSchema>
