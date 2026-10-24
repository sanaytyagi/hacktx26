import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import { newId, now, j, js } from '../db/database'
import { requireCap } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError, forbidden, notFound } from '../core/errors'
import { redact } from '../core/redact'
import { getPolicy } from '../core/settings'
import { roleHas } from '@shared/permissions'
import { TOOL_CATEGORIES, type ToolDeclaration } from '@shared/domain'
import { BUILTIN_TOOLS } from './builtins'
import { validate, coerceArgs, stableHash } from './jsonschema'
import type { ToolCallContext } from './types'
import { executeHttpTool, executeMcpTool, executePluginTool, discoverMcp, getIntegration, parseOpenApi, type IntegrationRow, type McpDiscoveredTool, type OpenApiOperation } from './integrations'
import { safeFetch } from '../core/netguard'
import { invokeRegisteredModel } from '../services/models'

export interface ToolRow {
  key: string
  version: number
  kind: string
  category: string
  integration_id: string | null
  declaration: string
  impl: string
  enabled: number
}

const builtinByKey = new Map(BUILTIN_TOOLS.map((t) => [t.declaration.key, t]))

export function syncBuiltinTools(ctx: AppContext) {
  for (const b of BUILTIN_TOOLS) {
    const existing = ctx.db.get<ToolRow>('SELECT * FROM tools WHERE key = ?', b.declaration.key)
    if (!existing) {
      ctx.db.insert('tools', { key: b.declaration.key, version: 1, kind: 'builtin', category: b.declaration.category, declaration: js(b.declaration), impl: '{}', enabled: 1, created_at: now(), updated_at: now() })
      ctx.db.insert('tool_versions', { key: b.declaration.key, version: 1, declaration: js(b.declaration), impl: '{}', created_at: now() })
      continue
    }
    const prev = j<ToolDeclaration>(existing.declaration, b.declaration)
    if (stableHash({ ...prev, version: 0 }) !== stableHash({ ...b.declaration, version: 0 })) {
      const version = existing.version + 1
      const d = { ...b.declaration, version }
      ctx.db.update('tools', 'key', d.key, { version, declaration: js(d), updated_at: now() })
      ctx.db.insert('tool_versions', { key: d.key, version, declaration: js(d), impl: '{}', created_at: now() })
    }
  }
}

export function getToolRow(ctx: AppContext, key: string): ToolRow {
  const t = ctx.db.get<ToolRow>('SELECT * FROM tools WHERE key = ?', key)
  if (!t) throw notFound(`Tool “${key}”`)
  return t
}

export function getDeclaration(ctx: AppContext, key: string, version?: number): ToolDeclaration {
  if (version) {
    const v = ctx.db.get<{ declaration: string }>('SELECT declaration FROM tool_versions WHERE key = ? AND version = ?', key, version)
    if (v) return j<ToolDeclaration>(v.declaration, {} as ToolDeclaration)
  }
  return j<ToolDeclaration>(getToolRow(ctx, key).declaration, {} as ToolDeclaration)
}

// ---------------- Grants ----------------

export function toolGrantsFor(ctx: AppContext, actor: Actor, key: string) {
  return ctx.db.all<{ id: string }>(
    `SELECT id FROM tool_grants WHERE tool_key = ? AND revoked_at IS NULL AND
      ((principal_type = 'workspace') OR (principal_type = 'team' AND principal_id = ?) OR (principal_type = 'user' AND principal_id = ?))`,
    key,
    actor.teamId ?? '__none__',
    actor.id
  )
}

export function checkToolUse(ctx: AppContext, actor: Actor, key: string): { allowed: boolean; reason: string } {
  const t = ctx.db.get<ToolRow>('SELECT * FROM tools WHERE key = ?', key)
  if (!t) return { allowed: false, reason: `Tool “${key}” is not registered.` }
  if (!t.enabled) return { allowed: false, reason: `Tool “${key}” is disabled by an administrator.` }
  if (!toolGrantsFor(ctx, actor, key).length) return { allowed: false, reason: `You have not been approved to use “${j<ToolDeclaration>(t.declaration, {} as ToolDeclaration).name}”.` }
  return { allowed: true, reason: 'Approved' }
}

