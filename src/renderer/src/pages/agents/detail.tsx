import * as React from 'react'
import {
  CalendarClock,
  ChevronRight,
  CircleCheck,
  FlaskConical,
  GitCompare,
  History,
  Lightbulb,
  Pause,
  Play,
  Power,
  Rocket,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Undo2,
  Users,
  Webhook,
  ListChecks,
  PlayCircle,
  Copy
} from 'lucide-react'
import { toast } from 'sonner'
import type { AgentSpec } from '@shared/domain'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { navigate, setQuery, useLeaveGuard, useRoute } from '@/lib/router'
import { dateTime, money, pct, short, when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Switch } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog, EmptyState, Field, JsonView, KeyValue, Loading, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'
import { SpecEditor, validateSpec } from '@/components/app/spec-editor'
import { useSession } from '@/components/app/shell'
import { RunsTable } from '../runs/list'

type Agent = Out<'agents.get'>

export function AgentDetailPage({ id }: { id: string }) {
  const { query } = useRoute()
  const q = useApi('agents.get', { id })
  const tab = query.tab ?? 'overview'
  return (
    <Query q={q}>
      {(a) => (
        <>
          <PageHeader
            breadcrumb={<a href="#/agents">Agents</a>}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {a.name}
                <StatusBadge status={a.status} />
                {a.killSwitch && <StatusBadge status="blocked" label="Kill switch on" />}
                {a.isTemplate && <Badge tone="neutral">Template (read-only)</Badge>}
              </span>
            }
            description={a.description || undefined}
            actions={<PrimaryActions a={a} />}
          />
          {query.created === '1' && a.status === 'draft' && (
            <Alert tone="success" title="Agent created as a draft" className="mb-4" action={<Button size="sm" onClick={() => setQuery({ tab: 'test', created: null })}>Run a test</Button>}>
              Next, run it in Test with sample inputs. Test runs use the same permissions and budgets, and nothing goes live until you deploy.
            </Alert>
          )}
          <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v, created: null })}>
            <TabsList>
              <TabsTrigger value="overview">
                <ListChecks /> Overview
              </TabsTrigger>
              <TabsTrigger value="steps">Steps</TabsTrigger>
              {!a.isTemplate && (
                <>
                  <TabsTrigger value="test">
                    <FlaskConical /> Test
                  </TabsTrigger>
                  <TabsTrigger value="runs">Runs</TabsTrigger>
                  <TabsTrigger value="versions">
                    <History /> Versions
                  </TabsTrigger>
                  <TabsTrigger value="schedule">
                    <CalendarClock /> Schedule & triggers
                  </TabsTrigger>
                  <TabsTrigger value="improve">
                    <Lightbulb /> Improvements
                  </TabsTrigger>
                  <TabsTrigger value="settings">
                    <Settings2 /> Settings
                  </TabsTrigger>
                </>
              )}
            </TabsList>
            <TabsContent value="overview">
              <Overview a={a} />
            </TabsContent>
            <TabsContent value="steps">
              <StepsTab a={a} />
            </TabsContent>
            {!a.isTemplate && (
              <>
                <TabsContent value="test">
                  <TestTab a={a} />
                </TabsContent>
                <TabsContent value="runs">
                  <RunsTab a={a} />
                </TabsContent>
                <TabsContent value="versions">
                  <VersionsTab a={a} />
                </TabsContent>
                <TabsContent value="schedule">
                  <ScheduleTab a={a} />
                </TabsContent>
                <TabsContent value="improve">
                  <ImproveTab a={a} />
                </TabsContent>
                <TabsContent value="settings">
                  <SettingsTab a={a} />
                </TabsContent>
              </>
            )}
          </Tabs>
        </>
      )}
    </Query>
  )
}

function PrimaryActions({ a }: { a: Agent }) {
  const useTemplate = useAction('agents.useTemplate', { success: 'Created your copy as a draft', onSuccess: (r) => navigate(`/agents/${r.id}?tab=steps`) })
  const state = useAction('agents.state', { success: (d) => null })
  if (a.isTemplate) return <Button onClick={() => useTemplate.mutate({ templateId: a.id })} loading={useTemplate.isPending}>Use this template</Button>
  if (!a.canOversee) return null
  return (
    <>
      {a.status === 'live' && (
        <Button variant="outline" onClick={() => state.mutate({ id: a.id, action: 'pause' }, { onSuccess: () => toast.success('Paused. Schedules and API triggers will not start new runs.') })}>
          <Pause /> Pause
        </Button>
      )}
      {a.status === 'paused' && (
        <Button variant="outline" onClick={() => state.mutate({ id: a.id, action: 'resume' }, { onSuccess: () => toast.success('Live again') })}>
          <Play /> Resume
        </Button>
      )}
      {a.status === 'live' && !a.killSwitch && (
        <Button onClick={() => setQuery({ tab: 'test', env: 'live' })}>
          <PlayCircle /> Run now
        </Button>
      )}
      {(a.status === 'draft' || a.status === 'tested') && a.canEdit && (
        <Button onClick={() => setQuery({ tab: a.status === 'draft' ? 'test' : 'overview' })}>{a.status === 'draft' ? <><FlaskConical /> Run a test</> : <><Rocket /> Deploy</>}</Button>
      )}
    </>
  )
}

