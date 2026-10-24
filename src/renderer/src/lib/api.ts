import { QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Api } from '../../../main/ipc/router'

export type { Api }
export type Method = keyof Api
export type Out<M extends Method> = Api[M]['output']
export type In<M extends Method> = Api[M]['input']

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
  }
}

export async function call<M extends Method>(method: M, input?: In<M>): Promise<Out<M>> {
  const r = (await window.relay.invoke(method, input ?? {})) as { ok: true; data: Out<M> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
  if (!r.ok) throw new ApiError(r.error.code, r.error.message, r.error.details)
  return r.data
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: (n, e) => n < 1 && !(e instanceof ApiError), refetchOnWindowFocus: false } }
})

export function useApi<M extends Method>(method: M, input?: In<M>, opts?: Omit<UseQueryOptions<Out<M>, ApiError>, 'queryKey' | 'queryFn'>) {
  return useQuery<Out<M>, ApiError>({ queryKey: [method, input ?? {}], queryFn: () => call(method, input), ...opts })
}

/** Mutation with toast feedback and cache invalidation by method-name prefix. */
export function useAction<M extends Method>(method: M, opts: { success?: string | ((d: Out<M>) => string | null); invalidate?: string[]; onSuccess?: (d: Out<M>, input: In<M>) => void; quiet?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation<Out<M>, ApiError, In<M>>({
    mutationFn: (input) => call(method, input),
    onSuccess: (d, input) => {
      const msg = typeof opts.success === 'function' ? opts.success(d) : opts.success
      if (msg) toast.success(msg)
      invalidatePrefixes(qc, opts.invalidate ?? [method.split('.')[0] + '.', 'home.', 'session.'])
      opts.onSuccess?.(d, input)
    },
    onError: (e) => {
      if (!opts.quiet) toast.error(errorTitle(e), { description: e.message })
    }
  })
}

export function errorTitle(e: ApiError) {
  return e.code === 'forbidden'
    ? 'Not allowed'
    : e.code === 'budget'
      ? 'Blocked by budget'
      : e.code === 'policy'
        ? 'Blocked by company policy'
        : e.code === 'unavailable'
          ? 'Not available yet'
          : e.code === 'invalid'
            ? 'Please check the details'
            : e.code === 'conflict'
              ? 'Can’t do that right now'
              : 'Something went wrong'
}

export function invalidatePrefixes(qc: QueryClient, prefixes: string[]) {
  qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.some((p) => (q.queryKey[0] as string).startsWith(p)) })
}

type PushEvent = { type: string; runId?: string; jobId?: string; [k: string]: unknown }
const listeners = new Set<(e: PushEvent) => void>()

export function startEventBridge() {
  return window.relay.onEvent((raw) => {
    const e = raw as PushEvent
    listeners.forEach((l) => l(e))
    const map: Record<string, string[]> = {
      'run.updated': ['runs.', 'agents.', 'home.', 'session.', 'budget.', 'results.'],
      'job.updated': ['ml.', 'home.', 'budget.'],
      notification: ['notifications.', 'session.'],
      'approvals.changed': ['approvals.', 'home.', 'session.', 'agents.', 'data.', 'tools.', 'ml.', 'budget.'],
      'data.changed': ['data.', 'ml.'],
      'tools.changed': ['tools.', 'agents.readiness']
    }
    if (map[e.type]) invalidatePrefixes(queryClient, map[e.type])
  })
}

export function onPush(l: (e: PushEvent) => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
