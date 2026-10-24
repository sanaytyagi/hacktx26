import * as React from 'react'
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleX,
  Clock,
  Hand,
  Hourglass,
  LoaderCircle,
  Lock,
  Plug,
  ShieldAlert,
  Archive,
  FlaskConical,
  Radio,
  type LucideIcon
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/lib/api'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary'

const STATUS: Record<string, { label: string; tone: Tone; icon: LucideIcon; spin?: boolean }> = {
  // agents
  draft: { label: 'Draft', tone: 'neutral', icon: CircleDashed },
  tested: { label: 'Tested', tone: 'info', icon: FlaskConical },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warning', icon: Hourglass },
  live: { label: 'Live', tone: 'success', icon: Radio },
  paused: { label: 'Paused', tone: 'warning', icon: CirclePause },
  archived: { label: 'Archived', tone: 'neutral', icon: Archive },
  // runs
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'info', icon: LoaderCircle, spin: true },
  needs_review: { label: 'Needs your review', tone: 'warning', icon: Hand },
  succeeded: { label: 'Succeeded', tone: 'success', icon: CircleCheck },
  failed: { label: 'Failed', tone: 'danger', icon: CircleX },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  blocked: { label: 'Blocked', tone: 'danger', icon: ShieldAlert },
  interrupted: { label: 'Interrupted', tone: 'warning', icon: CircleAlert },
  skipped: { label: 'Skipped', tone: 'neutral', icon: CircleDashed },
  // approvals
  pending: { label: 'Pending', tone: 'warning', icon: Hourglass },
  approved: { label: 'Approved', tone: 'success', icon: CircleCheck },
  rejected: { label: 'Rejected', tone: 'danger', icon: CircleX },
  // catalog
  available: { label: 'Available', tone: 'success', icon: CircleCheck },
  needs_connection: { label: 'Needs connection', tone: 'warning', icon: Plug },
  requires_permission: { label: 'Requires permission', tone: 'info', icon: Lock },
  not_supported: { label: 'Not supported', tone: 'neutral', icon: Ban },
  disabled: { label: 'Disabled', tone: 'neutral', icon: Ban },
  // models & jobs
  registered: { label: 'Registered', tone: 'info', icon: CircleDot },
  active: { label: 'Active', tone: 'success', icon: Radio },
  replaced: { label: 'Replaced', tone: 'neutral', icon: Archive },
  retired: { label: 'Retired', tone: 'neutral', icon: Archive },
  needs_review_model: { label: 'Needs review', tone: 'warning', icon: ShieldAlert },
  // integrations / health
  connected: { label: 'Connected', tone: 'success', icon: CircleCheck },
  ok: { label: 'Healthy', tone: 'success', icon: CircleCheck },
  error: { label: 'Error', tone: 'danger', icon: CircleX },
  unreachable: { label: 'Unreachable', tone: 'danger', icon: CircleX },
  broken: { label: 'Broken', tone: 'danger', icon: CircleX },
  failing: { label: 'Failing', tone: 'danger', icon: CircleX },
  schema_changed: { label: 'Schema changed', tone: 'warning', icon: CircleAlert },
  not_checked: { label: 'Not checked', tone: 'neutral', icon: CircleDashed },
  not_connected: { label: 'Not connected', tone: 'neutral', icon: Plug },
  unchecked: { label: 'Not checked', tone: 'neutral', icon: CircleDashed },
  published: { label: 'Published', tone: 'success', icon: CircleCheck },
  warn: { label: 'Warning', tone: 'warning', icon: CircleAlert },
  block: { label: 'Blocking', tone: 'danger', icon: CircleX },
  evaluating: { label: 'Evaluating', tone: 'info', icon: LoaderCircle, spin: true },
  evaluated: { label: 'Evaluated', tone: 'info', icon: CircleCheck },
  proposed: { label: 'Proposed', tone: 'neutral', icon: CircleDot },
  approval_pending: { label: 'Awaiting approval', tone: 'warning', icon: Hourglass },
  applied: { label: 'Applied', tone: 'success', icon: CircleCheck },
  dismissed: { label: 'Dismissed', tone: 'neutral', icon: Ban },
  open: { label: 'Open', tone: 'warning', icon: Hand },
  resolved: { label: 'Resolved', tone: 'success', icon: CircleCheck }
}

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const s = STATUS[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' as Tone, icon: CircleDot }
  const Icon = s.icon
  return (
    <Badge tone={s.tone} className={className}>
      <Icon aria-hidden className={s.spin ? 'animate-spin' : undefined} />
      {label ?? s.label}
    </Badge>
  )
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        {breadcrumb && <div className="text-xs text-muted-foreground">{breadcrumb}</div>}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center">
      {Icon && <Icon className="mb-3 size-8 text-muted-foreground" aria-hidden />}
      <div className="font-medium">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 py-8 text-sm text-muted-foreground', className)} role="status">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: ApiError | Error | null; retry?: () => void }) {
  if (!error) return null
  return (
    <Alert tone="danger" title="Couldn’t load this" action={retry && <Button size="sm" variant="outline" onClick={retry}>Retry</Button>}>
      {error.message}
    </Alert>
  )
}

/** Renders loading / error / content for a query result. */
export function Query<T>({ q, children, loading }: { q: { data?: T; error: ApiError | null; isLoading: boolean; refetch: () => unknown }; children: (d: T) => React.ReactNode; loading?: string }) {
  if (q.isLoading) return <Loading label={loading} />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  if (q.data === undefined) return null
  return <>{children(q.data)}</>
}

export function Field({ label, htmlFor, hint, error, children, className }: { label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function KeyValue({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function JsonView({ value, className, maxHeight = 320 }: { value: unknown; className?: string; maxHeight?: number }) {
  return (
    <pre className={cn('overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words', className)} style={{ maxHeight }}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  loading,
  children
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  loading?: boolean
  children?: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A dialog that asks for a short reason or comment (used for requests and decisions). */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = 'Reason',
  placeholder,
  confirmLabel = 'Submit',
  required = true,
  onSubmit,
  loading,
  children
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: React.ReactNode
  label?: string
  placeholder?: string
  confirmLabel?: string
  required?: boolean
  onSubmit: (reason: string) => void
  loading?: boolean
  children?: React.ReactNode
}) {
  const [text, setText] = React.useState('')
  const id = React.useId()
  React.useEffect(() => {
    if (open) setText('')
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <Field label={label} htmlFor={id}>
          <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={3} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(text.trim())} disabled={required && text.trim().length < 3} loading={loading}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function MonoId({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">{children}</code>
}

export function FixtureBadge() {
  return (
    <Badge tone="neutral" title="Created by the demo seed. It did not actually execute.">
      Sample (fixture)
    </Badge>
  )
}
