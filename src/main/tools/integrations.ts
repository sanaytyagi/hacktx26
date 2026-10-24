import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, invalid, notFound } from '../core/errors'
import { safeFetch, checkUrl } from '../core/netguard'
import { redactString } from '../core/redact'
import { resolveSecret } from '../services/credentials'
import { ToolDeclarationSchema, type JsonSchema, type ToolDeclaration, TOOL_CATEGORIES } from '@shared/domain'
import { TOOL_ACCESS } from '@shared/permissions'
import { stableHash } from './jsonschema'
import type { ToolCallContext } from './types'

export interface IntegrationRow {
  id: string
  kind: 'http' | 'openapi' | 'mcp' | 'plugin'
  name: string
  config: string
  credential_id: string | null
  status: string
  status_detail: string
  last_checked_at: string | null
  discovered: string
  created_at: string
}

export const AuthConfigSchema = z.object({
  type: z.enum(['none', 'api_key', 'bearer', 'basic']),
  headerName: z.string().max(100).optional(),
  queryParam: z.string().max(100).optional()
})
export type AuthConfig = z.infer<typeof AuthConfigSchema>

export function getIntegration(ctx: AppContext, id: string): IntegrationRow {
  const r = ctx.db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id)
  if (!r) throw notFound('Integration')
  return r
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'integration'
}

// ---------------- Tool registration (shared by all integration kinds) ----------------

/** Register or update a tool. A changed declaration creates a new version; agents stay pinned. */
export function registerTool(ctx: AppContext, decl: ToolDeclaration, impl: Record<string, unknown>, integrationId: string | null): { key: string; version: number } {
  const parsed = ToolDeclarationSchema.parse(decl)
  const existing = ctx.db.get<{ version: number; declaration: string; impl: string }>('SELECT version, declaration, impl FROM tools WHERE key = ?', parsed.key)
  if (existing) {
    const prev = j<ToolDeclaration>(existing.declaration, parsed)
    const same = stableHash({ ...prev, version: 0 }) === stableHash({ ...parsed, version: 0 }) && stableHash(j(existing.impl, {})) === stableHash(impl)
    if (same) return { key: parsed.key, version: existing.version }
    const version = existing.version + 1
    const d = { ...parsed, version }
    ctx.db.update('tools', 'key', parsed.key, { version, declaration: js(d), impl: js(impl), category: d.category, kind: d.kind, integration_id: integrationId, updated_at: now() })
    ctx.db.insert('tool_versions', { key: parsed.key, version, declaration: js(d), impl: js(impl), created_at: now() })
    return { key: parsed.key, version }
  }
  const d = { ...parsed, version: 1 }
  ctx.db.insert('tools', { key: d.key, version: 1, kind: d.kind, category: d.category, integration_id: integrationId, declaration: js(d), impl: js(impl), enabled: 1, created_at: now(), updated_at: now() })
  ctx.db.insert('tool_versions', { key: d.key, version: 1, declaration: js(d), impl: js(impl), created_at: now() })
  return { key: d.key, version: 1 }
}

/** Administrator decisions that override anything an imported spec claims. */
export const ToolPolicySchema = z.object({
  access: z.enum(TOOL_ACCESS),
  requiresApproval: z.boolean(),
  category: z.enum(TOOL_CATEGORIES),
  retrySafe: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000)
})

// ---------------- Custom HTTP tools ----------------

export const HttpToolInputSchema = z.object({
  integrationId: z.string().optional(),
  integrationName: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  auth: AuthConfigSchema,
  secret: z.string().max(10_000).optional(),
  allowPrivateNetwork: z.boolean().default(false),
  tool: z.object({
    name: z.string().min(1).max(100),
    operationKey: z.string().regex(/^[a-z0-9_]+$/),
    description: z.string().max(2000),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().max(500),
    queryParams: z.array(z.string()).default([]),
    bodyParams: z.array(z.string()).default([]),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    policy: ToolPolicySchema
  })
})

function defaultAccess(method: string): (typeof TOOL_ACCESS)[number] {
  return method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'write'
}

