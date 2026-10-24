import * as React from 'react'
import { Pencil, Plus } from 'lucide-react'
import { useAction, useApi, type Out } from '@/lib/api'
import { dateTime, duration, money, pct } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Progress, Switch } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Field, PageHeader, Query, ReasonDialog } from '@/components/app/common'
import { setQuery, useRoute } from '@/lib/router'

type B = Out<'budget.overview'>

export function BudgetPage() {
  const q = useApi('budget.overview')
  const { query } = useRoute()
  return (
    <>
      <PageHeader
        title="Budget"
        description="Operating (agent runs) and training budgets at workspace, team and agent level. Paid calls reserve their estimated cost before starting and are reconciled to metered usage afterwards."
      />
      <Alert tone="neutral" className="mb-4">
        Estimates are separated from metered costs (provider-reported usage × your configured prices). Calls already in flight may still be billed after a limit is reached, so Relay’s limits cannot guarantee an exact invoice cap. Unknown pricing is never counted as free.
      </Alert>
      <Query q={q}>
        {(d) => (
          <Tabs value={query.tab ?? 'budgets'} onValueChange={(v) => setQuery({ tab: v })}>
            <TabsList>
              <TabsTrigger value="budgets">Budgets</TabsTrigger>
              <TabsTrigger value="attribution">Attribution & effectiveness</TabsTrigger>
              <TabsTrigger value="ledger">Ledger</TabsTrigger>
              <TabsTrigger value="prices">Prices</TabsTrigger>
            </TabsList>
            <TabsContent value="budgets">
              <Budgets d={d} />
            </TabsContent>
            <TabsContent value="attribution">
              <Attribution d={d} />
            </TabsContent>
            <TabsContent value="ledger">
              <Ledger d={d} />
            </TabsContent>
            <TabsContent value="prices">
              <Prices d={d} />
            </TabsContent>
          </Tabs>
        )}
      </Query>
    </>
  )
}

