// Runs one plugin operation inside a worker thread so a slow or crashing plugin cannot block
// or take down the main process. Plugins are trusted code installed by an administrator; the
// worker isolates failures and timeouts, it is not a security sandbox. No credentials are passed.
import { parentPort, workerData } from 'node:worker_threads'

async function main() {
  const mod = await import(workerData.entry)
  const plugin = mod.default ?? mod.plugin
  if (!plugin || !Array.isArray(plugin.tools)) throw new Error('Plugin must export a default object with a tools array.')
  if (workerData.mode === 'manifest') {
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      tools: plugin.tools.map(({ execute, ...rest }) => rest)
    }
  }
  const tool = plugin.tools.find((t) => t.name === workerData.tool)
  if (!tool) throw new Error(`Plugin has no tool named ${workerData.tool}`)
  const logs = []
  const result = await tool.execute(workerData.args ?? {}, { log: (m) => logs.push(String(m).slice(0, 500)) })
  return result
}

main().then(
  (result) => parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) }),
  (e) => parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
)
