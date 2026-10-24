import * as React from 'react'
import { Activity, FileCode, Lock, Plug, Plus, Puzzle, RefreshCw, Search, Server, TestTube2, Webhook, Wrench, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { TOOL_CATEGORY_LABELS, TOOL_CATEGORIES, type ToolCategory } from '@shared/domain'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { setQuery, useRoute } from '@/lib/router'
import { when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Switch } from '@/components/ui/misc'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState, Field, JsonView, KeyValue, MonoId, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'
import { useCan } from '@/components/app/shell'

type Tool = Out<'tools.catalog'>['tools'][number]

export function ToolsPage() {
  const { query } = useRoute()
  const admin = useCan('tools.administer')
  const tab = query.tab ?? 'catalog'
  return (
    <>
      <PageHeader title="Tools" description="Capabilities agents can use. Each tool declares what it reads or changes, where data goes, and what it costs. Connecting a service never exposes all of its operations automatically." />
      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v })}>
        <TabsList>
          <TabsTrigger value="catalog">
            <Wrench /> Catalog
          </TabsTrigger>
          {admin && (
            <>
              <TabsTrigger value="integrations">
                <Plug /> Integrations & health
              </TabsTrigger>
              <TabsTrigger value="test">
                <TestTube2 /> Test a tool
              </TabsTrigger>
              <TabsTrigger value="webhooks">
                <Webhook /> Webhooks
              </TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="catalog">
          <Catalog />
        </TabsContent>
        {admin && (
          <>
            <TabsContent value="integrations">
              <Integrations />
            </TabsContent>
            <TabsContent value="test">
              <Tester />
            </TabsContent>
            <TabsContent value="webhooks">
              <Webhooks />
            </TabsContent>
          </>
        )}
      </Tabs>
    </>
  )
}