export const ToolGrantSchema = z.object({ toolKey: z.string(), principalType: z.enum(['workspace', 'team', 'user']), principalId: z.string() })

export function grantTool(ctx: AppContext, actor: Actor, input: z.infer<typeof ToolGrantSchema>, viaApproval = false) {
  if (!viaApproval) requireCap(ctx, actor, 'tools.administer', 'approve tools for teams')
  getToolRow(ctx, input.toolKey)
  const dup = ctx.db.get('SELECT 1 FROM tool_grants WHERE tool_key = ? AND principal_type = ? AND principal_id = ? AND revoked_at IS NULL', input.toolKey, input.principalType, input.principalId)
  if (dup) return
  ctx.db.insert('tool_grants', { id: newId('tg'), tool_key: input.toolKey, principal_type: input.principalType, principal_id: input.principalId, granted_by: actor.id, created_at: now() })
  audit(ctx, actor, 'tool.granted', { type: 'tool', id: input.toolKey }, input)
  ctx.events.emit({ type: 'tools.changed' })
}

export function revokeToolGrant(ctx: AppContext, actor: Actor, grantId: string) {
  requireCap(ctx, actor, 'tools.administer', 'revoke tool access')
  const g = ctx.db.get<{ tool_key: string }>('SELECT tool_key FROM tool_grants WHERE id = ? AND revoked_at IS NULL', grantId)
  if (!g) throw notFound('Tool grant')
  ctx.db.update('tool_grants', 'id', grantId, { revoked_at: now() })
  audit(ctx, actor, 'tool.revoked', { type: 'tool', id: g.tool_key }, { grantId })
  ctx.events.emit({ type: 'tools.changed' })
}

export function setToolEnabled(ctx: AppContext, actor: Actor, key: string, enabled: boolean) {
  requireCap(ctx, actor, 'tools.administer', 'enable or disable tools')
  getToolRow(ctx, key)
  ctx.db.update('tools', 'key', key, { enabled, updated_at: now() })
  audit(ctx, actor, enabled ? 'tool.enabled' : 'tool.disabled', { type: 'tool', id: key }, {})
  ctx.events.emit({ type: 'tools.changed' })
}

// ---------------- Catalog ----------------

export type CatalogStatus = 'available' | 'needs_connection' | 'requires_permission' | 'not_supported' | 'disabled'

const UNSUPPORTED_ENTRIES = [
  {
    key: 'catalog.browser_automation',
    name: 'Browser automation',
    category: 'browser_automation' as const,
    description: 'Clicking and typing in websites or desktop apps on your behalf. Not supported in this build: Relay does not drive browsers or desktop apps. Steps like this stay manual or become human tasks.'
  },
  {
    key: 'catalog.email_send',
    name: 'Send email',
    category: 'communication' as const,
    description: 'No native email connector in this build. Use “Draft a message” for human-sent drafts, or have an administrator add your email API as a Custom HTTP or OpenAPI tool (send-class, approval required).'
  }
]

export function toolNeeds(ctx: AppContext, t: ToolRow): string | null {
  if (t.kind === 'builtin') return builtinByKey.get(t.key)?.needs?.(ctx) ?? null
  if (t.kind === 'model') {
    const m = ctx.db.get<{ status: string }>("SELECT status FROM models WHERE name = ? AND status = 'active'", j<{ modelName: string }>(t.impl, { modelName: '' }).modelName)
    return m ? null : 'No active version of this model'
  }
  if (t.integration_id) {
    const integ = ctx.db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', t.integration_id)
    if (!integ) return 'Integration removed'
    const health = ctx.db.get<{ status: string; detail: string }>('SELECT status, detail FROM tool_health WHERE tool_key = ?', t.key)
    if (health?.status === 'schema_changed') return `Schema changed: ${health.detail}`
    if (integ.status === 'error') return `Connection failing: ${integ.status_detail}`
  }
  return null
}

