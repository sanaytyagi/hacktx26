import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { makeRelay, type TestRelay } from './helpers'
import { isPrivateAddress, safeFetch } from '../src/main/core/netguard'
import { invokeTool, grantTool, checkHealth } from '../src/main/tools/registry'
import { importOpenApi, discoverMcp, registerMcpTools, parseOpenApi } from '../src/main/tools/integrations'
import { createWebhook, sign } from '../src/main/services/webhooks'
import { createAgent } from '../src/main/services/agents'
import { setSetting } from '../src/main/core/settings'
import { redactString, registerSecret } from '../src/main/core/redact'
import { newId } from '../src/main/db/database'
import { AgentSpecSchema } from '../src/shared/domain'
import type { Actor } from '../src/main/core/context'

let t: TestRelay
let ticketing: http.Server
let ticketingUrl: string

const tc = (actor: Actor, env: 'test' | 'live' = 'live') => ({ ctx: t.ctx, actor, runId: null, agentId: null, teamId: actor.teamId, allowedCollections: null, idempotencyKey: newId('t'), inputTaint: [], signal: new AbortController().signal, environment: env, log: () => undefined })

beforeAll(async () => {
  t = await makeRelay()
  const mod = await import('../resources/examples/ticketing-api/server.mjs')
  ticketing = mod.createServer()
  await new Promise<void>((r) => ticketing.listen(0, '127.0.0.1', () => r()))
  ticketingUrl = `http://127.0.0.1:${(ticketing.address() as AddressInfo).port}`
})
afterAll(async () => {
  ticketing.close()
  await t.cleanup()
})

describe('network guard', () => {
  it('classifies private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1', '0.0.0.0']) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('blocks web tools from loopback, metadata and internal hostnames', async () => {
    for (const url of ['http://127.0.0.1:9/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://intranet.local/', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
      await expect(invokeTool(t.ctx, 'web.extract', { url }, tc(t.alex)), url).rejects.toThrow(/Blocked|Only http|credentials|not allowed/)
    }
  })

  it('re-checks every redirect hop', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as AddressInfo).port
    // Even an integration explicitly allowed to reach its own internal host cannot be redirected elsewhere.
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] })).rejects.toThrow(/not allowed/)
    srv.close()
  })
})

describe('OpenAPI tools', () => {
  it('parses a spec and registers only selected operations with admin-set access', async () => {
    const spec = readFileSync('resources/examples/ticketing-api/openapi.yaml', 'utf8')
    const parsed = parseOpenApi(spec)
    expect(parsed.operations.map((o) => o.operationKey).sort()).toEqual(['createticket', 'deleteticket', 'getticket', 'listtickets'])
    const r = importOpenApi(t.ctx, t.sam, {
      name: 'Tix',
      specText: spec,
      baseUrl: ticketingUrl,
      auth: { type: 'bearer' },
      secret: 'demo-ticketing-token',
      allowPrivateNetwork: true,
      operations: [
        { operationKey: 'listtickets', name: 'List', policy: { access: 'read', requiresApproval: false, category: 'business_systems', retrySafe: true, timeoutMs: 5000 } },
        { operationKey: 'createticket', name: 'Create', policy: { access: 'write', requiresApproval: true, category: 'business_systems', retrySafe: false, timeoutMs: 5000 } }
      ]
    })
    expect(r.registered.map((x) => x.key)).toEqual(['api.tix.listtickets', 'api.tix.createticket'])
    expect(t.ctx.db.get("SELECT 1 FROM tools WHERE key = 'api.tix.deleteticket'")).toBeUndefined()
  })

  it('calls the API with a stored credential the agent never sees, and enforces per-call approval', async () => {
    grantTool(t.ctx, t.sam, { toolKey: 'api.tix.listtickets', principalType: 'team', principalId: 'team_ops' })
    grantTool(t.ctx, t.sam, { toolKey: 'api.tix.createticket', principalType: 'team', principalId: 'team_ops' })
    const list = await invokeTool(t.ctx, 'api.tix.listtickets', { status: 'open' }, tc(t.alex))
    expect((list.output as { tickets: unknown[] }).tickets.length).toBeGreaterThan(0)
    await expect(invokeTool(t.ctx, 'api.tix.createticket', { title: 'x', service: 'checkout' }, tc(t.alex))).rejects.toThrow(/approval/)
    const c = tc(t.alex)
    const first = await invokeTool(t.ctx, 'api.tix.createticket', { title: 'From test', service: 'checkout' }, c, { approved: true })
    // Retrying with the same idempotency key returns the recorded result instead of creating a duplicate.
    const again = await invokeTool(t.ctx, 'api.tix.createticket', { title: 'From test', service: 'checkout' }, c, { approved: true })
    expect((again.output as { id: string }).id).toBe((first.output as { id: string }).id)
    expect(JSON.stringify(first.output)).not.toContain('demo-ticketing-token')
  })

  it('refuses tools for people without a tool grant', async () => {
    await expect(invokeTool(t.ctx, 'api.tix.listtickets', {}, tc(t.mei))).rejects.toThrow(/not been approved/)
  })

  it('validates tool inputs against the declared schema', async () => {
    await expect(invokeTool(t.ctx, 'api.tix.createticket', { title: 'no service' }, tc(t.alex), { approved: true })).rejects.toThrow(/service is required/)
  })

  it('detects when a registered operation changes in the spec', async () => {
    const changed = readFileSync('resources/examples/ticketing-api/openapi.yaml', 'utf8').replace('summary: Create a ticket in the ticketing system.', 'summary: Create a ticket (v2).')
    const specSrv = http.createServer((_req, res) => res.end(changed))
    await new Promise<void>((r) => specSrv.listen(0, '127.0.0.1', () => r()))
    const integ = t.ctx.db.get<{ id: string; config: string }>("SELECT id, config FROM integrations WHERE name = 'Tix'")!
    t.ctx.db.update('integrations', 'id', integ.id, { config: JSON.stringify({ ...JSON.parse(integ.config), specUrl: `http://127.0.0.1:${(specSrv.address() as AddressInfo).port}/spec.yaml` }) })
    await checkHealth(t.ctx, null, integ.id)
    const h = t.ctx.db.get<{ status: string }>("SELECT status FROM tool_health WHERE tool_key = 'api.tix.createticket'")!
    expect(h.status).toBe('schema_changed')
    expect(t.ctx.db.get<{ status: string }>("SELECT status FROM tool_health WHERE tool_key = 'api.tix.listtickets'")!.status).toBe('ok')
    specSrv.close()
  })
})