export function upsertHttpIntegration(
  ctx: AppContext,
  actor: Actor,
  input: { id?: string; kind: 'http' | 'openapi'; name: string; baseUrl: string; auth: AuthConfig; secret?: string; allowPrivateNetwork: boolean; extra?: Record<string, unknown> }
): string {
  requireCap(ctx, actor, 'tools.administer', 'configure integrations')
  checkUrl(input.baseUrl, { allowPrivateNetwork: input.allowPrivateNetwork })
  const id = input.id ?? newId('int')
  const existing = ctx.db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id)
  let credentialId = existing?.credential_id ?? null
  if (input.secret) {
    credentialId = credentialId ?? newId('cred')
    ctx.db.run(
      `INSERT INTO credentials (id, name, kind, service, secret, storage, hint, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, storage=excluded.storage, hint=excluded.hint`,
      credentialId,
      `${input.name} credential`,
      input.auth.type === 'bearer' ? 'bearer' : input.auth.type === 'basic' ? 'basic' : 'api_key',
      new URL(input.baseUrl).hostname,
      ctx.secrets.encrypt(input.secret),
      ctx.secrets.kind,
      input.secret.length > 8 ? `…${input.secret.slice(-4)}` : '••••',
      actor.id,
      now()
    )
  }
  const config = { ...(existing ? j<Record<string, unknown>>(existing.config, {}) : {}), ...input.extra, baseUrl: input.baseUrl, auth: input.auth, allowPrivateNetwork: input.allowPrivateNetwork }
  if (existing) ctx.db.update('integrations', 'id', id, { name: input.name, config: js(config), credential_id: credentialId })
  else ctx.db.insert('integrations', { id, kind: input.kind, name: input.name, config: js(config), credential_id: credentialId, status: 'not_checked', created_by: actor.id, created_at: now() })
  audit(ctx, actor, existing ? 'integration.updated' : 'integration.added', { type: 'integration', id }, { kind: input.kind, name: input.name, baseUrl: input.baseUrl, allowPrivateNetwork: input.allowPrivateNetwork })
  return id
}

export function addHttpTool(ctx: AppContext, actor: Actor, input: z.infer<typeof HttpToolInputSchema>) {
  const integrationId = upsertHttpIntegration(ctx, actor, {
    id: input.integrationId,
    kind: 'http',
    name: input.integrationName,
    baseUrl: input.baseUrl,
    auth: input.auth,
    secret: input.secret,
    allowPrivateNetwork: input.allowPrivateNetwork
  })
  const t = input.tool
  const host = new URL(input.baseUrl).hostname
  const decl: ToolDeclaration = {
    key: `http.${slug(input.integrationName)}.${t.operationKey}`,
    name: t.name,
    description: t.description,
    category: t.policy.category,
    kind: 'http',
    version: 1,
    inputSchema: t.inputSchema as JsonSchema,
    outputSchema: t.outputSchema as JsonSchema,
    auth: { type: input.auth.type, headerName: input.auth.headerName, queryParam: input.auth.queryParam },
    access: t.policy.access,
    sideEffects: t.method === 'GET' ? 'Reads from the external service.' : `${t.method} request may change data in ${input.integrationName}.`,
    dataDestinations: [host],
    external: !input.allowPrivateNetwork,
    cost: { kind: 'unknown', note: 'Billing depends on the external service.' },
    timeoutMs: t.policy.timeoutMs,
    retry: { max: t.policy.retrySafe ? 2 : 0, safe: t.policy.retrySafe },
    requiresApproval: t.policy.requiresApproval,
    capabilities: []
  }
  const r = registerTool(ctx, decl, { integrationId, method: t.method, path: t.path, queryParams: t.queryParams, bodyParams: t.bodyParams }, integrationId)
  audit(ctx, actor, 'tool.registered', { type: 'tool', id: r.key }, { version: r.version, access: decl.access, requiresApproval: decl.requiresApproval })
  ctx.events.emit({ type: 'tools.changed' })
  return r
}

function authParts(ctx: AppContext, integ: IntegrationRow): { headers: Record<string, string>; query: Record<string, string> } {
  const cfg = j<{ auth?: AuthConfig }>(integ.config, {})
  const auth = cfg.auth ?? { type: 'none' }
  if (auth.type === 'none') return { headers: {}, query: {} }
  const secret = resolveSecret(ctx, integ.credential_id)
  if (auth.type === 'bearer') return { headers: { authorization: `Bearer ${secret}` }, query: {} }
  if (auth.type === 'basic') return { headers: { authorization: `Basic ${Buffer.from(secret).toString('base64')}` }, query: {} }
  if (auth.queryParam) return { headers: {}, query: { [auth.queryParam]: secret } }
  return { headers: { [auth.headerName || 'x-api-key']: secret }, query: {} }
}