export function listCatalog(ctx: AppContext, actor: Actor) {
  const rows = ctx.db.all<ToolRow>('SELECT * FROM tools ORDER BY category, key')
  const isAdmin = roleHas(actor.role, 'tools.administer')
  const pendingRequests = new Set(
    ctx.db
      .all<{ payload: string }>("SELECT payload FROM approvals WHERE type = 'tool_access' AND status = 'pending' AND requester_id = ?", actor.id)
      .map((r) => j<{ toolKey: string }>(r.payload, { toolKey: '' }).toolKey)
  )
  const tools = rows.map((t) => {
    const d = j<ToolDeclaration>(t.declaration, {} as ToolDeclaration)
    const needs = toolNeeds(ctx, t)
    const granted = toolGrantsFor(ctx, actor, t.key).length > 0
    let status: CatalogStatus = !t.enabled ? 'disabled' : needs ? 'needs_connection' : granted ? 'available' : 'requires_permission'
    const health = ctx.db.get<{ status: string; detail: string; checked_at: string }>('SELECT status, detail, checked_at FROM tool_health WHERE tool_key = ?', t.key)
    return {
      key: t.key,
      version: t.version,
      kind: t.kind,
      name: d.name,
      description: d.description,
      category: d.category,
      access: d.access,
      external: d.external,
      dataDestinations: d.dataDestinations,
      sideEffects: d.sideEffects,
      cost: d.cost,
      requiresApproval: d.requiresApproval,
      retry: d.retry,
      timeoutMs: d.timeoutMs,
      rateLimitPerMin: d.rateLimitPerMin ?? null,
      auth: d.auth.type,
      capabilities: d.capabilities,
      inputSchema: d.inputSchema,
      outputSchema: d.outputSchema,
      status,
      statusDetail: !t.enabled ? 'Disabled by an administrator' : (needs ?? (granted ? 'Approved for you' : 'Not approved for your team')),
      requestPending: pendingRequests.has(t.key),
      integrationId: t.integration_id,
      health: health ?? null,
      grants: isAdmin
        ? ctx.db.all<{ id: string; principal_type: string; principal_id: string; name: string | null }>(
            `SELECT g.id, g.principal_type, g.principal_id, COALESCE(u.name, tm.name, 'Everyone') AS name FROM tool_grants g
             LEFT JOIN users u ON g.principal_type = 'user' AND u.id = g.principal_id LEFT JOIN teams tm ON g.principal_type = 'team' AND tm.id = g.principal_id
             WHERE g.tool_key = ? AND g.revoked_at IS NULL`,
            t.key
          )
        : []
    }
  })
  const unsupported = UNSUPPORTED_ENTRIES.map((u) => ({
    key: u.key,
    version: 0,
    kind: 'catalog',
    name: u.name,
    description: u.description,
    category: u.category,
    access: 'read' as const,
    external: false,
    dataDestinations: [],
    sideEffects: '',
    cost: { kind: 'unknown' as const },
    requiresApproval: false,
    retry: { max: 0, safe: false },
    timeoutMs: 0,
    rateLimitPerMin: null,
    auth: 'none',
    capabilities: u.category === 'browser_automation' ? ['desktop_action'] : ['send_message'],
    inputSchema: {},
    outputSchema: {},
    status: 'not_supported' as CatalogStatus,
    statusDetail: 'Not supported in this build',
    requestPending: false,
    integrationId: null,
    health: null,
    grants: []
  }))
  return { tools: [...tools, ...unsupported], categories: TOOL_CATEGORIES }
}

// ---------------- Invocation ----------------

const rateWindows = new Map<string, number[]>()

function checkRate(key: string, perMin?: number) {
  if (!perMin) return
  const t = Date.now()
  const w = (rateWindows.get(key) ?? []).filter((x) => t - x < 60_000)
  if (w.length >= perMin) throw new RelayError('failed', `Rate limit for ${key} reached (${perMin}/minute). Try again shortly.`, { retryable: true })
  w.push(t)
  rateWindows.set(key, w)
}

export interface InvokeOptions {
  pinnedVersion?: number
  /** Set by the engine when a human approved this specific call. */
  approved?: boolean
  /** Administrator diagnostics: skip the per-person tool grant (all other checks still apply). */
  adminDiagnostic?: boolean
}

export interface InvokeResult {
  output: unknown
  taint: string[]
  attempts: number
  durationMs: number
  version: number
}