function Budgets({ d }: { d: B }) {
  const [edit, setEdit] = React.useState<B['budgets'][number] | null>(null)
  const [inc, setInc] = React.useState<B['budgets'][number] | null>(null)
  const [newLimit, setNewLimit] = React.useState(0)
  const req = useAction('budget.requestIncrease', { success: 'Increase requested', onSuccess: () => setInc(null) })
  const groups: [string, (b: B['budgets'][number]) => boolean][] = [
    ['Workspace', (b) => b.scope === 'workspace'],
    ['Teams', (b) => b.scope === 'team'],
    ['Agents', (b) => b.scope === 'agent'],
    ['Jobs', (b) => b.scope === 'job']
  ]
  return (
    <div className="space-y-5">
      {groups.map(([label, f]) => {
        const items = d.budgets.filter(f)
        if (!items.length) return null
        return (
          <section key={label} className="space-y-2">
            <h2 className="text-sm font-semibold">{label}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((b) => (
                <Card key={b.id}>
                  <CardContent className="space-y-2 pt-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{b.label}</div>
                        <div className="text-xs text-muted-foreground">
                          Monthly · {b.hardLimit ? 'hard limit' : 'alert only'} · alert at {b.alertPct}%
                        </div>
                      </div>
                      <Badge tone={b.kind === 'training' ? 'info' : 'neutral'}>{b.kind}</Badge>
                    </div>
                    <Progress value={b.pct} aria-label={`${Math.round(b.pct)}% used`} />
                    <div className="flex flex-wrap justify-between gap-2 text-sm tabular-nums">
                      <span>
                        {money(b.chargedUsd)} spent{b.reservedUsd > 0 && ` + ${money(b.reservedUsd)} reserved`} of {money(b.limitUsd, 2)}
                      </span>
                      <span className={b.pct >= b.alertPct ? 'font-medium text-warning' : 'text-muted-foreground'}>{money(b.remainingUsd)} left</span>
                    </div>
                    {b.estimatedChargedUsd > 0 && <div className="text-xs text-muted-foreground">Includes {money(b.estimatedChargedUsd)} recorded as estimates (usage unknown).</div>}
                    <div className="flex gap-2">
                      {b.canEdit && (
                        <Button size="sm" variant="outline" onClick={() => setEdit(b)}>
                          <Pencil /> Edit
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => { setNewLimit(Math.max(b.limitUsd * 2, 1)); setInc(b) }}>
                        Request increase
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )
      })}
      {edit && <EditBudget b={edit} onClose={() => setEdit(null)} />}
      <ReasonDialog open={!!inc} onOpenChange={(o) => !o && setInc(null)} title="Request a budget increase" description="Managers approve agent budgets up to their ceiling. Team, workspace and larger requests go to an administrator." onSubmit={(reason) => inc && req.mutate({ budgetId: inc.id, newLimitUsd: newLimit, reason })} loading={req.isPending}>
        <Field label="New monthly limit (USD)">
          <Input type="number" min={0.01} step={0.01} value={newLimit} onChange={(e) => setNewLimit(Number(e.target.value))} />
        </Field>
      </ReasonDialog>
    </div>
  )
}

function EditBudget({ b, onClose }: { b: B['budgets'][number]; onClose: () => void }) {
  const [limit, setLimit] = React.useState(b.limitUsd)
  const [alert, setAlert] = React.useState(b.alertPct)
  const [hard, setHard] = React.useState(b.hardLimit)
  const save = useAction('budget.upsert', { success: 'Budget updated', onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{b.label}</DialogTitle>
          <DialogDescription>Changes are recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <Field label="Monthly limit (USD)">
          <Input type="number" min={0} step={0.01} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </Field>
        <Field label="Alert at (% of limit)">
          <Input type="number" min={1} max={100} value={alert} onChange={(e) => setAlert(Number(e.target.value))} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={hard} onCheckedChange={setHard} aria-label="Hard limit" /> Hard limit (block new paid calls when reached)
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate({ scope: b.scope, scopeId: b.scopeId, kind: b.kind, limitUsd: limit, alertPct: alert, hardLimit: hard })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Attribution({ d }: { d: B }) {
  const table = (title: string, rows: { k: string; v: number }[]) => (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No charges this month.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {rows.map((r) => (
              <li key={r.k} className="flex justify-between gap-2">
                <span className="truncate">{r.k}</span>
                <span className="tabular-nums">{money(r.v)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {table('By agent', d.byAgent.map((a) => ({ k: a.name, v: a.total })))}
        {table('By model or tool', d.byModel.map((m) => ({ k: m.model, v: m.total })))}
        {table('By team', d.byTeam.map((t) => ({ k: `${t.team} (${t.kind})`, v: t.total })))}
        {table('By project', d.byProject.map((p) => ({ k: p.project, v: p.total })))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Agent effectiveness this month</CardTitle>
          <CardDescription>Real runs only (sample runs excluded). Cost per successful run counts all spending, including failed runs.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Succeeded</TableHead>
                <TableHead className="text-right">Failure rate</TableHead>
                <TableHead className="text-right">Review rate</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Cost per successful run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.effectiveness.map((e) => (
                <TableRow key={e.agent_id}>
                  <TableCell>{e.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.runs}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.succeeded}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(e.failureRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(e.reviewRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(e.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.costPerSuccess === null ? '—' : money(e.costPerSuccess)}</TableCell>
                </TableRow>
              ))}
              {d.effectiveness.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    No runs this month.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Local compute</CardTitle>
          <CardDescription>
            Training runs on this computer. {d.localComputeRateUsdPerHour > 0 ? `Costed at the administrator-configured rate of ${money(d.localComputeRateUsdPerHour, 2)}/hour.` : 'No local compute rate is configured, so it is shown as time only.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {d.localCompute.length === 0 ? (
            <p className="text-sm text-muted-foreground">No training jobs yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.localCompute.map((j, i) => (
                <li key={i} className="flex justify-between">
                  <span>
                    {j.name} <span className="text-muted-foreground">({j.status})</span>
                  </span>
                  <span className="tabular-nums">
                    {duration(j.elapsed_sec)}
                    {d.localComputeRateUsdPerHour > 0 && ` · ${money((j.elapsed_sec / 3600) * d.localComputeRateUsdPerHour)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Ledger({ d }: { d: B }) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Basis</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {d.ledger.map((l) => (
            <TableRow key={String(l.id)}>
              <TableCell className="text-muted-foreground">{dateTime(String(l.created_at))}</TableCell>
              <TableCell>
                <Badge tone={l.entry_type === 'reservation' ? 'info' : 'neutral'}>{String(l.entry_type)}</Badge> <span className="text-xs text-muted-foreground">{String(l.status)}</span>
              </TableCell>
              <TableCell>
                <Badge tone={l.basis === 'estimate' ? 'warning' : l.basis === 'metered' ? 'success' : 'neutral'}>{l.basis === 'metered' ? 'metered usage' : String(l.basis)}</Badge>
              </TableCell>
              <TableCell className="max-w-sm truncate text-xs">{String(l.description)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{String(l.agent_name ?? '—')}</TableCell>
              <TableCell className="text-right tabular-nums">{money(Number(l.amount_usd))}</TableCell>
            </TableRow>
          ))}
          {d.ledger.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                No ledger entries yet. Paid model calls, web searches and training jobs appear here.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  )
}

function Prices({ d }: { d: B }) {
  const [edit, setEdit] = React.useState<null | Partial<B['prices'][number]>>(null)
  return (
    <div className="space-y-3">
      {d.canEditPrices && (
        <Button onClick={() => setEdit({ unit: 'per_1m_tokens', currency: 'USD', effective_date: new Date().toISOString().slice(0, 10) })}>
          <Plus /> Add price
        </Button>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Model / service</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Per call</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.prices.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.provider_kind}</TableCell>
                <TableCell className="font-mono text-xs">{p.model}</TableCell>
                <TableCell className="text-xs">{p.unit.replace(/_/g, ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{p.input_price === null ? '—' : `${money(p.input_price, 2)}`}</TableCell>
                <TableCell className="text-right tabular-nums">{p.output_price === null ? '—' : `${money(p.output_price, 2)}`}</TableCell>
                <TableCell className="text-right tabular-nums">{p.call_price === null ? '—' : money(p.call_price, 4)}</TableCell>
                <TableCell className="max-w-xs text-xs text-muted-foreground">{p.source}</TableCell>
                <TableCell className="text-xs">{p.effective_date}</TableCell>
                <TableCell>
                  {d.canEditPrices && (
                    <Button size="icon-sm" variant="ghost" aria-label="Edit price" onClick={() => setEdit(p)}>
                      <Pencil />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs text-muted-foreground">Prices are in {d.prices[0]?.currency ?? 'USD'}. Models without a price here are blocked from paid use, not treated as free.</p>
      {edit && <PriceDialog p={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function PriceDialog({ p, onClose }: { p: Partial<B['prices'][number]>; onClose: () => void }) {
  const [f, setF] = React.useState({ providerKind: p.provider_kind ?? '', model: p.model ?? '', unit: (p.unit ?? 'per_1m_tokens') as 'per_1m_tokens' | 'per_call' | 'per_hour', input: p.input_price ?? null, output: p.output_price ?? null, call: p.call_price ?? null, source: p.source ?? '', date: p.effective_date ?? new Date().toISOString().slice(0, 10), notes: p.notes ?? '' })
  const save = useAction('budget.upsertPrice', { success: 'Price saved', onSuccess: onClose })
  const num = (v: string) => (v === '' ? null : Number(v))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.id ? 'Edit price' : 'Add price'}</DialogTitle>
          <DialogDescription>Used to estimate and meter spend. Record where the number came from.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider kind" hint="anthropic, gemini, openai_compatible, serpapi…">
            <Input value={f.providerKind} onChange={(e) => setF({ ...f, providerKind: e.target.value })} />
          </Field>
          <Field label="Model / service">
            <Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
          </Field>
          <Field label="Unit">
            <Select value={f.unit} onValueChange={(v) => setF({ ...f, unit: v as 'per_call' })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_1m_tokens">Per 1M tokens</SelectItem>
                <SelectItem value="per_call">Per call</SelectItem>
                <SelectItem value="per_hour">Per hour</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Effective date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          {f.unit === 'per_1m_tokens' ? (
            <>
              <Field label="Input price (USD / 1M)">
                <Input type="number" step="0.01" value={f.input ?? ''} onChange={(e) => setF({ ...f, input: num(e.target.value) })} />
              </Field>
              <Field label="Output price (USD / 1M)">
                <Input type="number" step="0.01" value={f.output ?? ''} onChange={(e) => setF({ ...f, output: num(e.target.value) })} />
              </Field>
            </>
          ) : (
            <Field label={`Price (USD ${f.unit === 'per_call' ? 'per call' : 'per hour'})`}>
              <Input type="number" step="0.0001" value={f.call ?? ''} onChange={(e) => setF({ ...f, call: num(e.target.value) })} />
            </Field>
          )}
          <Field label="Source" className="sm:col-span-2">
            <Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="Provider pricing page, contract, …" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!f.providerKind || !f.model || !f.source}
            loading={save.isPending}
            onClick={() => save.mutate({ id: p.id, providerKind: f.providerKind, model: f.model, unit: f.unit, inputPrice: f.unit === 'per_1m_tokens' ? f.input : null, outputPrice: f.unit === 'per_1m_tokens' ? f.output : null, callPrice: f.unit !== 'per_1m_tokens' ? f.call : null, currency: 'USD', source: f.source, effectiveDate: f.date, notes: f.notes })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
