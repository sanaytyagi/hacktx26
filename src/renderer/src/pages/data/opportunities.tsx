import * as React from 'react'
import { ChevronRight, FlaskConical, Sparkles, Wand2 } from 'lucide-react'
import { useAction, useApi, type Out } from '@/lib/api'
import { navigate } from '@/lib/router'
import { money } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, KeyValue, Loading, PageHeader } from '@/components/app/common'

type Find = Out<'ml.findOpportunities'>
type Card_ = Find['opportunities'][number] & Record<string, unknown>

export function OpportunitiesPage({ collectionId }: { collectionId: string }) {
  const col = useApi('data.collection', { id: collectionId })
  const existing = useApi('ml.opportunities', { collectionId })
  const [result, setResult] = React.useState<Find | null>(null)
  const find = useAction('ml.findOpportunities', { onSuccess: setResult, invalidate: ['ml.', 'home.'] })
  const cards = (result?.opportunities ?? existing.data ?? []) as Card_[]
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <a href="#/data">Data</a> · <a href={`#/data/${collectionId}`}>{col.data?.name ?? 'Collection'}</a>
          </>
        }
        title="Model opportunities"
        description="Relay profiles the actual records you are approved to analyze and suggests where a specialized model could help — and where it would not. Profiling runs locally; nothing is sent to a provider."
        actions={
          <Button onClick={() => find.mutate({ collectionId })} loading={find.isPending}>
            <Sparkles /> {cards.length ? 'Re-run analysis' : 'Find model opportunities'}
          </Button>
        }
      />
      {find.isPending && <Loading label="Profiling the collection (schema, labels, duplicates, sensitive fields)…" />}
      {result?.profile && <ProfileView p={result.profile} />}
      <div className="mt-5 space-y-4">
        {!find.isPending && cards.length === 0 && (
          <EmptyState icon={Sparkles} title="Not analyzed yet">
            Click “Find model opportunities” to profile this collection.
          </EmptyState>
        )}
        {cards.map((c) => (
          <OpportunityCard key={String(c.id)} c={c} collectionId={collectionId} />
        ))}
      </div>
    </>
  )
}

