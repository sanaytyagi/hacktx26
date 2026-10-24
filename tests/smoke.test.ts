import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { makeRelay, type TestRelay } from './helpers'

let t: TestRelay
beforeAll(async () => {
  t = await makeRelay()
})
afterAll(() => t.cleanup())

describe('seeded workspace', () => {
  it('seeds personas, collections, tools and templates', async () => {
    const s = await t.ipc<{ personas: unknown[] }>('u_alex', 'session.get')
    expect(s.ok).toBe(true)
    if (s.ok) expect(s.data.personas).toHaveLength(3)
    const cols = await t.ipc<{ name: string }[]>('u_alex', 'data.collections')
    expect(cols.ok && cols.data.map((c) => c.name)).toContain('Incident history (Operations)')
    const agents = await t.ipc<{ name: string; isTemplate: boolean }[]>('u_alex', 'agents.list')
    expect(agents.ok && agents.data.filter((a) => a.isTemplate).length).toBeGreaterThanOrEqual(2)
  })

  it('runs the seeded digest agent end to end with local tools', async () => {
    const r = await t.ipc<{ id: string }>('u_alex', 'runs.start', { agentId: 'agt_digest', environment: 'live', inputs: { since: '2025-06-01' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const status = await t.relay.engine.waitFor(r.data.id)
    const run = t.relay.engine.run(r.data.id)
    expect(run.error).toBeNull()
    expect(status).toBe('succeeded')
    const tables = await t.ipc<{ name: string; rows: unknown[] }[]>('u_alex', 'results.tables')
    expect(tables.ok && tables.data.find((x) => x.name === 'Weekly incident digest')?.rows.length).toBeGreaterThan(3)
  })
})
