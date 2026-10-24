import * as React from 'react'
import { Ban, BookmarkPlus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { onPush, useAction, useApi, invalidatePrefixes } from '@/lib/api'
import { navigate } from '@/lib/router'
import { dateTime, duration, pct } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Progress } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog, Field, KeyValue, PageHeader, Query, StatusBadge } from '@/components/app/common'

type Metrics = {
  examples: number
  accuracy: number
  macro_f1: number
  per_class: { label: string; precision: number; recall: number; f1: number; support: number }[]
  confusion_matrix: { labels: string[]; matrix: number[][] }
  latency_ms_per_example_batched?: number
  latency_ms_single_p50?: number | null
  latency_ms_per_example?: number
  device?: string
  description?: string
}

export type TrainResult = {
  labels: string[]
  fine_tuned: Metrics
  baselines: { majority: Metrics; tfidf_logreg: Metrics | null }
  smoke_test: boolean
  train_examples: number
  validation_examples: number
  test_examples: number
  epochs: number
  best_epoch: number
  trainable_params: number
  total_params: number
  reload_check: { matched: number; of: number }
  elapsed_sec: number
  base_model: { id: string; license: string; size_bytes: number }
}

export function JobPage({ id }: { id: string }) {
  const qc = useQueryClient()
  const q = useApi('ml.job', { id }, { refetchInterval: (query) => (['running', 'queued'].includes((query.state.data as { status?: string } | undefined)?.status ?? '') ? 1500 : false) })
  React.useEffect(() => onPush((e) => (e.type === 'job.event' || e.type === 'job.updated') && e.jobId === id && invalidatePrefixes(qc, ['ml.job'])), [id, qc])
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const cancel = useAction('ml.cancelTraining', { success: 'Training cancelled', onSuccess: () => setCancelOpen(false) })
  return (
    <Query q={q}>
      {(j) => {
        const res = j.metrics as TrainResult | null
        const losses = j.events.filter((e) => e.type === 'progress').map((e) => ({ step: Number(e.step), loss: Number(e.loss) }))
        const evals = j.events.filter((e) => e.type === 'eval')
        const err = j.events.find((e) => e.type === 'error')
        return (
          <>
            <PageHeader
              breadcrumb={<a href="#/models?tab=jobs">Training jobs</a>}
              title={
                <span className="flex items-center gap-2">
                  {j.name} <StatusBadge status={j.status} /> {j.config.smokeTest && <Badge tone="warning">Smoke test</Badge>}
                </span>
              }
              description={`${j.datasetName} · ${j.config.baseModel} · started by ${j.createdBy} ${dateTime(j.startedAt ?? j.createdAt)}`}
              actions={
                ['running', 'queued', 'awaiting_approval'].includes(j.status) && (
                  <Button variant="outline" onClick={() => setCancelOpen(true)}>
                    <Ban /> Cancel
                  </Button>
                )
              }
            />
            {j.status === 'awaiting_approval' && <Alert tone="warning" className="mb-4" title="Waiting for budget approval">The estimated cost is above your approval ceiling. It starts automatically once approved.</Alert>}
            {j.error && (
              <Alert tone={j.status === 'cancelled' ? 'neutral' : 'danger'} className="mb-4" title={j.status === 'cancelled' ? 'Cancelled' : 'Training failed'}>
                {j.error}
              </Alert>
            )}
            {j.config.smokeTest && j.status === 'succeeded' && <Alert tone="warning" className="mb-4" title="Smoke test">This job trained briefly on at most 64 examples to verify the pipeline. Its metrics do not indicate business-quality performance.</Alert>}
            <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
              <div className="space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle>Progress</CardTitle>
                    <CardDescription>Measured live from the training process.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Progress value={j.progress * 100} aria-label="Training progress" className="flex-1" />
                      <span className="w-12 text-right text-sm tabular-nums">{Math.round(j.progress * 100)}%</span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Phase: {j.phase || '—'} · Elapsed: {duration(j.elapsedSec ?? (j.startedAt ? (Date.now() - new Date(j.startedAt).getTime()) / 1000 : null))}
                    </div>
                    {losses.length > 1 && <LossChart points={losses} />}
                    {evals.length > 0 && (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Epoch</TableHead>
                            <TableHead className="text-right">Train loss</TableHead>
                            <TableHead className="text-right">Validation accuracy</TableHead>
                            <TableHead className="text-right">Validation macro F1</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {evals.map((e, i) => (
                            <TableRow key={i}>
                              <TableCell>{String(e.epoch)}</TableCell>
                              <TableCell className="text-right tabular-nums">{Number(e.train_loss).toFixed(4)}</TableCell>
                              <TableCell className="text-right tabular-nums">{pct(Number(e.accuracy), 1)}</TableCell>
                              <TableCell className="text-right tabular-nums">{pct(Number(e.macro_f1), 1)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
                {res && <EvaluationView res={res} />}
              </div>
              <div className="space-y-5">
                {j.status === 'succeeded' && res && <RegisterCard jobId={j.id} registered={j.registeredModel} smoke={res.smoke_test} />}
                <Card>
                  <CardHeader>
                    <CardTitle>Log</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ol className="max-h-96 space-y-1 overflow-y-auto text-xs" aria-live="polite">
                      {j.events
                        .filter((e) => e.type !== 'progress')
                        .map((e, i) => (
                          <li key={i} className={cn(e.type === 'error' && 'text-danger')}>
                            <span className="text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()} </span>
                            {String(e.message ?? (e.type === 'eval' ? `Epoch ${e.epoch}: validation macro F1 ${pct(Number(e.macro_f1), 1)}` : e.type === 'baseline' ? 'Baselines evaluated on the test split' : e.type))}
                          </li>
                        ))}
                    </ol>
                    {err && <p className="mt-2 text-xs text-danger">{String(err.message)}</p>}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Hardware</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs">
                    <KeyValue
                      items={[
                        ['Python', String((j.hardware as { python?: string }).python ?? '—')],
                        ['PyTorch', String((j.hardware as { torch_version?: string }).torch_version ?? '—')],
                        ['Devices', Object.entries(((j.hardware as { devices?: Record<string, boolean> }).devices ?? {})).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ') || '—'],
                        ['Memory', (j.hardware as { ram_gb?: number }).ram_gb ? `${(j.hardware as { ram_gb?: number }).ram_gb} GB` : '—']
                      ]}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
            <ConfirmDialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel training?" description="The training process is stopped. Cancelled jobs are never marked successful and cannot be registered." destructive confirmLabel="Cancel training" onConfirm={() => cancel.mutate({ id: j.id })} loading={cancel.isPending} />
          </>
        )
      }}
    </Query>
  )
}

function LossChart({ points }: { points: { step: number; loss: number }[] }) {
  const w = 600
  const h = 140
  const maxS = Math.max(...points.map((p) => p.step))
  const maxL = Math.max(...points.map((p) => p.loss))
  const minL = Math.min(...points.map((p) => p.loss))
  const x = (s: number) => 36 + (s / maxS) * (w - 46)
  const y = (l: number) => 10 + (1 - (l - minL) / Math.max(1e-9, maxL - minL)) * (h - 34)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)},${y(p.loss).toFixed(1)}`).join(' ')
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`Training loss from ${points[0].loss.toFixed(3)} to ${points[points.length - 1].loss.toFixed(3)} over ${maxS} steps`}>
        <line x1="36" x2={w - 10} y1={h - 24} y2={h - 24} className="stroke-border" />
        <text x="2" y="14" className="fill-muted-foreground text-[10px]">{maxL.toFixed(2)}</text>
        <text x="2" y={h - 26} className="fill-muted-foreground text-[10px]">{minL.toFixed(2)}</text>
        <text x={w - 10} y={h - 8} textAnchor="end" className="fill-muted-foreground text-[10px]">step {maxS}</text>
        <path d={d} fill="none" className="stroke-primary" strokeWidth="2" />
      </svg>
      <figcaption className="text-xs text-muted-foreground">Training loss per logged step (measured)</figcaption>
    </figure>
  )
}

export function EvaluationView({ res }: { res: TrainResult }) {
  const rows: [string, Metrics | null, string][] = [
    ['Fine-tuned model', res.fine_tuned, `${res.base_model.id} + LoRA`],
    ['Baseline: TF-IDF + logistic regression', res.baselines.tfidf_logreg, 'Classic, cheap baseline'],
    ['Baseline: always majority class', res.baselines.majority, res.baselines.majority.description ?? '']
  ]
  const ft = res.fine_tuned
  const tf = res.baselines.tfidf_logreg
  const max = Math.max(1, ...ft.confusion_matrix.matrix.flat())
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evaluation on the held-out test set</CardTitle>
        <CardDescription>
          {res.test_examples} examples never used in training or tuning. All three models scored on the same examples.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {tf && (
          <Alert tone={ft.macro_f1 - tf.macro_f1 >= 0.03 ? 'success' : 'warning'}>
            {ft.macro_f1 - tf.macro_f1 >= 0.03
              ? `The fine-tuned model beats the TF-IDF baseline by ${((ft.macro_f1 - tf.macro_f1) * 100).toFixed(1)} macro-F1 points on ${res.test_examples} held-out examples.`
              : ft.macro_f1 >= tf.macro_f1
                ? `The fine-tuned model is only ${((ft.macro_f1 - tf.macro_f1) * 100).toFixed(1)} macro-F1 points above the TF-IDF baseline. On ${res.test_examples} test examples that difference is small; the simpler baseline may be good enough.`
                : `The TF-IDF baseline scores higher (${pct(tf.macro_f1, 1)} vs ${pct(ft.macro_f1, 1)}). Prefer the baseline or improve the data before using this model.`}
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Macro F1</TableHead>
              <TableHead className="text-right">Accuracy</TableHead>
              <TableHead className="text-right">Latency / example</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([name, m, note]) => (
              <TableRow key={name}>
                <TableCell>
                  <div className="font-medium">{name}</div>
                  <div className="text-xs text-muted-foreground">{note}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{m ? pct(m.macro_f1, 1) : 'n/a'}</TableCell>
                <TableCell className="text-right tabular-nums">{m ? pct(m.accuracy, 1) : 'n/a'}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {m?.latency_ms_single_p50 != null ? `${m.latency_ms_single_p50.toFixed(1)} ms (single, ${m.device})` : m?.latency_ms_per_example != null ? `${m.latency_ms_per_example.toFixed(2)} ms (batched)` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-medium">Per-class results (fine-tuned)</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead className="text-right">Precision</TableHead>
                  <TableHead className="text-right">Recall</TableHead>
                  <TableHead className="text-right">F1</TableHead>
                  <TableHead className="text-right">Support</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ft.per_class.map((c) => (
                  <TableRow key={c.label}>
                    <TableCell>{c.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(c.precision, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(c.recall, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(c.f1, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.support}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Confusion matrix (rows: true label, columns: predicted)</div>
            <div className="overflow-x-auto">
              <table className="text-xs" aria-label="Confusion matrix">
                <thead>
                  <tr>
                    <th />
                    {ft.confusion_matrix.labels.map((l) => (
                      <th key={l} className="px-1 pb-1 text-left font-medium text-muted-foreground" style={{ writingMode: 'vertical-rl' }}>
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ft.confusion_matrix.matrix.map((row, i) => (
                    <tr key={i}>
                      <th className="pr-2 text-right font-medium whitespace-nowrap text-muted-foreground">{ft.confusion_matrix.labels[i]}</th>
                      {row.map((v, k) => (
                        <td key={k} className={cn('size-8 border text-center tabular-nums', i === k ? 'font-semibold' : '')} style={{ background: v ? `color-mix(in oklch, var(--${i === k ? 'success' : 'danger'}) ${Math.round((v / max) * 55) + 8}%, transparent)` : undefined }}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <KeyValue
          items={[
            ['Training examples', `${res.train_examples} (validation ${res.validation_examples})`],
            ['Epochs', `${res.epochs} (best validation epoch: ${res.best_epoch})`],
            ['Trainable parameters', `${res.trainable_params.toLocaleString()} of ${res.total_params.toLocaleString()} (LoRA)`],
            ['Reload check', res.reload_check.matched === res.reload_check.of ? <StatusBadge key="r" status="ok" label={`Saved model reproduced ${res.reload_check.matched}/${res.reload_check.of} predictions`} /> : <StatusBadge key="r" status="warn" label={`${res.reload_check.matched}/${res.reload_check.of} matched after reload`} />],
            ['Base model license', `${res.base_model.license}`],
            ['Training time', duration(res.elapsed_sec)]
          ]}
        />
      </CardContent>
    </Card>
  )
}

function RegisterCard({ jobId, registered, smoke }: { jobId: string; registered: { id: string; name: string; version: number; status: string } | null; smoke: boolean }) {
  const [name, setName] = React.useState(smoke ? 'Incident classifier smoke test' : 'Incident classifier')
  const reg = useAction('ml.registerModel', { success: (r) => `Registered as version ${r.version}`, onSuccess: (r) => navigate(`/models/${r.id}`) })
  if (registered)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Registered</CardTitle>
        </CardHeader>
        <CardContent>
          <a className="text-primary hover:underline" href={`#/models/${registered.id}`}>
            {registered.name} v{registered.version}
          </a>{' '}
          <StatusBadge status={registered.status} />
        </CardContent>
      </Card>
    )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Register this model</CardTitle>
        <CardDescription>Registering records lineage and makes it available to activate. It is not used by agents until activated.</CardDescription>
      </CardHeader>
      <CardContent>
        <Field label="Model name" hint="Using an existing name creates a new version of that model.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => reg.mutate({ jobId, name })} loading={reg.isPending} disabled={!name.trim()}>
          <BookmarkPlus /> Register
        </Button>
      </CardFooter>
    </Card>
  )
}
