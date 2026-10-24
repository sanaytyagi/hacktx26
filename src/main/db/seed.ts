// Seeds the fictional demo workspace. Runs once per fresh workspace (or after reset).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext, Actor } from '../core/context'
import { newId, now, js, j } from './database'
import { setSetting, DEFAULT_POLICY } from '../core/settings'
import { audit } from '../core/audit'
import { writeSeedFiles } from './synthetic'
import { addSource, createCollection, grantAccess } from '../services/data'
import { storeCredential } from '../services/credentials'
import { syncBuiltinTools, grantTool } from '../tools/registry'
import { importOpenApi, registerPlugin } from '../tools/integrations'
import { AgentSpecSchema, type AgentSpec } from '@shared/domain'
import { pinTools } from '../services/agents'
import { readFileSync } from 'node:fs'

export const PERSONAS = {
  employee: 'u_alex',
  manager: 'u_priya',
  admin: 'u_sam'
}

function upsertUser(ctx: AppContext, u: { id: string; name: string; title: string; role: string; team_id: string | null; switchable: boolean }) {
  ctx.db.insert('users', { ...u, email: `${u.name.split(' ')[0].toLowerCase()}@northwind.example` })
}

function spec(s: Partial<AgentSpec> & { steps: AgentSpec['steps'] }): AgentSpec {
  return AgentSpecSchema.parse({ schemaVersion: 1, ...s })
}

const step = (x: Record<string, unknown>) => ({ description: '', args: {}, prompt: '', agentTools: [], outputFields: [], approvalBefore: false, onError: 'fail', maxRetries: 1, ...x }) as unknown as AgentSpec['steps'][number]

