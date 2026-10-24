import * as React from 'react'
import { ArrowLeft, ArrowRight, FlaskConical, Play, Plus, Trash2 } from 'lucide-react'
import type { DatasetConfig, TrainingConfig } from '@shared/domain'
import { useAction, useApi, type Out } from '@/lib/api'
import { navigate, useRoute } from '@/lib/router'
import { duration, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, Switch } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, KeyValue, Loading, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { useDraftState } from '@/lib/hooks'

const STAGES = ['Prepare dataset', 'Evaluation setup', 'Training settings', 'Budget & permission review'] as const

export function TrainPage() {
  const { query } = useRoute()
  const [stage, setStage] = useDraftState<number>(`train-stage:${query.collection ?? query.dataset}`, query.dataset ? 1 : 0)
  const [datasetId, setDatasetId] = useDraftState<string | null>(`train-ds:${query.collection ?? query.dataset}`, query.dataset ?? null)
  const [config, setConfig] = useDraftState<TrainingConfig>(`train-cfg:${query.collection ?? query.dataset}`, {
    baseModel: 'google/electra-small-discriminator',
    epochs: 4,
    learningRate: 0.001,
    batchSize: 16,
    maxLength: 128,
    loraRank: 8,
    device: 'auto',
    smokeTest: false
  })
  return (
    <>
      <PageHeader breadcrumb={<a href="#/models">Models</a>} title="Train a specialized model" description="Fine-tunes a small open-weight text classifier on this computer with LoRA, then evaluates it against baselines on a held-out test set." />
      <ol className="mb-5 flex flex-wrap gap-1 text-sm" aria-label="Progress">
        {STAGES.map((s, i) => (
          <li key={s}>
            <button disabled={i > 0 && !datasetId} onClick={() => setStage(i)} aria-current={stage === i ? 'step' : undefined} className={cn('rounded-md px-2 py-1', stage === i ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>
      {stage === 0 && <PrepareStage collectionId={query.collection} opportunityId={query.opportunity} text={query.text} label={query.label} datasetId={datasetId} onPrepared={(id) => { setDatasetId(id); setStage(1) }} />}
      {stage === 1 && datasetId && <EvalStage datasetId={datasetId} onNext={() => setStage(2)} onBack={() => setStage(0)} />}
      {stage === 2 && <ConfigStage config={config} setConfig={setConfig} onNext={() => setStage(3)} onBack={() => setStage(1)} />}
      {stage === 3 && datasetId && <ReviewStage datasetId={datasetId} config={config} opportunityId={query.opportunity} onBack={() => setStage(2)} />}
    </>
  )
}

function PrepareStage({ collectionId, opportunityId, text, label, datasetId, onPrepared }: { collectionId?: string; opportunityId?: string; text?: string; label?: string; datasetId: string | null; onPrepared: (id: string) => void }) {
  const col = useApi('data.collection', { id: collectionId ?? '' }, { enabled: !!collectionId })
  const preview = useApi('data.preview', { id: collectionId ?? '', limit: 200 }, { enabled: !!collectionId })
  const [cfg, setCfg] = useDraftState<DatasetConfig>(`train-dscfg:${collectionId}`, {
    textFields: text ? [text] : [],
    labelField: label ?? '',
    excludedFields: [],
    labelMap: {},
    dropLabels: [],
    split: { strategy: 'random', train: 0.7, validation: 0.15, seed: 13 },
    minExamplesPerLabel: 5
  })
  const [name, setName] = React.useState('Incident classifier data')
  const [mask, setMask] = React.useState(true)
  const [ackSensitive, setAckSensitive] = React.useState(false)
  const [renameFrom, setRenameFrom] = React.useState('')
  const [renameTo, setRenameTo] = React.useState('')
  const prep = useAction('ml.prepareDataset', { success: 'Dataset prepared', onSuccess: (r) => onPrepared(r.id), invalidate: ['ml.'] })
  if (!collectionId) return <Alert tone="info">Open a collection, choose “Find model opportunities”, then “Prepare dataset & train”. Or train from an existing dataset in Models → Datasets.</Alert>
  if (!preview.data || preview.data.kind !== 'table') return <Query q={preview}>{() => <Alert tone="warning">This collection has no table to train on.</Alert>}</Query>
  const columns = preview.data.columns
  const labelCounts = new Map<string, number>()
  for (const r of preview.data.rows) {
    const v = r[cfg.labelField]
    if (v !== null && v !== undefined && v !== '') labelCounts.set(String(v), (labelCounts.get(String(v)) ?? 0) + 1)
  }
  return (
    <div className="space-y-4">
      {datasetId && <Alert tone="success" title="A dataset is already prepared for this flow">Re-preparing creates a new dataset version.</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Map columns from {col.data?.name}</CardTitle>
          <CardDescription>Only the columns you map are written to the training files. Requires training access to this collection.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Dataset name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Label (what the model predicts)">
            <Select value={cfg.labelField} onValueChange={(v) => setCfg({ ...cfg, labelField: v, labelMap: {}, dropLabels: [] })}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-1.5 md:col-span-2">
            <div className="text-sm font-medium">Input text fields</div>
            <div className="flex flex-wrap gap-2">
              {columns
                .filter((c) => c !== cfg.labelField)
                .map((c) => (
                  <label key={c} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', cfg.textFields.includes(c) && 'border-primary bg-accent/40')}>
                    <Checkbox checked={cfg.textFields.includes(c)} onCheckedChange={(v) => setCfg({ ...cfg, textFields: v ? [...cfg.textFields, c] : cfg.textFields.filter((x) => x !== c), excludedFields: cfg.excludedFields.filter((x) => x !== c) })} />
                    {c}
                  </label>
                ))}
            </div>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <div className="text-sm font-medium">Excluded (sensitive) fields</div>
            <p className="text-xs text-muted-foreground">Excluded fields are never written to the dataset. Unmapped columns are dropped too.</p>
            <div className="flex flex-wrap gap-2">
              {columns
                .filter((c) => c !== cfg.labelField && !cfg.textFields.includes(c))
                .map((c) => (
                  <label key={c} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                    <Checkbox checked={cfg.excludedFields.includes(c)} onCheckedChange={(v) => setCfg({ ...cfg, excludedFields: v ? [...cfg.excludedFields, c] : cfg.excludedFields.filter((x) => x !== c) })} />
                    {c}
                  </label>
                ))}
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm md:col-span-2">
            <Switch checked={mask} onCheckedChange={setMask} aria-label="Mask personal data in inputs" />
            <span>
              Mask emails, phone numbers, IPs and SSN-like values in input text
              <span className="block text-xs text-muted-foreground">Recommended. Masking uses patterns and can miss some personal data.</span>
            </span>
          </label>
          {!mask && (
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <Checkbox checked={ackSensitive} onCheckedChange={(v) => setAckSensitive(!!v)} /> I confirm unmasked input fields may contain personal data and are approved for training
            </label>
          )}
        </CardContent>
      </Card>
      {cfg.labelField && (
        <Card>
          <CardHeader>
            <CardTitle>Labels</CardTitle>
            <CardDescription>From a sample of {preview.data.rows.length} rows. Merge or rename labels, or drop ones you don’t want to predict.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {[...labelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => {
                const dropped = cfg.dropLabels.includes(l)
                return (
                  <label key={l} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', dropped && 'opacity-50 line-through')}>
                    <Checkbox checked={!dropped} onCheckedChange={(v) => setCfg({ ...cfg, dropLabels: v ? cfg.dropLabels.filter((x) => x !== l) : [...cfg.dropLabels, l] })} aria-label={`Keep label ${l}`} />
                    {l} <span className="text-muted-foreground">({n}){cfg.labelMap[l] ? ` → ${cfg.labelMap[l]}` : ''}</span>
                  </label>
                )
              })}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Rename / merge label">
                <Select value={renameFrom} onValueChange={setRenameFrom}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Label" />
                  </SelectTrigger>
                  <SelectContent>
                    {[...labelCounts.keys()].map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Into">
                <Input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} className="w-48" />
              </Field>
              <Button variant="outline" disabled={!renameFrom || !renameTo.trim()} onClick={() => { setCfg({ ...cfg, labelMap: { ...cfg.labelMap, [renameFrom]: renameTo.trim() } }); setRenameFrom(''); setRenameTo('') }}>
                <Plus /> Add mapping
              </Button>
              {Object.keys(cfg.labelMap).length > 0 && (
                <Button variant="ghost" onClick={() => setCfg({ ...cfg, labelMap: {} })}>
                  <Trash2 /> Clear mappings
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Splits</CardTitle>
          <CardDescription>Duplicates are merged before splitting so the same text never appears in both training and test data. Conflicting duplicates are dropped.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Field label="Strategy">
            <Select value={cfg.split.strategy} onValueChange={(v) => setCfg({ ...cfg, split: { ...cfg.split, strategy: v as 'random' } })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random (stratified by label)</SelectItem>
                <SelectItem value="group">By group (e.g. service)</SelectItem>
                <SelectItem value="time">By time (test on newest)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {cfg.split.strategy === 'group' && (
            <Field label="Group field">
              <Select value={cfg.split.groupField ?? ''} onValueChange={(v) => setCfg({ ...cfg, split: { ...cfg.split, groupField: v } })}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {cfg.split.strategy === 'time' && (
            <Field label="Time field">
              <Select value={cfg.split.timeField ?? ''} onValueChange={(v) => setCfg({ ...cfg, split: { ...cfg.split, timeField: v } })}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Train share">
            <Input type="number" step={0.05} min={0.5} max={0.9} value={cfg.split.train} onChange={(e) => setCfg({ ...cfg, split: { ...cfg.split, train: Number(e.target.value) } })} />
          </Field>
          <Field label="Validation share" hint={`Test gets the remaining ${Math.round((1 - cfg.split.train - cfg.split.validation) * 100)}%`}>
            <Input type="number" step={0.05} min={0.05} max={0.25} value={cfg.split.validation} onChange={(e) => setCfg({ ...cfg, split: { ...cfg.split, validation: Number(e.target.value) } })} />
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={!cfg.labelField || !cfg.textFields.length || (!mask && !ackSensitive)}
            loading={prep.isPending}
            onClick={() => prep.mutate({ collectionId, opportunityId, name, config: cfg, maskPersonalData: mask, allowSensitiveFields: !mask && ackSensitive })}
          >
            Prepare dataset <ArrowRight />
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

function EvalStage({ datasetId, onNext, onBack }: { datasetId: string; onNext: () => void; onBack: () => void }) {
  const ds = useApi('ml.datasets')
  const pv = useApi('ml.datasetPreview', { id: datasetId })
  const d = ds.data?.find((x) => x.id === datasetId)
  const st = (d?.stats ?? {}) as { splits?: Record<string, number>; per_label?: Record<string, Record<string, number>>; removed?: Record<string, unknown>; leakage?: { text_overlap: number; group_overlap: number }; warnings?: string[]; labels?: string[]; strategy?: string }
  if (!d) return <Loading />
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {d.name} v{d.version}
          </CardTitle>
          <CardDescription>Prepared from {d.collectionName} (collection version {d.collectionVersion}). Split strategy: {st.strategy}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <KeyValue
              items={[
                ['Training examples', st.splits?.train],
                ['Validation examples', st.splits?.validation],
                ['Held-out test examples', <span key="t"><strong>{st.splits?.test}</strong> — never used for training or tuning</span>],
                ['Duplicates merged', String(st.removed?.duplicates_merged ?? 0)],
                ['Conflicting duplicates dropped', String(st.removed?.conflicting_duplicates_dropped ?? 0)],
                ['Missing labels removed', String(st.removed?.missing_label ?? 0)],
                ['Rare labels dropped', ((st.removed?.rare_labels_dropped as string[]) ?? []).join(', ') || 'none'],
                ['Leakage check', st.leakage && st.leakage.text_overlap + st.leakage.group_overlap === 0 ? <StatusBadge key="l" status="ok" label="No overlap between splits" /> : <StatusBadge key="l" status="error" label="Overlap found" />]
              ]}
            />
            {(st.warnings ?? []).map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Examples per label</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead className="text-right">Train</TableHead>
                  <TableHead className="text-right">Validation</TableHead>
                  <TableHead className="text-right">Test</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(st.per_label ?? {}).map(([l, c]) => (
                  <TableRow key={l}>
                    <TableCell>{l}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.train}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.validation}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.test}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>How the model will be evaluated</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            <li>Baselines trained on the same training split: always-majority-class, and TF-IDF + logistic regression.</li>
            <li>All models scored on the same held-out test split: macro F1, accuracy, per-class precision/recall/F1, and a confusion matrix.</li>
            <li>Latency per prediction measured on this computer.</li>
            <li>The saved model is reloaded from disk and must reproduce its predictions before the job counts as successful.</li>
          </ul>
          <Collapsible>
            <CollapsibleTrigger className="text-sm font-medium text-primary">Preview training data</CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <Query q={pv}>
                {(p) => (
                  <div className="max-h-64 overflow-auto rounded-md border">
                    <Table>
                      <TableBody>
                        {p.train.map((e: { text: string; label: string }, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="max-w-md truncate text-xs">{e.text}</TableCell>
                            <TableCell>
                              <Badge tone="neutral">{e.label}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Query>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
        <CardFooter className="justify-between">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
          <Button onClick={onNext}>
            Training settings <ArrowRight />
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

function ConfigStage({ config, setConfig, onNext, onBack }: { config: TrainingConfig; setConfig: (c: TrainingConfig) => void; onNext: () => void; onBack: () => void }) {
  const bases = useApi('ml.baseModels')
  return (
    <Card>
      <CardHeader>
        <CardTitle>Training settings</CardTitle>
        <CardDescription>Defaults suit a laptop. Advanced settings are optional.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2" role="radiogroup" aria-label="Base model">
          {(bases.data ?? []).map((b) => (
            <label key={b.id} className={cn('flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2', config.baseModel === b.id && 'border-primary bg-accent/40')}>
              <input type="radio" checked={config.baseModel === b.id} onChange={() => setConfig({ ...config, baseModel: b.id, smokeTest: b.tier === 'smoke' ? true : config.smokeTest })} />
              <div className="flex-1">
                <div className="text-sm font-medium">{b.label}</div>
                <div className="text-xs text-muted-foreground">
                  {b.id} · {b.license} license · ~{b.sizeMb} MB download · {b.paramsM}M parameters
                </div>
              </div>
              {b.tier === 'smoke' && <Badge tone="warning">Smoke test only</Badge>}
            </label>
          ))}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={config.smokeTest} onCheckedChange={(v) => setConfig({ ...config, smokeTest: v })} aria-label="Smoke test" />
          <span>
            Smoke test (1 epoch on ≤64 examples)
            <span className="block text-xs text-muted-foreground">Checks the pipeline end to end in seconds. Results are labeled as a smoke test and do not indicate business-quality performance.</span>
          </span>
        </label>
        <Collapsible>
          <CollapsibleTrigger className="text-sm font-medium text-primary">Advanced settings</CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="Epochs">
              <Input type="number" min={1} max={20} value={config.epochs} onChange={(e) => setConfig({ ...config, epochs: Number(e.target.value) })} />
            </Field>
            <Field label="Learning rate">
              <Input type="number" step={0.0001} value={config.learningRate} onChange={(e) => setConfig({ ...config, learningRate: Number(e.target.value) })} />
            </Field>
            <Field label="Batch size">
              <Input type="number" min={1} value={config.batchSize} onChange={(e) => setConfig({ ...config, batchSize: Number(e.target.value) })} />
            </Field>
            <Field label="Max tokens per example">
              <Input type="number" min={16} max={512} value={config.maxLength} onChange={(e) => setConfig({ ...config, maxLength: Number(e.target.value) })} />
            </Field>
            <Field label="LoRA rank">
              <Input type="number" min={1} max={64} value={config.loraRank} onChange={(e) => setConfig({ ...config, loraRank: Number(e.target.value) })} />
            </Field>
            <Field label="Device">
              <Select value={config.device} onValueChange={(v) => setConfig({ ...config, device: v as 'auto' })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automatic</SelectItem>
                  <SelectItem value="cpu">CPU</SelectItem>
                  <SelectItem value="mps">Apple Silicon GPU</SelectItem>
                  <SelectItem value="cuda">NVIDIA GPU (CUDA)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button onClick={onNext}>
          Review <ArrowRight />
        </Button>
      </CardFooter>
    </Card>
  )
}

function ReviewStage({ datasetId, config, opportunityId, onBack }: { datasetId: string; config: TrainingConfig; opportunityId?: string; onBack: () => void }) {
  const [review, setReview] = React.useState<Out<'ml.reviewTraining'> | null>(null)
  const r = useAction('ml.reviewTraining', { invalidate: [], onSuccess: setReview })
  const [name, setName] = React.useState(`Incident classifier ${config.smokeTest ? '(smoke test)' : ''}`.trim())
  const start = useAction('ml.startTraining', { success: (d) => (d.status === 'awaiting_approval' ? 'Sent for budget approval' : 'Training started'), onSuccess: (d) => navigate(`/models/jobs/${d.id}`) })
  React.useEffect(() => {
    r.mutate({ datasetId, config })
  }, [datasetId, JSON.stringify(config)])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget & permission review</CardTitle>
        <CardDescription>Checked again when the job starts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!review ? (
          <Loading label="Running hardware preflight and permission checks…" />
        ) : (
          <>
            <ul className="divide-y rounded-md border">
              {review.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <StatusBadge status={c.status} label={c.status === 'ok' ? 'OK' : undefined} />
                  <div>
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-muted-foreground">{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
            {review.estimate && (
              <KeyValue
                items={[
                  ['Estimated time', `${duration(review.estimate.seconds)} (${review.estimate.basis})`],
                  ['Estimated cost', review.estimate.costUsd ? money(review.estimate.costUsd) : 'No API cost'],
                  ['Cost basis', review.estimate.costNote],
                  ['Training examples', review.estimate.trainExamples],
                  ['Base model', review.model ? `${review.model.id} · ${String((review.model as { license?: string }).license ?? '')}` : '—']
                ]}
              />
            )}
            <Field label="Job name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button disabled={!review?.ready || !name.trim()} loading={start.isPending} onClick={() => start.mutate({ datasetId, opportunityId, name, config })}>
          {review?.needsApproval ? <><FlaskConical /> Request approval to train</> : <><Play /> Start training</>}
        </Button>
      </CardFooter>
    </Card>
  )
}