describe('MCP and plugins', () => {
  it('discovers tools from the example MCP server and calls a registered one', async () => {
    const tools = await discoverMcp(t.ctx, t.sam, 'int_mcp_oncall')
    expect(tools.map((x) => x.name).sort()).toEqual(['get_oncall', 'service_status'])
    const [reg] = registerMcpTools(t.ctx, t.sam, { integrationId: 'int_mcp_oncall', tools: [{ name: 'get_oncall', displayName: 'On-call lookup', policy: { access: 'read', requiresApproval: false, category: 'workflow', retrySafe: true, timeoutMs: 10000 } }] })
    grantTool(t.ctx, t.sam, { toolKey: reg.key, principalType: 'team', principalId: 'team_ops' })
    const out = await invokeTool(t.ctx, reg.key, { service: 'billing' }, tc(t.alex))
    expect(out.output).toMatchObject({ service: 'billing', primary: 'Hana Kim' })
    // Nothing the server didn't get explicitly registered is exposed.
    expect(t.ctx.db.get("SELECT 1 FROM tools WHERE key LIKE 'mcp.%service_status'")).toBeUndefined()
  }, 30_000)

  it('runs the example TypeScript plugin in a worker', async () => {
    const out = await invokeTool(t.ctx, 'plugin.sla_calculator.sla_due', { severity: 'SEV1', opened_at: '2026-10-24T00:00:00Z', now: '2026-10-24T05:00:00Z' }, tc(t.alex))
    expect(out.output).toMatchObject({ breached: true, rule: '4 calendar hours' })
  })
})

describe('webhooks and the local API', () => {
  it('requires the per-launch secret, rejects browsers, and starts runs only for enabled triggers', async () => {
    setSetting(t.ctx, 'api', { enabled: true, port: 0, modelInference: false })
    await t.relay.api.apply()
    const base = `http://127.0.0.1:${t.relay.api.port()}`
    const spec = AgentSpecSchema.parse({ schemaVersion: 1, steps: [{ id: 'a', title: 'A', kind: 'deterministic', tool: 'text.extract_fields', args: { text: '{{inputs.text}}', fields: [{ name: 'e', kind: 'email' }] } }], inputs: [{ key: 'text', label: 'Text', type: 'string', required: true }] })
    const { id } = createAgent(t.ctx, t.alex, { name: 'API agent', spec })
    t.ctx.db.run("UPDATE agents SET status = 'live', live_version_id = draft_version_id WHERE id = ?", id)
    const post = (path: string, headers: Record<string, string>, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    expect((await post(`/v1/agents/${id}/runs`, {}, { inputs: { text: 'a@b.co' } })).status).toBe(401)
    expect((await post(`/v1/agents/${id}/runs`, { authorization: `Bearer ${t.relay.api.secret}`, origin: 'https://evil.example' }, {})).status).toBe(403)
    expect((await post(`/v1/agents/${id}/runs`, { authorization: `Bearer ${t.relay.api.secret}` }, { inputs: { text: 'a@b.co' } })).status).toBe(403)
    await t.ipc('u_alex', 'agents.apiTrigger', { id, enabled: true })
    const ok = await post(`/v1/agents/${id}/runs`, { authorization: `Bearer ${t.relay.api.secret}` }, { inputs: { text: 'a@b.co' } })
    expect(ok.status).toBe(202)
    const { runId } = (await ok.json()) as { runId: string }
    expect(await t.relay.engine.waitFor(runId)).toBe('succeeded')

    const { id: hookId, secret } = createWebhook(t.ctx, t.sam, { direction: 'inbound', name: 'in', agentId: id, events: [], allowPrivateNetwork: false })
    const body = JSON.stringify({ text: 'c@d.co' })
    const bad = await fetch(`${base}/v1/hooks/${hookId}`, { method: 'POST', headers: { 'x-relay-signature': 'sha256=deadbeef' }, body })
    expect(bad.status).toBe(403)
    const good = await fetch(`${base}/v1/hooks/${hookId}`, { method: 'POST', headers: { 'x-relay-signature': sign(secret, body) }, body })
    expect(good.status).toBe(202)
    await t.relay.api.stop()
  })
})

describe('secret redaction', () => {
  it('masks registered secrets and common key formats in logs', () => {
    registerSecret('super-secret-value-123')
    expect(redactString('token super-secret-value-123 and sk-ant-abcdefghijklmnop and Bearer abc.def.ghijklmnop')).not.toMatch(/super-secret|sk-ant-abc|abc\.def/)
    const audit = t.ctx.db.all<{ details: string }>("SELECT details FROM audit_events WHERE action = 'integration.added'")
    expect(audit.map((a) => a.details).join(' ')).not.toContain('demo-ticketing-token')
  })
})
