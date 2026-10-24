import { z } from 'zod'
import type { AppContext, Actor } from '../core/context'
import type { RunEngine } from '../engine/runner'
import { StartRunSchema } from '../engine/runner'
import { RelayError } from '../core/errors'
import { audit } from '../core/audit'
import { actorFor } from '../core/authz'
import { getSetting, setSetting } from '../core/settings'
import { roleHas } from '@shared/permissions'
import { AgentSpecSchema, CollectionSelectionSchema, ScheduleSchema, WorkflowDraftSchema, TrainingConfigSchema } from '@shared/domain'
import * as data from '../services/data'
import * as creds from '../services/credentials'
import * as providers from '../services/providers'
import * as budget from '../services/budget'
import * as agents from '../services/agents'
import * as approvals from '../services/approvals'
import * as workflows from '../services/workflows'
import * as runs from '../services/runs'
import * as admin from '../services/admin'
import * as training from '../services/training'
import * as models from '../services/models'
import * as improvements from '../services/improvements'
import * as webhooks from '../services/webhooks'
import * as registry from '../tools/registry'
import * as integrations from '../tools/integrations'
import type { ApiServer } from '../api/server'
import type { PythonWorker } from '../python/worker'

export interface Services {
  ctx: AppContext
  engine: RunEngine
  api: ApiServer
  python: PythonWorker
  platform: PlatformHooks
}

/** Electron-specific capabilities, injected so the router stays testable. */
export interface PlatformHooks {
  openFile(opts: { title: string; filters?: { name: string; extensions: string[] }[]; directory?: boolean }): Promise<string | null>
  revealPath(path: string): void
  captureSources(): Promise<{ id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }[]>
  selectCaptureSource(id: string | null): void
  screenPermission(): { status: string; platform: string }
  openScreenSettings(): void
  showRecordingHud(show: boolean): void
  hudCommand(command: 'stop' | 'cancel'): void
  relaunchAfterReset(): void
  appInfo(): { version: string; dataDir: string; platform: string; electron: string }
}

type Handler<S extends z.ZodTypeAny, R> = { input: S; run: (input: z.output<S>, actor: Actor, s: Services) => R | Promise<R> }
const h = <S extends z.ZodTypeAny, R>(input: S, run: (input: z.output<S>, actor: Actor, s: Services) => R | Promise<R>): Handler<S, R> => ({ input, run })
const none = z.object({}).default({})
const idIn = z.object({ id: z.string() })