/** Whether a newer tool version can run in place of the pinned one without broader access. */
export function versionCompatibility(ctx: AppContext, key: string, pinned: number): { ok: boolean; reason: string } {
  const current = getToolRow(ctx, key)
  if (current.version === pinned) return { ok: true, reason: 'Same version' }
  const a = getDeclaration(ctx, key, pinned)
  const b = j<ToolDeclaration>(current.declaration, {} as ToolDeclaration)
  if (!a?.key) return { ok: false, reason: `Pinned version v${pinned} no longer exists.` }
  const rank = { read: 0, write: 1, send: 2, delete: 3, admin: 4 }
  if (rank[b.access] > rank[a.access]) return { ok: false, reason: `v${b.version} needs broader permission (${a.access} → ${b.access}); approval required before upgrading.` }
  if (stableHash(a.inputSchema) !== stableHash(b.inputSchema)) return { ok: false, reason: `Input schema changed between v${pinned} and v${b.version}. Re-test the agent with the new version.` }
  if (stableHash(a.dataDestinations) !== stableHash(b.dataDestinations)) return { ok: false, reason: `Data destinations changed between v${pinned} and v${b.version}.` }
  return { ok: true, reason: `Compatible upgrade v${pinned} → v${b.version}` }
}

export async function invokeTool(ctx: AppContext, key: string, rawArgs: Record<string, unknown>, tc: ToolCallContext, opts: InvokeOptions = {}): Promise<InvokeResult> {
  const row = getToolRow(ctx, key)
  const decl = j<ToolDeclaration>(row.declaration, {} as ToolDeclaration)
  const started = Date.now()
  // 1. Permission and availability, checked at execution time (not at build time).
  const use = opts.adminDiagnostic && roleHas(tc.actor.role, 'tools.administer') && row.enabled ? { allowed: true, reason: 'Administrator diagnostic test' } : checkToolUse(ctx, tc.actor, key)
  if (!use.allowed) {
    audit(ctx, tc.actor, 'tool.denied', { type: 'tool', id: key }, { runId: tc.runId, reason: use.reason }, 'denied')
    throw forbidden(use.reason)
  }
  if (opts.pinnedVersion && opts.pinnedVersion !== row.version) {
    const compat = versionCompatibility(ctx, key, opts.pinnedVersion)
    if (!compat.ok) throw new RelayError('conflict', `${decl.name}: ${compat.reason}`)
    tc.log(`Using ${decl.name} v${row.version} (agent pinned v${opts.pinnedVersion}; compatible).`)
  }
  const needs = toolNeeds(ctx, row)
  if (needs) throw new RelayError('unavailable', `${decl.name} is not ready: ${needs}.`)
  if (tc.environment === 'live' && !opts.approved && (decl.requiresApproval || (getPolicy(ctx).checkpointForSendAndDelete && (decl.access === 'send' || decl.access === 'delete'))))
    throw new RelayError('policy', `${decl.name} requires a human approval for each call.`, { needsApproval: true })
  if (tc.environment === 'test' && decl.access !== 'read' && decl.kind !== 'builtin' && !opts.approved)
    throw new RelayError('policy', `${decl.name} changes data in an external system; in Test it runs only after you approve the call.`, { needsApproval: true })
  // 2. Input contract.
  const args = coerceArgs(decl.inputSchema, rawArgs)
  const inErrs = validate(decl.inputSchema, args)
  if (inErrs.length) throw new RelayError('invalid', `Invalid input for ${decl.name}: ${inErrs.join('; ')}`, { validation: inErrs })
  checkRate(key, decl.rateLimitPerMin)
  // 3. Idempotent replay of completed side effects.
  if (decl.access !== 'read' && decl.kind !== 'builtin') {
    const prior = ctx.db.get<{ result: string }>('SELECT result FROM tool_effects WHERE idempotency_key = ?', tc.idempotencyKey)
    if (prior) {
      tc.log(`${decl.name} already completed for this step; returning the recorded result instead of repeating it.`)
      return { output: j(prior.result, null), taint: [], attempts: 0, durationMs: 0, version: row.version }
    }
  }
  // 4. Execute with timeout and bounded, safe-only retries.
  const maxAttempts = 1 + (decl.retry.safe ? decl.retry.max : 0)
  let attempt = 0
  let lastErr: unknown
  while (attempt < maxAttempts) {
    attempt++
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    tc.signal.addEventListener('abort', onAbort)
    const timer = setTimeout(() => ac.abort(), decl.timeoutMs)
    try {
      const sub: ToolCallContext = { ...tc, signal: ac.signal }
      const res = await Promise.race([
        execute(ctx, row, decl, args, sub),
        new Promise<never>((_r, reject) => ac.signal.addEventListener('abort', () => reject(new RelayError(tc.signal.aborted ? 'cancelled' : 'failed', tc.signal.aborted ? 'Cancelled.' : `${decl.name} timed out after ${decl.timeoutMs} ms.`, { retryable: !tc.signal.aborted }))))
      ])
      const outErrs = decl.outputSchema && Object.keys(decl.outputSchema).length ? validate(decl.outputSchema, res.output) : []
      if (outErrs.length) throw new RelayError('failed', `${decl.name} returned output that does not match its declared schema: ${outErrs.slice(0, 3).join('; ')}`)
      if (decl.access !== 'read' && decl.kind !== 'builtin')
        ctx.db.run('INSERT OR IGNORE INTO tool_effects (idempotency_key, run_id, tool_key, result, created_at) VALUES (?,?,?,?,?)', tc.idempotencyKey, tc.runId ?? '', key, js(res.output), now())
      audit(ctx, tc.actor, 'tool.called', { type: 'tool', id: key }, { runId: tc.runId, version: row.version, access: decl.access, attempts: attempt, environment: tc.environment })
      return { output: res.output, taint: res.taint ?? [], attempts: attempt, durationMs: Date.now() - started, version: row.version }
    } catch (e) {
      lastErr = e
      const err = e as RelayError
      const retryable = err.details?.retryable === true || (err.code === 'failed' && !err.details?.httpStatus && err.details?.retryable !== false)
      if (tc.signal.aborted || !decl.retry.safe || !retryable || attempt >= maxAttempts) break
      tc.log(`${decl.name} failed (attempt ${attempt}): ${err.message}. Retrying — this tool is marked safe to retry.`)
      await new Promise((r) => setTimeout(r, 400 * attempt))
    } finally {
      clearTimeout(timer)
      tc.signal.removeEventListener('abort', onAbort)
    }
  }
  audit(ctx, tc.actor, 'tool.failed', { type: 'tool', id: key }, { runId: tc.runId, error: (lastErr as Error)?.message, attempts: attempt }, 'error')
  throw lastErr
}