/** Executes an HTTP/OpenAPI tool. Requests stay on the configured host (redirects included). */
export async function executeHttpTool(ctx: AppContext, decl: ToolDeclaration, impl: Record<string, unknown>, args: Record<string, unknown>, tc: ToolCallContext) {
  const integ = getIntegration(ctx, String(impl.integrationId))
  const cfg = j<{ baseUrl: string; allowPrivateNetwork?: boolean }>(integ.config, { baseUrl: '' })
  const used = new Set<string>()
  const path = String(impl.path).replace(/\{([^}]+)\}/g, (_m, name: string) => {
    used.add(name)
    if (args[name] === undefined) throw new RelayError('invalid', `Missing path parameter “${name}”.`)
    return encodeURIComponent(String(args[name]))
  })
  const url = new URL(cfg.baseUrl.replace(/\/$/, '') + path)
  const { headers, query } = authParts(ctx, integ)
  for (const q of (impl.queryParams as string[]) ?? []) {
    used.add(q)
    if (args[q] !== undefined && args[q] !== null) url.searchParams.set(q, String(args[q]))
  }
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const method = String(impl.method)
  let body: string | undefined
  if (method !== 'GET' && method !== 'DELETE') {
    const bodyParams = (impl.bodyParams as string[]) ?? []
    const payload =
      impl.bodyField !== undefined
        ? args[String(impl.bodyField)]
        : Object.fromEntries(Object.entries(args).filter(([k]) => (bodyParams.length ? bodyParams.includes(k) : !used.has(k))))
    body = JSON.stringify(payload ?? {})
    headers['content-type'] = 'application/json'
  }
  if (method !== 'GET') headers['idempotency-key'] = tc.idempotencyKey
  const res = await safeFetch(url.toString(), {
    method,
    headers: { accept: 'application/json', ...headers },
    body,
    timeoutMs: decl.timeoutMs,
    allowedHosts: [url.hostname],
    allowPrivateNetwork: !!cfg.allowPrivateNetwork,
    signal: tc.signal
  })
  const text = res.body.toString('utf8')
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* plain text response */
  }
  if (res.status >= 400)
    throw new RelayError('failed', `${integ.name} returned HTTP ${res.status}: ${redactString(text.slice(0, 300))}`, { httpStatus: res.status, retryable: res.status === 429 || res.status >= 500 })
  return parsed
}

// ---------------- OpenAPI import ----------------

export interface OpenApiOperation {
  operationKey: string
  method: string
  path: string
  summary: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  queryParams: string[]
  bodyField: string | null
  suggestedAccess: (typeof TOOL_ACCESS)[number]
}

function resolveRef(spec: Record<string, unknown>, schema: unknown, depth = 0): JsonSchema {
  if (!schema || typeof schema !== 'object' || depth > 6) return {}
  const s = schema as Record<string, unknown>
  if (typeof s.$ref === 'string') {
    const parts = s.$ref.replace(/^#\//, '').split('/')
    let cur: unknown = spec
    for (const p of parts) cur = (cur as Record<string, unknown>)?.[p]
    return resolveRef(spec, cur, depth + 1)
  }
  const out: JsonSchema = {}
  if (typeof s.type === 'string') out.type = s.type as JsonSchema['type']
  if (typeof s.description === 'string') out.description = s.description
  if (Array.isArray(s.enum)) out.enum = s.enum
  if (Array.isArray(s.required)) out.required = s.required as string[]
  if (s.properties && typeof s.properties === 'object')
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, resolveRef(spec, v, depth + 1)]))
  if (s.items) out.items = resolveRef(spec, s.items, depth + 1)
  if (!out.type && out.properties) out.type = 'object'
  return out
}

