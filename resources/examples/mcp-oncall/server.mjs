// Example MCP server (stdio) for Relay's MCP integration demo. Synthetic on-call data.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve dependencies from Relay's own node_modules (set by Relay when it launches this server).
const require = createRequire(process.env.RELAY_MODULE_ROOT ? join(process.env.RELAY_MODULE_ROOT, 'package.json') : import.meta.url)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const here = dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(readFileSync(join(here, 'oncall.json'), 'utf8'))
const server = new McpServer({ name: 'oncall-directory', version: '1.0.0' })

server.registerTool(
  'get_oncall',
  { description: 'Look up the primary and secondary on-call engineer for a service.', inputSchema: { service: z.string().describe('Service name, e.g. checkout') } },
  async ({ service }) => {
    const entry = data[service]
    if (!entry) return { content: [{ type: 'text', text: `No on-call entry for ${service}` }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify({ service, primary: entry.primary, secondary: entry.secondary }) }] }
  }
)

server.registerTool(
  'service_status',
  { description: 'Current status of a service from the on-call directory.', inputSchema: { service: z.string() } },
  async ({ service }) => ({ content: [{ type: 'text', text: JSON.stringify({ service, status: data[service]?.status ?? 'unknown' }) }] })
)

await server.connect(new StdioServerTransport())