function Catalog() {
  const q = useApi('tools.catalog')
  const [search, setSearch] = React.useState('')
  const [status, setStatus] = React.useState('any')
  const [open, setOpen] = React.useState<Tool | null>(null)
  return (
    <Query q={q}>
      {(d) => {
        const s = search.toLowerCase()
        const tools = d.tools.filter((t) => (!s || `${t.name} ${t.description} ${t.key}`.toLowerCase().includes(s)) && (status === 'any' || t.status === status))
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-80">
                <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tools" className="pl-8" aria-label="Search tools" />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-56" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any status</SelectItem>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="needs_connection">Needs connection</SelectItem>
                  <SelectItem value="requires_permission">Requires permission</SelectItem>
                  <SelectItem value="not_supported">Not supported</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {TOOL_CATEGORIES.map((cat) => {
              const items = tools.filter((t) => t.category === cat)
              if (!items.length) return null
              return (
                <section key={cat} className="space-y-2">
                  <h2 className="text-sm font-semibold">{TOOL_CATEGORY_LABELS[cat]}</h2>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {items.map((t) => (
                      <button key={t.key} onClick={() => setOpen(t)} className="rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium">{t.name}</span>
                          <StatusBadge status={t.status} />
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {t.kind !== 'catalog' && <Badge tone={t.access === 'read' ? 'neutral' : 'warning'}>{t.access}</Badge>}
                          {t.external && <Badge tone="neutral">External</Badge>}
                          {t.requiresApproval && <Badge tone="warning">Approval per call</Badge>}
                          {t.kind !== 'builtin' && t.kind !== 'catalog' && <Badge tone="info">{t.kind}</Badge>}
                          {t.requestPending && <Badge tone="info">Request pending</Badge>}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
            {tools.length === 0 && <EmptyState icon={Wrench} title="No tools match" />}
            {open && <ToolSheet t={open} onClose={() => setOpen(null)} />}
          </div>
        )
      }}
    </Query>
  )
}

function ToolSheet({ t, onClose }: { t: Tool; onClose: () => void }) {
  const admin = useCan('tools.administer')
  const [reqOpen, setReqOpen] = React.useState(false)
  const req = useAction('tools.requestAccess', { success: 'Request sent to administrators', onSuccess: () => setReqOpen(false) })
  const versions = useApi('tools.versions', { key: t.key }, { enabled: t.kind !== 'catalog' })
  const dir = useApi('directory.get', undefined, { enabled: admin })
  const grant = useAction('tools.grant', { success: 'Approved' })
  const revoke = useAction('tools.revokeGrant', { success: 'Revoked' })
  const enable = useAction('tools.setEnabled', { success: 'Saved' })
  const [team, setTeam] = React.useState('')
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetTitle className="flex items-center gap-2">
          {t.name} <StatusBadge status={t.status} />
        </SheetTitle>
        <SheetDescription>{t.description}</SheetDescription>
        <p className="text-sm text-muted-foreground">{t.statusDetail}</p>
        {t.kind !== 'catalog' && (
          <>
            <KeyValue
              items={[
                ['Tool key', <MonoId key="k">{t.key}</MonoId>],
                ['Version', `v${t.version}`],
                ['Access', t.access],
                ['Side effects', t.sideEffects],
                ['Data goes to', t.dataDestinations.join(', ')],
                ['Authentication', t.auth],
                ['Cost', `${t.cost.kind.replace('_', ' ')}${(t.cost as { note?: string }).note ? ` — ${(t.cost as { note?: string }).note}` : ''}`],
                ['Timeout', `${t.timeoutMs / 1000}s`],
                ['Retries', t.retry.safe ? `Up to ${t.retry.max} (safe to retry)` : 'Not retried (not safe to repeat)'],
                ['Rate limit', t.rateLimitPerMin ? `${t.rateLimitPerMin}/minute` : '—'],
                ['Approval', t.requiresApproval ? 'Each live call needs human approval' : t.access === 'send' || t.access === 'delete' ? 'Checkpoint required by policy' : 'Not required']
              ]}
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">Input schema</div>
              <JsonView value={t.inputSchema} maxHeight={200} />
            </div>
            {versions.data && versions.data.length > 1 && (
              <div className="text-xs text-muted-foreground">
                Versions: {versions.data.map((v) => `v${v.version} (${v.access}${v.requiresApproval ? ', approval' : ''})`).join(' · ')}. Agents stay pinned to the version they were built with; broader-permission upgrades need re-approval.
              </div>
            )}
          </>
        )}
        {t.status === 'requires_permission' && !t.requestPending && (
          <Button onClick={() => setReqOpen(true)}>
            <Lock /> Request access
          </Button>
        )}
        {t.requestPending && <Alert tone="info">Your request is waiting for an administrator.</Alert>}
        {admin && t.kind !== 'catalog' && (
          <div className="space-y-3 border-t pt-3">
            <div className="text-sm font-medium">Who may use this tool</div>
            {t.grants.length === 0 && <p className="text-sm text-muted-foreground">Nobody yet.</p>}
            {t.grants.map((g) => (
              <div key={g.id} className="flex items-center justify-between text-sm">
                <span>
                  {g.name} <Badge tone="neutral">{g.principal_type}</Badge>
                </span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate({ id: g.id })}>
                  Revoke
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Select value={team} onValueChange={setTeam}>
                <SelectTrigger aria-label="Team">
                  <SelectValue placeholder="Approve for a team…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ws">Everyone</SelectItem>
                  {(dir.data?.teams ?? []).map((tm) => (
                    <SelectItem key={tm.id} value={tm.id}>
                      {tm.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button disabled={!team} onClick={() => grant.mutate({ toolKey: t.key, principalType: team === 'ws' ? 'workspace' : 'team', principalId: team })}>
                Approve
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={t.status !== 'disabled'} onCheckedChange={(v) => enable.mutate({ key: t.key, enabled: v })} aria-label="Tool enabled" /> Enabled
            </label>
          </div>
        )}
        <ReasonDialog open={reqOpen} onOpenChange={setReqOpen} title={`Request ${t.name}`} description="Administrators approve tool access per team or person." onSubmit={(reason) => req.mutate({ toolKey: t.key, reason })} loading={req.isPending} />
      </SheetContent>
    </Sheet>
  )
}

function Integrations() {
  const q = useApi('tools.integrations')
  const check = useAction('tools.checkHealth', { success: 'Health check finished' })
  const [add, setAdd] = React.useState<null | 'mcp' | 'openapi' | 'http' | 'plugin'>(null)
  const [register, setRegister] = React.useState<string | null>(null)
  const discover = useAction('tools.discoverMcp', { success: (d) => `Found ${d.length} tool(s)`, onSuccess: (_d, i) => setRegister(i.id) })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAdd('mcp')}>
          <Server /> Add MCP server
        </Button>
        <Button variant="outline" onClick={() => setAdd('openapi')}>
          <FileCode /> Import OpenAPI
        </Button>
        <Button variant="outline" onClick={() => setAdd('http')}>
          <Plus /> Custom HTTP tool
        </Button>
        <Button variant="outline" onClick={() => setAdd('plugin')}>
          <Puzzle /> Install plugin
        </Button>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => check.mutate({})} loading={check.isPending}>
          <Activity /> Check all connections
        </Button>
      </div>
      <Query q={q}>
        {(items) => (
          <div className="space-y-3">
            {items.length === 0 && <EmptyState icon={Plug} title="No integrations" />}
            {items.map((i) => (
              <Card key={i.id}>
                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {i.name} <Badge tone="info">{i.kind}</Badge> <StatusBadge status={i.status} />
                    </CardTitle>
                    <CardDescription>
                      {i.statusDetail} {i.lastCheckedAt && `· checked ${when(i.lastCheckedAt)}`}
                    </CardDescription>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {i.config.baseUrl && <>Base URL {i.config.baseUrl} · </>}
                      {i.config.transport && <>Transport {i.config.transport} {i.config.command && `· ${i.config.command}`} · </>}
                      {i.config.allowPrivateNetwork && <Badge tone="warning">Internal network allowed (admin)</Badge>} {i.hasCredential && <Badge tone="neutral">Credential stored</Badge>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {i.kind === 'mcp' && (
                      <Button size="sm" onClick={() => discover.mutate({ id: i.id })} loading={discover.isPending && discover.variables?.id === i.id}>
                        <RefreshCw /> Connect & discover
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => check.mutate({ integrationId: i.id })}>
                      Check
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {i.tools.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{i.kind === 'mcp' ? 'No tools registered yet. Connect, then choose which tools to expose.' : 'No tools registered.'}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {i.tools.map((t) => (
                        <li key={t.key} className="flex flex-wrap items-center gap-2">
                          <MonoId>{t.key}</MonoId> <span className="text-xs text-muted-foreground">v{t.version}</span>
                          {t.health ? <StatusBadge status={t.health.status} /> : <StatusBadge status="not_checked" />}
                          {t.health && <span className="text-xs text-muted-foreground">{t.health.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {i.kind === 'mcp' && i.discovered.length > 0 && (
                    <Button size="sm" variant="link" className="mt-2 h-auto p-0" onClick={() => setRegister(i.id)}>
                      Choose tools to expose ({i.discovered.length} discovered)
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Query>
      <Alert tone="neutral">Imported descriptions and API specifications never grant permissions: you choose each operation’s access level and whether calls need approval. Changes to a tool’s definition create a new version; agents stay on the version they were tested with.</Alert>
      {add === 'mcp' && <AddMcp onClose={() => setAdd(null)} />}
      {add === 'openapi' && <ImportOpenApi onClose={() => setAdd(null)} />}
      {add === 'http' && <AddHttp onClose={() => setAdd(null)} />}
      {add === 'plugin' && <AddPlugin onClose={() => setAdd(null)} />}
      {register && <RegisterMcp integrationId={register} discovered={(q.data?.find((x) => x.id === register)?.discovered ?? []) as { name: string; description: string }[]} onClose={() => setRegister(null)} />}
    </div>
  )
}

type Policy = { access: 'read' | 'write' | 'send' | 'delete' | 'admin'; requiresApproval: boolean; category: ToolCategory; retrySafe: boolean; timeoutMs: number }
const defaultPolicy = (access: Policy['access'] = 'read', category: ToolCategory = 'business_systems'): Policy => ({ access, requiresApproval: access !== 'read', category, retrySafe: access === 'read', timeoutMs: 20000 })

function PolicyEditor({ p, onChange }: { p: Policy; onChange: (p: Policy) => void }) {
  return (
    <div className="grid grid-cols-[7rem_10rem_auto_auto] items-center gap-2">
      <Select value={p.access} onValueChange={(v) => onChange({ ...p, access: v as Policy['access'], requiresApproval: v !== 'read' ? true : p.requiresApproval, retrySafe: v === 'read' ? p.retrySafe : false })}>
        <SelectTrigger className="h-8" aria-label="Access level">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {['read', 'write', 'send', 'delete', 'admin'].map((a) => (
            <SelectItem key={a} value={a}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={p.category} onValueChange={(v) => onChange({ ...p, category: v as ToolCategory })}>
        <SelectTrigger className="h-8" aria-label="Category">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TOOL_CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>
              {TOOL_CATEGORY_LABELS[c]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1.5 text-xs">
        <Checkbox checked={p.requiresApproval} onCheckedChange={(v) => onChange({ ...p, requiresApproval: !!v })} /> Approval per call
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <Checkbox checked={p.retrySafe} disabled={p.access !== 'read'} onCheckedChange={(v) => onChange({ ...p, retrySafe: !!v })} /> Safe to retry
      </label>
    </div>
  )
}

function AddMcp({ onClose }: { onClose: () => void }) {
  const [name, setName] = React.useState('')
  const [transport, setTransport] = React.useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = React.useState('')
  const [args, setArgs] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const [priv, setPriv] = React.useState(false)
  const add = useAction('tools.addMcp', { success: 'MCP server added. Connect & discover to list its tools.', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>Relay connects as an MCP client, lists the server’s tools, and you choose which ones to expose.</DialogDescription>
        </DialogHeader>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Transport">
          <Select value={transport} onValueChange={(v) => setTransport(v as 'stdio')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local command (stdio)</SelectItem>
              <SelectItem value="http">Remote URL (Streamable HTTP)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field label="Command" hint="Runs on this computer with a minimal environment.">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field label="Arguments (space-separated)">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={priv} onCheckedChange={setPriv} aria-label="Allow internal network" /> This server is on an internal network or localhost
            </label>
          </>
        )}
        <Field label="Bearer token (optional)" hint="Stored in the OS keychain; never shown to agents.">
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name || (transport === 'stdio' ? !command : !url)} loading={add.isPending} onClick={() => add.mutate({ name, config: { transport, command: command || undefined, args: args.split(' ').filter(Boolean), url: url || undefined, useBundledNode: false, allowPrivateNetwork: priv }, secret: secret || undefined })}>
            Add server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RegisterMcp({ integrationId, discovered, onClose }: { integrationId: string; discovered: { name: string; description: string }[]; onClose: () => void }) {
  const [sel, setSel] = React.useState<Record<string, Policy | undefined>>({})
  const reg = useAction('tools.registerMcpTools', { success: 'Tools registered. Approve them for teams in the catalog.', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Choose tools to expose</DialogTitle>
          <DialogDescription>Nothing is exposed by default. Set each tool’s access level yourself — the server’s own description doesn’t decide it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {discovered.map((t) => (
            <div key={t.name} className={cn('space-y-2 rounded-md border p-3', sel[t.name] && 'border-primary')}>
              <label className="flex items-start gap-2">
                <Checkbox checked={!!sel[t.name]} onCheckedChange={(v) => setSel({ ...sel, [t.name]: v ? defaultPolicy('read', 'workflow') : undefined })} className="mt-0.5" />
                <span>
                  <span className="font-mono text-sm">{t.name}</span>
                  <span className="block text-xs text-muted-foreground">{t.description}</span>
                </span>
              </label>
              {sel[t.name] && <PolicyEditor p={sel[t.name]!} onChange={(p) => setSel({ ...sel, [t.name]: p })} />}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!Object.values(sel).some(Boolean)} loading={reg.isPending} onClick={() => reg.mutate({ integrationId, tools: Object.entries(sel).filter(([, p]) => p).map(([name, p]) => ({ name, displayName: name.replace(/_/g, ' '), policy: p! })) })}>
            Register selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportOpenApi({ onClose }: { onClose: () => void }) {
  const [specText, setSpecText] = React.useState('')
  const [parsed, setParsed] = React.useState<Out<'tools.parseOpenApi'> | null>(null)
  const [name, setName] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [authType, setAuthType] = React.useState<'none' | 'api_key' | 'bearer' | 'basic'>('bearer')
  const [header, setHeader] = React.useState('x-api-key')
  const [secret, setSecret] = React.useState('')
  const [priv, setPriv] = React.useState(false)
  const [sel, setSel] = React.useState<Record<string, Policy | undefined>>({})
  const parse = useAction('tools.parseOpenApi', {
    invalidate: [],
    onSuccess: (p) => {
      setParsed(p)
      setName(p.title)
      setBaseUrl(p.servers[0] ?? '')
    }
  })
  const imp = useAction('tools.importOpenApi', { success: (r) => `Imported; ${r.registered.length} operation(s) registered`, onSuccess: onClose })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="max-w-3xl">
        <SheetTitle>Import an OpenAPI specification</SheetTitle>
        <SheetDescription>Select which operations to expose and set their access. A connected API never exposes every operation automatically.</SheetDescription>
        {!parsed ? (
          <div className="space-y-3">
            <Button variant="outline" onClick={async () => { const p = await call('app.openFile', { title: 'Choose an OpenAPI file', kind: 'spec' }); if (p) setSpecText(await call('tools.readSpecFile', { path: p })) }}>
              Choose file…
            </Button>
            <Field label="Or paste the specification (YAML or JSON)">
              <Textarea rows={12} className="font-mono text-xs" value={specText} onChange={(e) => setSpecText(e.target.value)} />
            </Field>
            <Button disabled={specText.length < 10} loading={parse.isPending} onClick={() => parse.mutate({ specText })}>
              Read specification
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Integration name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Base URL">
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </Field>
              <Field label="Authentication">
                <Select value={authType} onValueChange={(v) => setAuthType(v as 'bearer')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="api_key">API key header</SelectItem>
                    <SelectItem value="basic">Basic (user:password)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {authType !== 'none' && (
                <Field label="Secret" hint="Stored centrally; agents never see it.">
                  <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
                </Field>
              )}
              {authType === 'api_key' && (
                <Field label="Header name">
                  <Input value={header} onChange={(e) => setHeader(e.target.value)} />
                </Field>
              )}
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <Switch checked={priv} onCheckedChange={setPriv} aria-label="Internal API" /> This API is on an internal network or localhost (requests stay on this host only)
              </label>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{parsed.operations.length} operations</div>
              {parsed.operations.map((o) => (
                <div key={o.operationKey} className={cn('space-y-2 rounded-md border p-3', sel[o.operationKey] && 'border-primary')}>
                  <label className="flex items-start gap-2">
                    <Checkbox checked={!!sel[o.operationKey]} onCheckedChange={(v) => setSel({ ...sel, [o.operationKey]: v ? defaultPolicy(o.suggestedAccess) : undefined })} className="mt-0.5" />
                    <span>
                      <Badge tone={o.method === 'GET' ? 'neutral' : 'warning'}>{o.method}</Badge> <span className="font-mono text-xs">{o.path}</span>
                      <span className="block text-xs text-muted-foreground">{o.summary}</span>
                    </span>
                  </label>
                  {sel[o.operationKey] && <PolicyEditor p={sel[o.operationKey]!} onChange={(p) => setSel({ ...sel, [o.operationKey]: p })} />}
                </div>
              ))}
            </div>
            <Button
              disabled={!name || !baseUrl}
              loading={imp.isPending}
              onClick={() =>
                imp.mutate({
                  name,
                  specText,
                  baseUrl,
                  auth: { type: authType, headerName: authType === 'api_key' ? header : undefined },
                  secret: secret || undefined,
                  allowPrivateNetwork: priv,
                  operations: Object.entries(sel)
                    .filter(([, p]) => p)
                    .map(([operationKey, p]) => ({ operationKey, name: parsed.operations.find((o) => o.operationKey === operationKey)!.summary.slice(0, 80), policy: p! }))
                })
              }
            >
              Import
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function AddHttp({ onClose }: { onClose: () => void }) {
  const [f, setF] = React.useState({ integrationName: '', baseUrl: '', name: '', operationKey: '', description: '', method: 'POST' as 'POST', path: '/', queryParams: '', bodyParams: '', inputSchema: '{\n  "type": "object",\n  "properties": { "text": { "type": "string" } },\n  "required": ["text"]\n}', authType: 'bearer' as 'none' | 'api_key' | 'bearer' | 'basic', header: 'x-api-key', secret: '', priv: false })
  const [policy, setPolicy] = React.useState<Policy>(defaultPolicy('send', 'communication'))
  const add = useAction('tools.addHttpTool', { success: 'Tool registered', onSuccess: onClose })
  let schema: Record<string, unknown> | null = null
  try {
    schema = JSON.parse(f.inputSchema)
  } catch {
    schema = null
  }
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="max-w-2xl">
        <SheetTitle>Custom HTTP tool</SheetTitle>
        <SheetDescription>For example a Slack incoming webhook or your email API. Requests stay on the configured host, including redirects.</SheetDescription>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Service name">
            <Input value={f.integrationName} onChange={(e) => set({ integrationName: e.target.value })} placeholder="Slack" />
          </Field>
          <Field label="Base URL">
            <Input value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://hooks.slack.com" />
          </Field>
          <Field label="Tool name">
            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Post to #ops" />
          </Field>
          <Field label="Operation key" hint="lowercase_with_underscores">
            <Input value={f.operationKey} onChange={(e) => set({ operationKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          </Field>
          <Field label="Description" className="md:col-span-2">
            <Input value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Method">
            <Select value={f.method} onValueChange={(v) => set({ method: v as 'POST' })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Path" hint="Use {name} for path parameters">
            <Input value={f.path} onChange={(e) => set({ path: e.target.value })} />
          </Field>
          <Field label="Query parameters (comma-separated)">
            <Input value={f.queryParams} onChange={(e) => set({ queryParams: e.target.value })} />
          </Field>
          <Field label="Body fields (comma-separated; empty = all other inputs)">
            <Input value={f.bodyParams} onChange={(e) => set({ bodyParams: e.target.value })} />
          </Field>
          <Field label="Input schema (JSON Schema)" className="md:col-span-2" error={schema ? null : 'Not valid JSON'}>
            <Textarea rows={6} className="font-mono text-xs" value={f.inputSchema} onChange={(e) => set({ inputSchema: e.target.value })} />
          </Field>
          <Field label="Authentication">
            <Select value={f.authType} onValueChange={(v) => set({ authType: v as typeof f.authType })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (URL is the secret — e.g. webhook)</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="api_key">API key header</SelectItem>
                <SelectItem value="basic">Basic</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {f.authType !== 'none' && (
            <Field label="Secret">
              <Input type="password" value={f.secret} onChange={(e) => set({ secret: e.target.value })} />
            </Field>
          )}
          <div className="space-y-1.5 md:col-span-2">
            <div className="text-sm font-medium">Access & approval</div>
            <PolicyEditor p={policy} onChange={setPolicy} />
          </div>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Switch checked={f.priv} onCheckedChange={(v) => set({ priv: v })} aria-label="Internal host" /> Internal network / localhost host
          </label>
        </div>
        <Button
          disabled={!schema || !f.integrationName || !f.baseUrl || !f.name || !f.operationKey}
          loading={add.isPending}
          onClick={() =>
            add.mutate({
              integrationName: f.integrationName,
              baseUrl: f.baseUrl,
              auth: { type: f.authType, headerName: f.authType === 'api_key' ? f.header : undefined },
              secret: f.secret || undefined,
              allowPrivateNetwork: f.priv,
              tool: { name: f.name, operationKey: f.operationKey, description: f.description, method: f.method, path: f.path, queryParams: f.queryParams.split(',').map((s) => s.trim()).filter(Boolean), bodyParams: f.bodyParams.split(',').map((s) => s.trim()).filter(Boolean), inputSchema: schema!, outputSchema: {}, policy }
            })
          }
        >
          Register tool
        </Button>
      </SheetContent>
    </Sheet>
  )
}

function AddPlugin({ onClose }: { onClose: () => void }) {
  const [dir, setDir] = React.useState('${RESOURCES}/plugins/sla-calculator')
  const [manifest, setManifest] = React.useState<Out<'tools.inspectPlugin'> | null>(null)
  const [sel, setSel] = React.useState<Record<string, Policy | undefined>>({})
  const inspect = useAction('tools.inspectPlugin', { invalidate: [], onSuccess: setManifest })
  const reg = useAction('tools.registerPlugin', { success: 'Plugin tools registered', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Install a local plugin</DialogTitle>
          <DialogDescription>Plugins are TypeScript modules implementing Relay’s plugin interface (see resources/plugins/relay-plugin.d.ts). They are trusted code you install; each call runs in a worker thread with a timeout and receives no credentials.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Plugin folder" className="font-mono text-xs" />
          <Button variant="outline" onClick={async () => { const p = await call('app.openFile', { title: 'Choose a plugin folder', kind: 'folder' }); if (p) setDir(p) }}>
            Browse…
          </Button>
          <Button onClick={() => inspect.mutate({ dir })} loading={inspect.isPending}>
            Inspect
          </Button>
        </div>
        {manifest && (
          <div className="space-y-2">
            <div className="text-sm">
              <strong>{manifest.name}</strong> v{manifest.version}
            </div>
            {manifest.tools.map((t) => (
              <div key={t.name} className="space-y-2 rounded-md border p-3">
                <label className="flex items-start gap-2">
                  <Checkbox checked={!!sel[t.name]} onCheckedChange={(v) => setSel({ ...sel, [t.name]: v ? defaultPolicy(t.access as Policy['access'], t.category as ToolCategory) : undefined })} className="mt-0.5" />
                  <span>
                    <span className="font-mono text-sm">{t.name}</span> <Badge tone="neutral">requests {t.access}</Badge>
                    <span className="block text-xs text-muted-foreground">{t.description}</span>
                  </span>
                </label>
                {sel[t.name] && <PolicyEditor p={sel[t.name]!} onChange={(p) => setSel({ ...sel, [t.name]: p })} />}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!manifest || !Object.values(sel).some(Boolean)} loading={reg.isPending} onClick={() => reg.mutate({ dir, tools: Object.entries(sel).filter(([, p]) => p).map(([name, policy]) => ({ name, policy: policy! })) })}>
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Tester() {
  const q = useApi('tools.catalog')
  const [key, setKey] = React.useState('')
  const [args, setArgs] = React.useState('{}')
  const [confirm, setConfirm] = React.useState(false)
  const test = useAction('tools.test', { invalidate: ['tools.'] })
  const tool = q.data?.tools.find((t) => t.key === key)
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(args)
  } catch {
    parsed = null
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Test a tool</CardTitle>
          <CardDescription>Diagnose integrations before employees depend on them. Calls run as you, with your data access.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Tool">
            <Select value={key} onValueChange={(v) => { setKey(v); setArgs(JSON.stringify(exampleArgs(q.data?.tools.find((t) => t.key === v)?.inputSchema), null, 2)); setConfirm(false) }}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a tool" />
              </SelectTrigger>
              <SelectContent>
                {(q.data?.tools ?? []).filter((t) => t.kind !== 'catalog').map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.name} ({t.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {tool && <JsonView value={tool.inputSchema} maxHeight={160} />}
          <Field label="Arguments (JSON)" error={parsed ? null : 'Not valid JSON'}>
            <Textarea rows={8} className="font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
          {tool && tool.access !== 'read' && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={confirm} onCheckedChange={(v) => setConfirm(!!v)} className="mt-0.5" /> This {tool.access} tool points at a test environment; running it may change data there.
            </label>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={!key || !parsed || (tool?.access !== 'read' && !confirm)} loading={test.isPending} onClick={() => test.mutate({ key, args: parsed!, confirmSideEffects: confirm })}>
            Run test call
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Result</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!test.data && <p className="text-sm text-muted-foreground">Run a call to see its output, timing and errors.</p>}
          {test.data && (
            <>
              <StatusBadge status={test.data.ok ? 'succeeded' : 'failed'} /> <span className="text-xs text-muted-foreground">{test.data.durationMs} ms</span>
              {test.data.ok ? <JsonView value={test.data.output} maxHeight={420} /> : <Alert tone="danger">{test.data.error}</Alert>}
              {test.data.logs.map((l, i) => (
                <div key={i} className="text-xs text-muted-foreground">
                  {l}
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function exampleArgs(schema: unknown): Record<string, unknown> {
  const s = schema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined
  const out: Record<string, unknown> = {}
  for (const k of s?.required ?? []) {
    const p = s?.properties?.[k]
    out[k] = p?.enum?.[0] ?? (p?.type === 'number' || p?.type === 'integer' ? 0 : p?.type === 'array' ? [] : p?.type === 'object' ? {} : p?.type === 'boolean' ? false : '')
  }
  return out
}

function Webhooks() {
  const q = useApi('tools.webhooks')
  const agents = useApi('agents.list')
  const [direction, setDirection] = React.useState<'inbound' | 'outbound'>('outbound')
  const [name, setName] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [agentId, setAgentId] = React.useState<string>('any')
  const [events, setEvents] = React.useState<string[]>(['run.failed'])
  const [priv, setPriv] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)
  const settings = useApi('settings.get')
  const create = useAction('tools.createWebhook', { success: 'Webhook created', onSuccess: (r) => setSecret(r.secret) })
  const del = useAction('tools.deleteWebhook', { success: 'Deleted' })
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
      <div className="space-y-3">
        <Alert tone="info">Outbound webhooks POST signed JSON (header <code>x-relay-signature: sha256=…</code>) when events happen. Inbound webhooks start an agent from a signed request to Relay’s local API — external services cannot reach a loopback address unless you set up a gateway or tunnel.</Alert>
        <Query q={q}>
          {(hooks) =>
            hooks.length === 0 ? (
              <EmptyState icon={Webhook} title="No webhooks" />
            ) : (
              <div className="space-y-2">
                {hooks.map((h) => (
                  <Card key={h.id}>
                    <CardContent className="flex items-center gap-3 pt-4">
                      <Badge tone={h.direction === 'inbound' ? 'info' : 'neutral'}>{h.direction}</Badge>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="font-medium">{h.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {h.direction === 'outbound' ? `${h.url} · ${h.events.join(', ')}` : `Starts ${h.agentName} · POST ${settings.data?.api.url ?? 'http://127.0.0.1:<port>'}/v1/hooks/${h.id}`}
                          {h.lastStatus && ` · last: ${h.lastStatus}`}
                        </div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: h.id })}>
                        Delete
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          }
        </Query>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>New webhook</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Direction">
            <Select value={direction} onValueChange={(v) => setDirection(v as 'inbound')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outbound">Outbound (Relay → your service)</SelectItem>
                <SelectItem value="inbound">Inbound (starts an agent)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {direction === 'outbound' && (
            <>
              <Field label="Destination URL">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <div className="space-y-1">
                {['run.completed', 'run.failed', 'review.requested', 'approval.decided'].map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={events.includes(ev)} onCheckedChange={(v) => setEvents(v ? [...events, ev] : events.filter((x) => x !== ev))} />
                    {ev}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={priv} onCheckedChange={setPriv} aria-label="Internal destination" /> Destination is internal / localhost
              </label>
            </>
          )}
          <Field label={direction === 'inbound' ? 'Agent to start' : 'Only for agent (optional)'}>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {direction === 'outbound' && <SelectItem value="any">Any agent</SelectItem>}
                {(agents.data ?? []).filter((a) => !a.isTemplate).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button disabled={!name || (direction === 'outbound' ? !url : agentId === 'any')} loading={create.isPending} onClick={() => create.mutate({ direction, name, url: url || undefined, agentId: agentId === 'any' ? null : agentId, events: direction === 'outbound' ? (events as never) : [], allowPrivateNetwork: priv })}>
            Create
          </Button>
          {secret && (
            <Alert tone="warning" title="Signing secret (shown once)">
              <code className="break-all">{secret}</code>
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(secret).then(() => toast.success('Copied'))}>
                <Copy /> Copy
              </Button>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