async function execute(ctx: AppContext, row: ToolRow, decl: ToolDeclaration, args: Record<string, unknown>, tc: ToolCallContext): Promise<{ output: unknown; taint?: string[] }> {
  const impl = j<Record<string, unknown>>(row.impl, {})
  if (row.kind === 'builtin') {
    const b = builtinByKey.get(row.key)
    if (!b) throw new RelayError('unavailable', `Built-in tool ${row.key} is not available in this build.`)
    return b.impl(args, tc)
  }
  // External tools: enforce egress before any data leaves.
  if (decl.external) {
    const { checkEgress } = await import('../services/providers')
    checkEgress(ctx, { external: true, host: decl.dataDestinations[0] ?? 'external', label: decl.name }, tc.inputTaint)
  }
  if (row.kind === 'http' || row.kind === 'openapi') return { output: await executeHttpTool(ctx, decl, impl, args, tc) }
  if (row.kind === 'mcp') return { output: await executeMcpTool(ctx, impl, args, decl.timeoutMs) }
  if (row.kind === 'plugin') return { output: await executePluginTool(ctx, impl, args, decl.timeoutMs) }
  if (row.kind === 'model') return { output: await invokeRegisteredModel(ctx, tc.actor, String(impl.modelName), args, tc) }
  throw new RelayError('unavailable', `Unknown tool kind ${row.kind}.`)
}

// ---------------- Health & testing ----------------

function setHealth(ctx: AppContext, key: string, status: string, detail: string, schemaHash?: string) {
  ctx.db.run(
    'INSERT INTO tool_health (tool_key, status, detail, checked_at, schema_hash) VALUES (?,?,?,?,?) ON CONFLICT(tool_key) DO UPDATE SET status=excluded.status, detail=excluded.detail, checked_at=excluded.checked_at, schema_hash=COALESCE(excluded.schema_hash, tool_health.schema_hash)',
    key,
    status,
    detail,
    now(),
    schemaHash ?? null
  )
}

