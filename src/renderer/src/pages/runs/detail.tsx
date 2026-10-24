import * as React from 'react'
import { Ban, ChevronRight, CircleCheck, Pause, Play, RotateCcw, ThumbsUp, Pencil, Flag, FlaskConical, Repeat } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { onPush, useAction, useApi, invalidatePrefixes, type Out } from '@/lib/api'
import { navigate } from '@/lib/router'
import { dateTime, duration, money } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FixtureBadge, JsonView, KeyValue, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { KindBadge } from '@/components/app/spec-editor'

type Run = Out<'runs.get'>
const ACTIVE = ['queued', 'running', 'interrupted']

export function RunDetailPage({ id }: { id: string }) {
  const qc = useQueryClient()
  const q = useApi('runs.get', { id }, { refetchInterval: (query) => (ACTIVE.includes((query.state.data as Run | undefined)?.status ?? '') ? 1500 : false) })
  React.useEffect(() => onPush((e) => (e.type === 'run.event' || e.type === 'run.updated') && e.runId === id && invalidatePrefixes(qc, ['runs.get'])), [id, qc])
  return (
    <Query q={q}>
      {(r) => (
        <>
          <PageHeader
            breadcrumb={
              <>
                <a href="#/runs">Runs</a> · <a href={`#/agents/${r.agentId}`}>{r.agentName}</a>
              </>
            }
            title={
              <span className="flex flex-wrap items-center gap-2">
                Run of {r.agentName} <span className="text-muted-foreground">v{r.version}</span>
                <StatusBadge status={r.status} />
                <Badge tone={r.environment === 'test' ? 'neutral' : 'success'}>{r.environment === 'test' ? 'Test' : 'Live'}</Badge>
                {r.isFixture && <FixtureBadge />}
              </span>
            }
            description={`Started ${dateTime(r.startedAt ?? r.createdAt)} · ${r.trigger} trigger${r.finishedAt && r.startedAt ? ` · took ${duration((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}` : ''}`}
            actions={<Controls r={r} />}
          />
          {r.isFixture && <Alert tone="neutral" className="mb-4" title="Sample run (fixture)">This run was created by the demo seed to illustrate history. It did not actually execute.</Alert>}
          {r.error && (
            <Alert tone={r.status === 'blocked' ? 'warning' : 'danger'} className="mb-4" title={r.status === 'blocked' ? 'Blocked' : r.status === 'cancelled' ? 'Stopped' : 'Failed'}>
              {r.error}
            </Alert>
          )}
          <div className="grid gap-5 xl:grid-cols-[1fr_24rem]">
            <div className="space-y-4">
              {r.reviews.filter((t) => t.status === 'open').map((t) => (
                <ReviewPanel key={t.id} r={r} task={t} />
              ))}
              <Timeline r={r} />
              {(r.status === 'succeeded' || r.status === 'failed') && !r.isFixture && r.canGiveFeedback && <Feedback r={r} />}
            </div>
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Usage</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <KeyValue
                    items={[
                      ['Tool calls', `${r.toolCalls} of ${r.limits.maxToolCalls}`],
                      ['Tokens', `${(r.tokensIn + r.tokensOut).toLocaleString()} of ${r.limits.maxTokens.toLocaleString()}`],
                      ['Retries', String(r.retries)],
                      ['Cost (metered)', <span key="m">{money(r.costMetered)} <span className="text-xs text-muted-foreground">from provider-reported usage × configured prices</span></span>],
                      ['Cost (estimated)', <span key="e">{money(r.costEstimated)} <span className="text-xs text-muted-foreground">where usage was unknown</span></span>]
                    ]}
                  />
                  {r.usage.length > 0 && (
                    <div className="space-y-1 text-xs">
                      {r.usage.map((u, i) => (
                        <div key={i} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">
                            {u.model} {u.input_tokens !== null ? `(${u.input_tokens}/${u.output_tokens} tok)` : `(${u.calls} call)`}
                          </span>
                          <span className="tabular-nums">{u.basis === 'local' ? 'local' : money(u.cost_usd)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Inputs</CardTitle>
                </CardHeader>
                <CardContent>
                  <JsonView value={r.inputs} maxHeight={180} />
                </CardContent>
              </Card>
              {r.outputs !== null && (
                <Card>
                  <CardHeader>
                    <CardTitle>Outputs</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <JsonView value={r.outputs} maxHeight={260} />
                  </CardContent>
                </Card>
              )}
              <Activity r={r} />
            </div>
          </div>
        </>
      )}
    </Query>
  )
}

function Controls({ r }: { r: Run }) {
  const cancel = useAction('runs.cancel', { success: 'Run cancelled' })
  const pause = useAction('runs.pause', { success: 'Will pause after the current step' })
  const resume = useAction('runs.resume', { success: 'Resumed' })
  const retry = useAction('runs.retry', { success: 'Retrying the failed step' })
  const again = useAction('runs.start', { success: 'Started a new run', onSuccess: (d) => navigate(`/runs/${d.id}`) })
  if (r.isFixture || !r.canManage) return null
  const terminal = ['succeeded', 'failed', 'cancelled', 'blocked'].includes(r.status)
  return (
    <>
      {(r.status === 'running' || r.status === 'queued') && (
        <Button variant="outline" onClick={() => pause.mutate({ id: r.id })} loading={pause.isPending}>
          <Pause /> Pause
        </Button>
      )}
      {(r.status === 'paused' || r.status === 'interrupted') && (
        <Button onClick={() => resume.mutate({ id: r.id })} loading={resume.isPending}>
          <Play /> Resume
        </Button>
      )}
      {(r.status === 'failed' || r.status === 'blocked') && (
        <Button variant="outline" onClick={() => retry.mutate({ id: r.id })} loading={retry.isPending}>
          <RotateCcw /> Retry failed step
        </Button>
      )}
      {!terminal && (
        <Button variant="outline" onClick={() => cancel.mutate({ id: r.id })} loading={cancel.isPending}>
          <Ban /> Cancel
        </Button>
      )}
      {terminal && (
        <Button variant="outline" onClick={() => again.mutate({ agentId: r.agentId, environment: r.environment as 'test' | 'live', inputs: r.inputs as Record<string, unknown> })} loading={again.isPending}>
          <Repeat /> Run again
        </Button>
      )}
    </>
  )
}

function Timeline({ r }: { r: Run }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Steps</CardTitle>
        <CardDescription>In order. Completed steps are checkpointed: resuming or retrying never repeats them.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {r.plan.map((p, i) => {
            const rows = r.steps.filter((s) => s.stepId === p.id)
            const summary = rows.find((s) => s.iteration === -1)
            const iters = rows.filter((s) => s.iteration >= 0)
            const status = summary?.status ?? iters.find((s) => s.status === 'failed')?.status ?? iters.find((s) => s.status === 'running')?.status ?? (r.reviews.some((t) => t.stepId === p.id && t.status === 'open') ? 'needs_review' : 'queued')
            const shown = summary ?? iters[iters.length - 1]
            return (
              <li key={p.id} className="rounded-md border">
                <Collapsible defaultOpen={status === 'failed' || status === 'running'}>
                  <CollapsibleTrigger className="group flex w-full items-center gap-3 px-3 py-2 text-left">
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{i + 1}</span>
                    <span className="flex-1 truncate text-sm font-medium">{p.title}</span>
                    <KindBadge kind={p.kind} />
                    <StatusBadge status={status === 'queued' && ['succeeded', 'failed', 'cancelled', 'blocked'].includes(r.status) ? 'skipped' : status} label={status === 'queued' && ['succeeded', 'failed', 'cancelled', 'blocked'].includes(r.status) ? 'Not run' : status === 'queued' ? 'Waiting' : undefined} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 border-t px-3 py-2 text-sm">
                    {p.tool && <div className="text-xs text-muted-foreground">Tool: {p.tool}{p.approvalBefore ? ' · approval checkpoint' : ''}</div>}
                    {shown?.explanation && <div className="text-muted-foreground">{shown.explanation}</div>}
                    {iters.some((s) => s.error) && iters.filter((s) => s.error).map((s) => <Alert key={s.iteration} tone="danger">{p.forEach ? `Item ${s.iteration + 1}: ` : ''}{s.error}</Alert>)}
                    {p.forEach && iters.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {iters.map((s) => (
                          <StatusBadge key={s.iteration} status={s.status} label={`Item ${s.iteration + 1}`} />
                        ))}
                      </div>
                    )}
                    {shown && shown.output !== null && <JsonView value={shown.output} maxHeight={240} />}
                    {shown && shown.taint.length > 0 && <div className="text-xs text-muted-foreground">Contains data from {shown.taint.length} collection(s).</div>}
                  </CollapsibleContent>
                </Collapsible>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

function Activity({ r }: { r: Run }) {
  const ref = React.useRef<HTMLOListElement>(null)
  React.useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [r.events.length])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Live log of what the agent is doing</CardDescription>
      </CardHeader>
      <CardContent>
        <ol ref={ref} className="max-h-96 space-y-1.5 overflow-y-auto text-xs" aria-live="polite">
          {r.events.map((e) => (
            <li key={e.id} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={cn(e.type === 'failed' || e.type === 'tool_error' ? 'text-danger' : e.type === 'blocked' || e.type === 'needs_review' ? 'text-warning' : e.type === 'succeeded' ? 'text-success' : '')}>{e.message}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function ReviewPanel({ r, task }: { r: Run; task: Run['reviews'][number] }) {
  const payload = task.payload as { data?: unknown; args?: unknown; tool?: string; toolName?: string; access?: string; error?: string }
  const [text, setText] = React.useState(JSON.stringify(payload.data ?? null, null, 2))
  const [comment, setComment] = React.useState('')
  const resolve = useAction('runs.resolveReview', { success: 'Recorded. The run continues.', invalidate: ['runs.', 'home.', 'session.'] })
  let parsed: unknown = undefined
  let parseError: string | null = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    parseError = (e as Error).message
  }
  const act = (decision: 'approve' | 'reject' | 'edit' | 'done' | 'retry' | 'skip' | 'provide', data?: unknown) => resolve.mutate({ id: task.id, decision, data, comment: comment || undefined })
  return (
    <Card className="border-warning/50 bg-warning-subtle/30">
      <CardHeader>
        <div className="flex items-center gap-2">
          <StatusBadge status="needs_review" />
        </div>
        <CardTitle>{task.title}</CardTitle>
        <CardDescription>{task.prompt}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {task.kind === 'tool_approval' && (
          <>
            <KeyValue items={[['Tool', payload.toolName ?? payload.tool], ['Access', <Badge key="a" tone="warning">{payload.access}</Badge>]]} />
            <JsonView value={payload.args} maxHeight={200} />
          </>
        )}
        {task.kind === 'approval' && <JsonView value={payload.args} maxHeight={200} />}
        {task.kind === 'step_failed' && <Alert tone="danger">{payload.error}</Alert>}
        {(task.kind === 'review' || task.kind === 'step_failed' || task.kind === 'manual') && (
          <Field label={task.kind === 'review' ? 'Result to review (edit if needed)' : task.kind === 'manual' ? 'Result (optional)' : 'Provide the step’s output (JSON)'} error={parseError}>
            <Textarea className="font-mono text-xs" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        <Field label="Comment (optional)">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </CardContent>
      <CardFooter className="flex-wrap justify-end">
        {task.kind === 'review' && (
          <>
            <Button variant="outline" onClick={() => act('reject')} loading={resolve.isPending}>
              Reject and stop
            </Button>
            <Button variant="outline" disabled={!!parseError || text === JSON.stringify(payload.data ?? null, null, 2)} onClick={() => act('edit', parsed)}>
              <Pencil /> Save edits and continue
            </Button>
            <Button onClick={() => act('approve')} loading={resolve.isPending}>
              <CircleCheck /> Approve
            </Button>
          </>
        )}
        {(task.kind === 'approval' || task.kind === 'tool_approval') && (
          <>
            <Button variant="outline" onClick={() => act('reject')}>
              {task.kind === 'approval' ? 'Stop the run' : 'Decline'}
            </Button>
            <Button onClick={() => act('approve')} loading={resolve.isPending}>
              <CircleCheck /> Approve
            </Button>
          </>
        )}
        {task.kind === 'manual' && (
          <>
            <Button variant="outline" onClick={() => act('reject')}>
              I couldn’t do it
            </Button>
            <Button onClick={() => act('done', parseError ? null : parsed)} loading={resolve.isPending}>
              <CircleCheck /> Mark done
            </Button>
          </>
        )}
        {task.kind === 'step_failed' && (
          <>
            <Button variant="outline" onClick={() => act('reject')}>
              Stop
            </Button>
            <Button variant="outline" onClick={() => act('skip')}>
              Skip step
            </Button>
            <Button variant="outline" disabled={!!parseError} onClick={() => act('provide', parsed)}>
              Use my output
            </Button>
            <Button onClick={() => act('retry')} loading={resolve.isPending}>
              <RotateCcw /> Retry
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}

function Feedback({ r }: { r: Run }) {
  const [mode, setMode] = React.useState<null | 'correct' | 'failure'>(null)
  const [text, setText] = React.useState(JSON.stringify(r.outputs ?? {}, null, 2))
  const [category, setCategory] = React.useState('wrong_output')
  const [comment, setComment] = React.useState('')
  const fb = useAction('runs.feedback', { success: (d) => (d.evalExampleId ? 'Thanks — saved and added to the evaluation set' : 'Thanks — feedback saved'), onSuccess: () => setMode(null), invalidate: ['runs.', 'agents.'] })
  let parsed: unknown
  let err: string | null = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    err = (e as Error).message
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Was this right?</CardTitle>
        <CardDescription>Reviewed feedback powers improvement proposals for this agent. It is never used for training automatically.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => fb.mutate({ runId: r.id, kind: 'accept', comment: '' })}>
          <ThumbsUp /> Accept result
        </Button>
        <Button variant="outline" onClick={() => setMode('correct')}>
          <Pencil /> Correct result
        </Button>
        <Button variant="outline" onClick={() => setMode('failure')}>
          <Flag /> Report a problem
        </Button>
        <Button variant="outline" onClick={() => fb.mutate({ runId: r.id, kind: 'eval_example', comment: 'Added from run review' })}>
          <FlaskConical /> Add as evaluation example
        </Button>
        {r.feedback.length > 0 && <span className="self-center text-xs text-muted-foreground">{r.feedback.length} feedback item(s) on this run</span>}
      </CardContent>
      <Dialog open={!!mode} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>{mode === 'correct' ? 'Correct the result' : 'Report a problem'}</DialogTitle>
            <DialogDescription>{mode === 'correct' ? 'Edit the outputs to what they should have been. The correction becomes an evaluation example.' : 'Tell us what went wrong so Relay can propose a fix.'}</DialogDescription>
          </DialogHeader>
          {mode === 'correct' && (
            <Field label="Corrected outputs (JSON)" error={err}>
              <Textarea className="font-mono text-xs" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          {mode === 'failure' && (
            <Field label="What kind of problem?">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ['wrong_output', 'Wrong or low-quality result'],
                    ['missing_information', 'Missing information'],
                    ['wrong_tool', 'Used the wrong tool or source'],
                    ['tool_error', 'A tool failed'],
                    ['too_slow', 'Too slow'],
                    ['unsafe_action', 'Unsafe or unwanted action'],
                    ['other', 'Other']
                  ].map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Comment" hint="Specific guidance helps, e.g. “Always list missing certifications as gaps”.">
            <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              disabled={mode === 'correct' && !!err}
              loading={fb.isPending}
              onClick={() => (mode === 'correct' ? fb.mutate({ runId: r.id, kind: 'correct', correctedOutput: parsed, comment }) : fb.mutate({ runId: r.id, kind: 'failure', category: category as 'other', comment }))}
            >
              Save feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

