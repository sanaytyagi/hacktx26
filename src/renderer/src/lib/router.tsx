import * as React from 'react'

/** Minimal hash router: #/path/segments?query. Keeps state across reloads and back/forward. */
function parse() {
  const raw = window.location.hash.replace(/^#/, '') || '/'
  const [path, qs] = raw.split('?')
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs ?? '')) as Record<string, string> }
}

const listeners = new Set<() => void>()
window.addEventListener('hashchange', () => listeners.forEach((l) => l()))

const guards = new Set<() => string | null>()
/** Register a guard that returns a message when leaving would lose work. */
export function useLeaveGuard(message: string | null) {
  React.useEffect(() => {
    if (!message) return
    const g = () => message
    guards.add(g)
    return () => {
      guards.delete(g)
    }
  }, [message])
}

export function navigate(to: string, opts: { replace?: boolean; force?: boolean } = {}) {
  if (!opts.force) for (const g of guards) {
    const m = g()
    if (m && !window.confirm(m)) return
  }
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`
  if (opts.replace) window.location.replace(target)
  else window.location.hash = target
}

export function useRoute() {
  const [r, setR] = React.useState(parse)
  React.useEffect(() => {
    const l = () => setR(parse())
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return r
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return params
}

export function setQuery(patch: Record<string, string | null>) {
  const { path, query } = parse()
  const q = { ...query }
  for (const [k, v] of Object.entries(patch)) if (v === null) delete q[k]
  else q[k] = v
  const qs = new URLSearchParams(q).toString()
  window.location.replace(`#${path}${qs ? `?${qs}` : ''}`)
}

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: React.ReactNode } & Omit<React.ComponentProps<'a'>, 'href'>) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return
        e.preventDefault()
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
