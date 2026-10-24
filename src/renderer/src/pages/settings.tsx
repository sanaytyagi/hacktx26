import * as React from 'react'
import { KeyRound, ScrollText, Server, ShieldCheck, HardDrive, Info, UserRound, Plus, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { CAPABILITIES, ROLE_CAPABILITIES, type Role } from '@shared/permissions'
import { useAction, useApi, type Out } from '@/lib/api'
import { setQuery, useRoute } from '@/lib/router'
import { bytes, dateTime, when } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Switch } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Field, JsonView, KeyValue, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { useCan, useSession } from '@/components/app/shell'

export function SettingsPage() {
  const { query } = useRoute()
  const admin = useCan('credentials.manage')
  const audit = useCan('audit.view_team')
  const retention = useCan('retention.manage')
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs value={query.tab ?? 'profile'} onValueChange={(v) => setQuery({ tab: v })}>
        <TabsList>
          <TabsTrigger value="profile">
            <UserRound /> Personas & permissions
          </TabsTrigger>
          {admin && (
            <TabsTrigger value="keys">
              <KeyRound /> Models & keys
            </TabsTrigger>
          )}
          <TabsTrigger value="policies">
            <ShieldCheck /> Policies
          </TabsTrigger>
          {admin && (
            <TabsTrigger value="api">
              <Server /> Local API
            </TabsTrigger>
          )}
          {audit && (
            <TabsTrigger value="audit">
              <ScrollText /> Audit log
            </TabsTrigger>
          )}
          {retention && (
            <TabsTrigger value="storage">
              <HardDrive /> Storage & retention
            </TabsTrigger>
          )}
          <TabsTrigger value="about">
            <Info /> About
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <Profile />
        </TabsContent>
        {admin && (
          <TabsContent value="keys">
            <Keys />
          </TabsContent>
        )}
        <TabsContent value="policies">
          <Policies />
        </TabsContent>
        {admin && (
          <TabsContent value="api">
            <LocalApi />
          </TabsContent>
        )}
        {audit && (
          <TabsContent value="audit">
            <Audit />
          </TabsContent>
        )}
        {retention && (
          <TabsContent value="storage">
            <Storage />
          </TabsContent>
        )}
        <TabsContent value="about">
          <About />
        </TabsContent>
      </Tabs>
    </>
  )
}

const CAP_LABEL: Record<string, string> = {
  'agents.create': 'Create and test own agents',
  'agents.view_team': 'See team agents and runs',
  'agents.manage_all': 'Manage every agent',
  'deploy.personal': 'Deploy own agents for personal use',
  'deploy.request_shared': 'Request team deployment',
  'approvals.decide_team': 'Decide team requests (within limits)',
  'approvals.decide_all': 'Decide any request',
  'data.request_access': 'Request data access',
  'data.delegate': 'Delegate collections they hold delegable access to (own team)',
  'data.administer': 'Configure sources and collections',
  'tools.request_access': 'Request tool access',
  'tools.administer': 'Manage integrations and tool approvals',
  'opportunities.explore': 'Explore model opportunities',
  'training.run': 'Prepare datasets and train models',
  'models.activate': 'Register and activate models',
  'models.administer': 'Clear model review flags',
  'budgets.view_team': 'See team budgets',
  'budgets.view_all': 'See all budgets',
  'budgets.edit': 'Edit budgets',
  'pricing.edit': 'Edit prices',
  'policies.edit': 'Edit company policies',
  'credentials.manage': 'Manage keys and model providers',
  'audit.view_team': 'View team audit events',
  'audit.view_all': 'View all audit events',
  'retention.manage': 'Manage retention and delete artifacts',
  'workspace.reset': 'Reset the demo workspace'
}

