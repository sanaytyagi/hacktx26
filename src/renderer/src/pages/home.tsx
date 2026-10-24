import { Bot, CircleAlert, FileVideo, Hand, Inbox, LayoutTemplate, MessageSquareText, Plug, Sparkles, Video, Wallet } from 'lucide-react'
import { useApi, type Out } from '@/lib/api'
import { Link, navigate } from '@/lib/router'
import { money, pct, when } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, FixtureBadge, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { useSession } from '@/components/app/shell'

type Home = Out<'home.get'>

export function HomePage() {
  const s = useSession()
  const q = useApi('home.get')
  return (
    <>
      <PageHeader title={`Good to see you, ${s.actor.name.split(' ')[0]}`} description={`${s.actor.title}${s.actor.teamName ? ` · ${s.actor.teamName}` : ''}`} />
      <Query q={q}>{(d) => (d.role === 'employee' ? <EmployeeHome d={d} /> : <ManagerHome d={d} />)}</Query>
    </>
  )
}

function StartCard() {
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-accent/60 to-card">
      <CardContent className="flex flex-wrap items-center gap-6 py-5">
        <div className="min-w-64 flex-1 space-y-1">
          <div className="text-base font-semibold">Automate something you do every week</div>
          <p className="text-sm text-muted-foreground">Show Relay how you do it. It suggests what to automate, builds an agent with tools you’re approved to use, and helps you test it before it goes live.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => navigate('/agents/new?start=record')}>
            <Video /> Record a workflow
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate('/agents/new?start=import')}>
            <FileVideo /> Import recording
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate('/agents/new?start=describe')}>
            <MessageSquareText /> Describe a workflow
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EmployeeHome({ d }: { d: Home }) {
  return (
    <div className="space-y-5">
      <StartCard />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>My agents</CardTitle>
              <CardDescription>Agents you own</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/agents')}>
              All agents
            </Button>
          </CardHeader>
          <CardContent>
            {d.myAgents.length === 0 ? (
              <EmptyState icon={Bot} title="No agents yet">
                Record a workflow or start from a template.
              </EmptyState>
            ) : (
              <AgentTable agents={d.myAgents} />
            )}
            {d.templates.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <LayoutTemplate className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">Templates:</span>
                {d.templates.map((t) => (
                  <Link key={t.id} to={`/agents/${t.id}`} className="text-primary hover:underline">
                    {t.name.replace(/^Template: /, '')}
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <TasksCard d={d} />
          <BudgetCard d={d} />
        </div>
      </div>
      <RecentRuns d={d} />
    </div>
  )
}

function AgentTable({ agents }: { agents: Home['myAgents'] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Runs (30 days)</TableHead>
          <TableHead>Last run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => (
          <TableRow key={a.id} className="cursor-pointer" onClick={() => navigate(`/agents/${a.id}`)}>
            <TableCell className="font-medium">
              <Link to={`/agents/${a.id}`} className="hover:underline">
                {a.name}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge status={a.killSwitch ? 'blocked' : a.status} label={a.killSwitch ? 'Kill switch on' : undefined} />
            </TableCell>
            <TableCell className="tabular-nums">
              {a.runs30d}
              {a.failed30d > 0 && <span className="ml-1 text-danger">({a.failed30d} failed)</span>}
            </TableCell>
            <TableCell className="text-muted-foreground">{when(a.lastRunAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TasksCard({ d }: { d: Home }) {
  const total = d.tasks.length + d.myRequests.filter((r) => r.status === 'pending').length
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hand className="size-4" aria-hidden /> Waiting on me
        </CardTitle>
        <CardDescription>{total ? `${total} item(s)` : 'Nothing needs your input'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {d.tasks.map((t) => (
          <Link key={t.id} to={`/runs/${t.runId}`} className="block rounded-md border px-3 py-2 hover:bg-muted">
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusBadge status="needs_review" label="Needs your review" />
            </div>
            <div className="mt-1 text-sm">{t.title}</div>
            <div className="text-xs text-muted-foreground">
              {t.agentName} · {when(t.createdAt)}
            </div>
          </Link>
        ))}
        {d.myRequests.map((r) => (
          <Link key={r.id} to={`/approvals/${r.id}`} className="block rounded-md border px-3 py-2 hover:bg-muted">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{r.title}</span>
              <StatusBadge status={r.status} />
            </div>
            <div className="text-xs text-muted-foreground">Your request · {when(r.createdAt)}</div>
          </Link>
        ))}
        {total === 0 && d.myRequests.length === 0 && <p className="text-sm text-muted-foreground">Reviews and requests you make will show up here.</p>}
      </CardContent>
    </Card>
  )
}

function BudgetCard({ d }: { d: Home }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-4" aria-hidden /> Remaining budget
        </CardTitle>
        <CardDescription>This month, operating spend</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {d.budgets.filter((b) => b.kind === 'operating').length === 0 && <p className="text-sm text-muted-foreground">No budgets apply to you yet.</p>}
        {d.budgets
          .filter((b) => b.kind === 'operating')
          .map((b) => (
            <div key={b.id} className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="truncate">{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{money(b.remainingUsd, 2)} left</span>
              </div>
              <Progress value={b.pct} aria-label={`${Math.round(b.pct)}% used`} />
            </div>
          ))}
        <Button variant="link" className="h-auto p-0" onClick={() => navigate('/budget')}>
          Budget details
        </Button>
      </CardContent>
    </Card>
  )
}

function RecentRuns({ d }: { d: Home }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent runs</CardTitle>
        <Button variant="outline" size="sm" onClick={() => navigate('/runs')}>
          All runs
        </Button>
      </CardHeader>
      <CardContent>
        {d.recentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Where</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.recentRuns.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/runs/${r.id}`)}>
                  <TableCell className="font-medium">
                    {r.agentName} <span className="text-muted-foreground">v{r.version}</span> {r.isFixture && <FixtureBadge />}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>{r.environment === 'test' ? 'Test' : 'Live'}</TableCell>
                  <TableCell className="text-muted-foreground">{when(r.createdAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.costMetered + r.costEstimated)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ManagerHome({ d }: { d: Home & { role: 'manager' | 'admin' } }) {
  const m = d as Extract<Home, { inbox: unknown }>
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Inbox className="size-4" aria-hidden /> Approval inbox
              </CardTitle>
              <CardDescription>{m.inbox.length ? `${m.inbox.length} waiting for your decision` : 'Nothing waiting for you'}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/approvals')}>
              Open approvals
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {m.inbox.slice(0, 6).map((a) => (
              <Link key={a.id} to={`/approvals/${a.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {a.requesterName} · {when(a.createdAt)} · {a.reason}
                  </div>
                </div>
                {a.isFixture && <FixtureBadge />}
                <StatusBadge status="pending" />
              </Link>
            ))}
            {m.inbox.length === 0 && <p className="text-sm text-muted-foreground">Requests from your team appear here.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4" aria-hidden /> Spending & budgets
            </CardTitle>
            <CardDescription>{m.spending.warnings.length ? `${m.spending.warnings.length} budget(s) above their alert level` : 'All budgets below alert level'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {m.spending.budgets
              .filter((b) => b.scope !== 'agent')
              .slice(0, 6)
              .map((b) => (
                <div key={b.id} className="space-y-1">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate">{b.label}</span>
                    <span className={b.pct >= b.alertPct ? 'font-medium text-warning tabular-nums' : 'tabular-nums text-muted-foreground'}>
                      {money(b.chargedUsd + b.reservedUsd, 2)} / {money(b.limitUsd, 2)}
                    </span>
                  </div>
                  <Progress value={b.pct} aria-label={`${Math.round(b.pct)}% used`} />
                </div>
              ))}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Team performance</CardTitle>
            <CardDescription>Last 30 days, excluding sample runs</CardDescription>
          </CardHeader>
          <CardContent>
            {m.teamPerformance.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team agents yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    <TableHead className="text-right">Success rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.teamPerformance.map((a) => (
                    <TableRow key={a.id} className="cursor-pointer" onClick={() => navigate(`/agents/${a.id}`)}>
                      <TableCell className="font-medium">{a.name}</TableCell>
                      <TableCell className="text-muted-foreground">{a.owner}</TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{a.runs30d}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(a.successRate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleAlert className="size-4" aria-hidden /> Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {m.attention.length === 0 && m.connectorIssues.length === 0 && <p className="text-sm text-muted-foreground">No agents need attention.</p>}
            {m.attention.map((a) => (
              <Link key={a.id} to={`/agents/${a.id}`} className="block rounded-md border px-3 py-2 hover:bg-muted">
                <div className="text-sm font-medium">{a.name}</div>
                <div className="text-xs text-muted-foreground">{a.reason}</div>
              </Link>
            ))}
            {m.connectorIssues.map((c) => (
              <Link key={c.id} to="/tools?tab=integrations" className="flex items-start gap-2 rounded-md border px-3 py-2 hover:bg-muted">
                <Plug className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                <div>
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <StatusBadge status={c.status} /> {c.status_detail}
                  </div>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4" aria-hidden /> Data & model opportunities
              </CardTitle>
              <CardDescription>Specialized models from your approved data</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/data')}>
              Explore data
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {m.opportunities.length === 0 && <p className="text-sm text-muted-foreground">Open a collection you can analyze and choose “Find model opportunities”.</p>}
            {m.opportunities.map((o) => (
              <Link key={o.id} to={`/data/${o.collectionId}/opportunities`} className="block rounded-md border px-3 py-2 text-sm hover:bg-muted">
                {o.title}
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Models & training</CardTitle>
            <Button variant="outline" size="sm" onClick={() => navigate('/models')}>
              Models
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {m.jobs.map((j) => (
              <Link key={j.id} to={`/models/jobs/${j.id}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted">
                <span>{j.name}</span>
                <StatusBadge status={j.status} />
              </Link>
            ))}
            {m.models.map((x) => (
              <Link key={x.id} to={`/models/${x.id}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted">
                <span>
                  {x.name} v{x.version}
                </span>
                <StatusBadge status={x.status === 'needs_review' ? 'needs_review_model' : x.status} />
              </Link>
            ))}
            {m.jobs.length === 0 && m.models.length === 0 && <p className="text-sm text-muted-foreground">No training jobs yet.</p>}
          </CardContent>
        </Card>
      </div>
      <RecentRuns d={d} />
    </div>
  )
}