export const handlers = {
  // ---------------- Session & personas ----------------
  'session.get': h(none, (_i, actor, s) => admin.session(s.ctx, actor)),
  'session.switchPersona': h(z.object({ userId: z.string() }), (i, actor, s) => {
    const u = s.ctx.db.get<{ switchable: number }>('SELECT switchable FROM users WHERE id = ?', i.userId)
    if (!u?.switchable) throw new RelayError('invalid', 'Not a demo persona.')
    setSetting(s.ctx, 'persona', i.userId)
    audit(s.ctx, actor, 'persona.switched', { type: 'user', id: i.userId }, { note: 'Local demo persona switch (not authentication)' })
    return admin.session(s.ctx, actorFor(s.ctx, i.userId))
  }),
  'home.get': h(none, (_i, a, s) => admin.home(s.ctx, a)),
  'directory.get': h(none, (_i, _a, s) => data.directory(s.ctx)),
  'notifications.list': h(none, (_i, a, s) => admin.listNotifications(s.ctx, a)),
  'notifications.markRead': h(z.object({ ids: z.union([z.array(z.string()), z.literal('all')]) }), (i, a, s) => admin.markNotificationsRead(s.ctx, a, i.ids)),
  'app.info': h(none, (_i, _a, s) => ({ ...s.platform.appInfo(), python: s.python.pythonPath })),
  'app.pythonStatus': h(none, async (_i, _a, s) => {
    try {
      return { ok: true as const, env: await s.python.call<Record<string, unknown>>('env_check', {}, { timeoutMs: 60_000 }) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, stderr: s.python.stderr() }
    }
  }),
  'app.openFile': h(z.object({ title: z.string(), kind: z.enum(['video', 'data', 'folder', 'spec', 'any']) }), (i, _a, s) =>
    s.platform.openFile({
      title: i.title,
      directory: i.kind === 'folder',
      filters:
        i.kind === 'video'
          ? [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v'] }]
          : i.kind === 'data'
            ? [{ name: 'Data files', extensions: ['csv', 'json', 'jsonl', 'ndjson', 'txt', 'md', 'pdf', 'sqlite', 'db', 'sqlite3'] }]
            : i.kind === 'spec'
              ? [{ name: 'OpenAPI', extensions: ['yaml', 'yml', 'json'] }]
              : undefined
    })
  ),
  'app.reveal': h(z.object({ path: z.string() }), (i, a, s) => {
    if (!i.path.startsWith(s.ctx.paths.root)) throw new RelayError('forbidden', 'Only files inside Relay’s data folder can be revealed.')
    if (i.path.startsWith(s.ctx.paths.exports) && !i.path.includes(a.id) && !roleHas(a.role, 'retention.manage')) throw new RelayError('forbidden', 'Not your export.')
    s.platform.revealPath(i.path)
  }),
  'app.resetWorkspace': h(z.object({ confirm: z.literal('RESET') }), (_i, a, s) => {
    if (!roleHas(a.role, 'workspace.reset')) throw new RelayError('forbidden', 'Only an administrator can reset the demo workspace.')
    s.platform.relaunchAfterReset()
  }),

  // ---------------- Data ----------------
  'data.sources': h(none, (_i, a, s) => data.listSources(s.ctx, a)),
  'data.addSource': h(z.object({ path: z.string().min(1), name: z.string().optional() }), (i, a, s) => data.addSource(s.ctx, a, i)),
  'data.refreshSource': h(idIn, (i, a, s) => data.refreshSource(s.ctx, a, i.id)),
  'data.describeSource': h(idIn, (i, a, s) => data.describeSourceForAdmin(s.ctx, a, i.id)),
  'data.previewSelection': h(z.object({ sourceId: z.string(), selection: CollectionSelectionSchema }), (i, a, s) => data.previewSelection(s.ctx, a, i.sourceId, i.selection)),
  'data.collections': h(none, (_i, a, s) => data.listCollections(s.ctx, a)),
  'data.collection': h(idIn, (i, a, s) => data.getCollectionDetail(s.ctx, a, i.id)),
  'data.createCollection': h(data.CollectionInputSchema, (i, a, s) => data.createCollection(s.ctx, a, i)),
  'data.updateCollection': h(
    z.object({ id: z.string(), patch: data.CollectionInputSchema.pick({ name: true, description: true, selection: true, purposes: true, allowExternal: true, visibility: true, sensitivity: true }).partial().extend({ status: z.enum(['published', 'retired']).optional() }) }),
    (i, a, s) => data.updateCollection(s.ctx, a, i.id, i.patch)
  ),
  'data.preview': h(z.object({ id: z.string(), limit: z.number().int().min(1).max(200).default(50) }), (i, a, s) => data.previewCollection(s.ctx, a, i.id, i.limit)),
  'data.search': h(z.object({ collectionIds: z.array(z.string()).min(1), query: z.string().min(1).max(300) }), (i, a, s) => data.searchDocuments(s.ctx, a, i.collectionIds, i.query, 10, 'ui:search')),
  'data.export': h(z.object({ id: z.string(), format: z.enum(['csv', 'json']) }), (i, a, s) => data.exportCollection(s.ctx, a, i.id, i.format)),
  'data.grant': h(data.GrantInputSchema, (i, a, s) => data.grantAccess(s.ctx, a, i)),
  'data.revoke': h(idIn, (i, a, s) => data.revokeGrant(s.ctx, a, i.id)),
  'data.requestAccess': h(approvals.DataAccessRequestSchema, (i, a, s) => approvals.requestDataAccess(s.ctx, a, i)),

  // ---------------- Tools & integrations ----------------
  'tools.catalog': h(none, (_i, a, s) => registry.listCatalog(s.ctx, a)),
  'tools.versions': h(z.object({ key: z.string() }), (i, _a, s) => registry.toolVersions(s.ctx, i.key)),
  'tools.requestAccess': h(z.object({ toolKey: z.string(), reason: z.string().min(3).max(1000) }), (i, a, s) => approvals.requestToolAccess(s.ctx, a, i)),
  'tools.grant': h(registry.ToolGrantSchema, (i, a, s) => registry.grantTool(s.ctx, a, i)),
  'tools.revokeGrant': h(idIn, (i, a, s) => registry.revokeToolGrant(s.ctx, a, i.id)),
  'tools.setEnabled': h(z.object({ key: z.string(), enabled: z.boolean() }), (i, a, s) => registry.setToolEnabled(s.ctx, a, i.key, i.enabled)),
  'tools.test': h(z.object({ key: z.string(), args: z.record(z.string(), z.unknown()), confirmSideEffects: z.boolean().default(false) }), (i, a, s) => registry.testTool(s.ctx, a, i)),
  'tools.integrations': h(none, (_i, a, s) => registry.listIntegrations(s.ctx, a)),
  'tools.checkHealth': h(z.object({ integrationId: z.string().optional() }), (i, a, s) => registry.checkHealth(s.ctx, a, i.integrationId)),
  'tools.addHttpTool': h(integrations.HttpToolInputSchema, (i, a, s) => integrations.addHttpTool(s.ctx, a, i)),
  'tools.parseOpenApi': h(z.object({ specText: z.string().min(10).max(5_000_000) }), (i, a, s) => {
    if (!roleHas(a.role, 'tools.administer')) throw new RelayError('forbidden', 'Only administrators import API specifications.')
    return integrations.parseOpenApi(i.specText)
  }),
  'tools.readSpecFile': h(z.object({ path: z.string() }), (i, a) => {
    if (!roleHas(a.role, 'tools.administer')) throw new RelayError('forbidden', 'Only administrators import API specifications.')
    return integrations.readSpecFile(i.path)
  }),
  'tools.importOpenApi': h(integrations.OpenApiImportSchema, (i, a, s) => integrations.importOpenApi(s.ctx, a, i)),
  'tools.addMcp': h(z.object({ name: z.string().min(1).max(100), config: integrations.McpConfigSchema, secret: z.string().optional() }), (i, a, s) => {
    if (!roleHas(a.role, 'tools.administer')) throw new RelayError('forbidden', 'Only administrators add MCP servers.')
    const id = `int_${Date.now().toString(36)}`
    let credentialId: string | null = null
    if (i.secret) credentialId = creds.storeCredential(s.ctx, a, { name: `${i.name} token`, kind: 'bearer', service: 'mcp', secret: i.secret })
    s.ctx.db.insert('integrations', { id, kind: 'mcp', name: i.name, config: JSON.stringify(i.config), credential_id: credentialId, status: 'not_checked', status_detail: '', discovered: '[]', created_by: a.id, created_at: new Date().toISOString() })
    audit(s.ctx, a, 'integration.added', { type: 'integration', id }, { kind: 'mcp', name: i.name, transport: i.config.transport })
    return { id }
  }),
  'tools.discoverMcp': h(idIn, (i, a, s) => integrations.discoverMcp(s.ctx, a, i.id)),
  'tools.registerMcpTools': h(integrations.McpRegisterSchema, (i, a, s) => integrations.registerMcpTools(s.ctx, a, i)),
  'tools.inspectPlugin': h(z.object({ dir: z.string() }), (i, a, s) => {
    if (!roleHas(a.role, 'tools.administer')) throw new RelayError('forbidden', 'Only administrators install plugins.')
    return integrations.inspectPlugin(s.ctx, i.dir.replace('${RESOURCES}', s.ctx.resourcesDir))
  }),
  'tools.registerPlugin': h(integrations.PluginRegisterSchema, (i, a, s) => integrations.registerPlugin(s.ctx, a, i)),
  'tools.webhooks': h(none, (_i, a, s) => webhooks.listWebhooks(s.ctx, a)),
  'tools.createWebhook': h(webhooks.WebhookInputSchema, (i, a, s) => webhooks.createWebhook(s.ctx, a, i)),
  'tools.deleteWebhook': h(idIn, (i, a, s) => webhooks.deleteWebhook(s.ctx, a, i.id)),

  // ---------------- Providers, credentials, policies ----------------
  'providers.list': h(none, (_i, a, s) => providers.listProviders(s.ctx, a)),
  'providers.upsert': h(providers.ProviderInputSchema, (i, a, s) => providers.upsertProvider(s.ctx, a, i)),
  'providers.check': h(idIn, (i, a, s) => providers.checkProvider(s.ctx, a, i.id)),
  'credentials.list': h(none, (_i, a, s) => creds.listCredentials(s.ctx, a)),
  'credentials.delete': h(idIn, (i, a, s) => creds.deleteCredential(s.ctx, a, i.id)),
  'credentials.setSerpApi': h(z.object({ apiKey: z.string().min(8).max(500) }), (i, a, s) => {
    const id = creds.storeCredential(s.ctx, a, { name: 'SerpApi key', kind: 'api_key', service: 'serpapi', secret: i.apiKey }, getSetting<string | null>(s.ctx, 'serpapi_credential_id', null) ?? undefined)
    setSetting(s.ctx, 'serpapi_credential_id', id)
    return { id }
  }),
  'settings.get': h(none, (_i, a, s) => ({ ...admin.getSettingsView(s.ctx, a), api: s.api.info(a), serpApiConfigured: creds.hasCredential(s.ctx, getSetting<string | null>(s.ctx, 'serpapi_credential_id', null)) })),
  'settings.updatePolicy': h(z.object({ policy: z.unknown() }), (i, a, s) => admin.updatePolicy(s.ctx, a, i.policy as never)),
  'settings.setApi': h(z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535), modelInference: z.boolean() }), async (i, a, s) => {
    if (!roleHas(a.role, 'policies.edit')) throw new RelayError('forbidden', 'Only an administrator can configure the local API.')
    setSetting(s.ctx, 'api', i)
    await s.api.apply()
    audit(s.ctx, a, 'api.configured', {}, i)
    return s.api.info(a)
  }),
  'audit.list': h(z.object({ action: z.string().optional(), limit: z.number().int().max(1000).optional() }), (i, a, s) => admin.listAudit(s.ctx, a, i)),
  'retention.report': h(none, (_i, a, s) => admin.storageReport(s.ctx, a)),
  'retention.apply': h(none, (_i, a, s) => admin.applyRetention(s.ctx, a)),
  'retention.delete': h(z.object({ kind: z.enum(['export', 'dataset', 'run_history', 'model_files']), id: z.string() }), (i, a, s) => admin.deleteArtifact(s.ctx, a, i.kind, i.id)),

  // ---------------- Budget ----------------
  'budget.overview': h(none, (_i, a, s) => budget.budgetOverview(s.ctx, a)),
  'budget.upsert': h(budget.BudgetInputSchema, (i, a, s) => budget.upsertBudget(s.ctx, a, i)),
  'budget.upsertPrice': h(budget.PriceInputSchema, (i, a, s) => budget.upsertPrice(s.ctx, a, i)),
  'budget.requestIncrease': h(z.object({ budgetId: z.string(), newLimitUsd: z.number().positive().max(100000), reason: z.string().min(3).max(1000) }), (i, a, s) => approvals.requestBudgetIncrease(s.ctx, a, i)),

  // ---------------- Approvals ----------------
  'approvals.list': h(none, (_i, a, s) => approvals.listApprovals(s.ctx, a)),
  'approvals.decide': h(z.object({ id: z.string(), decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).default('') }), (i, a, s) => approvals.decide(s.ctx, a, i.id, i.decision, i.comment)),
  'approvals.comment': h(z.object({ id: z.string(), body: z.string().min(1).max(2000) }), (i, a, s) => approvals.addComment(s.ctx, a, i.id, i.body)),
  'approvals.withdraw': h(idIn, (i, a, s) => approvals.cancelRequest(s.ctx, a, i.id)),

  // ---------------- Workflows & recordings ----------------
  'capture.permission': h(none, (_i, _a, s) => s.platform.screenPermission()),
  'capture.openSettings': h(none, (_i, _a, s) => s.platform.openScreenSettings()),
  'capture.sources': h(none, (_i, _a, s) => s.platform.captureSources()),
  'capture.select': h(z.object({ id: z.string().nullable() }), (i, _a, s) => s.platform.selectCaptureSource(i.id)),
  'capture.hud': h(z.object({ show: z.boolean() }), (i, _a, s) => s.platform.showRecordingHud(i.show)),
  'capture.hudCommand': h(z.object({ command: z.enum(['stop', 'cancel']) }), (i, _a, s) => s.platform.hudCommand(i.command)),
  'recordings.begin': h(z.object({ mime: z.string() }), (i, a, s) => workflows.beginRecording(s.ctx, a, i.mime)),
  'recordings.append': h(z.object({ sessionId: z.string(), chunk: z.instanceof(Uint8Array) }), (i, a) => workflows.appendRecording(a, i.sessionId, i.chunk)),
  'recordings.finish': h(z.object({ sessionId: z.string(), title: z.string().max(200), durationSec: z.number().nullable(), cancel: z.boolean().default(false) }), (i, a, s) => workflows.finishRecording(s.ctx, a, i.sessionId, i)),
  'recordings.import': h(z.object({ path: z.string(), title: z.string().optional() }), (i, a, s) => workflows.importRecording(s.ctx, a, i)),
  'recordings.setDuration': h(z.object({ id: z.string(), durationSec: z.number().positive() }), (i, a, s) => workflows.setRecordingDuration(s.ctx, a, i.id, i.durationSec)),
  'recordings.delete': h(idIn, (i, a, s) => workflows.deleteRecording(s.ctx, a, i.id)),
  'workflows.list': h(none, (_i, a, s) => workflows.listWorkflows(s.ctx, a)),
  'workflows.create': h(z.object({ recordingId: z.string().nullable().optional(), draft: WorkflowDraftSchema.partial() }), (i, a, s) => workflows.createWorkflow(s.ctx, a, i)),
  'workflows.get': h(idIn, (i, a, s) => workflows.getWorkflow(s.ctx, a, i.id)),
  'workflows.update': h(z.object({ id: z.string(), draft: WorkflowDraftSchema }), (i, a, s) => workflows.updateWorkflow(s.ctx, a, i.id, i.draft)),
  'workflows.analysisPreview': h(idIn, (i, a, s) => workflows.analysisPreview(s.ctx, a, i.id)),
  'workflows.analyze': h(workflows.AnalyzeSchema, (i, a, s) => workflows.analyzeWorkflow(s.ctx, a, i)),
  'workflows.buildSpec': h(z.object({ id: z.string(), choices: z.record(z.string(), z.string().nullable()).default({}) }), (i, a, s) => workflows.buildSpec(s.ctx, a, i.id, i.choices)),
  'workflows.toolOptions': h(z.object({ capability: z.string() }), (i, a, s) => workflows.toolOptionsFor(s.ctx, a, i.capability as never)),

  // ---------------- Agents ----------------
  'agents.list': h(none, (_i, a, s) => agents.listAgents(s.ctx, a)),
  'agents.get': h(idIn, (i, a, s) => agents.getAgent(s.ctx, a, i.id)),
  'agents.create': h(agents.AgentCreateSchema, (i, a, s) => agents.createAgent(s.ctx, a, i)),
  'agents.useTemplate': h(z.object({ templateId: z.string(), name: z.string().optional() }), (i, a, s) => agents.copyTemplate(s.ctx, a, i.templateId, i.name)),
  'agents.save': h(z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional(), spec: AgentSpecSchema, note: z.string().optional() }), (i, a, s) => agents.saveDraft(s.ctx, a, i.id, i)),
  'agents.readiness': h(z.object({ id: z.string(), versionId: z.string().optional(), runConnectionChecks: z.boolean().default(false) }), (i, a, s) => agents.readiness(s.ctx, a, i.id, i)),
  'agents.estimate': h(z.object({ id: z.string(), versionId: z.string().optional() }), (i, _a, s) => s.engine.estimate(i.id, i.versionId)),
  'agents.deploy': h(z.object({ id: z.string(), mode: z.enum(['personal', 'team']), reason: z.string().max(1000).default('') }), (i, a, s) => agents.deployAgent(s.ctx, a, i.id, i.mode, i.reason)),
  'agents.state': h(z.object({ id: z.string(), action: z.enum(['pause', 'resume', 'archive', 'kill_on', 'kill_off']) }), (i, a, s) => agents.setAgentState(s.ctx, a, i.id, i.action, s.engine)),
  'agents.rollback': h(z.object({ id: z.string(), versionId: z.string() }), (i, a, s) => agents.rollback(s.ctx, a, i.id, i.versionId)),
  'agents.restoreDraft': h(z.object({ id: z.string(), versionId: z.string() }), (i, a, s) => agents.restoreDraft(s.ctx, a, i.id, i.versionId)),
  'agents.diff': h(z.object({ id: z.string(), from: z.string(), to: z.string() }), (i, a, s) => agents.versionDiff(s.ctx, a, i.id, i.from, i.to)),
  'agents.settings': h(z.object({ id: z.string(), notifyOnFailure: z.array(z.string()).optional(), ownerId: z.string().optional() }), (i, a, s) => agents.updateAgentSettings(s.ctx, a, i.id, i)),
  'agents.schedule': h(z.object({ id: z.string(), schedule: ScheduleSchema.nullable() }), (i, a, s) => agents.setSchedule(s.ctx, a, i.id, i.schedule)),
  'agents.apiTrigger': h(z.object({ id: z.string(), enabled: z.boolean() }), (i, a, s) => agents.setApiTrigger(s.ctx, a, i.id, i.enabled)),
  'agents.improvements': h(idIn, (i, a, s) => improvements.improvementOverview(s.ctx, a, i.id)),
  'agents.proposeImprovements': h(z.object({ id: z.string(), useModel: z.boolean().default(false) }), (i, a, s) => improvements.generateProposals(s.ctx, a, i.id, i)),
  'agents.evaluateProposal': h(idIn, (i, a, s) => improvements.evaluateProposal(s.ctx, a, s.engine, i.id)),
  'agents.submitProposal': h(z.object({ id: z.string(), reason: z.string().min(3).max(1000) }), (i, a, s) => improvements.submitProposal(s.ctx, a, i.id, i.reason)),
  'agents.dismissProposal': h(idIn, (i, a, s) => improvements.rejectProposal(s.ctx, a, i.id)),
  'agents.setExampleSplit': h(z.object({ id: z.string(), split: z.enum(['holdout', 'improvement']) }), (i, a, s) => improvements.setExampleSplit(s.ctx, a, i.id, i.split)),

  // ---------------- Runs ----------------
  'runs.list': h(z.object({ agentId: z.string().optional(), status: z.string().optional(), limit: z.number().int().max(500).optional() }), (i, a, s) => runs.listRuns(s.ctx, a, i)),
  'runs.get': h(idIn, (i, a, s) => runs.getRun(s.ctx, a, i.id)),
  'runs.start': h(StartRunSchema.pick({ agentId: true, environment: true, inputs: true }), (i, a, s) => ({ id: s.engine.start(a, { ...i, trigger: 'manual' }) })),
  'runs.cancel': h(idIn, (i, a, s) => s.engine.cancel(a, i.id)),
  'runs.pause': h(idIn, (i, a, s) => s.engine.pause(a, i.id)),
  'runs.resume': h(idIn, (i, a, s) => s.engine.resume(a, i.id)),
  'runs.retry': h(idIn, (i, a, s) => s.engine.retryFailed(a, i.id)),
  'runs.reviews': h(none, (_i, a, s) => runs.listReviewTasks(s.ctx, a)),
  'runs.resolveReview': h(
    z.object({ id: z.string(), decision: z.enum(['approve', 'reject', 'edit', 'done', 'retry', 'skip', 'provide']), data: z.unknown().optional(), comment: z.string().max(2000).optional() }),
    (i, a, s) => s.engine.resolveReview(a, i.id, i)
  ),
  'runs.feedback': h(improvements.FeedbackSchema, (i, a, s) => improvements.submitFeedback(s.ctx, a, i)),
  'results.tables': h(none, (_i, a, s) => runs.listOutputTables(s.ctx, a)),
  'results.export': h(z.object({ table: z.string(), format: z.enum(['csv', 'json']) }), (i, a, s) => runs.exportOutputTable(s.ctx, a, i.table, i.format)),

  // ---------------- Opportunities, datasets, training, models ----------------
  'ml.findOpportunities': h(z.object({ collectionId: z.string() }), (i, a, s) => training.findOpportunities(s.ctx, a, i.collectionId)),
  'ml.opportunities': h(z.object({ collectionId: z.string().optional() }), (i, a, s) => training.listOpportunities(s.ctx, a, i.collectionId)),
  'ml.explainOpportunity': h(z.object({ id: z.string(), providerId: z.string(), model: z.string() }), (i, a, s) => training.explainOpportunity(s.ctx, a, i.id, i.providerId, i.model)),
  'ml.baseModels': h(none, () => training.BASE_MODEL_CHOICES),
  'ml.prepareDataset': h(training.PrepareDatasetSchema, (i, a, s) => training.prepareDataset(s.ctx, a, i)),
  'ml.datasets': h(none, (_i, a, s) => training.listDatasets(s.ctx, a)),
  'ml.datasetPreview': h(idIn, (i, a, s) => training.previewDataset(s.ctx, a, i.id)),
  'ml.reviewTraining': h(z.object({ datasetId: z.string(), config: TrainingConfigSchema }), (i, a, s) => training.reviewTraining(s.ctx, a, i)),
  'ml.startTraining': h(training.StartTrainingSchema, (i, a, s) => training.startTraining(s.ctx, a, i)),
  'ml.cancelTraining': h(idIn, (i, a, s) => training.cancelTraining(s.ctx, a, i.id)),
  'ml.jobs': h(none, (_i, a, s) => training.listJobs(s.ctx, a)),
  'ml.job': h(idIn, (i, a, s) => training.getJob(s.ctx, a, i.id)),
  'ml.models': h(none, (_i, a, s) => models.listModels(s.ctx, a)),
  'ml.model': h(idIn, (i, a, s) => models.getModel(s.ctx, a, i.id)),
  'ml.registerModel': h(z.object({ jobId: z.string(), name: z.string() }), (i, a, s) => models.registerModel(s.ctx, a, i)),
  'ml.activateModel': h(idIn, (i, a, s) => models.activateModel(s.ctx, a, i.id)),
  'ml.setModelStatus': h(z.object({ id: z.string(), status: z.enum(['retired', 'registered']), note: z.string().default('') }), (i, a, s) => models.setModelStatus(s.ctx, a, i.id, i.status, i.note)),
  'ml.tryModel': h(z.object({ id: z.string(), text: z.string().min(1).max(20000) }), (i, a, s) => models.tryModel(s.ctx, a, i.id, i.text))
} satisfies Record<string, Handler<z.ZodTypeAny, unknown>>