const LIFECYCLE = ['draft', 'tested', 'awaiting_approval', 'live'] as const

function Overview({ a }: { a: Agent }) {
  const est = useApi('agents.estimate', { id: a.id })
  const [checks, setChecks] = React.useState<Out<'agents.readiness'> | null>(null)
  const readiness = useAction('agents.readiness', { quiet: false, invalidate: [], onSuccess: (r) => setChecks(r) })
  React.useEffect(() => {
    readiness.mutate({ id: a.id, runConnectionChecks: false })
  }, [a.id, a.draftVersionId])
  const current = a.status === 'paused' || a.status === 'archived' ? 'live' : a.status
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
            <CardDescription>
              <strong>Test</strong> runs check your agent with sample inputs. <strong>Live</strong> is the approved version that runs on demand, on a schedule, or via triggers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-wrap items-center gap-2 text-sm">
              {LIFECYCLE.map((s, i) => {
                const idx = LIFECYCLE.indexOf(current as (typeof LIFECYCLE)[number])
                return (
                  <li key={s} className="flex items-center gap-2">
                    <span className={cn('rounded-md border px-2 py-1', i === idx ? 'border-primary bg-accent font-medium' : i < idx ? 'text-foreground' : 'text-muted-foreground')}>
                      {i < idx && <CircleCheck className="mr-1 inline size-3.5 text-success" aria-hidden />}
                      {{ draft: 'Draft', tested: 'Tested', awaiting_approval: 'Awaiting approval (if required)', live: 'Live' }[s]}
                    </span>
                    {i < LIFECYCLE.length - 1 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
                  </li>
                )
              })}
              <li className="text-muted-foreground">→ Paused / Archived</li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
              {a.liveVersionId && <Badge tone="success">Live: v{a.versions.find((v) => v.isLive)?.version}</Badge>}
              {a.draft && <Badge tone="neutral">Draft: v{a.draft.version}{a.draft.testedRunId ? ' (tested)' : ' (not tested)'}</Badge>}
              <span>
                Owner: {a.ownerName} · {a.deployment ? `${a.deployment === 'team' ? 'Team' : 'Personal'} deployment` : 'Not deployed'}
              </span>
            </div>
            {a.pendingApproval && (
              <Alert tone="warning" className="mt-3" title="Waiting for approval" action={<Button size="sm" variant="outline" onClick={() => navigate(`/approvals/${a.pendingApproval!.id}`)}>View request</Button>}>
                A deployment or improvement request for this agent is pending.
              </Alert>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4" aria-hidden /> Readiness check
              </CardTitle>
              <CardDescription>Can this agent access the required data, perform each action, and verify its output?</CardDescription>
            </div>
            <Button size="sm" variant="outline" loading={readiness.isPending} onClick={() => readiness.mutate({ id: a.id, runConnectionChecks: true })}>
              Re-check connections
            </Button>
          </CardHeader>
          <CardContent>{checks ? <ReadinessList a={a} r={checks} /> : <Loading label="Checking…" />}</CardContent>
          {!a.isTemplate && a.canEdit && checks && <DeployFooter a={a} ready={checks.ready} />}
        </Card>
      </div>
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>Estimated cost per run</CardTitle>
            <CardDescription>Before running. Actual usage is metered from provider-reported tokens.</CardDescription>
          </CardHeader>
          <CardContent>
            <Query q={est}>
              {(e) => (
                <div className="space-y-2 text-sm">
                  <div className="text-2xl font-semibold tabular-nums">{e.lines.length ? money(e.totalUsd) : '$0.00'}</div>
                  {e.lines.map((l, i) => (
                    <div key={i} className="flex justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {l.step}: {l.basis}
                      </span>
                      <span className="tabular-nums">{l.usd === null ? 'unknown' : money(l.usd)}</span>
                    </div>
                  ))}
                  {e.lines.length === 0 && <p className="text-xs text-muted-foreground">Only local tools: no API charges.</p>}
                  {e.unknownPricing.length > 0 && <Alert tone="warning">Pricing unknown for: {e.unknownPricing.join(', ')}. Unknown pricing is never counted as free — those calls are blocked until a price is set.</Alert>}
                  <p className="text-xs text-muted-foreground">{e.assumptions}</p>
                </div>
              )}
            </Query>
          </CardContent>
        </Card>
        {!a.isTemplate && a.canOversee && <KillSwitch a={a} />}
      </div>
    </div>
  )
}

function ReadinessList({ a, r }: { a: Agent; r: Out<'agents.readiness'> }) {
  const [reqTool, setReqTool] = React.useState<string | null>(null)
  const [reqData, setReqData] = React.useState<string | null>(null)
  const tool = useAction('tools.requestAccess', { success: 'Request sent for approval', onSuccess: () => setReqTool(null) })
  const data = useAction('data.requestAccess', { success: 'Request sent for approval', onSuccess: () => setReqData(null) })
  const titles = new Map((a.draft?.spec.steps ?? []).map((s) => [s.id, s.title]))
  return (
    <div className="space-y-3">
      <Alert tone={r.ready ? (r.checks.some((c) => c.status === 'warn') ? 'warning' : 'success') : 'danger'}>{r.summary}</Alert>
      <ul className="divide-y rounded-md border">
        {r.checks.map((c, i) => (
          <li key={i} className="flex flex-wrap items-start gap-3 px-3 py-2">
            <StatusBadge status={c.status} label={c.status === 'ok' ? 'OK' : undefined} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">
                {c.stepId ? <span className="text-muted-foreground">{titles.get(c.stepId)} · </span> : null}
                {c.label}
              </div>
              <div className="text-xs text-muted-foreground">{c.detail}</div>
            </div>
            {c.fix?.kind === 'request_tool' && c.fix.toolKey && (
              <Button size="sm" variant="outline" onClick={() => setReqTool(c.fix!.toolKey!)}>
                Request access
              </Button>
            )}
            {c.fix?.kind === 'request_data' && c.fix.collectionId && (
              <Button size="sm" variant="outline" onClick={() => setReqData(c.fix!.collectionId!)}>
                Request data access
              </Button>
            )}
            {(c.fix?.kind === 'human_handoff' || c.fix?.kind === 'alternative') && (
              <Button size="sm" variant="outline" onClick={() => setQuery({ tab: 'steps' })}>
                {c.fix.kind === 'alternative' ? `Use an alternative${c.fix.alternatives?.length ? ` (${c.fix.alternatives.length})` : ''}` : 'Hand to a person'}
              </Button>
            )}
            {c.fix?.kind === 'test' && (
              <Button size="sm" variant="outline" onClick={() => setQuery({ tab: 'test' })}>
                Run a test
              </Button>
            )}
            {c.fix?.kind === 'configure' && <span className="text-xs text-muted-foreground">Ask an administrator</span>}
          </li>
        ))}
      </ul>
      <ReasonDialog open={!!reqTool} onOpenChange={(o) => !o && setReqTool(null)} title="Request tool access" description="Administrators approve tool access per team." onSubmit={(reason) => reqTool && tool.mutate({ toolKey: reqTool, reason })} loading={tool.isPending} />
      <ReasonDialog open={!!reqData} onOpenChange={(o) => !o && setReqData(null)} title="Request data access" description="Your manager or an administrator decides." onSubmit={(reason) => reqData && data.mutate({ collectionId: reqData, purposes: ['retrieval'], reason })} loading={data.isPending} />
    </div>
  )
}

function DeployFooter({ a, ready }: { a: Agent; ready: boolean }) {
  const [teamOpen, setTeamOpen] = React.useState(false)
  const deploy = useAction('agents.deploy', {
    success: (r) => (r.status === 'live' ? 'Deployed. This version is live for you.' : 'Sent for approval. You’ll be notified when it’s decided.'),
    onSuccess: () => setTeamOpen(false)
  })
  const isLiveDraft = a.liveVersionId === a.draftVersionId
  return (
    <CardFooter className="flex-wrap justify-between">
      <span className="text-xs text-muted-foreground">{isLiveDraft && a.status === 'live' ? 'The draft is the live version.' : 'Deploying makes the current draft version live.'}</span>
      <div className="flex gap-2">
        <Button variant="outline" disabled={!ready || a.status === 'awaiting_approval' || (isLiveDraft && a.status === 'live')} onClick={() => setTeamOpen(true)}>
          <Users /> Request team deployment
        </Button>
        <Button disabled={!ready || a.status === 'awaiting_approval' || (isLiveDraft && a.status === 'live')} loading={deploy.isPending && deploy.variables?.mode === 'personal'} onClick={() => deploy.mutate({ id: a.id, mode: 'personal', reason: '' })}>
          <Rocket /> Go live for me
        </Button>
      </div>
      <ReasonDialog open={teamOpen} onOpenChange={setTeamOpen} title="Request team deployment" description="Your manager reviews shared deployments within admin-defined limits." placeholder="Who will use it and why?" confirmLabel="Send request" onSubmit={(reason) => deploy.mutate({ id: a.id, mode: 'team', reason })} loading={deploy.isPending} />
    </CardFooter>
  )
}

function KillSwitch({ a }: { a: Agent }) {
  const [open, setOpen] = React.useState(false)
  const state = useAction('agents.state', { success: a.killSwitch ? 'Kill switch off' : 'Kill switch on: live runs stopped', onSuccess: () => setOpen(false) })
  return (
    <Card className={a.killSwitch ? 'border-danger/40' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Power className="size-4" aria-hidden /> Kill switch
        </CardTitle>
        <CardDescription>Immediately stops in-progress live runs and blocks new ones. Completed actions are not undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant={a.killSwitch ? 'outline' : 'destructive'} onClick={() => (a.killSwitch ? state.mutate({ id: a.id, action: 'kill_off' }) : setOpen(true))} loading={state.isPending}>
          {a.killSwitch ? 'Turn kill switch off' : 'Turn kill switch on'}
        </Button>
      </CardContent>
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Stop this agent now?" description="All running live runs are cancelled and no new live runs can start until the switch is turned off." destructive confirmLabel="Stop agent" onConfirm={() => state.mutate({ id: a.id, action: 'kill_on' })} loading={state.isPending} />
    </Card>
  )
}

function StepsTab({ a }: { a: Agent }) {
  const [spec, setSpec] = React.useState<AgentSpec | null>(a.draft?.spec ?? null)
  const [dirty, setDirty] = React.useState(false)
  const [note, setNote] = React.useState('')
  const save = useAction('agents.save', { success: (r) => (r.versionId !== a.draftVersionId ? 'Saved as a new draft version. Test it before deploying.' : 'Saved'), onSuccess: () => setDirty(false) })
  React.useEffect(() => {
    if (!dirty) setSpec(a.draft?.spec ?? null)
  }, [a.draft?.id])
  useLeaveGuard(dirty ? 'You have unsaved changes to this agent. Leave without saving?' : null)
  if (!spec) return <EmptyState title="No draft version" />
  const issues = validateSpec(spec)
  return (
    <div className="space-y-4">
      {a.status === 'live' && !a.isTemplate && <Alert tone="info">Saving creates a new draft version. Live keeps running its current version until you test and deploy the new one.</Alert>}
      <SpecEditor spec={spec} onChange={(s) => { setSpec(s); setDirty(true) }} readOnly={!a.canEdit} />
      {a.canEdit && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background/95 py-3">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" className="max-w-md" aria-label="Change note" />
          <div className="flex-1 text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'All changes saved'}</div>
          <Button variant="outline" disabled={!dirty} onClick={() => { setSpec(a.draft?.spec ?? null); setDirty(false) }}>
            Discard
          </Button>
          <Button disabled={!dirty || issues.length > 0} loading={save.isPending} onClick={() => save.mutate({ id: a.id, spec, note: note || undefined })}>
            <Save /> Save
          </Button>
        </div>
      )}
    </div>
  )
}

function TestTab({ a }: { a: Agent }) {
  const { query } = useRoute()
  const spec = a.draft?.spec
  const [env, setEnv] = React.useState<'test' | 'live'>(query.env === 'live' && a.status === 'live' ? 'live' : 'test')
  const liveSpec = a.versions.find((v) => v.isLive)
  const [inputs, setInputs] = React.useState<Record<string, unknown>>(() => Object.fromEntries((spec?.inputs ?? []).map((f) => [f.key, f.default ?? (f.type === 'boolean' ? false : '')])))
  const start = useAction('runs.start', { success: 'Run started', onSuccess: (r) => navigate(`/runs/${r.id}`) })
  if (!spec) return null
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader>
          <CardTitle>Run with inputs</CardTitle>
          <CardDescription>{env === 'test' ? `Test runs the draft (v${a.draft?.version}). Data-changing external tools ask for your approval first.` : `Runs the live version (v${liveSpec?.version}).`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2" role="radiogroup" aria-label="Environment">
            <Button variant={env === 'test' ? 'default' : 'outline'} size="sm" role="radio" aria-checked={env === 'test'} onClick={() => setEnv('test')}>
              <FlaskConical /> Test
            </Button>
            <Button variant={env === 'live' ? 'default' : 'outline'} size="sm" role="radio" aria-checked={env === 'live'} disabled={a.status !== 'live' || a.killSwitch} onClick={() => setEnv('live')}>
              <Rocket /> Live
            </Button>
          </div>
          {spec.inputs.length === 0 && <p className="text-sm text-muted-foreground">This agent takes no inputs.</p>}
          {spec.inputs.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.description || undefined} htmlFor={`in-${f.key}`}>
              {f.type === 'text' ? (
                <Textarea id={`in-${f.key}`} rows={4} value={String(inputs[f.key] ?? '')} onChange={(e) => setInputs({ ...inputs, [f.key]: e.target.value })} />
              ) : f.type === 'boolean' ? (
                <Switch checked={!!inputs[f.key]} onCheckedChange={(v) => setInputs({ ...inputs, [f.key]: v })} />
              ) : (
                <Input id={`in-${f.key}`} type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'} value={String(inputs[f.key] ?? '')} onChange={(e) => setInputs({ ...inputs, [f.key]: e.target.value })} placeholder={f.type === 'url' ? 'https://' : undefined} />
              )}
            </Field>
          ))}
        </CardContent>
        <CardFooter className="justify-end">
          <Button loading={start.isPending} onClick={() => start.mutate({ agentId: a.id, environment: env, inputs })}>
            <Play /> {env === 'test' ? 'Run test' : 'Run live now'}
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What happens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>You’ll see each step as it runs: tool calls, outputs, and short explanations.</p>
          <p>You can pause, cancel, or retry a failed step. Review steps wait for you; resuming never repeats completed writes.</p>
          <p>Costs are reserved from your budgets before paid calls and reconciled afterwards.</p>
        </CardContent>
      </Card>
    </div>
  )
}

