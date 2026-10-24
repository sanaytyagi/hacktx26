import { join } from 'node:path'
import { Db } from './db/database'
import { makePaths, type AppContext, type PushEvent, type SecretBox } from './core/context'
import { PythonWorker } from './python/worker'
import { RunEngine } from './engine/runner'
import { Scheduler } from './services/scheduler'
import { ApiServer } from './api/server'
import { registerCoreApprovalHandlers } from './services/approvals'
import { registerTrainingApprovalHandler, recoverTrainingJobs } from './services/training'
import { registerImprovementApprovalHandler } from './services/improvements'
import { syncBuiltinTools } from './tools/registry'
import { closeMcp } from './tools/integrations'
import { seedWorkspace } from './db/seed'
import { applyRetention } from './services/admin'

export interface RelayOptions {
  dataDir: string
  resourcesDir: string
  pythonDir: string
  appRoot?: string
  secrets: SecretBox
  emit?: (e: PushEvent) => void
  seed?: boolean
  schedulerTickMs?: number
}

export type Relay = Awaited<ReturnType<typeof createRelay>>

export async function createRelay(opts: RelayOptions) {
  const paths = makePaths(opts.dataDir)
  const db = new Db(paths.db)
  const python = new PythonWorker({
    pythonDir: opts.pythonDir,
    venvDirs: [join(opts.dataDir, '..', 'python-venv')],
    env: { HF_HOME: process.env.RELAY_HF_HOME || paths.hfCache, TOKENIZERS_PARALLELISM: 'false', HF_HUB_DISABLE_TELEMETRY: '1' }
  })
  const listeners = new Set<(e: PushEvent) => void>()
  if (opts.emit) listeners.add(opts.emit)
  const ctx: AppContext = { db, paths, secrets: opts.secrets, python, resourcesDir: opts.resourcesDir, appRoot: opts.appRoot ?? process.cwd(), events: { emit: (e) => listeners.forEach((l) => l(e)) } }
  registerCoreApprovalHandlers()
  registerTrainingApprovalHandler()
  registerImprovementApprovalHandler()
  if (opts.seed !== false) await seedWorkspace(ctx)
  syncBuiltinTools(ctx)
  recoverTrainingJobs(ctx)
  const engine = new RunEngine(ctx)
  const scheduler = new Scheduler(ctx, engine, opts.schedulerTickMs)
  const api = new ApiServer(ctx, engine)
  let retentionTimer: NodeJS.Timeout | null = null
  return {
    ctx,
    engine,
    scheduler,
    api,
    python,
    onEvent(l: (e: PushEvent) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async start() {
      engine.recover()
      scheduler.start()
      await api.apply()
      applyRetention(ctx, null)
      retentionTimer = setInterval(() => applyRetention(ctx, null), 24 * 3600_000)
    },
    async stop() {
      if (retentionTimer) clearInterval(retentionTimer)
      scheduler.stop()
      engine.shutdown()
      await api.stop()
      closeMcp()
      python.stop()
      db.close()
    }
  }
}
