import * as React from 'react'
import { Database, FileText, FolderOpen, Lock, Plus, RefreshCw, Table2, Trash2, Unplug } from 'lucide-react'
import { PURPOSES, PURPOSE_LABELS, type Purpose } from '@shared/permissions'
import type { CollectionSelection, RowFilter } from '@shared/domain'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { navigate, setQuery, useRoute } from '@/lib/router'
import { bytes, when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Switch } from '@/components/ui/misc'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, Field, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'
import { useCan, useSession } from '@/components/app/shell'

export function DataPage() {
  const { query } = useRoute()
  const admin = useCan('data.administer')
  const tab = query.tab ?? 'collections'
  return (
    <>
      <PageHeader
        title="Data"
        description="A source is where information comes from. A collection is an approved subset of a source. Data access grants say who can use a collection, and for what."
      />
      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v })}>
        <TabsList>
          <TabsTrigger value="collections">
            <Database /> Collections
          </TabsTrigger>
          {admin && (
            <TabsTrigger value="sources">
              <FolderOpen /> Sources
            </TabsTrigger>
          )}
          <TabsTrigger value="connectors">
            <Unplug /> Enterprise connectors
          </TabsTrigger>
        </TabsList>
        <TabsContent value="collections">
          <Collections />
        </TabsContent>
        {admin && (
          <TabsContent value="sources">
            <Sources />
          </TabsContent>
        )}
        <TabsContent value="connectors">
          <Connectors />
        </TabsContent>
      </Tabs>
    </>
  )
}

export function PurposeBadges({ purposes, mine }: { purposes: string[]; mine?: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {purposes.map((p) => (
        <Badge key={p} tone={mine ? (mine.includes(p) ? 'success' : 'neutral') : 'outline'} title={PURPOSE_LABELS[p as Purpose]}>
          {mine && !mine.includes(p) && <Lock aria-hidden />}
          {p}
        </Badge>
      ))}
    </div>
  )
}