function Profile() {
  const s = useSession()
  return (
    <div className="space-y-5">
      <Alert tone="info" title="Demo personas, not real accounts">
        Relay opens directly into a fictional workspace. The persona switcher (top right) lets you act as an Employee, Manager or Administrator on this computer. There is no login. Permissions are still enforced by Relay’s services for the active persona — hiding a button is never the only protection.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>You are acting as {s.actor.name}</CardTitle>
          <CardDescription>
            {s.actor.title} · {s.actor.teamName} · <span className="capitalize">{s.actor.role}</span>
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Permission matrix</CardTitle>
          <CardDescription>Role rights are a ceiling. Using data additionally requires a grant for that collection and purpose; managers only act within their own team and admin-defined limits.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Capability</TableHead>
                {(['employee', 'manager', 'admin'] as Role[]).map((r) => (
                  <TableHead key={r} className="text-center capitalize">
                    {r}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {CAPABILITIES.map((c) => (
                <TableRow key={c}>
                  <TableCell>{CAP_LABEL[c] ?? c}</TableCell>
                  {(['employee', 'manager', 'admin'] as Role[]).map((r) => (
                    <TableCell key={r} className="text-center">
                      {ROLE_CAPABILITIES[r].includes(c) ? <span className="text-success">Yes</span> : <span className="text-muted-foreground">No</span>}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function Keys() {
  const providers = useApi('providers.list')
  const creds = useApi('credentials.list')
  const settings = useApi('settings.get')
  const s = useSession()
  const [edit, setEdit] = React.useState<Out<'providers.list'>[number] | 'new' | null>(null)
  const check = useAction('providers.check', { success: (p) => (p?.status === 'ok' ? 'Connection works' : `Check failed: ${p?.statusDetail}`) })
  const [serp, setSerp] = React.useState('')
  const setSerpM = useAction('credentials.setSerpApi', { success: 'SerpApi key saved', onSuccess: () => setSerp('') })
  const del = useAction('credentials.delete', { success: 'Credential deleted' })
  return (
    <div className="space-y-5">
      {s.secretStorage === 'plaintext_fallback' ? (
        <Alert tone="warning" title="No OS keychain available">Keys are stored without OS encryption on this computer. Use a machine with a system keychain for real credentials.</Alert>
      ) : (
        <Alert tone="success">Keys are encrypted with your operating system’s keychain and only decrypted inside Relay’s main process. They are never shown to agents, models or this screen.</Alert>
      )}
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Model providers</CardTitle>
            <CardDescription>General models for agent steps and workflow analysis. Whether a provider is “external” is derived from its address, not configured.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setEdit('new')}>
            <Plus /> Add provider
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <Query q={providers}>
            {(ps) =>
              ps.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {p.name} {p.external ? <Badge tone="neutral">External · {p.destination}</Badge> : <Badge tone="success">Local</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.models.join(', ')} {p.statusDetail && `· ${p.statusDetail}`}
                    </div>
                  </div>
                  {!p.enabled ? <StatusBadge status="disabled" /> : p.configured ? <StatusBadge status={p.status === 'ok' ? 'ok' : p.status === 'error' ? 'error' : 'unchecked'} /> : <StatusBadge status="needs_connection" label="No key" />}
                  <Button size="sm" variant="outline" disabled={!p.enabled || !p.configured} loading={check.isPending && check.variables?.id === p.id} onClick={() => check.mutate({ id: p.id })}>
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                    Edit
                  </Button>
                </div>
              ))
            }
          </Query>
          <p className="text-xs text-muted-foreground">Test calls are real, small paid requests and are recorded in the ledger. The local Python model downloads Qwen2.5-0.5B-Instruct (Apache-2.0, ~1 GB) on first use.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Web search (SerpApi)</CardTitle>
          <CardDescription>{settings.data?.serpApiConfigured ? 'A key is configured.' : 'Not configured: the Web search tool shows “Needs connection”.'}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input type="password" value={serp} onChange={(e) => setSerp(e.target.value)} placeholder="SerpApi API key" aria-label="SerpApi API key" />
          <Button disabled={serp.length < 8} loading={setSerpM.isPending} onClick={() => setSerpM.mutate({ apiKey: serp })}>
            Save key
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Stored credentials</CardTitle>
          <CardDescription>Metadata only. Values never leave the main process.</CardDescription>
        </CardHeader>
        <CardContent>
          <Query q={creds}>
            {(cs) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Hint</TableHead>
                    <TableHead>Storage</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cs.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>{c.service}</TableCell>
                      <TableCell className="font-mono text-xs">{c.hint}</TableCell>
                      <TableCell>{c.storage === 'os_keychain' ? 'OS keychain' : 'Unencrypted'}</TableCell>
                      <TableCell className="text-muted-foreground">{when(c.last_used_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: c.id })}>
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Query>
        </CardContent>
      </Card>
      {edit && <ProviderDialog p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function ProviderDialog({ p, onClose }: { p: Out<'providers.list'>[number] | null; onClose: () => void }) {
  const [kind, setKind] = React.useState<'anthropic' | 'gemini' | 'openai_compatible' | 'local'>((p?.kind as 'anthropic') ?? 'openai_compatible')
  const [name, setName] = React.useState(p?.name ?? '')
  const [baseUrl, setBaseUrl] = React.useState(p?.baseUrl ?? '')
  const [models, setModels] = React.useState((p?.models ?? []).join(', '))
  const [key, setKey] = React.useState('')
  const [enabled, setEnabled] = React.useState(p?.enabled ?? true)
  const save = useAction('providers.upsert', { success: 'Provider saved', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p ? `Edit ${p.name}` : 'Add model provider'}</DialogTitle>
          <DialogDescription>Allowed models are also governed by company policy.</DialogDescription>
        </DialogHeader>
        {!p && (
          <Field label="Kind">
            <Select value={kind} onValueChange={(v) => setKind(v as 'local')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="gemini">Google Gemini</SelectItem>
                <SelectItem value="openai_compatible">OpenAI-compatible (OpenAI, Ollama, LM Studio, vLLM)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {(kind === 'openai_compatible' || kind === 'anthropic' || kind === 'gemini') && (
          <Field label="Base URL" hint={kind === 'openai_compatible' ? 'e.g. http://127.0.0.1:11434/v1 for Ollama (local), or https://api.openai.com/v1' : 'Leave empty for the default endpoint'}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        )}
        <Field label="Models (comma-separated)">
          <Input value={models} onChange={(e) => setModels(e.target.value)} />
        </Field>
        {kind !== 'local' && (
          <Field label={p ? 'Replace API key (leave empty to keep)' : 'API key'}>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" /> Enabled
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name || !models.trim()}
            loading={save.isPending}
            onClick={() => save.mutate({ id: p?.id, kind, name, baseUrl: baseUrl || null, apiKey: key || undefined, models: models.split(',').map((m) => m.trim()).filter(Boolean), enabled })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Policy = Out<'settings.get'>['policy']

function Policies() {
  const q = useApi('settings.get')
  const [p, setP] = React.useState<Policy | null>(null)
  const save = useAction('settings.updatePolicy', { success: 'Policies saved' })
  React.useEffect(() => {
    if (q.data && !p) setP(q.data.policy)
  }, [q.data])
  if (!q.data || !p) return <Query q={q}>{() => null}</Query>
  const ro = !q.data.canEdit
  const num = (path: (x: Policy) => number, set: (x: Policy, v: number) => Policy, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" step="any" disabled={ro} value={path(p)} onChange={(e) => setP(set(p, Number(e.target.value)))} />
    </Field>
  )
  return (
    <div className="space-y-5">
      {ro && <Alert tone="neutral">Company policies are set by administrators. You can view them here.</Alert>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Deployment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-center gap-2">
              <Switch disabled={ro} checked={p.personalDeploy.allowed} onCheckedChange={(v) => setP({ ...p, personalDeploy: { ...p.personalDeploy, allowed: v } })} aria-label="Allow personal deployment" /> Employees may deploy agents for personal use
            </label>
            <label className="flex items-center gap-2">
              <Switch disabled={ro} checked={p.personalDeploy.requireSuccessfulTest} onCheckedChange={(v) => setP({ ...p, personalDeploy: { ...p.personalDeploy, requireSuccessfulTest: v } })} aria-label="Require test" /> Require a successful test before going live
            </label>
            <Field label="Tool access allowed without approval for personal deployment" hint="Comma-separated: read, write, send, delete">
              <Input disabled={ro} value={p.personalDeploy.allowedToolAccess.join(', ')} onChange={(e) => setP({ ...p, personalDeploy: { ...p.personalDeploy, allowedToolAccess: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) as Policy['personalDeploy']['allowedToolAccess'] } })} />
            </Field>
            <label className="flex items-center gap-2">
              <Switch disabled={ro} checked={p.sharedDeployRequiresApproval} onCheckedChange={(v) => setP({ ...p, sharedDeployRequiresApproval: v })} aria-label="Shared deploy approval" /> Team deployments require approval
            </label>
            <label className="flex items-center gap-2">
              <Switch disabled={ro} checked={p.checkpointForSendAndDelete} onCheckedChange={(v) => setP({ ...p, checkpointForSendAndDelete: v })} aria-label="Checkpoint send/delete" /> Send and delete actions always pause for approval
            </label>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Models & data destinations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Allowed models (provider:model, * = any)">
              <Textarea disabled={ro} rows={3} value={p.allowedModels.map((m) => `${m.providerKind}:${m.model}`).join('\n')} onChange={(e) => setP({ ...p, allowedModels: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ providerKind: l.split(':')[0], model: l.split(':').slice(1).join(':') || '*' })) })} />
            </Field>
            <Field label="Allowed external destinations (one per line)" hint="*.public-web allows the Read web page tool to fetch public websites.">
              <Textarea disabled={ro} rows={4} value={p.allowedExternalDestinations.join('\n')} onChange={(e) => setP({ ...p, allowedExternalDestinations: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch disabled={ro} checked={p.allowUnknownPricing} onCheckedChange={(v) => setP({ ...p, allowUnknownPricing: v })} aria-label="Allow unknown pricing" /> Allow paid calls with unknown pricing (recorded at $0 estimate — not recommended)
            </label>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Run caps & budgets</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {num((x) => x.runCaps.maxToolCalls, (x, v) => ({ ...x, runCaps: { ...x.runCaps, maxToolCalls: v } }), 'Max tool calls per run')}
            {num((x) => x.runCaps.maxTokens, (x, v) => ({ ...x, runCaps: { ...x.runCaps, maxTokens: v } }), 'Max tokens per run')}
            {num((x) => x.runCaps.maxRuntimeSec, (x, v) => ({ ...x, runCaps: { ...x.runCaps, maxRuntimeSec: v } }), 'Max runtime (seconds)')}
            {num((x) => x.runCaps.maxRetries, (x, v) => ({ ...x, runCaps: { ...x.runCaps, maxRetries: v } }), 'Max retries per run')}
            {num((x) => x.runCaps.maxCostUsd, (x, v) => ({ ...x, runCaps: { ...x.runCaps, maxCostUsd: v } }), 'Max cost per run (USD)')}
            {num((x) => x.managerApprovalCeilingUsd, (x, v) => ({ ...x, managerApprovalCeilingUsd: v }), 'Manager approval ceiling (USD)')}
            {num((x) => x.defaultAgentMonthlyBudgetUsd, (x, v) => ({ ...x, defaultAgentMonthlyBudgetUsd: v }), 'Default agent budget (USD/month)')}
            {num((x) => x.localComputeRateUsdPerHour, (x, v) => ({ ...x, localComputeRateUsdPerHour: v }), 'Local compute rate (USD/hour)', '0 shows local compute as time only')}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Retention</CardTitle>
            <CardDescription>Applied daily and on demand in Storage & retention.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {num((x) => x.retention.recordingsDays, (x, v) => ({ ...x, retention: { ...x.retention, recordingsDays: v } }), 'Recordings (days)')}
            {num((x) => x.retention.exportsDays, (x, v) => ({ ...x, retention: { ...x.retention, exportsDays: v } }), 'Exports (days)')}
            {num((x) => x.retention.runHistoryDays, (x, v) => ({ ...x, retention: { ...x.retention, runHistoryDays: v } }), 'Run details (days)')}
          </CardContent>
        </Card>
      </div>
      {!ro && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setP(q.data!.policy)}>
            Discard changes
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate({ policy: p })}>
            Save policies
          </Button>
        </div>
      )}
    </div>
  )
}

function LocalApi() {
  const q = useApi('settings.get')
  const [enabled, setEnabled] = React.useState<boolean | null>(null)
  const [port, setPort] = React.useState(47821)
  const [inference, setInference] = React.useState(false)
  const save = useAction('settings.setApi', { success: 'Local API updated' })
  React.useEffect(() => {
    if (q.data && enabled === null) {
      setEnabled(q.data.api.enabled)
      setPort(q.data.api.port)
      setInference(q.data.api.modelInference)
    }
  }, [q.data])
  const api = q.data?.api
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Local HTTP API</CardTitle>
          <CardDescription>Binds to 127.0.0.1 only. Every request needs the per-launch secret (or a valid webhook signature). Browser requests are refused.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={!!enabled} onCheckedChange={setEnabled} aria-label="Enable local API" /> Enable the local API
          </label>
          <Field label="Port">
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={inference} onCheckedChange={setInference} aria-label="Allow model inference" /> Allow inference on active fine-tuned models
          </label>
        </CardContent>
        <CardFooter className="justify-end">
          <Button loading={save.isPending} onClick={() => save.mutate({ enabled: !!enabled, port, modelInference: inference })}>
            Apply
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {api?.error && <Alert tone="danger">{api.error}</Alert>}
          <KeyValue items={[['Running', api?.running ? 'Yes' : 'No'], ['Address', api?.url ?? '—']]} />
          {api?.secret && (
            <div className="space-y-1">
              <div className="text-xs font-medium">Secret for this launch</div>
              <div className="flex gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{api.secret}</code>
                <Button size="icon-sm" variant="ghost" aria-label="Copy secret" onClick={() => navigator.clipboard.writeText(api.secret!).then(() => toast.success('Copied'))}>
                  <Copy />
                </Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{api?.note}</p>
          <JsonView value={`POST /v1/agents/{agentId}/runs   {"inputs": {...}}\nGET  /v1/runs/{runId}\nPOST /v1/models/{name}/predict  {"text": "..."}\nPOST /v1/hooks/{webhookId}   (x-relay-signature: sha256=HMAC)`} />
          <p className="text-xs text-muted-foreground">External services cannot reach 127.0.0.1. To receive webhooks from outside this computer you must set up your own gateway or tunnel, which is outside Relay.</p>
        </CardContent>
      </Card>
    </div>
  )
}

function Audit() {
  const [prefix, setPrefix] = React.useState('')
  const q = useApi('audit.list', { action: prefix || undefined, limit: 300 })
  return (
    <div className="space-y-3">
      <Alert tone="neutral">This is Relay’s local application log, stored in the local database. It is useful for review and troubleshooting, but it is not tamper-proof compliance infrastructure. Secrets are redacted.</Alert>
      <div className="flex items-center gap-2">
        <Select value={prefix || 'all'} onValueChange={(v) => setPrefix(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-60" aria-label="Filter events">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              ['all', 'All events'],
              ['grant', 'Access changes'],
              ['data', 'Data access'],
              ['agent', 'Agents & deployment'],
              ['tool', 'Tool actions'],
              ['approval', 'Approvals'],
              ['budget', 'Budgets'],
              ['dataset', 'Datasets'],
              ['training', 'Training jobs'],
              ['model', 'Models'],
              ['authz', 'Denied actions']
            ].map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Query q={q}>
        {(events) => (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{dateTime(e.ts)}</TableCell>
                    <TableCell className="text-xs">{e.actor_name ?? e.actor_id}</TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.target_type ? `${e.target_type}:${e.target_id}` : '—'}</TableCell>
                    <TableCell>{e.outcome === 'ok' ? <Badge tone="success">ok</Badge> : <Badge tone="danger">{e.outcome}</Badge>}</TableCell>
                    <TableCell className="max-w-md truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(e.details)}>
                      {JSON.stringify(e.details)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </Query>
    </div>
  )
}

function Storage() {
  const q = useApi('retention.report')
  const apply = useAction('retention.apply', { success: (r) => `Removed ${r.recordings} recording(s), ${r.exports} export(s), ${r.runEvents} run log entries` })
  const del = useAction('retention.delete', { success: 'Deleted' })
  return (
    <Query q={q}>
      {(r) => (
        <div className="space-y-5">
          <Card>
            <CardHeader className="flex-row items-start justify-between">
              <div>
                <CardTitle>Local storage</CardTitle>
                <CardDescription className="break-all">{r.root}</CardDescription>
              </div>
              <Button variant="outline" onClick={() => apply.mutate({})} loading={apply.isPending}>
                Apply retention now
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {r.usage.map((u) => (
                    <TableRow key={u.key}>
                      <TableCell>{u.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.items ? `${u.items} item(s)` : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.bytes ? bytes(u.bytes) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                Policy: recordings {r.policy.recordingsDays} days, exports {r.policy.exportsDays} days, run details {r.policy.runHistoryDays} days. Run summaries and audit events are kept.
              </p>
            </CardContent>
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Exports</CardTitle>
              </CardHeader>
              <CardContent className="max-h-80 space-y-1 overflow-y-auto text-sm">
                {r.exports.length === 0 && <p className="text-muted-foreground">None.</p>}
                {r.exports.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">{e.path.split(/[\\/]/).pop()}</span>
                    <Button size="sm" variant="ghost" onClick={() => del.mutate({ kind: 'export', id: e.id })}>
                      Delete
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Prepared datasets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {r.datasets.length === 0 && <p className="text-muted-foreground">None.</p>}
                {r.datasets.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2">
                    <span>
                      {d.name} v{d.version} <span className="text-xs text-muted-foreground">{when(d.created_at)}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => del.mutate({ kind: 'dataset', id: d.id })}>
                      Delete files
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </Query>
  )
}

function About() {
  const info = useApi('app.info')
  const py = useApi('app.pythonStatus')
  const canReset = useCan('workspace.reset')
  const [reset, setReset] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const resetM = useAction('app.resetWorkspace', { success: 'Resetting…' })
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Relay</CardTitle>
          <CardDescription>Local prototype. Runs on this computer; no accounts, hosted backend or payments. Local runtime and local model inference are the private deployment — there is no hosted private-cloud deployment.</CardDescription>
        </CardHeader>
        <CardContent>
          <Query q={info}>
            {(i) => <KeyValue items={[['Version', i.version], ['Platform', i.platform], ['Electron', i.electron], ['Data folder', <span key="d" className="break-all text-xs">{i.dataDir}</span>], ['Python', <span key="p" className="break-all text-xs">{i.python}</span>]]} />}
          </Query>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Python worker</CardTitle>
          <CardDescription>Used for dataset profiling, training, and local inference.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Query q={py}>
            {(p) =>
              p.ok ? (
                <>
                  <KeyValue
                    items={[
                      ['Python', String(p.env.python)],
                      ['Packages', Object.entries(p.env.packages as Record<string, boolean>).map(([k, v]) => `${k}${v ? '' : ' (missing)'}`).join(', ')],
                      ['Devices', Object.entries(p.env.devices as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ')]
                    ]}
                  />
                  {!(p.env.packages as Record<string, boolean>).torch && <Alert tone="warning">Training packages are not installed. Run <code>npm run setup:python -- --train</code>.</Alert>}
                </>
              ) : (
                <Alert tone="danger" title="Python worker unavailable">
                  {p.error} Run <code>npm run setup:python</code>.
                </Alert>
              )
            }
          </Query>
        </CardContent>
      </Card>
      {canReset && (
        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle>Reset demo workspace</CardTitle>
            <CardDescription>Deletes all local Relay data (database, recordings, datasets, models, exports) and restarts with fresh synthetic data.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={() => setReset(true)}>
              Reset workspace…
            </Button>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={reset} onOpenChange={setReset} title="Reset the demo workspace?" description="Type RESET to confirm. Relay will restart." destructive confirmLabel="Reset and restart" onConfirm={() => typed === 'RESET' && resetM.mutate({ confirm: 'RESET' })} loading={resetM.isPending}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type RESET" />
      </ConfirmDialog>
    </div>
  )
}

