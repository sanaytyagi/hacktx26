import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeRelay, type TestRelay } from './helpers'
import { ROLE_CAPABILITIES, roleHas } from '../src/shared/permissions'
import { invokeTool } from '../src/main/tools/registry'
import { prepareDataset } from '../src/main/services/training'
import { checkCollectionUse } from '../src/main/core/authz'
import { newId } from '../src/main/db/database'
import type { Actor } from '../src/main/core/context'

let t: TestRelay
beforeAll(async () => {
  t = await makeRelay()
})
afterAll(() => t.cleanup())

function tc(actor: Actor, allowed: string[] | null = null) {
  return {
    ctx: t.ctx,
    actor,
    runId: null,
    agentId: null,
    teamId: actor.teamId,
    allowedCollections: allowed,
    idempotencyKey: newId('t'),
    inputTaint: [],
    signal: new AbortController().signal,
    environment: 'test' as const,
    log: () => undefined
  }
}

describe('permission matrix', () => {
  it('gives each role the documented capabilities only', () => {
    expect(roleHas('employee', 'data.administer')).toBe(false)
    expect(roleHas('employee', 'approvals.decide_team')).toBe(false)
    expect(roleHas('manager', 'approvals.decide_team')).toBe(true)
    expect(roleHas('manager', 'data.administer')).toBe(false)
    expect(roleHas('manager', 'policies.edit')).toBe(false)
    expect(roleHas('admin', 'policies.edit')).toBe(true)
    // A manager title grants no data access by itself: no capability implies reading collections.
    expect(ROLE_CAPABILITIES.manager.some((c) => c.startsWith('data.read'))).toBe(false)
  })

  it('enforces role checks in the service layer, not just the UI', async () => {
    const r = await t.ipc('u_alex', 'settings.updatePolicy', { policy: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('forbidden')
    const s = await t.ipc('u_alex', 'data.sources')
    expect(!s.ok && s.error.code).toBe('forbidden')
    const p = await t.ipc('u_priya', 'providers.upsert', { kind: 'anthropic', name: 'x', models: ['m'] })
    expect(!p.ok && p.error.code).toBe('forbidden')
  })
})

describe('employee cannot reach restricted data', () => {
  it('does not list the restricted collection', async () => {
    const r = await t.ipc<{ id: string }[]>('u_alex', 'data.collections')
    expect(r.ok && r.data.map((c) => c.id)).not.toContain(t.ids.cPostmortems)
  })

  it('refuses preview, search and detail over IPC', async () => {
    const preview = await t.ipc('u_alex', 'data.preview', { id: t.ids.cPostmortems })
    expect(!preview.ok && preview.error.code).toBe('forbidden')
    const search = await t.ipc('u_alex', 'data.search', { collectionIds: [t.ids.cPostmortems], query: 'credential token' })
    expect(!search.ok && search.error.code).toBe('forbidden')
    const detail = await t.ipc('u_alex', 'data.collection', { id: t.ids.cPostmortems })
    expect(!detail.ok && detail.error.code).toBe('not_found')
  })

  it('refuses through tools even if an agent lists the collection', async () => {
    await expect(invokeTool(t.ctx, 'docs.search', { query: 'credential', collectionIds: [t.ids.cPostmortems] }, tc(t.alex, [t.ids.cPostmortems]))).rejects.toThrow(/do not have retrieval access/)
    await expect(invokeTool(t.ctx, 'docs.read', { collectionId: t.ids.cPostmortems, path: 'pm-2025-06-phishing.md' }, tc(t.alex, [t.ids.cPostmortems]))).rejects.toThrow(/access/)
    await expect(invokeTool(t.ctx, 'data.query', { collectionId: t.ids.cTickets, query: { limit: 5 } }, tc(t.alex, [t.ids.cTickets]))).rejects.toThrow(/access/)
  })

  it('refuses exports and training without those purposes', async () => {
    const exp = await t.ipc('u_alex', 'data.export', { id: t.ids.cIncidents, format: 'csv' })
    expect(!exp.ok && exp.error.code).toBe('forbidden')
    await expect(
      prepareDataset(t.ctx, { ...t.alex, role: 'manager' }, {
        collectionId: t.ids.cIncidents,
        name: 'x',
        config: { textFields: ['description'], labelField: 'category', excludedFields: [], labelMap: {}, dropLabels: [], split: { strategy: 'random', train: 0.7, validation: 0.15, seed: 1 }, minExamplesPerLabel: 5 },
        maskPersonalData: true,
        allowSensitiveFields: false
      })
    ).rejects.toThrow(/training access/)
  })

  it('blocks exporting an output table that contains data from a collection the person may not export', async () => {
    // Alex can read incidents but has no export purpose.
    const write = await invokeTool(t.ctx, 'table.write', { table: 'Leak test', row: { a: 1 } }, { ...tc(t.alex, [t.ids.cIncidents]), inputTaint: [t.ids.cIncidents] })
    expect(write.output).toMatchObject({ inserted: 1 })
    await expect(invokeTool(t.ctx, 'table.export', { table: 'Leak test', format: 'csv' }, tc(t.alex))).rejects.toThrow(/Export blocked/)
  })

  it('administrators are not exempt from grants when using data', () => {
    expect(checkCollectionUse(t.ctx, t.sam, t.ids.cTickets, 'retrieval').allowed).toBe(false)
  })
})

describe('manager delegation limits', () => {
  const grant = (persona: string, input: Record<string, unknown>) => t.ipc(persona, 'data.grant', { canDelegate: false, note: '', ...input })

  it('lets a manager delegate what they hold, within their team', async () => {
    const r = await grant('u_priya', { collectionId: t.ids.cVendors, principalType: 'user', principalId: 'u_alex', purposes: ['retrieval'] })
    expect(r.ok).toBe(true)
    expect(checkCollectionUse(t.ctx, t.alex, t.ids.cVendors, 'retrieval').allowed).toBe(true)
  })

  it('refuses grants to people outside the team', async () => {
    const r = await grant('u_priya', { collectionId: t.ids.cVendors, principalType: 'user', principalId: 'u_mei', purposes: ['retrieval'] })
    expect(!r.ok && r.error.message).toMatch(/own team/)
  })

  it('refuses collections and purposes the manager cannot delegate', async () => {
    const other = await grant('u_priya', { collectionId: t.ids.cTickets, principalType: 'user', principalId: 'u_alex', purposes: ['retrieval'] })
    expect(!other.ok && other.error.code).toBe('forbidden')
    const notHeld = await grant('u_priya', { collectionId: t.ids.cServices, principalType: 'user', principalId: 'u_alex', purposes: ['analysis'] })
    expect(!notHeld.ok && notHeld.error.code).toBe('forbidden')
    const redelegate = await grant('u_priya', { collectionId: t.ids.cIncidents, principalType: 'user', principalId: 'u_omar', purposes: ['training'], canDelegate: true })
    expect(!redelegate.ok && redelegate.error.message).toMatch(/administrators/)
  })

  it('refuses employees granting at all', async () => {
    const r = await grant('u_alex', { collectionId: t.ids.cProcedures, principalType: 'user', principalId: 'u_omar', purposes: ['retrieval'] })
    expect(!r.ok && r.error.code).toBe('forbidden')
  })

  it('does not let a manager approve a data request beyond their authority', async () => {
    const list = await t.ipc<{ id: string; canDecide: boolean; cannotDecideReason: string }[]>('u_priya', 'approvals.list')
    const fixture = list.ok ? list.data.find((a) => a.id === 'apr_fixture_1') : undefined
    expect(fixture?.canDecide).toBe(false)
    expect(fixture?.cannotDecideReason).toMatch(/administrator/)
    const d = await t.ipc('u_priya', 'approvals.decide', { id: 'apr_fixture_1', decision: 'approve' })
    expect(!d.ok && d.error.code).toBe('forbidden')
  })

  it('revocation blocks future reads immediately', async () => {
    const g = await t.ipc<{ id: string }>('u_sam', 'data.grant', { collectionId: t.ids.cProcedures, principalType: 'user', principalId: 'u_mei', purposes: ['export'], canDelegate: false, note: '' })
    expect(g.ok).toBe(true)
    expect(checkCollectionUse(t.ctx, t.mei, t.ids.cProcedures, 'export').allowed).toBe(true)
    if (g.ok) await t.ipc('u_sam', 'data.revoke', { id: g.data.id })
    expect(checkCollectionUse(t.ctx, t.mei, t.ids.cProcedures, 'export').allowed).toBe(false)
  })
})

describe('row filters and column limits apply before data is returned', () => {
  it('hides excluded columns and filtered rows from previews and queries', async () => {
    const p = await t.ipc<{ kind: string; columns: string[]; rows: Record<string, unknown>[] }>('u_alex', 'data.preview', { id: t.ids.cServices, limit: 200 })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.data.columns).not.toContain('oncall_email')
    expect(p.data.rows.every((r) => r.tier !== 'decommissioned')).toBe(true)
    await expect(invokeTool(t.ctx, 'data.query', { collectionId: t.ids.cServices, query: { columns: ['oncall_email'] } }, tc(t.alex, [t.ids.cServices]))).rejects.toThrow(/not available/)
  })
})
