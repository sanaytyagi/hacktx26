import * as React from 'react'
import { Archive, Radio, ShieldCheck, Wand2 } from 'lucide-react'
import { useAction, useApi } from '@/lib/api'
import { dateTime, pct } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { ConfirmDialog, KeyValue, MonoId, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { useCan } from '@/components/app/shell'
import { EvaluationView, type TrainResult } from './job'

export function ModelPage({ id }: { id: string }) {
  const q = useApi('ml.model', { id })
  const all = useApi('ml.models')
  const activate = useAction('ml.activateModel', { success: (r) => (r.previousVersion ? `Activated. v${r.previousVersion} is now replaced.` : 'Activated. Agents can now use it as a tool.') })
  const status = useAction('ml.setModelStatus', { success: 'Updated' })
  const [retire, setRetire] = React.useState(false)
  const isAdmin = useCan('models.administer')
  return (
    <Query q={q}>
      {(m) => {
        const versions = (all.data ?? []).filter((x) => x.name === m.name)
        const res = m.metrics as unknown as TrainResult
        return (
          <>
            <PageHeader
              breadcrumb={<a href="#/models">Models</a>}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {m.name} v{m.version} <StatusBadge status={m.status === 'needs_review' ? 'needs_review_model' : m.status} /> {m.isSmoke && <Badge tone="warning">Smoke test</Badge>}
                </span>
              }
              description={`Text classifier fine-tuned from ${m.baseModel}. Runs locally in Relay’s Python worker.`}
              actions={
                <>
                  {m.status !== 'active' && m.status !== 'retired' && m.status !== 'needs_review' && (
                    <Button onClick={() => activate.mutate({ id: m.id })} loading={activate.isPending}>
                      <Radio /> {versions.some((v) => v.status === 'active' && v.version > m.version) ? 'Roll back to this version' : 'Activate'}
                    </Button>
                  )}
                  {m.status === 'needs_review' && isAdmin && (
                    <Button variant="outline" onClick={() => status.mutate({ id: m.id, status: 'registered', note: 'Reviewed after data access change' })}>
                      <ShieldCheck /> Mark reviewed
                    </Button>
                  )}
                  {m.status !== 'retired' && (
                    <Button variant="outline" onClick={() => setRetire(true)}>
                      <Archive /> Retire
                    </Button>
                  )}
                </>
              }
            />
            {m.status === 'needs_review' && (
              <Alert tone="warning" className="mb-4" title="Needs review">
                {m.reviewReason}. Revoking data access does not untrain a model; review whether to keep or retire it. It cannot be invoked until reviewed.
              </Alert>
            )}
            {m.isSmoke && <Alert tone="warning" className="mb-4">Smoke-test model: trained briefly to check the pipeline. Do not rely on its predictions.</Alert>}
            {!m.artifactPresent && <Alert tone="danger" className="mb-4">Model files are missing on disk; it cannot be loaded.</Alert>}
            <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
              <div className="space-y-5">
                <TryIt id={m.id} labels={m.labels} />
                {res?.fine_tuned && <EvaluationView res={res} />}
              </div>
              <div className="space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle>Lineage</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm">
                    <KeyValue
                      items={[
                        ['Training job', <a key="j" className="text-primary hover:underline" href={`#/models/jobs/${m.lineage.jobId}`}>{m.lineage.jobName}</a>],
                        ['Trained', dateTime(m.lineage.trainedAt)],
                        ['Dataset', `${m.lineage.datasetName} v${m.lineage.datasetVersion}`],
                        ['Collections', m.lineage.collections.map((c) => `${c.name}${c.version ? ` (v${c.version})` : ''}`).join(', ')],
                        ['Base model', m.baseModel],
                        ['Labels', m.labels.join(', ')],
                        ['Agent tool', <MonoId key="t">{m.toolKey}</MonoId>],
                        ['Artifacts', <span key="a" className="break-all text-xs text-muted-foreground">{m.artifactDir}</span>]
                      ]}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Versions of {m.name}</CardTitle>
                    <CardDescription>Activate an earlier version to roll back. Agents always call the active version.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1.5 text-sm">
                    {versions.map((v) => (
                      <a key={v.id} href={`#/models/${v.id}`} className="flex items-center justify-between rounded-md border px-2.5 py-1.5 hover:bg-muted">
                        <span>
                          v{v.version} · F1 {pct((v.metrics as { fine_tuned?: { macro_f1: number } }).fine_tuned?.macro_f1, 1)}
                        </span>
                        <StatusBadge status={v.status === 'needs_review' ? 'needs_review_model' : v.status} />
                      </a>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
            <ConfirmDialog open={retire} onOpenChange={setRetire} title="Retire this model version?" description="Agents can no longer call this version. Files stay on disk until deleted in Settings → Storage." destructive confirmLabel="Retire" onConfirm={() => status.mutate({ id: m.id, status: 'retired' }, { onSuccess: () => setRetire(false) })} />
          </>
        )
      }}
    </Query>
  )
}

function TryIt({ id, labels }: { id: string; labels: string[] }) {
  const [text, setText] = React.useState('Replica lag on the billing postgres read replica above 200 seconds; queries timing out')
  const run = useAction('ml.tryModel', { invalidate: [] })
  const p = run.data?.prediction as undefined | { label: string; confidence: number; scores: { label: string; p: number }[] }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Try it</CardTitle>
        <CardDescription>Loads the saved model from disk and classifies your text locally. Possible labels: {labels.join(', ')}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to classify" />
        {run.error && <Alert tone="danger">{run.error.message}</Alert>}
        {p && (
          <div className="space-y-1.5">
            <div className="text-sm">
              Prediction: <strong>{p.label}</strong> ({pct(p.confidence, 0)} confidence) · {run.data!.latencyMs.toFixed(1)} ms on {run.data!.device}
            </div>
            {p.scores.map((s) => (
              <div key={s.label} className="flex items-center gap-2 text-xs">
                <span className="w-32 truncate">{s.label}</span>
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-primary" style={{ width: `${s.p * 100}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums">{pct(s.p, 0)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => run.mutate({ id, text })} loading={run.isPending} disabled={!text.trim()}>
          <Wand2 /> Classify
        </Button>
      </CardFooter>
    </Card>
  )
}

