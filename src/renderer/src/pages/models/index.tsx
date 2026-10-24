import { BrainCircuit, Database, FlaskConical, Server } from 'lucide-react'
import { useApi } from '@/lib/api'
import { navigate, setQuery, useRoute } from '@/lib/router'
import { duration, pct, when } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, PageHeader, Query, StatusBadge } from '@/components/app/common'

export function ModelsPage() {
  const { query } = useRoute()
  const tab = query.tab ?? 'registry'
  return (
    <>
      <PageHeader
        title="Models"
        description="Specialized models trained locally on approved company data, plus the general models agents can use. Start from Data → a collection → Find model opportunities."
        actions={<Button onClick={() => navigate('/data')}><FlaskConical /> Find an opportunity</Button>}
      />
      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v })}>
        <TabsList>
          <TabsTrigger value="registry">
            <BrainCircuit /> Registry
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <FlaskConical /> Training jobs
          </TabsTrigger>
          <TabsTrigger value="datasets">
            <Database /> Datasets
          </TabsTrigger>
          <TabsTrigger value="general">
            <Server /> General models
          </TabsTrigger>
        </TabsList>
        <TabsContent value="registry">
          <Registry />
        </TabsContent>
        <TabsContent value="jobs">
          <Jobs />
        </TabsContent>
        <TabsContent value="datasets">
          <Datasets />
        </TabsContent>
        <TabsContent value="general">
          <General />
        </TabsContent>
      </Tabs>
    </>
  )
}

function Registry() {
  const q = useApi('ml.models')
  return (
    <Query q={q}>
      {(models) =>
        models.length === 0 ? (
          <EmptyState icon={BrainCircuit} title="No registered models">Train a model from a classification opportunity, then register it here.</EmptyState>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Base model</TableHead>
                  <TableHead>Trained on</TableHead>
                  <TableHead className="text-right">Macro F1 (test)</TableHead>
                  <TableHead className="text-right">Baseline F1</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => {
                  const metrics = m.metrics as { fine_tuned?: { macro_f1: number }; baselines?: { tfidf_logreg?: { macro_f1: number } | null } }
                  return (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => navigate(`/models/${m.id}`)}>
                      <TableCell className="font-medium">
                        {m.name} v{m.version} {m.isSmoke && <Badge tone="warning">Smoke test</Badge>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={m.status === 'needs_review' ? 'needs_review_model' : m.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.baseModel}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {m.lineage.datasetName} v{m.lineage.datasetVersion}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pct(metrics.fine_tuned?.macro_f1, 1)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{pct(metrics.baselines?.tfidf_logreg?.macro_f1, 1)}</TableCell>
                      <TableCell className="text-muted-foreground">{when(m.createdAt)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        )
      }
    </Query>
  )
}

function Jobs() {
  const q = useApi('ml.jobs', undefined, { refetchInterval: (query) => ((query.state.data ?? []).some((j: { status: string }) => j.status === 'running') ? 2000 : false) })
  return (
    <Query q={q}>
      {(jobs) =>
        jobs.length === 0 ? (
          <EmptyState icon={FlaskConical} title="No training jobs yet" />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Dataset</TableHead>
                  <TableHead>Base model</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Started by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.id} className="cursor-pointer" onClick={() => navigate(`/models/jobs/${j.id}`)}>
                    <TableCell className="font-medium">
                      {j.name} {j.config.smokeTest && <Badge tone="warning">Smoke test</Badge>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={j.status === 'awaiting_approval' ? 'awaiting_approval' : j.status} />
                    </TableCell>
                    <TableCell className="w-40">{j.status === 'running' ? <Progress value={j.progress * 100} aria-label={`${Math.round(j.progress * 100)}%`} /> : j.phase}</TableCell>
                    <TableCell className="text-muted-foreground">{j.datasetName}</TableCell>
                    <TableCell className="text-muted-foreground">{j.config.baseModel}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{duration(j.elapsedSec)}</TableCell>
                    <TableCell className="text-muted-foreground">{j.createdBy}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )
      }
    </Query>
  )
}

function Datasets() {
  const q = useApi('ml.datasets')
  return (
    <Query q={q}>
      {(ds) =>
        ds.length === 0 ? (
          <EmptyState icon={Database} title="No prepared datasets" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {ds.map((d) => {
              const st = d.stats as { splits?: { train: number; validation: number; test: number }; labels?: string[]; removed?: Record<string, unknown> }
              return (
                <Card key={d.id}>
                  <CardHeader>
                    <CardTitle>
                      {d.name} v{d.version}
                    </CardTitle>
                    <CardDescription>
                      From {d.collectionName} (collection v{d.collectionVersion}) · {when(d.createdAt)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {st.splits && (
                      <div>
                        Train {st.splits.train} · Validation {st.splits.validation} · Held-out test {st.splits.test}
                      </div>
                    )}
                    {st.labels && <div className="text-muted-foreground">Labels: {st.labels.join(', ')}</div>}
                    <Button size="sm" variant="outline" onClick={() => navigate(`/models/train?dataset=${d.id}`)}>
                      Train with this dataset
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )
      }
    </Query>
  )
}

function General() {
  const q = useApi('providers.list')
  return (
    <Query q={q}>
      {(ps) => (
        <div className="grid gap-3 md:grid-cols-2">
          {ps.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {p.name} {p.external ? <Badge tone="neutral">External: {p.destination}</Badge> : <Badge tone="success">Runs locally</Badge>}
                </CardTitle>
                <CardDescription>{p.models.join(', ')}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-2 text-sm">
                {!p.enabled ? <StatusBadge status="disabled" /> : p.configured ? <StatusBadge status={p.status === 'ok' ? 'ok' : p.status === 'error' ? 'error' : 'unchecked'} /> : <StatusBadge status="needs_connection" label="No key configured" />}
                <span className="text-xs text-muted-foreground">{p.statusDetail}</span>
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-muted-foreground md:col-span-2">Administrators configure providers and keys in Settings → Models &amp; keys.</p>
        </div>
      )}
    </Query>
  )
}
