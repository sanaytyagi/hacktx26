// Outbound HTTP with SSRF protection. Every hop (including redirects) is resolved and checked;
// the check runs inside the socket's DNS lookup so DNS rebinding cannot swap in a private address.
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import { RelayError } from './errors'

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return true
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('100::') || v.startsWith('2001:db8')
  }
  return true
}

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** Admin-configured integrations may target internal hosts explicitly. Never for web tools. */
  allowPrivateNetwork?: boolean
  /** If set, every hop must stay on one of these hostnames. */
  allowedHosts?: string[]
  /** Restrict ports for public web fetches. */
  allowedPorts?: number[]
  signal?: AbortSignal
}

export interface SafeResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  finalUrl: string
  truncated: boolean
}

function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error) => void)(err)
      const list = addresses as dns.LookupAddress[]
      const bad = list.find((a) => isPrivateAddress(a.address))
      if (bad && !allowPrivate) {
        return (callback as (e: Error) => void)(
          new RelayError('forbidden', `Blocked request to a private or loopback address (${hostname} → ${bad.address}).`)
        )
      }
      const first = list[0]
      if ((options as { all?: boolean }).all) (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list)
      else (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family)
    })
  }
}

export function checkUrl(raw: string, opts: SafeFetchOptions): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new RelayError('invalid', `Not a valid URL: ${raw.slice(0, 200)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RelayError('forbidden', `Only http and https URLs are allowed (got ${u.protocol}).`)
  if (u.username || u.password) throw new RelayError('forbidden', 'URLs with embedded credentials are not allowed.')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (opts.allowedHosts && !opts.allowedHosts.includes(host)) throw new RelayError('forbidden', `Requests to ${host} are not allowed for this tool.`)
  if (!opts.allowPrivateNetwork) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new RelayError('forbidden', `Blocked request to a private or loopback address (${host}).`)
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host))
      throw new RelayError('forbidden', `Blocked request to an internal hostname (${host}).`)
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (opts.allowedPorts && !opts.allowedPorts.includes(port)) throw new RelayError('forbidden', `Port ${port} is not allowed for web requests.`)
  return u
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 5
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 20_000
  let url = checkUrl(rawUrl, opts)
  let method = (opts.method ?? 'GET').toUpperCase()
  let body = opts.body
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(url, method, opts.headers ?? {}, body, timeoutMs, maxBytes, !!opts.allowPrivateNetwork, opts.signal)
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop === maxRedirects) throw new RelayError('failed', 'Too many redirects.')
      const next = new URL(res.headers.location, url)
      url = checkUrl(next.toString(), opts)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    return { ...res, finalUrl: url.toString() }
  }
  throw new RelayError('failed', 'Too many redirects.')
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxBytes: number,
  allowPrivate: boolean,
  signal?: AbortSignal
): Promise<Omit<SafeResponse, 'finalUrl'>> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method,
        headers: { 'user-agent': 'RelayPrototype/0.1 (+local desktop app)', ...headers, ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}) },
        lookup: guardedLookup(allowPrivate),
        timeout: timeoutMs,
        signal
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        res.on('data', (c: Buffer) => {
          if (truncated) return
          size += c.length
          if (size > maxBytes) {
            truncated = true
            chunks.push(c.subarray(0, c.length - (size - maxBytes)))
            res.destroy()
            finish()
            return
          }
          chunks.push(c)
        })
        let done = false
        const finish = () => {
          if (done) return
          done = true
          const hdrs: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) hdrs[k] = Array.isArray(v) ? v.join(', ') : String(v)
          resolve({ status: res.statusCode ?? 0, headers: hdrs, body: Buffer.concat(chunks), truncated })
        }
        res.on('end', finish)
        res.on('error', (e) => (truncated ? finish() : reject(e)))
      }
    )
    req.on('timeout', () => req.destroy(new RelayError('failed', `Request timed out after ${timeoutMs} ms.`)))
    req.on('error', (e) => reject(e instanceof RelayError ? e : new RelayError('failed', `Request failed: ${(e as Error).message}`)))
    if (body) req.write(body)
    req.end()
  })
}

/** Minimal, dependency-free HTML → text for page extraction. Content is treated as untrusted data. */
export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]).slice(0, 100)
  const text = html
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
  return { title: decodeTitle(title), text, links }
}

function decodeTitle(t: string) {
  return t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
}
