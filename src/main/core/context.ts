import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/database'
import type { Role } from '@shared/permissions'
import type { PythonWorker } from '../python/worker'

export interface Paths {
  root: string
  db: string
  recordings: string
  sources: string
  datasets: string
  exports: string
  models: string
  jobs: string
  plugins: string
  hfCache: string
  tmp: string
}

export function makePaths(root: string): Paths {
  const p: Paths = {
    root,
    db: join(root, 'relay.sqlite'),
    recordings: join(root, 'recordings'),
    sources: join(root, 'sources'),
    datasets: join(root, 'datasets'),
    exports: join(root, 'exports'),
    models: join(root, 'models'),
    jobs: join(root, 'jobs'),
    plugins: join(root, 'plugins'),
    hfCache: join(root, 'hf-cache'),
    tmp: join(root, 'tmp')
  }
  for (const [k, v] of Object.entries(p)) if (k !== 'db') mkdirSync(v, { recursive: true })
  return p
}

/** Encrypts secrets at rest. In Electron this is backed by safeStorage (OS keychain). */
export interface SecretBox {
  readonly kind: 'os_keychain' | 'plaintext_fallback'
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

export type PushEvent =
  | { type: 'run.updated'; runId: string; agentId: string; status: string }
  | { type: 'run.event'; runId: string; event: unknown }
  | { type: 'job.updated'; jobId: string; status: string; progress: number; phase: string }
  | { type: 'job.event'; jobId: string; event: unknown }
  | { type: 'notification'; userId: string }
  | { type: 'approvals.changed' }
  | { type: 'data.changed' }
  | { type: 'tools.changed' }

export interface EventBus {
  emit(e: PushEvent): void
}

export interface AppContext {
  db: Db
  paths: Paths
  secrets: SecretBox
  events: EventBus
  python: PythonWorker
  /** Directory with bundled resources (seed data, example plugin, python worker). */
  resourcesDir: string
  /** Application root (contains node_modules); used by bundled example integrations. */
  appRoot: string
}

export interface Actor {
  id: string
  name: string
  role: Role
  teamId: string | null
}