export async function seedWorkspace(ctx: AppContext) {
  if (ctx.db.get("SELECT 1 FROM settings WHERE key = 'seeded_at'")) return false
  ctx.db.tx(() => {
    ctx.db.insert('teams', { id: 'team_ops', name: 'Operations', manager_id: 'u_priya' })
    ctx.db.insert('teams', { id: 'team_sup', name: 'Support', manager_id: 'u_jordan' })
    ctx.db.insert('teams', { id: 'team_it', name: 'IT', manager_id: 'u_sam' })
    upsertUser(ctx, { id: 'u_alex', name: 'Alex Rivera', title: 'Operations Analyst', role: 'employee', team_id: 'team_ops', switchable: true })
    upsertUser(ctx, { id: 'u_priya', name: 'Priya Shah', title: 'Operations Manager', role: 'manager', team_id: 'team_ops', switchable: true })
    upsertUser(ctx, { id: 'u_sam', name: 'Sam Lee', title: 'IT Administrator', role: 'admin', team_id: 'team_it', switchable: true })
    upsertUser(ctx, { id: 'u_jordan', name: 'Jordan Ellis', title: 'Support Manager', role: 'manager', team_id: 'team_sup', switchable: false })
    upsertUser(ctx, { id: 'u_mei', name: 'Mei Tanaka', title: 'Support Specialist', role: 'employee', team_id: 'team_sup', switchable: false })
    upsertUser(ctx, { id: 'u_omar', name: 'Omar Haddad', title: 'Operations Engineer', role: 'employee', team_id: 'team_ops', switchable: false })
    setSetting(ctx, 'workspace', { name: 'Northwind Logistics', synthetic: true })
    setSetting(ctx, 'policy', { ...DEFAULT_POLICY, localComputeRateUsdPerHour: 0.6 })
    setSetting(ctx, 'persona', PERSONAS.employee)
  })
  const admin: Actor = { id: 'u_sam', name: 'Sam Lee', role: 'admin', teamId: 'team_it' }

  // ---------- Providers, prices, credentials ----------
  const providers = [
    { id: 'prv_anthropic', kind: 'anthropic', name: 'Anthropic (Claude)', base_url: null, external: 1, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], enabled: 1, env: 'ANTHROPIC_API_KEY' },
    { id: 'prv_gemini', kind: 'gemini', name: 'Google Gemini', base_url: null, external: 1, models: ['gemini-3.8-flash'], enabled: 1, env: 'GEMINI_API_KEY' },
    { id: 'prv_ollama', kind: 'openai_compatible', name: 'Local OpenAI-compatible server (e.g. Ollama)', base_url: 'http://127.0.0.1:11434/v1', external: 0, models: ['llama3.2:3b'], enabled: 0, env: '' },
    { id: 'prv_local', kind: 'local', name: 'Local model in Relay’s Python worker', base_url: null, external: 0, models: ['Qwen/Qwen2.5-0.5B-Instruct'], enabled: 0, env: '' }
  ]
  for (const p of providers) {
    let credentialId: string | null = null
    if (p.env && process.env[p.env]) credentialId = storeCredential(ctx, null, { name: `${p.name} key (from ${p.env})`, kind: 'api_key', service: p.kind, secret: process.env[p.env]! })
    ctx.db.insert('providers', { id: p.id, kind: p.kind, name: p.name, base_url: p.base_url, credential_id: credentialId, enabled: p.enabled, external: p.external, models: js(p.models), status: 'unchecked', status_detail: '', created_at: now() })
  }
  if (process.env.SERPAPI_API_KEY) setSetting(ctx, 'serpapi_credential_id', storeCredential(ctx, null, { name: 'SerpApi key (from SERPAPI_API_KEY)', kind: 'api_key', service: 'serpapi', secret: process.env.SERPAPI_API_KEY }))
  const prices = [
    ['anthropic', 'claude-opus-5-5', 4, 20, null, 'Anthropic API pricing (claude-api reference cached 2026-10-06); verify current rates'],
    ['anthropic', 'claude-sonnet-5-5', 2, 10, null, 'Anthropic API pricing (claude-api reference cached 2026-10-06); verify current rates'],
    ['anthropic', 'claude-haiku-5-5', 0.1, 0.5, null, 'Anthropic API pricing (claude-api reference cached 2026-10-06), prompts ≤100K tokens; verify'],
    ['serpapi', 'google_search', null, null, 0.015, 'Example value for the demo — set this from your SerpApi plan']
  ] as const
  for (const [kind, model, inp, out, call, source] of prices)
    ctx.db.insert('prices', { id: newId('prc'), provider_kind: kind, model, unit: call !== null ? 'per_call' : 'per_1m_tokens', input_price: inp, output_price: out, call_price: call, currency: 'USD', source, effective_date: '2026-10-06', notes: kind === 'serpapi' ? 'Demo seed' : '', updated_by: 'system', updated_at: now() })

  // ---------- Budgets ----------
  const budgets: [string, string, string, number, number][] = [
    ['workspace', 'ws', 'operating', 500, 80],
    ['workspace', 'ws', 'training', 50, 80],
    ['team', 'team_ops', 'operating', 100, 80],
    ['team', 'team_ops', 'training', 0, 80],
    ['team', 'team_sup', 'operating', 100, 80],
    ['team', 'team_sup', 'training', 20, 80],
    ['team', 'team_it', 'operating', 50, 80],
    ['team', 'team_it', 'training', 20, 80]
  ]
  for (const [scope, id, kind, limit, alert] of budgets)
    ctx.db.insert('budgets', { id: newId('bud'), scope, scope_id: id, kind, period: 'monthly', limit_usd: limit, alert_pct: alert, hard_limit: 1, created_at: now(), updated_at: now() })

  // ---------- Data ----------
  const files = writeSeedFiles(join(ctx.paths.root, 'seed-data'))
  const s = async (p: string, name: string) => (await addSource(ctx, admin, { path: join(files.root, p), name })).id
  const srcIncidents = await s('incidents.csv', 'Incident history export (synthetic)')
  const srcTickets = await s('support_tickets.jsonl', 'Support ticket export (synthetic)')
  const srcProcedures = await s('procedures', 'Company procedures folder (synthetic)')
  const srcPostmortems = await s('security_postmortems', 'Security postmortems folder (synthetic)')
  const srcInventory = await s('ops_inventory.sqlite', 'Operations inventory database (synthetic, read-only)')
  const col = (x: Parameters<typeof createCollection>[2]) => {
    const { id } = createCollection(ctx, admin, x)
    ctx.db.update('collections', 'id', id, { is_synthetic: 1 })
    return id
  }
  const cIncidents = col({ sourceId: srcIncidents, name: 'Incident history (Operations)', description: 'Reviewed production incidents with categories, Jan 2025 onward. Synthetic.', selection: { files: [], columns: [], filters: [] }, purposes: ['retrieval', 'analysis', 'training', 'export'], allowExternal: false, visibility: 'discoverable', sensitivity: 'confidential', ownerTeamId: 'team_ops' })
  const cTickets = col({ sourceId: srcTickets, name: 'Support tickets (Support)', description: 'Customer tickets with routing labels. Contains customer contact details. Synthetic.', selection: { files: [], columns: [], filters: [] }, purposes: ['retrieval', 'analysis', 'training'], allowExternal: false, visibility: 'discoverable', sensitivity: 'confidential', ownerTeamId: 'team_sup' })
  const cProcedures = col({ sourceId: srcProcedures, name: 'Company procedures', description: 'Runbooks and policies, including the vendor security review procedure. Synthetic.', selection: { files: [], columns: [], filters: [] }, purposes: ['retrieval', 'export'], allowExternal: true, visibility: 'discoverable', sensitivity: 'internal', ownerTeamId: null })
  const cPostmortems = col({ sourceId: srcPostmortems, name: 'Security postmortems (restricted)', description: 'Restricted security incident reviews. Synthetic.', selection: { files: [], columns: [], filters: [] }, purposes: ['retrieval'], allowExternal: false, visibility: 'hidden', sensitivity: 'restricted', ownerTeamId: 'team_it' })
  const cServices = col({ sourceId: srcInventory, name: 'Service inventory', description: 'Service owners and tiers (on-call emails excluded; decommissioned services filtered out).', selection: { files: [], table: 'services', columns: ['service', 'owner_team', 'tier', 'runbook', 'cost_center'], filters: [{ column: 'tier', op: 'neq', value: 'decommissioned' }] }, purposes: ['retrieval', 'analysis'], allowExternal: true, visibility: 'discoverable', sensitivity: 'internal', ownerTeamId: 'team_ops' })
  const cVendors = col({ sourceId: srcInventory, name: 'Approved vendor register', description: 'Vendors and their review status (terminated vendors filtered out).', selection: { files: [], table: 'vendors', columns: [], filters: [{ column: 'status', op: 'neq', value: 'terminated' }] }, purposes: ['retrieval', 'export'], allowExternal: true, visibility: 'discoverable', sensitivity: 'internal', ownerTeamId: 'team_ops' })
  const g = (collectionId: string, principalType: 'user' | 'team', principalId: string, purposes: ('retrieval' | 'analysis' | 'training' | 'export')[], canDelegate = false) =>
    grantAccess(ctx, admin, { collectionId, principalType, principalId, purposes, canDelegate, note: 'Demo seed' })
  g(cIncidents, 'team', 'team_ops', ['retrieval', 'analysis'])
  g(cIncidents, 'user', 'u_priya', ['retrieval', 'analysis', 'training', 'export'], true)
  g(cIncidents, 'user', 'u_sam', ['retrieval', 'analysis', 'training'])
  g(cTickets, 'team', 'team_sup', ['retrieval', 'analysis'])
  g(cTickets, 'user', 'u_jordan', ['retrieval', 'analysis', 'training'], true)
  for (const t of ['team_ops', 'team_sup', 'team_it']) g(cProcedures, 'team', t, ['retrieval'])
  g(cPostmortems, 'user', 'u_sam', ['retrieval'])
  g(cServices, 'team', 'team_ops', ['retrieval', 'analysis'])
  g(cVendors, 'user', 'u_priya', ['retrieval', 'export'], true)
  g(cVendors, 'user', 'u_omar', ['retrieval'])

  // ---------- Tools ----------
  syncBuiltinTools(ctx)
  const everyone = ['web.extract', 'web.compare', 'docs.search', 'docs.read', 'docs.summarize', 'data.query', 'data.transform', 'text.extract_fields', 'text.classify_keywords', 'db.schema', 'db.query', 'table.write', 'table.export', 'files.write', 'notify.user', 'message.draft', 'human.review', 'agent.invoke', 'model.generate']
  for (const k of everyone) grantTool(ctx, admin, { toolKey: k, principalType: 'workspace', principalId: 'ws' })
  grantTool(ctx, admin, { toolKey: 'web.search', principalType: 'team', principalId: 'team_sup' })
  grantTool(ctx, admin, { toolKey: 'web.search', principalType: 'user', principalId: 'u_priya' })

  // Integrations: OpenAPI example (local ticketing service), MCP example, and the example plugin.
  const specPath = join(ctx.resourcesDir, 'examples', 'ticketing-api', 'openapi.yaml')
  if (existsSync(specPath)) {
    const r = importOpenApi(ctx, admin, {
      name: 'Ticketing API (example)',
      specText: readFileSync(specPath, 'utf8'),
      baseUrl: 'http://127.0.0.1:4010',
      auth: { type: 'bearer' },
      secret: 'demo-ticketing-token',
      allowPrivateNetwork: true,
      operations: [
        { operationKey: 'listtickets', name: 'List tickets', policy: { access: 'read', requiresApproval: false, category: 'business_systems', retrySafe: true, timeoutMs: 10000 } },
        { operationKey: 'createticket', name: 'Create ticket', policy: { access: 'write', requiresApproval: true, category: 'business_systems', retrySafe: false, timeoutMs: 10000 } }
      ]
    })
    for (const t of r.registered) if (t.key.endsWith('listtickets')) grantTool(ctx, admin, { toolKey: t.key, principalType: 'team', principalId: 'team_ops' })
  }
  ctx.db.insert('integrations', {
    id: 'int_mcp_oncall',
    kind: 'mcp',
    name: 'On-call directory (example MCP server)',
    config: js({ transport: 'stdio', useBundledNode: true, args: ['${RESOURCES}/examples/mcp-oncall/server.mjs'], cwd: '${RESOURCES}/examples/mcp-oncall', allowPrivateNetwork: false }),
    status: 'not_checked',
    status_detail: 'Click “Connect & discover” to start the local server and list its tools.',
    discovered: '[]',
    created_by: admin.id,
    created_at: now()
  })
  try {
    const out = await registerPlugin(ctx, admin, { dir: '${RESOURCES}/plugins/sla-calculator', tools: [{ name: 'sla_due', policy: { access: 'read', requiresApproval: false, category: 'workflow', retrySafe: true, timeoutMs: 5000 } }] })
    for (const t of out) grantTool(ctx, admin, { toolKey: t.key, principalType: 'workspace', principalId: 'ws' })
  } catch (e) {
    ctx.db.insert('integrations', { id: newId('int'), kind: 'plugin', name: 'SLA calculator (example plugin)', config: js({ dir: '${RESOURCES}/plugins/sla-calculator' }), status: 'error', status_detail: (e as Error).message, discovered: '[]', created_by: admin.id, created_at: now() })
  }

  // ---------- Agent templates (owned by the administrator, read-only) ----------
  const tmpl = (name: string, description: string, sp: AgentSpec) => {
    const id = newId('agt')
    const vid = newId('agv')
    ctx.db.insert('agents', { id, owner_id: admin.id, team_id: 'team_it', name: `Template: ${name}`, description, status: 'draft', draft_version_id: vid, notify_on_failure: '[]', is_template: 1, created_at: now(), updated_at: now() })
    ctx.db.insert('agent_versions', { id: vid, agent_id: id, version: 1, spec: js(pinTools(ctx, sp)), created_by: admin.id, created_at: now(), note: 'Template', source: 'template' })
    return id
  }
  tmpl(
    'Vendor security review',
    'Research a vendor’s security page, check it against the procurement procedure and vendor register, draft an assessment, and record it after review.',
    spec({
      instructions: 'You help Operations review vendors against the vendor security review procedure. Be factual and cite where each finding came from.',
      inputs: [
        { key: 'vendor_name', label: 'Vendor name', type: 'string', required: true, description: '' },
        { key: 'security_page_url', label: 'Vendor security or trust page URL', type: 'url', required: true, description: 'Public page, e.g. https://vendor.example/security' }
      ],
      collections: [cProcedures],
      steps: [
        step({ id: 'read_page', title: 'Read the vendor’s security page', kind: 'deterministic', tool: 'web.extract', args: { url: '{{inputs.security_page_url}}', maxChars: 15000 } }),
        step({ id: 'find_certs', title: 'Extract certifications', kind: 'deterministic', tool: 'text.extract_fields', args: { text: '{{steps.read_page.output.text}}', fields: [{ name: 'certifications', kind: 'certification' }, { name: 'dates', kind: 'date' }] } }),
        step({ id: 'compare', title: 'Check required controls', kind: 'deterministic', tool: 'web.compare', args: { sources: [{ label: '{{inputs.vendor_name}} security page', text: '{{steps.read_page.output.text}}' }], terms: ['SOC 2', 'ISO 27001', 'encrypt', 'SSO', 'GDPR', 'sub-processor'] } }),
        step({ id: 'policy', title: 'Look up our review procedure', kind: 'deterministic', tool: 'docs.search', args: { query: 'vendor security review requirements SOC 2 ISO 27001', limit: 3 } }),
        step({
          id: 'assess',
          title: 'Draft the assessment',
          kind: 'agent',
          prompt: 'Using the procedure excerpts and the evidence found on the vendor page, draft an assessment: approve, approve with conditions, or reject. List blocking gaps explicitly.',
          args: { vendor: '{{inputs.vendor_name}}', certifications: '{{steps.find_certs.output.fields}}', controls: '{{steps.compare.output}}', procedure: '{{steps.policy.output.results}}' },
          outputFields: [
            { key: 'recommendation', type: 'string', description: 'approve | approve with conditions | reject' },
            { key: 'gaps', type: 'array', description: 'Missing requirements' },
            { key: 'summary', type: 'string', description: 'Two or three sentences' }
          ]
        }),
        step({ id: 'review', title: 'Reviewer checks the assessment', kind: 'human_review', prompt: 'Check the recommendation and gaps. Edit if needed, then approve.', args: { data: '{{steps.assess.output}}' } }),
        step({ id: 'record', title: 'Record the review', kind: 'deterministic', tool: 'table.write', args: { table: 'Vendor reviews', row: { vendor: '{{inputs.vendor_name}}', certifications: '{{steps.find_certs.output.fields.certifications}}', review: '{{steps.review.output.data}}', reviewed_by: '{{steps.review.output.reviewer}}', recorded_at: '{{now}}' } } })
      ],
      outputs: [{ key: 'assessment', label: 'Assessment', from: '{{steps.review.output.data}}' }]
    })
  )
  tmpl(
    'Incident triage note',
    'Categorize a new incident with keyword rules (or a registered classifier), pull the routing guidance, and draft a triage note.',
    spec({
      inputs: [{ key: 'incident', label: 'Incident description', type: 'text', required: true, description: '' }],
      collections: [cProcedures],
      steps: [
        step({ id: 'categorize', title: 'Categorize the incident', kind: 'deterministic', tool: 'text.classify_keywords', args: { text: '{{inputs.incident}}', categories: { Database: ['replica', 'query', 'deadlock', 'postgres', 'connection pool', 'migration'], Network: ['dns', 'packet', 'load balancer', '502', 'tls', 'latency'], Deployment: ['release', 'deploy', 'canary', 'rollout', 'config'], Authentication: ['login', 'sso', 'token', 'mfa', 'password'], Storage: ['disk', 'bucket', 'backup', 'storage', 'nfs'], 'Third-party API': ['vendor', 'provider', 'api', 'webhook', '429'] }, defaultLabel: 'Unclassified' } }),
        step({ id: 'routing', title: 'Find routing guidance', kind: 'deterministic', tool: 'docs.search', args: { query: 'incident triage routing {{steps.categorize.output.label}}', limit: 3 } }),
        step({ id: 'note', title: 'Record triage', kind: 'deterministic', tool: 'table.write', args: { table: 'Incident triage', row: { incident: '{{inputs.incident}}', category: '{{steps.categorize.output.label}}', matched: '{{steps.categorize.output.matched}}', guidance: '{{steps.routing.output.results[0].snippet}}' } } })
      ],
      outputs: [{ key: 'category', label: 'Category', from: '{{steps.categorize.output.label}}' }]
    })
  )

  // ---------- Example agent owned by the employee (real, runnable without API keys) ----------
  const digestSpec = pinTools(
    ctx,
    spec({
      instructions: 'Summarize incident volume by category for the weekly Operations sync.',
      inputs: [{ key: 'since', label: 'Count incidents opened on or after (YYYY-MM-DD)', type: 'string', required: true, description: '', default: '2025-06-01' }],
      collections: [cIncidents],
      steps: [
        step({ id: 'count', title: 'Count incidents by category', kind: 'deterministic', tool: 'data.query', args: { collectionId: cIncidents, query: { filters: [{ column: 'opened_at', op: 'gte', value: '{{inputs.since}}' }], groupBy: 'category', aggregate: { fn: 'count' }, orderBy: { column: 'count', direction: 'desc' }, limit: 20 } } }),
        step({ id: 'record', title: 'Record the digest', kind: 'deterministic', tool: 'table.write', args: { table: 'Weekly incident digest', rows: '{{steps.count.output.rows}}' } }),
        step({ id: 'notify', title: 'Notify me', kind: 'deterministic', tool: 'notify.user', args: { to: 'owner', title: 'Weekly incident digest is ready', body: '{{steps.count.output.matched}} incidents since {{inputs.since}}.' } })
      ],
      outputs: [{ key: 'by_category', label: 'Incidents by category', from: '{{steps.count.output.rows}}' }]
    })
  )
  const digestId = 'agt_digest'
  const digestV = 'agv_digest1'
  ctx.db.insert('agents', { id: digestId, owner_id: 'u_alex', team_id: 'team_ops', name: 'Weekly incident digest', description: 'Counts incidents by category and posts a digest. Uses only local data and tools.', status: 'live', deployment: 'personal', draft_version_id: digestV, live_version_id: digestV, notify_on_failure: js(['u_priya']), created_at: now(), updated_at: now() })
  ctx.db.insert('agent_versions', { id: digestV, agent_id: digestId, version: 1, spec: js(digestSpec), created_by: 'u_alex', created_at: now(), note: 'Created (demo seed)', source: 'edit', tested_run_id: 'run_fixture_0' })
  ctx.db.insert('budgets', { id: newId('bud'), scope: 'agent', scope_id: digestId, kind: 'operating', period: 'monthly', limit_usd: 20, alert_pct: 80, hard_limit: 1, created_at: now(), updated_at: now() })
  audit(ctx, { id: 'u_alex', name: 'Alex Rivera', role: 'employee', teamId: 'team_ops' }, 'agent.deployed', { type: 'agent', id: digestId }, { versionId: digestV, mode: 'personal', source: 'demo seed' })
  // Historical sample runs: labeled fixtures, never presented as live results.
  const statuses = ['succeeded', 'succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded']
  statuses.forEach((st, i) => {
    const at = new Date(Date.now() - (i + 1) * 7 * 86400_000).toISOString()
    ctx.db.insert('runs', { id: `run_fixture_${i}`, agent_id: digestId, agent_version_id: digestV, environment: i === 0 ? 'test' : 'live', trigger: i === 0 ? 'manual' : 'schedule', status: st, inputs: js({ since: '2025-06-01' }), outputs: st === 'succeeded' ? js({ note: 'Sample (fixture) run — did not execute' }) : null, error: st === 'failed' ? 'Sample (fixture) failure: collection was being refreshed' : null, created_by: 'u_alex', created_at: at, started_at: at, finished_at: at, is_fixture: 1 })
    ctx.db.insert('run_events', { run_id: `run_fixture_${i}`, ts: at, type: 'note', message: 'Sample (fixture) run created by the demo seed. It did not execute.', data: '{}' })
  })
  // Example pending request (fixture): Omar asks for Support tickets. Priya cannot delegate it.
  ctx.db.insert('approvals', { id: 'apr_fixture_1', type: 'data_access', title: 'Data access: Support tickets (Support) (analysis)', reason: 'Sample request (fixture): compare incident spikes with ticket volume.', requester_id: 'u_omar', team_id: 'team_ops', status: 'pending', payload: js({ collectionId: cTickets, purposes: ['analysis'], principalType: 'user', principalId: 'u_omar' }), target_type: 'collection', target_id: cTickets, created_at: now(), is_fixture: 1 })

  setSetting(ctx, 'seeded_at', now())
  setSetting(ctx, 'seed_ids', { cIncidents, cTickets, cProcedures, cPostmortems, cServices, cVendors, digestId })
  return true
}

export function seedIds(ctx: AppContext) {
  return j<Record<string, string>>(ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'seed_ids'")?.value, {})
}

