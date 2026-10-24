import type { JsonSchema } from '@shared/domain'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ContentPart[]
  /** Provider-native assistant content to replay unchanged (e.g. Anthropic thinking blocks). */
  raw?: unknown
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface GenerateRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens: number
  json?: boolean
  signal?: AbortSignal
}

export interface GenerateResult {
  text: string
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
  usage: { inputTokens: number; outputTokens: number }
  stopReason: string
  raw?: unknown
}

export interface ProviderConfig {
  id: string
  kind: 'anthropic' | 'gemini' | 'openai_compatible' | 'local'
  name: string
  baseUrl: string | null
  apiKey: string | null
  external: boolean
}

export interface ProviderAdapter {
  supportsTools: boolean
  generate(cfg: ProviderConfig, req: GenerateRequest): Promise<GenerateResult>
}

/** Tool names sent to providers must be simple identifiers. */
export function wireToolName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}
