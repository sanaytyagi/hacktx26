import * as React from 'react'
import { Bell, Bot, BrainCircuit, ChevronDown, Database, House, Inbox, Moon, PlayCircle, Settings, Sun, Wallet, Wrench, UserRound, FlaskConical } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, navigate, useRoute } from '@/lib/router'
import { useApi, useAction, invalidatePrefixes, type Out } from '@/lib/api'
import { useTheme } from '@/lib/hooks'
import { when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/misc'

const NAV = [
  { key: 'home', label: 'Home', icon: House, to: '/' },
  { key: 'agents', label: 'Agents', icon: Bot, to: '/agents' },
  { key: 'runs', label: 'Runs', icon: PlayCircle, to: '/runs' },
  { key: 'approvals', label: 'Approvals', icon: Inbox, to: '/approvals' },
  { key: 'data', label: 'Data', icon: Database, to: '/data' },
  { key: 'tools', label: 'Tools', icon: Wrench, to: '/tools' },
  { key: 'models', label: 'Models', icon: BrainCircuit, to: '/models' },
  { key: 'budget', label: 'Budget', icon: Wallet, to: '/budget' },
  { key: 'settings', label: 'Settings', icon: Settings, to: '/settings' }
] as const

export type Session = Out<'session.get'>
export const SessionContext = React.createContext<Session | null>(null)
export function useSession() {
  const s = React.useContext(SessionContext)
  if (!s) throw new Error('Session not loaded')
  return s
}
export function useCan(cap: string) {
  return useSession().capabilities.includes(cap as never)
}

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const { path } = useRoute()
  const approvals = useApi('approvals.list')
  const pendingForMe = (approvals.data ?? []).filter((a) => a.status === 'pending' && a.canDecide).length
  const section = path === '/' ? 'home' : path.split('/')[1]
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="drag flex h-12 items-end px-4 pb-1" style={{ paddingLeft: window.relay.platform === 'darwin' ? 80 : 16 }}>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">Relay</span>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-0.5 px-2 pt-4">
          {NAV.filter((n) => session.nav.includes(n.key)).map((n) => {
            const active = section === n.key || (n.key === 'home' && section === '')
            const Icon = n.icon
            return (
              <Link
                key={n.key}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted', active ? 'bg-card font-medium text-foreground shadow-xs ring-1 ring-border' : 'text-sidebar-foreground')}
              >
                <Icon className="size-4" aria-hidden />
                <span className="flex-1">{n.label}</span>
                {n.key === 'approvals' && pendingForMe > 0 && (
                  <Badge tone="warning" aria-label={`${pendingForMe} waiting for your decision`}>
                    {pendingForMe}
                  </Badge>
                )}
                {n.key === 'runs' && session.openReviews > 0 && (
                  <Badge tone="warning" aria-label={`${session.openReviews} need your review`}>
                    {session.openReviews}
                  </Badge>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="space-y-2 border-t p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="size-3.5" aria-hidden />
            <span>
              <strong className="font-medium text-foreground">Local prototype.</strong> Data stays on this computer unless a step sends it to a provider you configure.
            </span>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar session={session} />
        <main className="min-h-0 flex-1 overflow-y-auto" id="main">
          <div className="mx-auto max-w-[1280px] px-8 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}

function TopBar({ session }: { session: Session }) {
  const [theme, setTheme] = useTheme()
  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 border-b bg-background/95 px-4">
      <div className="no-drag flex items-center gap-2">
        <span className="font-medium">{session.workspace.name}</span>
        {session.workspace.synthetic && <Badge tone="neutral">Synthetic demo data</Badge>}
        <Badge tone="info" title="Runs entirely on this computer. No accounts, hosted backend or payments.">
          Local prototype
        </Badge>
      </div>
      <div className="flex-1" />
      <div className="no-drag flex items-center gap-1">
        <Notifications unread={session.unreadNotifications} />
        <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <PersonaSwitcher session={session} />
      </div>
    </header>
  )
}

function PersonaSwitcher({ session }: { session: Session }) {
  const qc = useQueryClient()
  const sw = useAction('session.switchPersona', {
    quiet: false,
    onSuccess: () => {
      qc.clear()
      navigate('/', { force: true })
    },
    invalidate: ['']
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={`Acting as ${session.actor.name}. Switch demo persona`}>
          <UserRound className="size-4" />
          <span className="max-w-40 truncate">{session.actor.name}</span>
          <Badge tone="primary" className="capitalize">
            {session.actor.role}
          </Badge>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Demo persona (not a login)</DropdownMenuLabel>
        {session.personas.map((p) => (
          <DropdownMenuItem key={p.id} disabled={p.id === session.actor.id} onSelect={() => sw.mutate({ userId: p.id })}>
            <div className="flex-1">
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                {p.title} · {p.team}
              </div>
            </div>
            <Badge tone="neutral" className="capitalize">
              {p.role}
            </Badge>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Personas let you try each role locally. Permissions are still enforced by Relay’s services for whichever persona is active.</div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Notifications({ unread }: { unread: number }) {
  const q = useApi('notifications.list')
  const qc = useQueryClient()
  const mark = useAction('notifications.markRead', { quiet: true, onSuccess: () => invalidatePrefixes(qc, ['notifications.', 'session.']) })
  return (
    <Popover onOpenChange={(o) => !o && unread > 0 && mark.mutate({ ids: 'all' })}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className="relative">
          <Bell />
          {unread > 0 && <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Notifications</div>
        <div className="max-h-96 overflow-y-auto">
          {(q.data ?? []).length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</div>}
          {(q.data ?? []).map((n) => (
            <button
              key={n.id}
              className={cn('block w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted', !n.read && 'bg-accent/50')}
              onClick={() => n.link && navigate(`/${n.link}`)}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {!n.read && <span className="size-1.5 rounded-full bg-primary" aria-label="Unread" />}
                {n.title}
              </div>
              {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</div>}
              <div className="mt-0.5 text-[11px] text-muted-foreground">{when(n.created_at)}</div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
