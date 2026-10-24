export type ErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'budget'
  | 'unavailable'
  | 'conflict'
  | 'policy'
  | 'cancelled'
  | 'failed'

/** Errors that are safe to show to the user. Anything else is reported as an internal error. */
export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

export const forbidden = (msg: string, details?: Record<string, unknown>) => new RelayError('forbidden', msg, details)
export const notFound = (what: string) => new RelayError('not_found', `${what} was not found.`)
export const invalid = (msg: string, details?: Record<string, unknown>) => new RelayError('invalid', msg, details)
export const unavailable = (msg: string, details?: Record<string, unknown>) => new RelayError('unavailable', msg, details)
