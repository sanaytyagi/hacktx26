// Dev helper: drive a running Relay window over the Chrome DevTools Protocol.
// Start Relay with:  npx electron . --remote-debugging-port=9333
// Usage: node scripts/cdp.mjs shot <hash-route> <out.png> [waitMs]
//        node scripts/cdp.mjs eval "<js expression>"
const [cmd, a, b, wait = '1200'] = process.argv.slice(2)
const port = process.env.CDP_PORT || 9333
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.includes('recording-hud'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result
if (cmd === 'shot') {
  if (a !== '-') await evaluate(`location.hash = ${JSON.stringify(a)}`)
  await new Promise((r) => setTimeout(r, Number(wait)))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(b, Buffer.from(shot.result.data, 'base64'))
  console.log('saved', b)
} else if (cmd === 'eval') {
  console.log(JSON.stringify((await evaluate(a)).result?.value ?? (await evaluate(a)), null, 1))
}
ws.close()
