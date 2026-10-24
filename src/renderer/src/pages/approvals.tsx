import * as React from 'react'
import { CircleCheck, CircleX, Inbox, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useAction, useApi, type Out } from '@/lib/api'
import { navigate } from '@/lib/router'
import { dateTime, money, pct, when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, FixtureBadge, JsonView, KeyValue, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'

type Approval = Out<'approvals.list'>[number]

const TYPE_LABEL: Record<string, string> = {
  deployment: 'Deployment',
  data_access: 'Data access',
  tool_access: 'Tool access',
  budget_increase: 'Budget increase',
  training_job: 'Training job',
  improvement: 'Agent improvement'
}

export function ApprovalsPage({ selected }: { selected?: string }) {
  const q = useApi('approvals.list')
  const [filter, setFilter] = React.useState<'mine_to_decide' | 'my_requests' | 'all'>('mine_to_decide')
  return (
    <>
      <PageHeader title="Approvals" description="Requests for data access, tools, deployments, budgets, training and improvements. Every decision is recorded in the audit log." />
      <Query q={q}>
        {(items) => {
          const lists = {
            mine_to_decide: items.filter((a) => a.status === 'pending' && a.canDecide),
            my_requests: items.filter((a) => a.mine),
            all: items
          }
          const list = lists[filter]
          const current = items.find((a) => a.id === selected) ?? list[0]
          return (
            <div className="space-y-4">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
                <TabsList>
                  <TabsTrigger value="mine_to_decide">Waiting for me ({lists.mine_to_decide.length})</TabsTrigger>
                  <TabsTrigger value="my_requests">My requests ({lists.my_requests.length})</TabsTrigger>
                  <TabsTrigger value="all">All I can see ({lists.all.length})</TabsTrigger>
                </TabsList>
              </Tabs>
              {list.length === 0 && !current ? (
                <EmptyState icon={Inbox} title="Nothing here">
                  {filter === 'mine_to_decide' ? 'No requests are waiting for your decision.' : 'No requests yet.'}
                </EmptyState>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
                  <ul className="space-y-2" aria-label="Requests">
                    {list.map((a) => (
                      <li key={a.id}>
                        <button onClick={() => navigate(`/approvals/${a.id}`, { replace: true })} className={cn('w-full rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted', current?.id === a.id && 'border-primary ring-2 ring-primary/20')} aria-current={current?.id === a.id}>
                          <div className="flex items-center gap-2">
                            <Badge tone="neutral">{TYPE_LABEL[a.type] ?? a.type}</Badge>
                            <StatusBadge status={a.status} />
                            {a.isFixture && <FixtureBadge />}
                          </div>
                          <div className="mt-1 line-clamp-2 text-sm font-medium">{a.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {a.mine ? 'You' : a.requesterName} · {when(a.createdAt)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {current && <ApprovalDetail a={current} />}
                </div>
              )}
            </div>
          )
        }}
      </Query>
    </>
  )
}

function PayloadView({ a }: { a: Approval }) {
  const p = a.payload as Record<string, unknown>
  if (a.type === 'data_access') return <KeyValue items={[['Purposes', (p.purposes as string[]).join(', ')], ['For', a.requesterName], ['Collection', <a key="c" className="text-primary hover:underline" href={`#/data/${p.collectionId}`}>Open collection</a>]]} />
  if (a.type === 'budget_increase') return <KeyValue items={[['Current limit', money(p.currentLimitUsd as number, 2)], ['Requested limit', money(p.newLimitUsd as number, 2)]]} />
  if (a.type === 'deployment')
    return (
      <div className="space-y-2">
        <KeyValue items={[['Deployment', p.mode === 'team' ? 'Shared with the team' : 'Personal'], ['Agent', <a key="a" className="text-primary hover:underline" href={`#/agents/${p.agentId}`}>Open agent</a>]]} />
        {(p.warnings as string[] | undefined)?.length ? (
          <Alert tone="warning" title="Readiness warnings">
            <ul className="list-disc pl-4">
              {(p.warnings as string[]).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    )
  if (a.type === 'improvement') {
    const ev = p.evaluation as null | { examples: number; current: { meanScore: number }; candidate: { meanScore: number } }
    return (
      <div className="space-y-2">
        <KeyValue items={[['Agent', <a key="a" className="text-primary hover:underline" href={`#/agents/${p.agentId}?tab=improve`}>Open improvements</a>]]} />
        {ev && (
          <Alert tone={ev.candidate.meanScore >= ev.current.meanScore ? 'success' : 'warning'} title={`Held-out evaluation on ${ev.examples} example(s)`}>
            Current {pct(ev.current.meanScore)} → proposed {pct(ev.candidate.meanScore)}
          </Alert>
        )}
      </div>
    )
  }
  if (a.type === 'tool_access') return <KeyValue items={[['Tool', String(p.toolKey)]]} />
  if (a.type === 'training_job') return <KeyValue items={[['Estimated cost', money(p.costUsd as number)], ['Job', <a key="j" className="text-primary hover:underline" href={`#/models/jobs/${p.jobId}`}>Open job</a>]]} />
  return <JsonView value={p} />
}

function ApprovalDetail({ a }: { a: Approval }) {
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [comment, setComment] = React.useState('')
  const decide = useAction('approvals.decide', { success: (d) => null, invalidate: [''] })
  const addComment = useAction('approvals.comment', { success: 'Comment added', onSuccess: () => setComment('') })
  const withdraw = useAction('approvals.withdraw', { success: 'Request withdrawn' })
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{TYPE_LABEL[a.type] ?? a.type}</Badge>
          <StatusBadge status={a.status} />
          {a.isFixture && <FixtureBadge />}
        </div>
        <CardTitle className="text-base">{a.title}</CardTitle>
        <CardDescription>
          Requested by {a.requesterName} on {dateTime(a.createdAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Reason</div>
          <p className="text-sm">{a.reason || '—'}</p>
        </div>
        <PayloadView a={a} />
        {a.status !== 'pending' && (
          <Alert tone={a.status === 'approved' ? 'success' : 'neutral'} title={`${a.status[0].toUpperCase()}${a.status.slice(1)}${a.decidedBy ? ` by ${a.decidedBy}` : ''}`}>
            {a.decisionComment || 'No comment.'} {a.decidedAt && `(${dateTime(a.decidedAt)})`}
          </Alert>
        )}
        {a.status === 'pending' && !a.canDecide && !a.mine && a.cannotDecideReason && <Alert tone="info" title="You can’t decide this request">{a.cannotDecideReason}</Alert>}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <MessageSquare className="size-4" aria-hidden /> Comments
          </div>
          {a.comments.length === 0 && <p className="text-sm text-muted-foreground">No comments.</p>}
          {a.comments.map((c) => (
            <div key={c.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">{c.author}</span> <span className="text-xs text-muted-foreground">{when(c.created_at)}</span>
              <div>{c.body}</div>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" aria-label="Comment" />
            <Button variant="outline" disabled={!comment.trim()} onClick={() => addComment.mutate({ id: a.id, body: comment.trim() })}>
              Comment
            </Button>
          </div>
        </div>
      </CardContent>
      {a.status === 'pending' && (a.canDecide || a.mine) && (
        <CardFooter className="justify-end">
          {a.mine && (
            <Button variant="outline" onClick={() => withdraw.mutate({ id: a.id })} loading={withdraw.isPending}>
              Withdraw request
            </Button>
          )}
          {a.canDecide && (
            <>
              <Button variant="outline" onClick={() => setRejectOpen(true)}>
                <CircleX /> Reject
              </Button>
              <Button onClick={() => decide.mutate({ id: a.id, decision: 'approve', comment: '' }, { onSuccess: () => toastDone('Approved and applied') })} loading={decide.isPending && decide.variables?.decision === 'approve'}>
                <CircleCheck /> Approve
              </Button>
            </>
          )}
        </CardFooter>
      )}
      <ReasonDialog open={rejectOpen} onOpenChange={setRejectOpen} title="Reject this request" description="The requester sees your reason." label="Reason" confirmLabel="Reject" onSubmit={(reason) => decide.mutate({ id: a.id, decision: 'reject', comment: reason }, { onSuccess: () => { setRejectOpen(false); toastDone('Rejected') } })} loading={decide.isPending} />
    </Card>
  )
}

function toastDone(m: string) {
  toast.success(m)
}