/** Check connections and detect schema drift for every integration-backed tool. */
export async function checkHealth(ctx: AppContext, actor: Actor | null, integrationId?: string) {
  if (actor) requireCap(ctx, actor, 'tools.administer', 'run connector health checks')
  const integrations = ctx.db.all<IntegrationRow>(`SELECT * FROM integrations ${integrationId ? 'WHERE id = ?' : ''}`, ...(integrationId ? [integrationId] : []))
  for (const integ of integrations) {
    const tools = ctx.db.all<ToolRow>('SELECT * FROM tools WHERE integration_id = ?', integ.id)
    try {
      if (integ.kind === 'mcp') {
        const discovered = await discoverMcp(ctx, null, integ.id)
        for (const t of tools) {
          const impl = j<{ mcpTool: string; schemaHash: string }>(t.impl, { mcpTool: '', schemaHash: '' })
          const now_ = discovered.find((d: McpDiscoveredTool) => d.name === impl.mcpTool)
          if (!now_) setHealth(ctx, t.key, 'broken', 'Tool no longer offered by the MCP server')
          else if (now_.schemaHash !== impl.schemaHash) setHealth(ctx, t.key, 'schema_changed', 'Input schema changed on the server; re-register to review the change', now_.schemaHash)
          else setHealth(ctx, t.key, 'ok', 'Connected; schema unchanged')
        }
      } else if (integ.kind === 'http' || integ.kind === 'openapi') {
        const cfg = j<{ baseUrl: string; allowPrivateNetwork?: boolean; specUrl?: string }>(integ.config, { baseUrl: '' })
        const res = await safeFetch(cfg.baseUrl, { timeoutMs: 8000, allowedHosts: [new URL(cfg.baseUrl).hostname], allowPrivateNetwork: !!cfg.allowPrivateNetwork })
        const reachable = res.status < 500
        if (integ.kind === 'openapi' && cfg.specUrl) {
          const spec = await safeFetch(cfg.specUrl, { timeoutMs: 8000, allowedHosts: [new URL(cfg.specUrl).hostname], allowPrivateNetwork: !!cfg.allowPrivateNetwork })
          const ops = parseOpenApi(spec.body.toString('utf8')).operations
          for (const t of tools) {
            const impl = j<{ path: string; method: string; schemaHash: string }>(t.impl, { path: '', method: '', schemaHash: '' })
            const op = ops.find((o: OpenApiOperation) => o.path === impl.path && o.method === impl.method)
            if (!op) setHealth(ctx, t.key, 'broken', 'Operation removed from the API specification')
            else if (stableHash(op) !== impl.schemaHash) setHealth(ctx, t.key, 'schema_changed', 'Operation definition changed in the specification')
            else setHealth(ctx, t.key, reachable ? 'ok' : 'unreachable', reachable ? `Reachable (HTTP ${res.status}); schema unchanged` : `Server error HTTP ${res.status}`)
          }
        } else for (const t of tools) setHealth(ctx, t.key, reachable ? 'ok' : 'unreachable', reachable ? `Reachable (HTTP ${res.status})` : `Server error HTTP ${res.status}`)
        ctx.db.update('integrations', 'id', integ.id, { status: reachable ? 'connected' : 'error', status_detail: reachable ? `Reachable (HTTP ${res.status})` : `HTTP ${res.status}`, last_checked_at: now() })
      } else if (integ.kind === 'plugin') {
        const { inspectPlugin } = await import('./integrations')
        const dir = String(j<{ dir: string }>(integ.config, { dir: '' }).dir).replace('${RESOURCES}', ctx.resourcesDir)
        const m = await inspectPlugin(ctx, dir)
        for (const t of tools) {
          const name = j<{ pluginTool: string }>(t.impl, { pluginTool: '' }).pluginTool
          setHealth(ctx, t.key, m.tools.some((x) => x.name === name) ? 'ok' : 'broken', m.tools.some((x) => x.name === name) ? `Plugin v${m.version} loaded` : 'Tool missing from plugin')
        }
        ctx.db.update('integrations', 'id', integ.id, { status: 'connected', status_detail: `Plugin v${m.version}`, last_checked_at: now() })
      }
    } catch (e) {
      const msg = (e as Error).message
      ctx.db.update('integrations', 'id', integ.id, { status: 'error', status_detail: msg, last_checked_at: now() })
      for (const t of tools) setHealth(ctx, t.key, 'unreachable', msg)
    }
  }
  ctx.events.emit({ type: 'tools.changed' })
  return listIntegrations(ctx, actor)
}