function ProfileView({ p }: { p: NonNullable<Find['profile']> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data profile</CardTitle>
        <CardDescription>
          {p.rows.toLocaleString()} rows · {p.columns.length} columns · {p.exact_duplicate_rows} exact duplicate rows
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-primary">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> Columns
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Column</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Missing</TableHead>
                  <TableHead className="text-right">Distinct</TableHead>
                  <TableHead>Sensitive</TableHead>
                  <TableHead>Top values</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.columns.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-mono text-xs">{c.name}</TableCell>
                    <TableCell>{c.kind}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.missing_pct}%</TableCell>
                    <TableCell className="text-right tabular-nums">{c.unique}</TableCell>
                    <TableCell>{c.sensitive.length ? <Badge tone="warning">{c.sensitive.join(', ')}</Badge> : '—'}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{c.top_values.slice(0, 4).map((t) => `${t.value} (${t.count})`).join(', ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CollapsibleContent>
        </Collapsible>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {p.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function OpportunityCard({ c, collectionId }: { c: Card_; collectionId: string }) {
  const providers = useApi('providers.list')
  const [prov, setProv] = React.useState('')
  const explain = useAction('ml.explainOpportunity', { invalidate: [] })
  const approach = c.approach as { recommended: string; options: { approach: string; why: string }[] }
  const compute = c.compute as null | { baseModel: string; license: string; downloadMb: number; estTrainMinutes: number; device: string; trainingCostUsd: number | null; trainingCostNote: string; inferenceCost: string }
  const worth = c.worth as { for: string[]; against: string[] }
  const evidence = c.evidence as { label: string; value: string }[]
  const configured = (providers.data ?? []).filter((p) => p.enabled && p.configured)
  const label: Record<string, string> = { rules: 'Rules', retrieval: 'Retrieval (search)', baseline: 'Baseline classifier', fine_tune: 'Fine-tune a small model' }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={c.kind === 'classification' ? 'primary' : 'neutral'}>{c.kind === 'classification' ? 'Classification' : c.kind === 'retrieval' ? 'Retrieval' : 'Not recommended'}</Badge>
          <Badge tone="info">Suggested approach: {label[approach.recommended] ?? approach.recommended}</Badge>
        </div>
        <CardTitle className="text-base">{String(c.title)}</CardTitle>
        <CardDescription>{String(c.businessTask)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <KeyValue items={[['Intended users', String(c.intendedUsers || '—')], ['Input', (c.inputs as string[]).join(', ') || '—'], ['Output', String(c.output ?? '—')]]} />
          <div>
            <div className="mb-1 text-sm font-medium">Evidence from the data</div>
            <KeyValue items={evidence.map((e) => [e.label, e.value])} />
          </div>
          {(c.cleanup as string[]).length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium">Cleanup needed</div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {(c.cleanup as string[]).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {(c.sensitiveExcluded as string[]).length > 0 && <Alert tone="warning">Sensitive fields that will be excluded from training: {(c.sensitiveExcluded as string[]).join(', ')}</Alert>}
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-sm font-medium">Approaches compared</div>
            <ul className="space-y-1 text-sm">
              {approach.options.map((o) => (
                <li key={o.approach}>
                  <span className="font-medium">{label[o.approach]}:</span> <span className="text-muted-foreground">{o.why}</span>
                </li>
              ))}
            </ul>
          </div>
          {(c.evaluation as string[]).length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium">How we’d evaluate it</div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {(c.evaluation as string[]).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {compute && (
            <div>
              <div className="mb-1 text-sm font-medium">Compute & cost (estimates)</div>
              <KeyValue
                items={[
                  ['Base model', `${compute.baseModel} (${compute.license}, ~${compute.downloadMb} MB download)`],
                  ['Training time', `~${compute.estTrainMinutes} min on ${compute.device}`],
                  ['Training cost', compute.trainingCostUsd !== null ? money(compute.trainingCostUsd) : 'Time only'],
                  ['Inference', compute.inferenceCost]
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{compute.trainingCostNote}</p>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-sm font-medium text-success">Why it may be worth it</div>
              <ul className="list-disc pl-5 text-xs">{worth.for.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
            <div>
              <div className="mb-1 text-sm font-medium text-warning">Why it may not</div>
              <ul className="list-disc pl-5 text-xs">{worth.against.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          </div>
          {explain.data && (
            <Alert tone="info" title={`Explanation (${explain.data.model})`}>
              <span className="whitespace-pre-wrap">{explain.data.text}</span>
            </Alert>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        <div className="flex items-center gap-2">
          {configured.length > 0 ? (
            <>
              <Select value={prov} onValueChange={setProv}>
                <SelectTrigger className="h-8 w-64" aria-label="Model for explanation">
                  <SelectValue placeholder="Explain with a model…" />
                </SelectTrigger>
                <SelectContent>
                  {configured.flatMap((p) => p.models.map((m) => <SelectItem key={`${p.id}|${m}`} value={`${p.id}|${m}`}>{p.name} · {m}</SelectItem>))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!prov} loading={explain.isPending} onClick={() => explain.mutate({ id: String(c.id), providerId: prov.split('|')[0], model: prov.split('|')[1] })}>
                <Wand2 /> Explain
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Optional model explanations need a configured provider. Local-only collections can only be explained by a local model.</span>
          )}
        </div>
        {c.kind === 'classification' && (
          <Button onClick={() => navigate(`/models/train?collection=${collectionId}&opportunity=${c.id}&text=${encodeURIComponent(String(c.textColumn))}&label=${encodeURIComponent(String(c.labelColumn))}`)}>
            <FlaskConical /> Prepare dataset & train
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