function Collections() {
  const q = useApi('data.collections')
  const admin = useCan('data.administer')
  const [requestFor, setRequestFor] = React.useState<{ id: string; name: string } | null>(null)
  const [purposes, setPurposes] = React.useState<Purpose[]>(['retrieval'])
  const req = useAction('data.requestAccess', { success: 'Request sent', onSuccess: () => setRequestFor(null) })
  return (
    <Query q={q}>
      {(cols) => (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Green purposes are ones you can use. {admin ? 'As an administrator you see every collection; using one in agents or training still needs a grant.' : 'Restricted collections you don’t have access to are not listed.'}
          </p>
          {cols.length === 0 && <EmptyState icon={Database} title="No collections" />}
          <div className="grid gap-3 md:grid-cols-2">
            {cols.map((c) => (
              <Card key={c.id} className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => navigate(`/data/${c.id}`)}>
                <CardHeader>
                  <div className="flex items-start gap-2">
                    {c.kind === 'documents' ? <FileText className="mt-0.5 size-4 text-muted-foreground" aria-hidden /> : <Table2 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />}
                    <div className="min-w-0 flex-1">
                      <CardTitle>
                        <a href={`#/data/${c.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                          {c.name}
                        </a>
                      </CardTitle>
                      <CardDescription className="line-clamp-2">{c.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <PurposeBadges purposes={c.purposes} mine={c.myPurposes} />
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge tone={c.allowExternal ? 'neutral' : 'warning'}>{c.allowExternal ? 'May go to external providers' : 'Local only'}</Badge>
                    <Badge tone={c.sensitivity === 'restricted' || c.sensitivity === 'confidential' ? 'warning' : 'neutral'}>{c.sensitivity}</Badge>
                    {c.visibility === 'hidden' && <Badge tone="neutral">Hidden from browse</Badge>}
                    {c.isSynthetic && <Badge tone="neutral">Synthetic</Badge>}
                    <span>
                      v{c.version} · from {c.sourceName}
                    </span>
                  </div>
                  {!c.hasAccess && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPurposes(['retrieval'])
                        setRequestFor({ id: c.id, name: c.name })
                      }}
                    >
                      <Lock /> Request access
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <ReasonDialog open={!!requestFor} onOpenChange={(o) => !o && setRequestFor(null)} title={`Request access to ${requestFor?.name ?? ''}`} description="Your manager (if they can delegate this collection) or an administrator decides." placeholder="What will you use it for?" onSubmit={(reason) => requestFor && req.mutate({ collectionId: requestFor.id, purposes, reason })} loading={req.isPending}>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Purposes</div>
              {(cols.find((c) => c.id === requestFor?.id)?.purposes ?? []).map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={purposes.includes(p as Purpose)} onCheckedChange={(v) => setPurposes(v ? [...purposes, p as Purpose] : purposes.filter((x) => x !== p))} /> {PURPOSE_LABELS[p as Purpose]}
                </label>
              ))}
            </div>
          </ReasonDialog>
        </div>
      )}
    </Query>
  )
}

function Sources() {
  const q = useApi('data.sources')
  const add = useAction('data.addSource', { success: 'Source added' })
  const refresh = useAction('data.refreshSource', { success: 'Source refreshed; dependent collections got new versions' })
  const [builder, setBuilder] = React.useState<string | null>(null)
  async function pick(kind: 'data' | 'folder') {
    const path = await call('app.openFile', { title: kind === 'folder' ? 'Choose a folder of documents' : 'Choose a file (CSV, JSON/JSONL, text, Markdown, PDF, or SQLite)', kind })
    if (path) add.mutate({ path })
  }
  return (
    <Query q={q}>
      {(d) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => pick('data')} loading={add.isPending}>
              <Plus /> Add file
            </Button>
            <Button variant="outline" onClick={() => pick('folder')}>
              <FolderOpen /> Add folder
            </Button>
            <span className="text-xs text-muted-foreground">Files are copied into Relay so collection versions are stable. Imported files do not carry the original system’s permissions — grant access explicitly.</span>
          </div>
          {d.sources.map((s) => (
            <Card key={s.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {s.name} <Badge tone="neutral">{s.kind}</Badge> <StatusBadge status={s.status === 'ready' ? 'ok' : 'error'} label={s.status === 'ready' ? 'Ready' : 'Error'} />
                  </CardTitle>
                  <CardDescription>
                    {s.originalPath ? `Imported from ${s.originalPath}` : 'Local import'} · refreshed {when(s.refreshedAt)}
                  </CardDescription>
                  {s.statusDetail && <p className="text-xs text-danger">{s.statusDetail}</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => refresh.mutate({ id: s.id })} loading={refresh.isPending && refresh.variables?.id === s.id}>
                    <RefreshCw /> Refresh
                  </Button>
                  <Button size="sm" onClick={() => setBuilder(s.id)}>
                    <Plus /> New collection
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {s.items.length > 1 && (
                  <ul className="grid gap-1 text-xs md:grid-cols-2">
                    {s.items.map((i) => (
                      <li key={i.rel_path} className="flex items-center gap-2">
                        {i.status === 'ok' ? <FileText className="size-3.5 text-muted-foreground" /> : <Badge tone="warning">Unsupported</Badge>}
                        <span className="truncate">{i.rel_path}</span>
                        <span className="text-muted-foreground">{bytes(i.size)}</span>
                        {i.detail && <span className="truncate text-warning" title={i.detail}>{i.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="text-xs text-muted-foreground">Collections: {s.collections.map((c) => c.name).join(', ') || 'none'}</div>
              </CardContent>
            </Card>
          ))}
          {builder && <CollectionBuilder sourceId={builder} source={d.sources.find((s) => s.id === builder)!} onClose={() => setBuilder(null)} />}
        </div>
      )}
    </Query>
  )
}

const OPS: { value: RowFilter['op']; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'in', label: 'is one of (comma-separated)' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'contains', label: 'contains' },
  { value: 'gte', label: 'is at least' },
  { value: 'lte', label: 'is at most' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' }
]

export function FilterEditor({ filters, columns, onChange }: { filters: RowFilter[]; columns: string[]; onChange: (f: RowFilter[]) => void }) {
  return (
    <div className="space-y-2">
      {filters.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_12rem_1fr_auto] gap-2">
          <Select value={f.column} onValueChange={(v) => onChange(filters.map((x, j) => (j === i ? { ...x, column: v } : x)))}>
            <SelectTrigger aria-label="Column">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={f.op} onValueChange={(v) => onChange(filters.map((x, j) => (j === i ? { ...x, op: v as RowFilter['op'] } : x)))}>
            <SelectTrigger aria-label="Condition">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input aria-label="Value" disabled={f.op === 'is_empty' || f.op === 'not_empty'} value={String(f.value ?? '')} onChange={(e) => onChange(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" disabled={!columns.length} onClick={() => onChange([...filters, { column: columns[0], op: 'eq', value: '' }])}>
        <Plus /> Add row filter
      </Button>
    </div>
  )
}

function CollectionBuilder({ sourceId, source, onClose }: { sourceId: string; source: Out<'data.sources'>['sources'][number]; onClose: () => void }) {
  const desc = useApi('data.describeSource', { id: sourceId })
  const dir = useApi('directory.get')
  const [name, setName] = React.useState(`${source.name} — subset`)
  const [description, setDescription] = React.useState('')
  const [sel, setSel] = React.useState<CollectionSelection>({ files: [], columns: [], filters: [] })
  const [purposes, setPurposes] = React.useState<Purpose[]>(['retrieval'])
  const [allowExternal, setAllowExternal] = React.useState(false)
  const [visibility, setVisibility] = React.useState<'discoverable' | 'hidden'>('discoverable')
  const [sensitivity, setSensitivity] = React.useState<'public' | 'internal' | 'confidential' | 'restricted'>('internal')
  const [ownerTeamId, setOwnerTeamId] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<Out<'data.previewSelection'> | null>(null)
  const previewM = useAction('data.previewSelection', { invalidate: [], onSuccess: setPreview })
  const create = useAction('data.createCollection', { success: 'Collection published', onSuccess: (r) => { onClose(); navigate(`/data/${r.id}?tab=access`) } })
  const tables = desc.data?.tables ?? []
  const table = tables.find((t) => t.name === sel.table) ?? (tables.length === 1 ? tables[0] : undefined)
  const columns = table?.columns ?? []
  const docs = (desc.data?.items ?? []).filter((i) => i.kind === 'document')
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="max-w-3xl">
        <SheetTitle>New collection from {source.name}</SheetTitle>
        <SheetDescription>Choose exactly what is approved. Row filters and column choices are applied before any data reaches previews, agents, models, exports or training.</SheetDescription>
        <Query q={desc}>
          {() => (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Owning team">
                  <Select value={ownerTeamId ?? 'none'} onValueChange={(v) => setOwnerTeamId(v === 'none' ? null : v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {(dir.data?.teams ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Description" className="md:col-span-2">
                  <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
                </Field>
              </div>
              {tables.length > 1 && (
                <Field label="Table">
                  <Select value={sel.table ?? ''} onValueChange={(v) => setSel({ ...sel, table: v, columns: [], filters: [] })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a table" />
                    </SelectTrigger>
                    <SelectContent>
                      {tables.map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name} ({t.rowCount} rows)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {docs.length > 0 && source.kind === 'folder' && (
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Files (none selected = all supported files)</div>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                    {docs.map((d) => (
                      <label key={d.relPath} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={sel.files.includes(d.relPath)} onCheckedChange={(v) => setSel({ ...sel, files: v ? [...sel.files, d.relPath] : sel.files.filter((f) => f !== d.relPath) })} />
                        {d.relPath}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {columns.length > 0 && (
                <>
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">Allowed columns (none selected = all)</div>
                    <div className="flex flex-wrap gap-2">
                      {columns.map((c) => (
                        <label key={c} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', sel.columns.includes(c) && 'border-primary bg-accent/40')}>
                          <Checkbox checked={sel.columns.includes(c)} onCheckedChange={(v) => setSel({ ...sel, columns: v ? [...sel.columns, c] : sel.columns.filter((x) => x !== c) })} />
                          {c}
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
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Allowed purposes</div>
                  {PURPOSES.map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={purposes.includes(p)} onCheckedChange={(v) => setPurposes(v ? [...purposes, p] : purposes.filter((x) => x !== p))} />
                      {PURPOSE_LABELS[p]}
                    </label>
                  ))}
                  <p className="text-xs text-muted-foreground">Training and export are separate from use in agents.</p>
                </div>
                <div className="space-y-3">
                  <label className="flex items-start gap-2 text-sm">
                    <Switch checked={allowExternal} onCheckedChange={setAllowExternal} aria-label="May be sent to external model providers" />
                    <span>
                      May be sent to external model providers
                      <span className="block text-xs text-muted-foreground">Off = local only. Runs that would send this data to an external provider or web service are blocked.</span>
                    </span>
                  </label>
                  <Field label="Sensitivity">
                    <Select value={sensitivity} onValueChange={(v) => setSensitivity(v as typeof sensitivity)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {['public', 'internal', 'confidential', 'restricted'].map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={visibility === 'hidden'} onCheckedChange={(v) => setVisibility(v ? 'hidden' : 'discoverable')} aria-label="Hide from people without access" /> Hide from people without access
                  </label>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => previewM.mutate({ sourceId, selection: { ...sel, table: sel.table ?? table?.name } })} loading={previewM.isPending}>
                  Preview
                </Button>
                <Button disabled={!name.trim() || !purposes.length} onClick={() => create.mutate({ sourceId, name, description, selection: { ...sel, table: sel.table ?? (source.kind === 'sqlite' ? table?.name : undefined) }, purposes, allowExternal, visibility, sensitivity, ownerTeamId })} loading={create.isPending}>
                  Publish collection
                </Button>
              </div>
              {preview && <PreviewView p={preview} />}
            </div>
          )}
        </Query>
      </SheetContent>
    </Sheet>
  )
}

export function PreviewView({ p }: { p: Out<'data.preview'> }) {
  if (p.kind === 'documents')
    return (
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">{p.totalFiles} document(s)</div>
        {p.files.map((f) => (
          <div key={f.relPath} className="rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" aria-hidden /> {f.relPath} {!f.error && <span className="text-xs font-normal text-muted-foreground">{f.chars.toLocaleString()} characters</span>}
            </div>
            {f.error ? <Alert tone="warning" className="mt-2">{f.error}</Alert> : <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">{f.excerpt}</p>}
          </div>
        ))}
      </div>
    )
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Showing {p.rows.length} of {p.totalRows.toLocaleString()} rows after filters
      </div>
      {p.warnings.map((w, i) => (
        <Alert key={i} tone="warning">
          {w}
        </Alert>
      ))}
      <div className="max-h-96 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {p.columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.rows.map((r, i) => (
              <TableRow key={i}>
                {p.columns.map((c) => (
                  <TableCell key={c} className="max-w-xs truncate text-xs" title={String(r[c] ?? '')}>
                    {String(r[c] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function Connectors() {
  const s = useSession()
  const q = useApi('data.sources', undefined, { enabled: s.capabilities.includes('data.administer') })
  const adapters = q.data?.adapters ?? STATIC_ADAPTERS
  return (
    <div className="space-y-3">
      <Alert tone="info">These enterprise systems are not connected in this build. Each card explains the working alternative: export from the system and import the files here. Exported files do not keep the source system’s permissions, so access must be granted explicitly in Relay.</Alert>
      <div className="grid gap-3 md:grid-cols-2">
        {adapters.map((a) => (
          <Card key={a.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {a.name} <Badge tone="neutral">Not connected / not available in this build</Badge>
              </CardTitle>
              <CardDescription>{a.explanation}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <span className="font-medium">Alternative: </span>
              {a.alternative}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

const STATIC_ADAPTERS = [
  { key: 'sharepoint', name: 'SharePoint / OneDrive', explanation: 'Not connected / not available in this build.', alternative: 'Ask an administrator to import an export of the files.' },
  { key: 'gdrive', name: 'Google Drive', explanation: 'Not connected / not available in this build.', alternative: 'Ask an administrator to import an export of the files.' },
  { key: 's3', name: 'Object storage', explanation: 'Not connected / not available in this build.', alternative: 'Ask an administrator to import a local copy.' },
  { key: 'postgres', name: 'Postgres / Snowflake', explanation: 'Not connected / not available in this build.', alternative: 'Ask an administrator to import a CSV or SQLite export.' },
  { key: 'ticketing', name: 'Ticketing systems', explanation: 'Not connected / not available in this build.', alternative: 'Ticket exports can be imported as CSV/JSON; ticket actions can be added as API tools.' }
]