export function parseOpenApi(text: string): { title: string; version: string; servers: string[]; operations: OpenApiOperation[] } {
  let spec: Record<string, unknown>
  try {
    spec = (text.trim().startsWith('{') ? JSON.parse(text) : YAML.parse(text)) as Record<string, unknown>
  } catch (e) {
    throw invalid(`Could not parse the specification: ${(e as Error).message}`)
  }
  if (!spec || typeof spec !== 'object' || !String(spec.openapi ?? '').startsWith('3')) throw invalid('Only OpenAPI 3.x specifications are supported.')
  const info = (spec.info ?? {}) as { title?: string; version?: string }
  const servers = ((spec.servers as { url: string }[]) ?? []).map((s) => s.url)
  const operations: OpenApiOperation[] = []
  for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method] as Record<string, unknown> | undefined
      if (!op) continue
      const params = [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])].map((p) => resolveParam(spec, p))
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      const queryParams: string[] = []
      for (const p of params) {
        if (!p.name || (p.in !== 'path' && p.in !== 'query')) continue
        properties[p.name] = { ...p.schema, description: p.description ?? p.schema.description }
        if (p.required || p.in === 'path') required.push(p.name)
        if (p.in === 'query') queryParams.push(p.name)
      }
      let bodyField: string | null = null
      const rb = resolveRef(spec, (op.requestBody as Record<string, unknown>) ?? null) as unknown as { content?: Record<string, { schema?: unknown }> }
      const rawRb = op.requestBody as { content?: Record<string, { schema?: unknown }>; required?: boolean; $ref?: string } | undefined
      const content = rawRb?.content ?? rb?.content
      const bodySchema = content?.['application/json']?.schema ? resolveRef(spec, content['application/json'].schema) : null
      if (bodySchema) {
        if (bodySchema.type === 'object' && bodySchema.properties) {
          for (const [k, v] of Object.entries(bodySchema.properties)) properties[k] = v
          required.push(...(bodySchema.required ?? []))
        } else {
          bodyField = 'body'
          properties.body = bodySchema
          if (rawRb?.required) required.push('body')
        }
      }
      const responses = (op.responses ?? {}) as Record<string, { content?: Record<string, { schema?: unknown }> }>
      const ok = responses['200'] ?? responses['201'] ?? responses.default
      const outputSchema = ok?.content?.['application/json']?.schema ? resolveRef(spec, ok.content['application/json'].schema) : {}
      const operationKey = slug(String(op.operationId ?? `${method}_${path}`))
      operations.push({
        operationKey,
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).slice(0, 500),
        inputSchema: { type: 'object', properties, required: [...new Set(required)] },
        outputSchema,
        queryParams,
        bodyField,
        suggestedAccess: defaultAccess(method.toUpperCase())
      })
    }
  }
  return { title: info.title ?? 'Imported API', version: info.version ?? '', servers, operations }
}

function resolveParam(spec: Record<string, unknown>, p: unknown): { name?: string; in?: string; required?: boolean; description?: string; schema: JsonSchema } {
  let cur = p as Record<string, unknown>
  if (cur && typeof cur.$ref === 'string') {
    let x: unknown = spec
    for (const part of cur.$ref.replace(/^#\//, '').split('/')) x = (x as Record<string, unknown>)?.[part]
    cur = (x ?? {}) as Record<string, unknown>
  }
  return { name: cur?.name as string, in: cur?.in as string, required: !!cur?.required, description: cur?.description as string | undefined, schema: resolveRef(spec, cur?.schema) }
}

export const OpenApiImportSchema = z.object({
  integrationId: z.string().optional(),
  name: z.string().min(1).max(100),
  specText: z.string().min(10).max(5_000_000),
  baseUrl: z.string().url(),
  auth: AuthConfigSchema,
  secret: z.string().max(10_000).optional(),
  allowPrivateNetwork: z.boolean().default(false),
  operations: z.array(z.object({ operationKey: z.string(), name: z.string().min(1).max(100), policy: ToolPolicySchema })).default([])
})

/** Import a spec and register only the operations an administrator selected, with admin-set access. */
export function importOpenApi(ctx: AppContext, actor: Actor, input: z.infer<typeof OpenApiImportSchema>) {
  requireCap(ctx, actor, 'tools.administer', 'import API specifications')
  const parsed = parseOpenApi(input.specText)
  const integrationId = upsertHttpIntegration(ctx, actor, {
    id: input.integrationId,
    kind: 'openapi',
    name: input.name,
    baseUrl: input.baseUrl,
    auth: input.auth,
    secret: input.secret,
    allowPrivateNetwork: input.allowPrivateNetwork,
    extra: { specTitle: parsed.title, specVersion: parsed.version, specHash: stableHash(parsed.operations) }
  })
  ctx.db.update('integrations', 'id', integrationId, { discovered: js(parsed.operations) })
  const host = new URL(input.baseUrl).hostname
  const registered: { key: string; version: number }[] = []
  for (const sel of input.operations) {
    const op = parsed.operations.find((o) => o.operationKey === sel.operationKey)
    if (!op) throw invalid(`Operation ${sel.operationKey} is not in the specification.`)
    const decl: ToolDeclaration = {
      key: `api.${slug(input.name)}.${op.operationKey}`,
      name: sel.name,
      description: op.summary,
      category: sel.policy.category,
      kind: 'openapi',
      version: 1,
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
      auth: { type: input.auth.type, headerName: input.auth.headerName, queryParam: input.auth.queryParam },
      access: sel.policy.access,
      sideEffects: op.method === 'GET' ? `Reads from ${input.name}.` : `${op.method} ${op.path} may change data in ${input.name}.`,
      dataDestinations: [host],
      external: !input.allowPrivateNetwork,
      cost: { kind: 'unknown' },
      timeoutMs: sel.policy.timeoutMs,
      retry: { max: sel.policy.retrySafe ? 2 : 0, safe: sel.policy.retrySafe },
      requiresApproval: sel.policy.requiresApproval,
      capabilities: op.method === 'GET' ? [] : ['ticket_update']
    }
    const r = registerTool(ctx, decl, { integrationId, method: op.method, path: op.path, queryParams: op.queryParams, bodyField: op.bodyField ?? undefined, schemaHash: stableHash(op) }, integrationId)
    registered.push(r)
    audit(ctx, actor, 'tool.registered', { type: 'tool', id: r.key }, { version: r.version, access: decl.access, requiresApproval: decl.requiresApproval, source: 'openapi' })
  }
  ctx.events.emit({ type: 'tools.changed' })
  return { integrationId, operations: parsed.operations, registered }
}

// ---------------- MCP ----------------

export const McpConfigSchema = z.object({
  transport: z.enum(['stdio', 'http']),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(1000)).max(30).default([]),
  url: z.string().url().optional(),
  cwd: z.string().optional(),
  useBundledNode: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false)
})
export type McpConfig = z.infer<typeof McpConfigSchema>

