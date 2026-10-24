import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRelay } from '../src/main/bootstrap'
import { actorFor } from '../src/main/core/authz'
import type { SecretBox } from '../src/main/core/context'
import { seedIds } from '../src/main/db/seed'
import { dispatch, type Services } from '../src/main/ipc/router'
import { setSetting } from '../src/main/core/settings'

export const testSecrets: SecretBox = {
  kind: 'plaintext_fallback',
  encrypt: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decrypt: (b) => b.toString('utf8').replace(/^enc:/, '')
}

export async function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  const relay = await createRelay({ dataDir: dir, resourcesDir: resolve('resources'), pythonDir: resolve('python'), secrets: testSecrets })
  const ctx = relay.ctx
  const services: Services = {
    ctx,
    engine: relay.engine,
    api: relay.api,
    python: relay.python,
    platform: new Proxy({} as Services['platform'], { get: () => () => { throw new Error('platform hook not available in tests') } })
  }
  return {
    relay,
    ctx,
    ids: seedIds(ctx),
    alex: actorFor(ctx, 'u_alex'),
    priya: actorFor(ctx, 'u_priya'),
    sam: actorFor(ctx, 'u_sam'),
    omar: actorFor(ctx, 'u_omar'),
    mei: actorFor(ctx, 'u_mei'),
    /** Call an IPC method as a persona, exactly like the renderer does. */
    async ipc<T = unknown>(persona: string, method: string, input: unknown = {}) {
      setSetting(ctx, 'persona', persona)
      return (await dispatch(services, method, input)) as { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
    },
    async cleanup() {
      await relay.stop().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export type TestRelay = Awaited<ReturnType<typeof makeRelay>>
