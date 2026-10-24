import * as React from 'react'
import { Download, Lock, Search, Sparkles, UserPlus } from 'lucide-react'
import { PURPOSE_LABELS, type Purpose } from '@shared/permissions'
import type { CollectionSelection } from '@shared/domain'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { navigate, setQuery, useRoute } from '@/lib/router'
import { dateTime, when } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Switch } from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog, EmptyState, Field, KeyValue, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'
import { useCan } from '@/components/app/shell'
import { FilterEditor, PreviewView, PurposeBadges } from './index'

type Col = Out<'data.collection'>

export function CollectionPage({ id }: { id: string }) {
  const { query } = useRoute()
  const q = useApi('data.collection', { id })
  const canExplore = useCan('opportunities.explore')
  const exp = useAction('data.export', { success: (r) => `Exported ${r.rows} rows` })
  const [reqOpen, setReqOpen] = React.useState(false)
  const req = useAction('data.requestAccess', { success: 'Request sent', onSuccess: () => setReqOpen(false) })
  return (
    <Query q={q}>
      {(c) => {
        const canPreview = c.isAdmin || c.myPurposes.includes('retrieval') || c.myPurposes.includes('analysis')
        const tab = query.tab ?? (canPreview ? 'preview' : 'about')
        return (
          <>
            <PageHeader
              breadcrumb={<a href="#/data">Data</a>}
              title={c.name}
              description={c.description}
              actions={
                <>
                  {!c.hasAccess && (
                    <Button onClick={() => setReqOpen(true)}>
                      <Lock /> Request access
                    </Button>
                  )}
                  {c.myPurposes.includes('export') && c.kind === 'table' && (
                    <Button variant="outline" onClick={() => exp.mutate({ id: c.id, format: 'csv' }, { onSuccess: (r) => void call('app.reveal', { path: r.path }).catch(() => undefined) })} loading={exp.isPending}>
                      <Download /> Export CSV
                    </Button>
                  )}
                  {canExplore && c.myPurposes.includes('analysis') && (
                    <Button onClick={() => navigate(`/data/${c.id}/opportunities`)}>
                      <Sparkles /> Find model opportunities
                    </Button>
                  )}
                </>
              }
            />
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <PurposeBadges purposes={c.purposes} mine={c.myPurposes} />
              <Badge tone={c.allowExternal ? 'neutral' : 'warning'}>{c.allowExternal ? 'May go to external providers' : 'Local only'}</Badge>
              <Badge tone="neutral">{c.sensitivity}</Badge>
              <Badge tone="neutral">Version {c.version}</Badge>
              <span className="text-muted-foreground">
                {c.kind === 'documents' ? 'Documents' : 'Table'} from {c.sourceName} · refreshed {when(c.refreshedAt)}
              </span>
            </div>
            <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v })}>
              <TabsList>
                {canPreview && <TabsTrigger value="preview">Preview</TabsTrigger>}
                {c.kind === 'documents' && c.myPurposes.includes('retrieval') && <TabsTrigger value="search">Search</TabsTrigger>}
                <TabsTrigger value="access">Data access</TabsTrigger>
                {c.isAdmin && <TabsTrigger value="settings">Settings & versions</TabsTrigger>}
                <TabsTrigger value="about">Models & lineage</TabsTrigger>
              </TabsList>
              {canPreview && (
                <TabsContent value="preview">
                  <PreviewTab id={c.id} admin={c.isAdmin && !c.hasAccess} />
                </TabsContent>
              )}
              <TabsContent value="search">
                <SearchTab id={c.id} />
              </TabsContent>
              <TabsContent value="access">
                <AccessTab c={c} />
              </TabsContent>
              {c.isAdmin && (
                <TabsContent value="settings">
                  <SettingsTab c={c} />
                </TabsContent>
              )}
              <TabsContent value="about">
                <Card>
                  <CardHeader>
                    <CardTitle>Models trained on this collection</CardTitle>
                    <CardDescription>Revoking access does not untrain a model; affected models are flagged for review.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {c.models.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No models yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {c.models.map((m) => (
                          <li key={m.id} className="flex items-center gap-2 text-sm">
                            <a className="text-primary hover:underline" href={`#/models/${m.id}`}>
                              {m.name} v{m.version}
                            </a>
                            <StatusBadge status={m.status === 'needs_review' ? 'needs_review_model' : m.status} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
            <ReasonDialog open={reqOpen} onOpenChange={setReqOpen} title={`Request access to ${c.name}`} description="Requests use in agents (search & read)." onSubmit={(reason) => req.mutate({ collectionId: c.id, purposes: ['retrieval'], reason })} loading={req.isPending} />
          </>
        )
      }}
    </Query>
  )
}

function PreviewTab({ id, admin }: { id: string; admin: boolean }) {
  const q = useApi('data.preview', { id, limit: 50 })
  return (
    <div className="space-y-3">
      {admin && <Alert tone="info">You’re previewing as an administrator configuring this collection. This preview is recorded in the audit log; using the data in agents or training still requires a grant.</Alert>}
      <Query q={q} loading="Reading the approved subset…">
        {(p) => <PreviewView p={p} />}
      </Query>
    </div>
  )
}

function SearchTab({ id }: { id: string }) {
  const [text, setText] = React.useState('')
  const search = useAction('data.search', { invalidate: [] })
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) search.mutate({ collectionIds: [id], query: text.trim() })
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search these documents" aria-label="Search query" />
        <Button type="submit" loading={search.isPending}>
          <Search /> Search
        </Button>
      </form>
      {search.data?.warnings.map((w, i) => (
        <Alert key={i} tone="warning">
          {w}
        </Alert>
      ))}
      {search.data && search.data.hits.length === 0 && <EmptyState title="No matches" />}
      {search.data?.hits.map((h, i) => (
        <Card key={i}>
          <CardContent className="pt-4 text-sm">
            <div className="mb-1 font-medium">{h.relPath}</div>
            <p className="text-muted-foreground">{h.snippet.replace(/[«»]/g, '')}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function AccessTab({ c }: { c: Col }) {
  const dir = useApi('directory.get')
  const [ptype, setPtype] = React.useState<'user' | 'team'>('user')
  const [pid, setPid] = React.useState('')
  const [purposes, setPurposes] = React.useState<Purpose[]>(['retrieval'])
  const [canDelegate, setCanDelegate] = React.useState(false)
  const [revoke, setRevoke] = React.useState<string | null>(null)
  const grant = useAction('data.grant', { success: 'Access granted', onSuccess: () => setPid('') })
  const revokeM = useAction('data.revoke', { success: 'Access revoked. Future reads are blocked and caches cleared.', onSuccess: () => setRevoke(null) })
  const allowed = c.delegablePurposes
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>Who can use this collection</CardTitle>
          <CardDescription>{c.canManageGrants ? (c.isAdmin ? 'All grants.' : 'Grants within your team.') : 'You can see your own access only.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyValue className="mb-4" items={[['Your access', c.myPurposes.length ? c.myPurposes.map((p) => PURPOSE_LABELS[p as Purpose]).join(', ') : 'None']]} />
          {c.grants.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Who</TableHead>
                  <TableHead>Purposes</TableHead>
                  <TableHead>Granted by</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.grants.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      {g.principalName} <Badge tone="neutral">{g.principalType}</Badge> {g.canDelegate && <Badge tone="info">can delegate</Badge>}
                    </TableCell>
                    <TableCell>
                      <PurposeBadges purposes={g.purposes} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.grantedBy ?? '—'} · {when(g.createdAt)}
                    </TableCell>
                    <TableCell>{g.revokedAt ? <StatusBadge status="cancelled" label="Revoked" /> : <StatusBadge status="active" label="Active" />}</TableCell>
                    <TableCell className="text-right">
                      {g.canRevoke && (
                        <Button size="sm" variant="ghost" onClick={() => setRevoke(g.id)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {c.canManageGrants && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="size-4" aria-hidden /> Grant access
            </CardTitle>
            <CardDescription>{c.isAdmin ? 'Administrators can grant any purpose the collection allows.' : `You can delegate ${allowed.join(', ')} within your team.`}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="To">
              <div className="grid grid-cols-[6rem_1fr] gap-2">
                <Select value={ptype} onValueChange={(v) => { setPtype(v as 'user'); setPid('') }}>
                  <SelectTrigger aria-label="Person or team">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Person</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={pid} onValueChange={setPid}>
                  <SelectTrigger aria-label="Who">
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {ptype === 'user'
                      ? (dir.data?.users ?? []).map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name} — {u.title}
                          </SelectItem>
                        ))
                      : (dir.data?.teams ?? []).map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>
              </div>
            </Field>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Purposes</div>
              {c.purposes.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <Checkbox disabled={!allowed.includes(p)} checked={purposes.includes(p as Purpose)} onCheckedChange={(v) => setPurposes(v ? [...purposes, p as Purpose] : purposes.filter((x) => x !== p))} />
                  {PURPOSE_LABELS[p as Purpose]} {!allowed.includes(p) && <span className="text-xs text-muted-foreground">(not yours to delegate)</span>}
                </label>
              ))}
            </div>
            {c.isAdmin && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={canDelegate} onCheckedChange={setCanDelegate} aria-label="Allow re-delegation within their team" /> Allow them to delegate within their team
              </label>
            )}
            <Button disabled={!pid || !purposes.length} loading={grant.isPending} onClick={() => grant.mutate({ collectionId: c.id, principalType: ptype, principalId: pid, purposes, canDelegate, note: '' })}>
              Grant access
            </Button>
            <p className="text-xs text-muted-foreground">Relay checks your authority when you grant, not just here. Grants outside your team or beyond your own delegable access are refused and logged.</p>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} title="Revoke this access?" description="Future reads are blocked immediately, including runs that resume later. Models already trained are not untrained; they are flagged for review if training access was removed." destructive confirmLabel="Revoke" onConfirm={() => revoke && revokeM.mutate({ id: revoke })} loading={revokeM.isPending} />
    </div>
  )
}

function SettingsTab({ c }: { c: Col }) {
  const [purposes, setPurposes] = React.useState<Purpose[]>(c.purposes as Purpose[])
  const [allowExternal, setAllowExternal] = React.useState(c.allowExternal)
  const [sel, setSel] = React.useState<CollectionSelection>(c.selection ?? { files: [], columns: [], filters: [] })
  const [retire, setRetire] = React.useState(false)
  const desc = useApi('data.describeSource', { id: c.sourceId })
  const update = useAction('data.updateCollection', { success: 'Saved as a new collection version' })
  const columns = desc.data?.tables.find((t) => t.name === sel.table)?.columns ?? desc.data?.tables[0]?.columns ?? []
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Approved subset & purposes</CardTitle>
          <CardDescription>Changes create a new version. Removing the training purpose flags models trained on this collection for review.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {c.kind === 'table' && (
            <>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Allowed columns (none = all)</div>
                <div className="flex flex-wrap gap-2">
                  {columns.map((col) => (
                    <label key={col} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                      <Checkbox checked={sel.columns.includes(col)} onCheckedChange={(v) => setSel({ ...sel, columns: v ? [...sel.columns, col] : sel.columns.filter((x) => x !== col) })} />
                      {col}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="text-sm font-medium">Row filters</div>
                <FilterEditor filters={sel.filters} columns={columns} onChange={(filters) => setSel({ ...sel, filters })} />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <div className="text-sm font-medium">Purposes</div>
            {(['retrieval', 'analysis', 'training', 'export'] as Purpose[]).map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <Checkbox checked={purposes.includes(p)} onCheckedChange={(v) => setPurposes(v ? [...purposes, p] : purposes.filter((x) => x !== p))} />
                {PURPOSE_LABELS[p]}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={allowExternal} onCheckedChange={setAllowExternal} aria-label="May be sent to external providers" /> May be sent to external model providers
          </label>
          <div className="flex gap-2">
            <Button disabled={!purposes.length} onClick={() => update.mutate({ id: c.id, patch: { purposes, allowExternal, selection: sel } })} loading={update.isPending}>
              Save new version
            </Button>
            <Button variant="outline" onClick={() => setRetire(true)}>
              Retire collection
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {c.versions.map((v) => (
              <li key={v.version} className="flex justify-between">
                <span>
                  v{v.version} — {v.note}
                </span>
                <span className="text-muted-foreground">{dateTime(v.created_at)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <ConfirmDialog open={retire} onOpenChange={setRetire} title="Retire this collection?" description="All reads are blocked and dependent models are flagged for review." destructive confirmLabel="Retire" onConfirm={() => update.mutate({ id: c.id, patch: { status: 'retired' } }, { onSuccess: () => setRetire(false) })} />
    </div>
  )
}