const mcpClients = new Map<string, Client>()

async function mcpClient(ctx: AppContext, integ: IntegrationRow): Promise<Client> {
  const cached = mcpClients.get(integ.id)
  if (cached) return cached
  const cfg = McpConfigSchema.parse(j(integ.config, {}))
  const client = new Client({ name: 'relay', version: '0.1.0' })
  if (cfg.transport === 'stdio') {
    if (!cfg.command && !cfg.useBundledNode) throw invalid('Command is required for a local MCP server.')
    const command = cfg.useBundledNode ? process.execPath : cfg.command!
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    if (cfg.useBundledNode) {
      env.ELECTRON_RUN_AS_NODE = '1'
      env.RELAY_MODULE_ROOT = ctx.appRoot
    }
    if (integ.credential_id) env.RELAY_MCP_TOKEN = resolveSecret(ctx, integ.credential_id)
    const args = cfg.args.map((a) => a.replace('${RESOURCES}', ctx.resourcesDir))
    await client.connect(new StdioClientTransport({ command, args, env, cwd: cfg.cwd?.replace('${RESOURCES}', ctx.resourcesDir) ?? ctx.resourcesDir, stderr: 'ignore' }))
  } else {
    if (!cfg.url) throw invalid('URL is required for a remote MCP server.')
    checkUrl(cfg.url, { allowPrivateNetwork: cfg.allowPrivateNetwork })
    const headers: Record<string, string> = integ.credential_id ? { authorization: `Bearer ${resolveSecret(ctx, integ.credential_id)}` } : {}
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }))
  }
  mcpClients.set(integ.id, client)
  return client
}

export function closeMcp(id?: string) {
  for (const [k, c] of mcpClients) {
    if (id && k !== id) continue
    c.close().catch(() => undefined)
    mcpClients.delete(k)
  }
}

export interface McpDiscoveredTool {
  name: string
  description: string
  inputSchema: JsonSchema
  schemaHash: string
}