export type Handlers = typeof handlers
export type Method = keyof Handlers
export type Api = { [K in Method]: { input: z.input<Handlers[K]['input']>; output: Awaited<ReturnType<Handlers[K]['run']>> } }

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

export async function dispatch(s: Services, method: string, rawInput: unknown): Promise<IpcResult<unknown>> {
  const handler = (handlers as Record<string, Handler<z.ZodTypeAny, unknown>>)[method]
  if (!handler) return { ok: false, error: { code: 'invalid', message: `Unknown method ${method}` } }
  const parsed = handler.input.safeParse(rawInput ?? {})
  if (!parsed.success)
    return { ok: false, error: { code: 'invalid', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), details: { issues: parsed.error.issues } } }
  try {
    const personaId = getSetting<string>(s.ctx, 'persona', 'u_alex')
    const actor = actorFor(s.ctx, personaId)
    const data = await handler.run(parsed.data, actor, s)
    return { ok: true, data: data ?? null }
  } catch (e) {
    if (e instanceof RelayError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } }
    if (e instanceof z.ZodError) return { ok: false, error: { code: 'invalid', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } }
    console.error(`[ipc] ${method} failed`, e)
    return { ok: false, error: { code: 'internal', message: `Something went wrong (${(e as Error).message}).` } }
  }
}

