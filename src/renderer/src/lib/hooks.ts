import * as React from 'react'

/** State persisted to sessionStorage so in-progress work survives navigation. */
export function useDraftState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(`draft:${key}`)
      if (raw) return JSON.parse(raw) as T
    } catch {
      /* ignore */
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  React.useEffect(() => {
    try {
      sessionStorage.setItem(`draft:${key}`, JSON.stringify(value))
    } catch {
      /* ignore */
    }
  }, [key, value])
  const clear = React.useCallback(() => sessionStorage.removeItem(`draft:${key}`), [key])
  return [value, setValue, clear] as const
}

export function useTheme() {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => (localStorage.getItem('relay-theme') as 'light' | 'dark') || 'light')
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('relay-theme', theme)
  }, [theme])
  return [theme, setTheme] as const
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = React.useRef(fn)
  ref.current = fn
  React.useEffect(() => {
    if (ms === null) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}
