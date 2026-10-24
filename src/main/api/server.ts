// Optional local HTTP API. Binds to 127.0.0.1 only, requires a per-launch bearer secret (or a
// valid HMAC signature for inbound webhooks), and rejects browser-originated requests.
// External services cannot reach this endpoint unless an administrator sets up a gateway/tunnel.
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import type { RunEngine } from '../engine/runner'
import { getSetting } from '../core/settings'
import { actorFor } from '../core/authz'
import { audit } from '../core/audit'
import { RelayError } from '../core/errors'
import { j } from '../db/database'
import { roleHas } from '@shared/permissions'
import { verifyInbound } from '../services/webhooks'
import { invokeRegisteredModel } from '../services/models'

export interface ApiConfig {
  enabled: boolean
  port: number
  modelInference: boolean
}

const DEFAULT: ApiConfig = { enabled: false, port: 47821, modelInference: false }

export class ApiServer {
  private server: http.Server | null = null
  readonly secret = randomBytes(32).toString('hex')
  private boundPort: number | null = null
  private lastError: string | null = null

  constructor(
    private ctx: AppContext,
    private engine: RunEngine
  ) {}

  config(): ApiConfig {
    return { ...DEFAULT, ...getSetting<Partial<ApiConfig>>(this.ctx, 'api', {}) }
  }

  info(actor: Actor) {
    const c = this.config()
    const canSeeSecret = roleHas(actor.role, 'policies.edit') || !!this.ctx.db.get('SELECT 1 FROM api_triggers t JOIN agents a ON a.id = t.agent_id WHERE a.owner_id = ? AND t.enabled = 1', actor.id)
    return {
      ...c,
      running: !!this.server && this.boundPort !== null,
      url: this.boundPort ? `http://127.0.0.1:${this.boundPort}` : null,
      secret: c.enabled && canSeeSecret ? this.secret : null,
      error: this.lastError,
      note: 'The secret changes every time Relay starts. Only programs on this computer can reach this address.'
    }
  }

  async apply() {
    await this.stop()
    const c = this.config()
    if (!c.enabled) return
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, 500, { error: (e as Error).message })))
    await new Promise<void>((resolve) => {
      this.server!.once('error', (e) => {
        this.lastError = `Could not listen on port ${c.port}: ${(e as Error).message}`
        this.server = null
        this.boundPort = null
        resolve()
      })
      this.server!.listen(c.port, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : c.port
        this.lastError = null
        resolve()
      })
    })
  }

  async stop() {
    if (!this.server) return
    await new Promise<void>((r) => this.server!.close(() => r()))
    this.server = null
    this.boundPort = null
  }

  port() {
    return this.boundPort
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  private authorized(req: http.IncomingMessage) {
    const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
    const want = Buffer.from(this.secret)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  private async body(req: http.IncomingMessage): Promise<string> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 1_000_000) throw new RelayError('invalid', 'Request body too large')
      chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = (req.headers.host ?? '').split(':')[0]
    if (host !== '127.0.0.1' && host !== 'localhost') return this.send(res, 403, { error: 'Invalid Host header' })
    if (req.headers.origin) return this.send(res, 403, { error: 'Browser requests are not accepted' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      // Inbound webhooks authenticate with an HMAC signature of the raw body.
      if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'hooks' && parts[2]) {
        const raw = await this.body(req)
        const hook = verifyInbound(this.ctx, parts[2], raw, req.headers['x-relay-signature'] as string | undefined)
        const owner = this.ctx.db.get<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = ?', hook.agent_id)
        if (!owner) return this.send(res, 404, { error: 'Agent not found' })
        const inputs = z.record(z.string(), z.unknown()).parse(JSON.parse(raw || '{}'))
        const runId = this.engine.start(actorFor(this.ctx, owner.owner_id), { agentId: hook.agent_id!, environment: 'live', inputs, trigger: 'webhook' })
        audit(this.ctx, null, 'webhook.received', { type: 'webhook', id: hook.id }, { runId })
        return this.send(res, 202, { runId })
      }
      if (!this.authorized(req)) return this.send(res, 401, { error: 'Missing or invalid bearer secret' })
      if (req.method === 'GET' && url.pathname === '/v1/health') return this.send(res, 200, { ok: true })
      if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'runs') {
        const agentId = parts[2]
        const trig = this.ctx.db.get<{ enabled: number }>('SELECT enabled FROM api_triggers WHERE agent_id = ?', agentId)
        if (!trig?.enabled) return this.send(res, 403, { error: 'API trigger is not enabled for this agent' })
        const owner = this.ctx.db.get<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = ?', agentId)!
        const body = z.object({ inputs: z.record(z.string(), z.unknown()).default({}) }).parse(JSON.parse((await this.body(req)) || '{}'))
        const runId = this.engine.start(actorFor(this.ctx, owner.owner_id), { agentId, environment: 'live', inputs: body.inputs, trigger: 'api' })
        return this.send(res, 202, { runId })
      }
      if (req.method === 'GET' && parts[1] === 'runs' && parts[2]) {
        const r = this.ctx.db.get<{ status: string; outputs: string | null; error: string | null; agent_id: string; trigger: string }>('SELECT status, outputs, error, agent_id, trigger FROM runs WHERE id = ?', parts[2])
        if (!r || !this.ctx.db.get('SELECT 1 FROM api_triggers WHERE agent_id = ? AND enabled = 1', r.agent_id)) return this.send(res, 404, { error: 'Not found' })
        return this.send(res, 200, { status: r.status, outputs: j(r.outputs, null), error: r.error })
      }
      if (req.method === 'POST' && parts[1] === 'models' && parts[3] === 'predict') {
        if (!this.config().modelInference) return this.send(res, 403, { error: 'Model inference over the local API is disabled' })
        const name = decodeURIComponent(parts[2])
        const m = this.ctx.db.get<{ activated_by: string }>("SELECT activated_by FROM models WHERE name = ? AND status = 'active'", name)
        if (!m) return this.send(res, 404, { error: 'No active model with that name' })
        const body = z.object({ text: z.string().optional(), texts: z.array(z.string()).max(256).optional() }).parse(JSON.parse((await this.body(req)) || '{}'))
        return this.send(res, 200, await invokeRegisteredModel(this.ctx, actorFor(this.ctx, m.activated_by), name, body))
      }
      return this.send(res, 404, { error: 'Not found' })
    } catch (e) {
      const err = e as RelayError
      const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : err.code === 'invalid' || e instanceof z.ZodError || e instanceof SyntaxError ? 400 : err.code === 'conflict' || err.code === 'policy' ? 409 : 500
      return this.send(res, status, { error: err.message })
    }
  }
}
