import { Bot, LayoutTemplate, Plus } from 'lucide-react'
import { useAction, useApi } from '@/lib/api'
import { navigate } from '@/lib/router'
import { when } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, PageHeader, Query, StatusBadge } from '@/components/app/common'
import { useCan, useSession } from '@/components/app/shell'

export function AgentsPage() {
  const s = useSession()
  const q = useApi('agents.list')
  const useTemplate = useAction('agents.useTemplate', { success: 'Created your copy as a draft', onSuccess: (r) => navigate(`/agents/${r.id}?tab=steps`) })
  const canCreate = useCan('agents.create')
  return (
    <>
      <PageHeader
        title="Agents"
        description={s.actor.role === 'employee' ? 'Agents you own. Create one by recording or describing your work.' : s.actor.role === 'manager' ? 'Your agents and your team’s agents.' : 'All agents in the workspace.'}
        actions={
          canCreate && (
            <Button onClick={() => navigate('/agents/new')}>
              <Plus /> Create agent
            </Button>
          )
        }
      />
      <Query q={q}>
        {(agents) => {
          const own = agents.filter((a) => !a.isTemplate)
          const templates = agents.filter((a) => a.isTemplate)
          return (
            <div className="space-y-6">
              {own.length === 0 ? (
                <EmptyState icon={Bot} title="No agents yet" action={canCreate && <Button onClick={() => navigate('/agents/new')}>Create agent</Button>}>
                  Record a workflow, describe it, or start from a template below.
                </EmptyState>
              ) : (
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead className="text-right">Runs (30d)</TableHead>
                        <TableHead>Last run</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {own.map((a) => (
                        <TableRow key={a.id} className="cursor-pointer" onClick={() => navigate(`/agents/${a.id}`)}>
                          <TableCell>
                            <a href={`#/agents/${a.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                              {a.name}
                            </a>
                            <div className="line-clamp-1 max-w-md text-xs text-muted-foreground">{a.description}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{a.mine ? 'You' : a.ownerName}</TableCell>
                          <TableCell className="space-x-1">
                            <StatusBadge status={a.status} />
                            {a.killSwitch && <StatusBadge status="blocked" label="Kill switch on" />}
                            {a.needsReview > 0 && <StatusBadge status="needs_review" label={`${a.needsReview} need review`} />}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {a.liveVersion ? `Live v${a.liveVersion}` : '—'}
                            {a.draftVersion && a.draftVersion !== a.liveVersion ? ` · Draft v${a.draftVersion}` : ''}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {a.runs30d}
                            {a.failed30d > 0 && <span className="text-danger"> ({a.failed30d} failed)</span>}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{when(a.lastRunAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              )}
              {templates.length > 0 && canCreate && (
                <div className="space-y-3">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold">
                    <LayoutTemplate className="size-4" aria-hidden /> Templates
                  </h2>
                  <div className="grid gap-3 md:grid-cols-2">
                    {templates.map((t) => (
                      <Card key={t.id}>
                        <CardHeader>
                          <CardTitle>{t.name.replace(/^Template: /, '')}</CardTitle>
                          <CardDescription>{t.description}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex gap-2">
                          <Button size="sm" onClick={() => useTemplate.mutate({ templateId: t.id })} loading={useTemplate.isPending && useTemplate.variables?.templateId === t.id}>
                            Use template
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => navigate(`/agents/${t.id}?tab=steps`)}>
                            View steps
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        }}
      </Query>
    </>
  )
}