function RunsTab({ a }: { a: Agent }) {
  const q = useApi('runs.list', { agentId: a.id })
  return <Query q={q}>{(runs) => (runs.length ? <Card><RunsTable runs={runs} hideAgent /></Card> : <EmptyState icon={PlayCircle} title="No runs yet">Run a test from the Test tab.</EmptyState>)}</Query>
}

function VersionsTab({ a }: { a: Agent }) {
  const [diff, setDiff] = React.useState<{ from: string; to: string; changes: string[] } | null>(null)
  const [rollbackTo, setRollbackTo] = React.useState<string | null>(null)
  const rollback = useAction('agents.rollback', { success: (r) => `Live now runs v${r.liveVersion}. ${r.note}`, onSuccess: () => setRollbackTo(null) })
  const restore = useAction('agents.restoreDraft', { success: 'Restored as a new draft version', onSuccess: () => setQuery({ tab: 'steps' }) })
  const versions = a.versions
  return (
    <div className="space-y-4">
      <Alert tone="neutral">Each version bundles instructions, tools (with pinned tool versions), data permissions and model references. Existing runs keep the version they started with. Rolling back changes which version runs next; it does not undo rows written, files exported, or messages already sent.</Alert>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Tested</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v, i) => (
              <TableRow key={v.id}>
                <TableCell className="font-medium">
                  v{v.version} {v.isLive && <Badge tone="success">Live</Badge>} {v.isDraft && <Badge tone="neutral">Draft</Badge>} {v.source === 'proposal' && <Badge tone="info">Candidate</Badge>}
                </TableCell>
                <TableCell className="text-muted-foreground">{dateTime(v.createdAt)}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">{v.note}</TableCell>
                <TableCell>{v.testedRunId ? <StatusBadge status="succeeded" label="Passed test" /> : <span className="text-xs text-muted-foreground">Not tested</span>}</TableCell>
                <TableCell className="space-x-1 text-right">
                  {versions[i + 1] && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => setDiff({ from: versions[i + 1].id, to: v.id, changes: await call('agents.diff', { id: a.id, from: versions[i + 1].id, to: v.id }) })}
                    >
                      <GitCompare /> Changes
                    </Button>
                  )}
                  {a.canEdit && !v.isDraft && (
                    <Button size="sm" variant="ghost" onClick={() => restore.mutate({ id: a.id, versionId: v.id })}>
                      Edit from here
                    </Button>
                  )}
                  {a.canEdit && !v.isLive && a.liveVersionId && (
                    <Button size="sm" variant="outline" onClick={() => setRollbackTo(v.id)}>
                      <Undo2 /> Roll back live
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {diff && (
        <Card>
          <CardHeader>
            <CardTitle>
              Changes in v{versions.find((v) => v.id === diff.to)?.version} since v{versions.find((v) => v.id === diff.from)?.version}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diff.changes.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {diff.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No differences.</p>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={!!rollbackTo}
        onOpenChange={(o) => !o && setRollbackTo(null)}
        title="Roll back the live version?"
        description="Future runs use the selected version. Effects of earlier runs (written rows, exported files, created tickets) are not undone. Only versions that were previously live can be restored."
        confirmLabel="Roll back"
        onConfirm={() => rollbackTo && rollback.mutate({ id: a.id, versionId: rollbackTo })}
        loading={rollback.isPending}
      />
    </div>
  )
}

function ScheduleTab({ a }: { a: Agent }) {
  const settings = useApi('settings.get')
  const cfg = a.schedule?.config
  const [kind, setKind] = React.useState<'interval' | 'daily' | 'weekly'>(cfg?.kind ?? 'daily')
  const [every, setEvery] = React.useState(cfg?.everyMinutes ?? 60)
  const [time, setTime] = React.useState(cfg?.timeOfDay ?? '09:00')
  const [weekday, setWeekday] = React.useState(cfg?.weekday ?? 1)
  const [catchUp, setCatchUp] = React.useState<'run_once' | 'skip'>(cfg?.catchUp ?? 'run_once')
  const [inputsText, setInputsText] = React.useState(JSON.stringify(cfg?.inputs ?? Object.fromEntries((a.draft?.spec.inputs ?? []).map((f) => [f.key, f.default ?? ''])), null, 2))
  const save = useAction('agents.schedule', { success: 'Schedule saved' })
  const trig = useAction('agents.apiTrigger', { success: 'Saved' })
  let inputs: Record<string, unknown> | null = null
  try {
    inputs = JSON.parse(inputsText)
  } catch {
    inputs = null
  }
  const api = settings.data?.api
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Local schedule</CardTitle>
          <CardDescription>Runs the live version while Relay is open on this computer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert tone="warning">Scheduled runs do not happen while the computer is asleep or Relay is closed. Each missed time is recorded below. With “Run once to catch up”, Relay starts a single catch-up run the next time it can, no matter how many times were missed.</Alert>
          {a.status !== 'live' && <Alert tone="neutral">The agent must be live for scheduled runs to start.</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Repeat">
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interval">Every N minutes</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {kind === 'interval' ? (
              <Field label="Every (minutes)">
                <Input type="number" min={5} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
              </Field>
            ) : (
              <Field label="At (local time)">
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            )}
            {kind === 'weekly' && (
              <Field label="On">
                <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="If times were missed">
              <Select value={catchUp} onValueChange={(v) => setCatchUp(v as typeof catchUp)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="run_once">Run once to catch up</SelectItem>
                  <SelectItem value="skip">Skip until next time</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Inputs for scheduled runs (JSON)" error={inputs ? null : 'Not valid JSON'}>
            <Textarea className="font-mono text-xs" rows={4} value={inputsText} onChange={(e) => setInputsText(e.target.value)} />
          </Field>
        </CardContent>
        <CardFooter className="justify-between">
          <span className="text-xs text-muted-foreground">{a.schedule?.enabled ? `Next run: ${dateTime(a.schedule.nextRunAt)}` : 'No schedule'}</span>
          <div className="flex gap-2">
            {a.schedule?.enabled && (
              <Button variant="outline" onClick={() => save.mutate({ id: a.id, schedule: null })}>
                Turn off
              </Button>
            )}
            <Button disabled={!inputs || !a.canEdit} loading={save.isPending} onClick={() => save.mutate({ id: a.id, schedule: { kind, everyMinutes: kind === 'interval' ? every : undefined, timeOfDay: kind !== 'interval' ? time : undefined, weekday: kind === 'weekly' ? weekday : undefined, catchUp, inputs: inputs ?? {} } })}>
              Save schedule
            </Button>
          </div>
        </CardFooter>
        {a.schedule && a.schedule.events.length > 0 && (
          <CardContent>
            <div className="mb-2 text-sm font-medium">Recent scheduled times</div>
            <ul className="space-y-1 text-xs">
              {a.schedule.events.map((e, i) => (
                <li key={i} className="flex items-center gap-2">
                  <StatusBadge status={e.outcome === 'ran' ? 'succeeded' : e.outcome === 'catch_up_run' ? 'running' : e.outcome === 'missed' ? 'interrupted' : 'blocked'} label={e.outcome === 'ran' ? 'Ran' : e.outcome === 'catch_up_run' ? 'Catch-up run' : e.outcome === 'missed' ? 'Missed' : 'Not run'} />
                  <span className="tabular-nums">{dateTime(e.due_at)}</span>
                  {e.outcome.startsWith('not_run') && <span className="text-muted-foreground">{e.outcome.replace('not_run: ', '')}</span>}
                  {e.run_id && (
                    <a className="text-primary hover:underline" href={`#/runs/${e.run_id}`}>
                      View run
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="size-4" aria-hidden /> Local API trigger
          </CardTitle>
          <CardDescription>Let scripts on this computer start the live version over HTTP.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={!!a.apiTrigger?.enabled} disabled={!a.canEdit} onCheckedChange={(v) => trig.mutate({ id: a.id, enabled: v })} aria-label="Enable local API trigger" /> Allow starting this agent through the local API
          </label>
          {!api?.enabled && <Alert tone="neutral">The local API is off. An administrator can turn it on in Settings → Local API.</Alert>}
          {api?.enabled && a.apiTrigger?.enabled && (
            <>
              <p className="text-xs text-muted-foreground">{api.note} Requests must come from this computer; external services need a gateway or tunnel you set up yourself.</p>
              <div className="relative">
                <JsonView value={`curl -X POST ${api.url ?? 'http://127.0.0.1:' + api.port}/v1/agents/${a.id}/runs \\\n  -H "Authorization: Bearer ${api.secret ?? '<secret shown to admins and agent owners>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"inputs": ${short(JSON.stringify(inputs ?? {}), 200)}}'`} />
                <Button size="icon-sm" variant="ghost" className="absolute top-1 right-1" aria-label="Copy command" onClick={() => navigator.clipboard.writeText(`curl -X POST ${api.url}/v1/agents/${a.id}/runs -H "Authorization: Bearer ${api.secret}" -H "Content-Type: application/json" -d '{"inputs": {}}'`).then(() => toast.success('Copied'))}>
                  <Copy />
                </Button>
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">Signed inbound webhooks can also start this agent. Administrators create them in Tools → Webhooks.</p>
        </CardContent>
      </Card>
    </div>
  )
}

function ImproveTab({ a }: { a: Agent }) {
  const q = useApi('agents.improvements', { id: a.id })
  const [useModel, setUseModel] = React.useState(false)
  const propose = useAction('agents.proposeImprovements', { success: (r) => (r.created ? `${r.created} proposal(s) created` : (r.note ?? 'No proposals')) })
  return (
    <Query q={q}>
      {(d) => (
        <div className="space-y-5">
          <Alert tone="neutral">Proposals come from reviewed feedback and run history. They are checked on a held-out evaluation set that proposal generation never sees, and they need approval before going live. Nothing is trained automatically.</Alert>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Feedback</CardTitle>
                <CardDescription>{d.feedback.length} item(s) from run reviews</CardDescription>
              </CardHeader>
              <CardContent className="max-h-80 space-y-2 overflow-y-auto">
                {d.feedback.length === 0 && <p className="text-sm text-muted-foreground">Open a run and accept, correct, or report a failure.</p>}
                {d.feedback.map((f) => (
                  <a key={f.id} href={`#/runs/${f.run_id}`} className="block rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted">
                    <div className="flex items-center gap-2">
                      <Badge tone={f.kind === 'accept' ? 'success' : f.kind === 'failure' ? 'danger' : 'info'}>{f.kind === 'eval_example' ? 'Evaluation example' : f.kind}</Badge>
                      {f.category && <span className="text-xs text-muted-foreground">{f.category.replace(/_/g, ' ')}</span>}
                      <span className="ml-auto text-xs text-muted-foreground">{when(f.created_at)}</span>
                    </div>
                    {f.comment && <div className="mt-1 line-clamp-2 text-xs">{f.comment}</div>}
                  </a>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Evaluation set</CardTitle>
                <CardDescription>
                  {d.counts.holdout} held-out · {d.counts.improvement} for improvements
                </CardDescription>
              </CardHeader>
              <CardContent className="max-h-80 space-y-2 overflow-y-auto">
                {d.examples.length === 0 && <p className="text-sm text-muted-foreground">Add examples from reviewed runs (“Add as evaluation example”, or corrections).</p>}
                {d.examples.map((e) => (
                  <ExampleRow key={e.id} e={e} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Propose improvements</CardTitle>
                <CardDescription>Instruction, tool, workflow, checkpoint or model changes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={useModel} onCheckedChange={(v) => setUseModel(!!v)} className="mt-0.5" /> Use the configured model to word instruction changes (sends reviewer comments to the provider)
                </label>
                <Button onClick={() => propose.mutate({ id: a.id, useModel })} loading={propose.isPending}>
                  <Sparkles /> Generate proposals
                </Button>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-3">
            {d.proposals.length === 0 && <EmptyState icon={Lightbulb} title="No proposals yet">Proposals appear here after you generate them from reviewed feedback.</EmptyState>}
            {d.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}
    </Query>
  )
}

function ExampleRow({ e }: { e: Out<'agents.improvements'>['examples'][number] }) {
  const set = useAction('agents.setExampleSplit', { success: 'Updated', invalidate: ['agents.'] })
  return (
    <div className="rounded-md border px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <Badge tone={e.split === 'holdout' ? 'warning' : 'neutral'}>{e.split === 'holdout' ? 'Held-out' : 'Improvement'}</Badge>
        <span className="text-muted-foreground">{e.source.replace('_', ' ')}</span>
        <button className="ml-auto text-primary hover:underline" onClick={() => set.mutate({ id: e.id, split: e.split === 'holdout' ? 'improvement' : 'holdout' })}>
          Move to {e.split === 'holdout' ? 'improvement' : 'held-out'}
        </button>
      </div>
      <div className="mt-1 truncate text-muted-foreground">Inputs: {short(e.inputs, 90)}</div>
    </div>
  )
}

function ProposalCard({ p }: { p: Out<'agents.improvements'>['proposals'][number] }) {
  const evaluate = useAction('agents.evaluateProposal', { success: 'Evaluation finished' })
  const [submit, setSubmit] = React.useState(false)
  const submitM = useAction('agents.submitProposal', { success: 'Sent for approval', onSuccess: () => setSubmit(false) })
  const dismiss = useAction('agents.dismissProposal', { success: 'Dismissed' })
  const ev = p.evaluation as null | { examples: number; current: { meanScore: number; successRate: number; costUsd: number }; candidate: { meanScore: number; successRate: number; costUsd: number }; note: string }
  const kindLabel: Record<string, string> = { instruction_change: 'Instruction change', tool_selection: 'Tool selection', workflow_change: 'Workflow change', human_checkpoint: 'Human checkpoint', another_model: 'Another model', training_dataset: 'Candidate training dataset' }
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="primary">{kindLabel[p.kind] ?? p.kind}</Badge>
            <StatusBadge status={p.status} />
          </div>
          <CardTitle>{p.title}</CardTitle>
          <CardDescription>{p.rationale}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <KeyValue
          items={[
            ['Expected effect', p.expectedEffect],
            [
              'Evidence',
              <ul key="e" className="space-y-0.5">
                {(p.evidence as { runId: string; summary: string }[]).map((e, i) => (
                  <li key={i}>
                    <a className="text-primary hover:underline" href={`#/runs/${e.runId}`}>
                      Run
                    </a>{' '}
                    — {short(e.summary, 140)}
                  </li>
                ))}
              </ul>
            ]
          ]}
        />
        {ev && (
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>On {ev.examples} held-out examples</TableHead>
                  <TableHead className="text-right">Match score</TableHead>
                  <TableHead className="text-right">Runs succeeded</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Current version</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(ev.current.meanScore)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(ev.current.successRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(ev.current.costUsd)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Proposed version</TableCell>
                  <TableCell className={cn('text-right font-medium tabular-nums', ev.candidate.meanScore > ev.current.meanScore ? 'text-success' : ev.candidate.meanScore < ev.current.meanScore ? 'text-danger' : '')}>{pct(ev.candidate.meanScore)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(ev.candidate.successRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(ev.candidate.costUsd)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">{ev.note}</p>
          </div>
        )}
      </CardContent>
      {['proposed', 'evaluated'].includes(p.status) && (
        <CardFooter className="justify-end">
          <Button variant="ghost" onClick={() => dismiss.mutate({ id: p.id })}>
            Dismiss
          </Button>
          {p.kind !== 'training_dataset' && (
            <Button variant="outline" onClick={() => evaluate.mutate({ id: p.id })} loading={evaluate.isPending}>
              Evaluate on held-out set
            </Button>
          )}
          {p.status === 'evaluated' && <Button onClick={() => setSubmit(true)}>Request deployment</Button>}
        </CardFooter>
      )}
      <ReasonDialog open={submit} onOpenChange={setSubmit} title="Request deployment of this improvement" description="Your manager reviews it with the evaluation results." onSubmit={(reason) => submitM.mutate({ id: p.id, reason })} loading={submitM.isPending} />
    </Card>
  )
}

function SettingsTab({ a }: { a: Agent }) {
  const s = useSession()
  const dir = useApi('directory.get')
  const budget = useApi('budget.overview')
  const settings = useAction('agents.settings', { success: 'Saved' })
  const archive = useAction('agents.state', { success: 'Archived', onSuccess: () => navigate('/agents') })
  const [archiveOpen, setArchiveOpen] = React.useState(false)
  const [incOpen, setIncOpen] = React.useState(false)
  const [newLimit, setNewLimit] = React.useState(50)
  const req = useAction('budget.requestIncrease', { success: 'Budget increase requested', onSuccess: () => setIncOpen(false) })
  const team = (dir.data?.users ?? []).filter((u) => u.team_id === a.teamId)
  const b = budget.data?.budgets.find((x) => x.scope === 'agent' && x.scopeId === a.id)
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Ownership & failure notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Owner" hint="The owner is notified about reviews and failures. Managers can reassign within their team.">
            <Select value={a.ownerId} disabled={!(s.actor.role !== 'employee')} onValueChange={(v) => settings.mutate({ id: a.id, ownerId: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {team.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} — {u.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-1.5">
            <div className="text-sm font-medium">Also notify on failure</div>
            {team
              .filter((u) => u.id !== a.ownerId)
              .map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={a.notifyOnFailure.includes(u.id)}
                    disabled={!a.canEdit}
                    onCheckedChange={(v) => settings.mutate({ id: a.id, notifyOnFailure: v ? [...a.notifyOnFailure, u.id] : a.notifyOnFailure.filter((x) => x !== u.id) })}
                  />
                  {u.name}
                </label>
              ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Operating budget for this agent</CardTitle>
          <CardDescription>Monthly hard limit. Paid calls reserve their estimated cost first.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {b ? (
            <>
              <KeyValue items={[['Limit', money(b.limitUsd, 2)], ['Spent', money(b.chargedUsd)], ['Reserved (in progress)', money(b.reservedUsd)], ['Remaining', money(b.remainingUsd)]]} />
              <Button variant="outline" size="sm" onClick={() => { setNewLimit(Math.max(b.limitUsd * 2, 10)); setIncOpen(true) }}>
                Request increase
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No agent-level budget.</p>
          )}
        </CardContent>
      </Card>
      {a.canEdit && (
        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle>Archive</CardTitle>
            <CardDescription>Stops schedules and hides the agent. Run history is kept.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => setArchiveOpen(true)}>
              Archive agent
            </Button>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive this agent?" destructive confirmLabel="Archive" onConfirm={() => archive.mutate({ id: a.id, action: 'archive' })} loading={archive.isPending} />
      <ReasonDialog open={incOpen} onOpenChange={setIncOpen} title="Request a budget increase" description="Managers can approve agent budgets up to their ceiling; larger increases go to an administrator." onSubmit={(reason) => b && req.mutate({ budgetId: b.id, newLimitUsd: newLimit, reason })} loading={req.isPending}>
        <Field label="New monthly limit (USD)">
          <Input type="number" min={1} value={newLimit} onChange={(e) => setNewLimit(Number(e.target.value))} />
        </Field>
      </ReasonDialog>
    </div>
  )
}
