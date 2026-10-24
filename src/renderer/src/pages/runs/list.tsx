import * as React from 'react'
import { Download, FolderOpen, Hand, PlayCircle, Table2 } from 'lucide-react'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { navigate, setQuery, useRoute } from '@/lib/router'
import { money, when, short } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState, FixtureBadge, PageHeader, Query, StatusBadge } from '@/components/app/common'

type RunRow = Out<'runs.list'>[number]

export function RunsTable({ runs, hideAgent }: { runs: RunRow[]; hideAgent?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {!hideAgent && <TableHead>Agent</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Where</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Started</TableHead>
          <TableHead className="text-right">Tool calls</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/runs/${r.id}`)}>
            {!hideAgent && (
              <TableCell className="font-medium">
                <a href={`#/runs/${r.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                  {r.agentName}
                </a>{' '}
                <span className="text-muted-foreground">v{r.version}</span> {r.isFixture && <FixtureBadge />}
              </TableCell>
            )}
            <TableCell>
              <StatusBadge status={r.status} />
              {hideAgent && r.isFixture && <FixtureBadge />}
              {r.error && <div className="mt-0.5 max-w-xs truncate text-xs text-muted-foreground">{r.error}</div>}
            </TableCell>
            <TableCell>{r.environment === 'test' ? 'Test' : 'Live'}</TableCell>
            <TableCell className="capitalize text-muted-foreground">{r.trigger}</TableCell>
            <TableCell className="text-muted-foreground">{when(r.createdAt)}</TableCell>
            <TableCell className="text-right tabular-nums">{r.toolCalls}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.costMetered + r.costEstimated)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RunsPage() {
  const { query } = useRoute()
  const tab = query.tab ?? 'all'
  const [status, setStatus] = React.useState<string>('any')
  const runs = useApi('runs.list', { status: status === 'any' ? undefined : status, limit: 200 })
  const reviews = useApi('runs.reviews')
  return (
    <>
      <PageHeader title="Runs" description="Every agent run with its steps, tool calls, outputs and costs. Sample runs from the demo seed are labeled." />
      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v })}>
        <TabsList>
          <TabsTrigger value="all">
            <PlayCircle /> All runs
          </TabsTrigger>
          <TabsTrigger value="review">
            <Hand /> Needs review {reviews.data?.length ? `(${reviews.data.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="results">
            <Table2 /> Results
          </TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Status</span>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-48" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['any', 'running', 'needs_review', 'paused', 'succeeded', 'failed', 'blocked', 'cancelled'].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === 'any' ? 'Any status' : s.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Query q={runs}>{(r) => (r.length ? <Card><RunsTable runs={r} /></Card> : <EmptyState icon={PlayCircle} title="No runs match">Run an agent from its Test tab.</EmptyState>)}</Query>
        </TabsContent>
        <TabsContent value="review">
          <Query q={reviews}>
            {(items) =>
              items.length === 0 ? (
                <EmptyState icon={Hand} title="Nothing needs your review" />
              ) : (
                <div className="space-y-2">
                  {items.map((t) => (
                    <a key={t.id} href={`#/runs/${t.runId}`} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-muted">
                      <StatusBadge status="needs_review" label={t.kind === 'approval' || t.kind === 'tool_approval' ? 'Needs approval' : t.kind === 'manual' ? 'Manual step' : t.kind === 'step_failed' ? 'Step failed' : 'Needs your review'} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{t.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {t.agentName} · {t.mine ? 'assigned to you' : `assigned to ${t.assignee}`} · {when(t.createdAt)}
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              )
            }
          </Query>
        </TabsContent>
        <TabsContent value="results">
          <ResultsTab />
        </TabsContent>
      </Tabs>
    </>
  )
}

function ResultsTab() {
  const q = useApi('results.tables')
  const exp = useAction('results.export', { success: (r) => `Exported ${r.rows} row(s)` })
  return (
    <Query q={q}>
      {(tables) =>
        tables.length === 0 ? (
          <EmptyState icon={Table2} title="No result tables yet">Agents that use “Record results in a table” write here.</EmptyState>
        ) : (
          <div className="space-y-4">
            {tables.map((t) => (
              <Card key={t.id}>
                <CardHeader className="flex-row items-start justify-between">
                  <div>
                    <CardTitle>{t.name}</CardTitle>
                    <CardDescription>{t.rows.length} row(s) · stored in Relay</CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" loading={exp.isPending && exp.variables?.table === t.name && exp.variables.format === 'csv'} onClick={() => exp.mutate({ table: t.name, format: 'csv' })}>
                      <Download /> CSV
                    </Button>
                    <Button size="sm" variant="outline" loading={exp.isPending && exp.variables?.table === t.name && exp.variables.format === 'json'} onClick={() => exp.mutate({ table: t.name, format: 'json' })}>
                      <Download /> JSON
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {t.columns.map((c) => (
                            <TableHead key={c}>{c}</TableHead>
                          ))}
                          <TableHead>Run</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.rows.map((r) => (
                          <TableRow key={r.id}>
                            {t.columns.map((c) => (
                              <TableCell key={c} className="max-w-xs truncate text-xs">
                                {short(r.data[c] ?? '', 120)}
                              </TableCell>
                            ))}
                            <TableCell className="text-xs">{r.runId ? <a className="text-primary hover:underline" href={`#/runs/${r.runId}`}>{when(r.createdAt)}</a> : when(r.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {t.exports.length > 0 && (
                    <div className="mt-3 space-y-1 text-xs">
                      {t.exports.map((e) => (
                        <div key={e.path} className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            {e.format.toUpperCase()} · {e.rows} rows · {when(e.created_at)}
                          </span>
                          <button className="flex items-center gap-1 text-primary hover:underline" onClick={() => call('app.reveal', { path: e.path })}>
                            <FolderOpen className="size-3.5" /> Show file
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )
      }
    </Query>
  )
}