export async function discoverMcp(ctx: AppContext, actor: Actor | null, integrationId: string): Promise<McpDiscoveredTool[]> {
  if (actor) requireCap(ctx, actor, 'tools.administer', 'connect MCP servers')
  const integ = getIntegration(ctx, integrationId)
  closeMcp(integrationId)
  try {
    const client = await mcpClient(ctx, integ)
    const listed = await client.listTools()
    const tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object' }) as JsonSchema,
      schemaHash: stableHash(t.inputSchema ?? {})
    }))
    ctx.db.update('integrations', 'id', integrationId, { status: 'connected', status_detail: `${tools.length} tools available`, discovered: js(tools), last_checked_at: now() })
    if (actor) audit(ctx, actor, 'integration.discovered', { type: 'integration', id: integrationId }, { tools: tools.map((t) => t.name) })
    return tools
  } catch (e) {
    closeMcp(integrationId)
    ctx.db.update('integrations', 'id', integrationId, { status: 'error', status_detail: redactString((e as Error).message), last_checked_at: now() })
    throw new RelayError('unavailable', `Could not connect to the MCP server: ${redactString((e as Error).message)}`)
  }
}

export const McpRegisterSchema = z.object({
  integrationId: z.string(),
  tools: z.array(z.object({ name: z.string(), displayName: z.string().min(1).max(100), policy: ToolPolicySchema })).min(1)
})

export function registerMcpTools(ctx: AppContext, actor: Actor, input: z.infer<typeof McpRegisterSchema>) {
  requireCap(ctx, actor, 'tools.administer', 'register MCP tools')
  const integ = getIntegration(ctx, input.integrationId)
  const discovered = j<McpDiscoveredTool[]>(integ.discovered, [])
  const cfg = McpConfigSchema.parse(j(integ.config, {}))
  const out = []
  for (const sel of input.tools) {
    const t = discovered.find((d) => d.name === sel.name)
    if (!t) throw invalid(`Tool ${sel.name} was not discovered on this server. Run discovery again.`)
    const decl: ToolDeclaration = {
      key: `mcp.${slug(integ.name)}.${slug(t.name)}`,
      name: sel.displayName,
      description: t.description,
      category: sel.policy.category,
      kind: 'mcp',
      version: 1,
      inputSchema: t.inputSchema,
      outputSchema: {},
      auth: { type: integ.credential_id ? 'bearer' : 'none' },
      access: sel.policy.access,
      sideEffects: sel.policy.access === 'read' ? 'Administrator classified this tool as read-only.' : `Administrator classified this tool as ${sel.policy.access}.`,
      dataDestinations: [cfg.transport === 'stdio' ? 'local process' : new URL(cfg.url!).hostname],
      external: cfg.transport === 'http' && !cfg.allowPrivateNetwork,
      cost: { kind: 'unknown' },
      timeoutMs: sel.policy.timeoutMs,
      retry: { max: sel.policy.retrySafe ? 2 : 0, safe: sel.policy.retrySafe },
      requiresApproval: sel.policy.requiresApproval,
      capabilities: []
    }
    const r = registerTool(ctx, decl, { integrationId: integ.id, mcpTool: t.name, schemaHash: t.schemaHash }, integ.id)
    audit(ctx, actor, 'tool.registered', { type: 'tool', id: r.key }, { version: r.version, access: decl.access, source: 'mcp' })
    out.push(r)
  }
  ctx.events.emit({ type: 'tools.changed' })
  return out
}

