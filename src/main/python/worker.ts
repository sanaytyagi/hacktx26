// Managed Python subprocess. A long-lived worker handles profiling, dataset preparation and
// inference over a JSON-lines protocol on stdio; training runs in its own process per job so
// it can be cancelled by terminating that process.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { RelayError } from '../core/errors'
import { redactString } from '../core/redact'

const ResponseSchema = z.union([
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.object({ message: z.string(), code: z.string().optional() }) }),
  z.object({ id: z.number(), event: z.record(z.string(), z.unknown()) })
])

export interface PythonWorkerOptions {
  pythonDir: string
  env: Record<string, string>
  /** Additional virtualenv locations to try (e.g. one created under the app data folder). */
  venvDirs?: string[]
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onEvent?: (e: Record<string, unknown>) => void
  timer?: NodeJS.Timeout
}

export function resolvePython(pythonDir: string, venvDirs: string[] = []): string {
  if (process.env.RELAY_PYTHON) return process.env.RELAY_PYTHON
  for (const dir of [join(pythonDir, '.venv'), ...venvDirs]) {
    const exe = process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python')
    if (existsSync(exe)) return exe
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

export class PythonWorker {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stderrTail: string[] = []
  private jobs = new Set<ChildProcess>()
  readonly pythonPath: string

  constructor(private opts: PythonWorkerOptions) {
    this.pythonPath = resolvePython(opts.pythonDir, opts.venvDirs)
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.opts.env, PYTHONPATH: this.opts.pythonDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
  }

  private ensure(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc
    const proc = spawn(this.pythonPath, ['-u', '-m', 'relay_worker.main'], { cwd: this.opts.pythonDir, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.on('error', (e) => this.failAll(new RelayError('unavailable', `Could not start Python (${this.pythonPath}): ${e.message}. Run “npm run setup:python”.`)))
    proc.on('exit', (code) => {
      this.failAll(new RelayError('failed', `Python worker exited (code ${code}). ${redactString(this.stderrTail.slice(-5).join(' | '))}`))
      this.proc = null
    })
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail.push(...d.toString('utf8').split('\n').filter(Boolean))
      if (this.stderrTail.length > 200) this.stderrTail = this.stderrTail.slice(-200)
    })
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line))
    return proc
  }

  private onLine(line: string) {
    let msg: z.infer<typeof ResponseSchema>
    try {
      msg = ResponseSchema.parse(JSON.parse(line))
    } catch {
      this.stderrTail.push(`[stdout] ${line.slice(0, 500)}`)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    if ('event' in msg) return p.onEvent?.(msg.event)
    this.pending.delete(msg.id)
    if (p.timer) clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new RelayError(msg.error.code === 'invalid' ? 'invalid' : msg.error.code === 'unavailable' ? 'unavailable' : 'failed', msg.error.message))
  }

  private failAll(e: Error) {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(e)
      this.pending.delete(id)
    }
  }

  call<T>(method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; onEvent?: (e: Record<string, unknown>) => void } = {}): Promise<T> {
    const proc = this.ensure()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject, onEvent: opts.onEvent }
      if (opts.timeoutMs)
        p.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new RelayError('failed', `Python worker call “${method}” timed out.`))
        }, opts.timeoutMs)
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        if (p.timer) clearTimeout(p.timer)
        reject(new RelayError('cancelled', 'Cancelled.'))
      })
      this.pending.set(id, p)
      proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  /** Run a separate Python process for a long job. Lines on stdout are JSON events. */
  spawnJob(module: string, args: string[], onEvent: (e: Record<string, unknown>) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void): ChildProcess {
    const proc = spawn(this.pythonPath, ['-u', '-m', module, ...args], { cwd: this.opts.pythonDir, env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
    this.jobs.add(proc)
    const tail: string[] = []
    proc.stderr!.on('data', (d: Buffer) => {
      tail.push(...d.toString('utf8').split('\n').filter(Boolean))
      if (tail.length > 80) tail.splice(0, tail.length - 80)
    })
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        const e = JSON.parse(line)
        if (e && typeof e === 'object') onEvent(e)
      } catch {
        tail.push(line)
      }
    })
    proc.on('error', (e) => {
      tail.push(e.message)
    })
    proc.on('close', (code, signal) => {
      this.jobs.delete(proc)
      onExit(code, signal, redactString(tail.join('\n')))
    })
    return proc
  }

  stderr(): string[] {
    return this.stderrTail.slice(-50).map(redactString)
  }

  stop() {
    this.failAll(new RelayError('cancelled', 'Python worker stopped.'))
    this.proc?.kill()
    this.proc = null
    for (const j of this.jobs) j.kill()
  }
}
