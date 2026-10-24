// Example ticketing service for Relay's OpenAPI import demo. Binds to loopback only.
// Run: npm run example:ticketing   (PORT defaults to 4010, token "demo-ticketing-token")
import http from 'node:http'

const PORT = Number(process.env.PORT || 4010)
const TOKEN = process.env.TICKETING_TOKEN || 'demo-ticketing-token'
const tickets = [
  { id: 'TCK-1', title: 'Checkout latency spike', service: 'checkout', severity: 'SEV2', status: 'open', created_at: new Date().toISOString() },
  { id: 'TCK-2', title: 'Search index rebuild', service: 'search', severity: 'SEV4', status: 'resolved', created_at: new Date().toISOString() }
]
const seen = new Map()

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/') return send(res, 200, { ok: true, service: 'example-ticketing' })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (url.pathname === '/tickets' && req.method === 'GET') {
        const st = url.searchParams.get('status')
        const svc = url.searchParams.get('service')
        return send(res, 200, { tickets: tickets.filter((t) => (!st || t.status === st) && (!svc || t.service === svc)) })
      }
      if (url.pathname === '/tickets' && req.method === 'POST') {
        const key = req.headers['idempotency-key']
        if (key && seen.has(key)) return send(res, 201, seen.get(key))
        let data
        try {
          data = JSON.parse(body || '{}')
        } catch {
          return send(res, 400, { error: 'invalid json' })
        }
        if (!data.title || !data.service) return send(res, 400, { error: 'title and service are required' })
        const t = { id: `TCK-${tickets.length + 1}`, title: data.title, service: data.service, severity: data.severity || 'SEV3', status: 'open', created_at: new Date().toISOString() }
        tickets.push(t)
        if (key) seen.set(key, t)
        return send(res, 201, t)
      }
      const m = url.pathname.match(/^\/tickets\/([\w-]+)$/)
      if (m) {
        const i = tickets.findIndex((t) => t.id === m[1])
        if (i < 0) return send(res, 404, { error: 'not found' })
        if (req.method === 'GET') return send(res, 200, tickets[i])
        if (req.method === 'DELETE') {
          tickets.splice(i, 1)
          return send(res, 204)
        }
      }
      send(res, 404, { error: 'not found' })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, '127.0.0.1', () => console.log(`Example ticketing API on http://127.0.0.1:${PORT}`))
}