export function listIntegrations(ctx: AppContext, actor: Actor | null) {
  if (actor) requireCap(ctx, actor, 'tools.administer', 'view integrations')
  return ctx.db.all<IntegrationRow>('SELECT * FROM integrations ORDER BY created_at').map((i) => {
    const cfg = j<Record<string, unknown>>(i.config, {})
    return {
      id: i.id,
      kind: i.kind,
      name: i.name,
      status: i.status,
      statusDetail: i.status_detail,
      lastCheckedAt: i.last_checked_at,
      hasCredential: !!i.credential_id,
      config: { baseUrl: cfg.baseUrl ?? null, transport: cfg.transport ?? null, command: cfg.useBundledNode ? '(bundled Node runtime)' : (cfg.command ?? null), args: cfg.args ?? null, url: cfg.url ?? null, allowPrivateNetwork: !!cfg.allowPrivateNetwork, specTitle: cfg.specTitle ?? null, dir: cfg.dir ?? null, auth: cfg.auth ?? null },
      discovered: j<unknown[]>(i.discovered, []),
      tools: ctx.db.all<{ key: string; version: number; enabled: number }>('SELECT key, version, enabled FROM tools WHERE integration_id = ?', i.id).map((t) => ({
        ...t,
        health: ctx.db.get<{ status: string; detail: string; checked_at: string }>('SELECT status, detail, checked_at FROM tool_health WHERE tool_key = ?', t.key) ?? null
      }))
    }
  })
}

/** Admin tool tester. Write/send/delete tools need explicit confirmation of a test environment. */
export async function testTool(ctx: AppContext, actor: Actor, input: { key: string; args: Record<string, unknown>; confirmSideEffects: boolean; collectionIds?: string[] }) {
  requireCap(ctx, actor, 'tools.administer', 'test tools')
  const decl = getDeclaration(ctx, input.key)
  if (decl.access !== 'read' && !input.confirmSideEffects)
    throw new RelayError('policy', `${decl.name} is a ${decl.access} tool. Confirm you are pointing at a test environment before running it.`)
  const logs: string[] = []
  const ac = new AbortController()
  const started = Date.now()
  try {
    const r = await invokeTool(
      ctx,
      input.key,
      input.args,
      {
        ctx,
        actor,
        runId: null,
        agentId: null,
        teamId: actor.teamId,
        allowedCollections: null,
        idempotencyKey: `test:${newId('t')}`,
        inputTaint: [],
        signal: ac.signal,
        environment: 'live',
        log: (m) => logs.push(m)
      },
      { approved: true, adminDiagnostic: true }
    )
    audit(ctx, actor, 'tool.tested', { type: 'tool', id: input.key }, { durationMs: r.durationMs })
    setHealth(ctx, input.key, 'ok', `Test call succeeded in ${r.durationMs} ms`)
    return { ok: true, output: redact(r.output), durationMs: r.durationMs, logs }
  } catch (e) {
    setHealth(ctx, input.key, 'failing', (e as Error).message)
    return { ok: false, error: (e as Error).message, durationMs: Date.now() - started, logs }
  }
}

export function toolVersions(ctx: AppContext, key: string) {
  return ctx.db.all<{ version: number; created_at: string; declaration: string }>('SELECT version, created_at, declaration FROM tool_versions WHERE key = ? ORDER BY version DESC', key).map((v) => {
    const d = j<ToolDeclaration>(v.declaration, {} as ToolDeclaration)
    return { version: v.version, createdAt: v.created_at, access: d.access, requiresApproval: d.requiresApproval, inputSchemaHash: stableHash(d.inputSchema) }
  })
}

export { getIntegration }
