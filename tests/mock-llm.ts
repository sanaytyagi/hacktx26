// A local stand-in for the Anthropic Messages API so tests exercise the real SDK adapter,
// budgeting, metering and egress checks without network access or a paid key.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockLlm {
  url: string
  calls: { body: Record<string, unknown> }[]
  close(): Promise<void>
}

export async function startMockAnthropic(reply: (body: Record<string, unknown>) => string, delayMs = 50): Promise<MockLlm> {
  const calls: MockLlm['calls'] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      calls.push({ body })
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: `msg_${calls.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: reply(body) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1000, output_tokens: 200 }
          })
        )
      }, delayMs)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) }
}