export async function executeMcpTool(ctx: AppContext, impl: Record<string, unknown>, args: Record<string, unknown>, timeoutMs: number) {
  const integ = getIntegration(ctx, String(impl.integrationId))
  const client = await mcpClient(ctx, integ)
  const res = (await client.callTool({ name: String(impl.mcpTool), arguments: args }, undefined, { timeout: timeoutMs })) as {
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  if (res.isError) throw new RelayError('failed', `MCP tool reported an error: ${redactString(text.slice(0, 500))}`)
  if (res.structuredContent !== undefined) return res.structuredContent
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

// ---------------- Local plugins ----------------

export interface PluginManifestTool {
  name: string
  description: string
  category: (typeof TOOL_CATEGORIES)[number]
  access: (typeof TOOL_ACCESS)[number]
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  sideEffects: string
}

/** Load a plugin's manifest in a worker (never in the main thread). */
export function inspectPlugin(ctx: AppContext, dir: string): Promise<{ id: string; name: string; version: string; tools: PluginManifestTool[] }> {
  const entry = join(dir, 'dist', 'index.js')
  if (!existsSync(entry)) throw invalid(`Plugin is not built: ${entry} not found. Run “npm run build:plugins”.`)
  return runPluginWorker(ctx, { entry, mode: 'manifest' }, 10_000) as Promise<{ id: string; name: string; version: string; tools: PluginManifestTool[] }>
}

export function runPluginWorker(ctx: AppContext, data: { entry: string; mode: 'manifest' | 'execute'; tool?: string; args?: unknown }, timeoutMs: number): Promise<unknown> {
  const host = join(ctx.resourcesDir, 'plugin-host.mjs')
  return new Promise((resolvePromise, reject) => {
    const w = new Worker(pathToFileURL(host), { workerData: { ...data, entry: pathToFileURL(resolve(data.entry)).href }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new RelayError('failed', `Plugin timed out after ${timeoutMs} ms.`, { retryable: false }))
    }, timeoutMs)
    w.once('message', (m: { ok: boolean; result?: unknown; error?: string }) => {
      clearTimeout(timer)
      w.terminate()
      if (m.ok) resolvePromise(m.result)
      else reject(new RelayError('failed', `Plugin error: ${redactString(String(m.error))}`))
    })
    w.once('error', (e) => {
      clearTimeout(timer)
      reject(new RelayError('failed', `Plugin crashed: ${redactString(e.message)}`))
    })
  })
}

export const PluginRegisterSchema = z.object({
  dir: z.string().min(1),
  tools: z.array(z.object({ name: z.string(), policy: ToolPolicySchema })).min(1)
})

export async function registerPlugin(ctx: AppContext, actor: Actor, input: z.infer<typeof PluginRegisterSchema>) {
  requireCap(ctx, actor, 'tools.administer', 'install plugins')
  const dir = input.dir.replace('${RESOURCES}', ctx.resourcesDir)
  const manifest = await inspectPlugin(ctx, dir)
  let integ = ctx.db.get<IntegrationRow>("SELECT * FROM integrations WHERE kind = 'plugin' AND json_extract(config, '$.pluginId') = ?", manifest.id)
  if (!integ) {
    const id = newId('int')
    ctx.db.insert('integrations', {
      id,
      kind: 'plugin',
      name: manifest.name,
      config: js({ pluginId: manifest.id, dir: input.dir, version: manifest.version }),
      status: 'connected',
      status_detail: `Plugin v${manifest.version}`,
      discovered: js(manifest.tools),
      created_by: actor.id,
      created_at: now()
    })
    integ = getIntegration(ctx, id)
  } else ctx.db.update('integrations', 'id', integ.id, { discovered: js(manifest.tools), status: 'connected', status_detail: `Plugin v${manifest.version}`, config: js({ pluginId: manifest.id, dir: input.dir, version: manifest.version }) })
  const out = []
  for (const sel of input.tools) {
    const t = manifest.tools.find((x) => x.name === sel.name)
    if (!t) throw invalid(`Plugin does not provide tool ${sel.name}.`)
    const decl: ToolDeclaration = {
      key: `plugin.${slug(manifest.id)}.${slug(t.name)}`,
      name: t.name.replace(/_/g, ' '),
      description: t.description,
      category: sel.policy.category,
      kind: 'plugin',
      version: 1,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      auth: { type: 'none' },
      access: sel.policy.access,
      sideEffects: t.sideEffects,
      dataDestinations: ['local plugin'],
      external: false,
      cost: { kind: 'free' },
      timeoutMs: sel.policy.timeoutMs,
      retry: { max: sel.policy.retrySafe ? 1 : 0, safe: sel.policy.retrySafe },
      requiresApproval: sel.policy.requiresApproval,
      capabilities: []
    }
    const r = registerTool(ctx, decl, { integrationId: integ.id, pluginTool: t.name }, integ.id)
    audit(ctx, actor, 'tool.registered', { type: 'tool', id: r.key }, { version: r.version, source: 'plugin', pluginVersion: manifest.version })
    out.push(r)
  }
  ctx.events.emit({ type: 'tools.changed' })
  return out
}

export async function executePluginTool(ctx: AppContext, impl: Record<string, unknown>, args: Record<string, unknown>, timeoutMs: number) {
  const integ = getIntegration(ctx, String(impl.integrationId))
  const dir = String(j<{ dir: string }>(integ.config, { dir: '' }).dir).replace('${RESOURCES}', ctx.resourcesDir)
  return runPluginWorker(ctx, { entry: join(dir, 'dist', 'index.js'), mode: 'execute', tool: String(impl.pluginTool), args }, timeoutMs)
}

export function readSpecFile(path: string): string {
  return readFileSync(path, 'utf8')
}
