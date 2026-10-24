// Relay local plugin interface (TypeScript). A plugin is a directory with:
//   package.json  ("type": "module")
//   dist/index.js (built output; default export is a RelayPlugin)
// Plugins are trusted code installed by an administrator. Relay runs each call in a worker
// thread with a timeout and memory limit, passes only the validated arguments, and never
// passes credentials. Declared access is a request: the administrator sets the final access
// level and approval requirement when registering the tool.

export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
}

export interface RelayPluginContext {
  /** Append a short line to the tool call log (truncated to 500 characters). */
  log(message: string): void
}

export interface RelayPluginTool<I = Record<string, unknown>, O = unknown> {
  /** snake_case identifier, unique within the plugin. */
  name: string
  description: string
  category: 'research' | 'documents' | 'structured_data' | 'databases' | 'communication' | 'business_systems' | 'files' | 'models' | 'workflow'
  /** Requested access level; the administrator confirms or lowers it. */
  access: 'read' | 'write' | 'send' | 'delete'
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  sideEffects: string
  execute(args: I, ctx: RelayPluginContext): Promise<O>
}

export interface RelayPlugin {
  id: string
  name: string
  version: string
  tools: RelayPluginTool[]
}
