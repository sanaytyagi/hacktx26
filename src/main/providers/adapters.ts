import Anthropic from '@anthropic-ai/sdk'
import net from 'node:net'
import type { AppContext } from '../core/context'
import { safeFetch, isPrivateAddress } from '../core/netguard'
import { RelayError } from '../core/errors'
import { redactString } from '../core/redact'
import type { ChatMessage, GenerateRequest, GenerateResult, ProviderAdapter, ProviderConfig } from './types'

// ---------------- Anthropic (official SDK) ----------------

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'assistant' && m.raw) return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] }
    const content: Anthropic.ContentBlockParam[] = m.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text }
      if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: p.name, input: p.args }
      return { type: 'tool_result', tool_use_id: p.id, content: p.content, is_error: p.isError ?? false }
    })
    return { role: m.role, content }
  })
}

export const anthropicAdapter: ProviderAdapter = {
  supportsTools: true,
  async generate(cfg, req) {
    if (!cfg.apiKey) throw new RelayError('unavailable', 'Anthropic API key is not configured.')
    const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), maxRetries: 1, timeout: 120_000 })
    try {
      const res = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools?.length
            ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object' as const, ...(t.inputSchema as object) } })) }
            : {})
        },
        { signal: req.signal }
      )
      if (res.stop_reason === 'refusal') throw new RelayError('failed', 'The model declined this request (refusal).')
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
      const toolCalls = res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }] : []))
      return {
        text,
        toolCalls,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        stopReason: res.stop_reason ?? 'end_turn',
        raw: res.content
      }
    } catch (e) {
      if (e instanceof RelayError) throw e
      if (e instanceof Anthropic.AuthenticationError) throw new RelayError('unavailable', 'Anthropic rejected the API key.', { httpStatus: 401 })
      if (e instanceof Anthropic.RateLimitError) throw new RelayError('failed', 'Anthropic rate limit reached; try again shortly.', { httpStatus: 429, retryable: true })
      if (e instanceof Anthropic.APIError) throw new RelayError('failed', `Anthropic API error ${e.status}: ${redactString(e.message)}`, { httpStatus: e.status })
      throw new RelayError('failed', `Could not reach Anthropic: ${redactString((e as Error).message)}`, { network: true })
    }
  }
}

// ---------------- Gemini (REST) ----------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'

async function jsonRequest(url: string, cfg: ProviderConfig, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }) {
  const host = new URL(url).hostname
  const res = await safeFetch(url, {
    ...init,
    allowedHosts: [host],
    allowPrivateNetwork: !cfg.external,
    timeoutMs: init.timeoutMs ?? 120_000,
    maxBytes: 20 * 1024 * 1024
  })
  const text = res.body.toString('utf8')
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (res.status >= 400) {
    const msg = (parsed as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300)
    throw new RelayError(res.status === 401 || res.status === 403 ? 'unavailable' : 'failed', `Provider error ${res.status}: ${redactString(msg)}`, {
      httpStatus: res.status,
      retryable: res.status === 429 || res.status >= 500
    })
  }
  return { json: parsed as Record<string, unknown>, headers: res.headers }
}

type GeminiPart = { text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: unknown }; file_data?: { mime_type: string; file_uri: string } }

export function geminiContents(messages: ChatMessage[], extraParts: GeminiPart[] = []) {
  return messages.map((m, i) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(i === 0 ? extraParts : []),
      ...m.content.map((p): GeminiPart => {
        if (p.type === 'text') return { text: p.text }
        if (p.type === 'tool_call') return { functionCall: { name: p.name, args: p.args } }
        return { functionResponse: { name: p.name, response: { content: p.content, isError: !!p.isError } } }
      })
    ]
  }))
}

export async function geminiGenerate(cfg: ProviderConfig, req: GenerateRequest, extraParts: GeminiPart[] = []): Promise<GenerateResult> {
  if (!cfg.apiKey) throw new RelayError('unavailable', 'Gemini API key is not configured.')
  const base = cfg.baseUrl || GEMINI_BASE
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: geminiContents(req.messages, extraParts),
    ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens, ...(req.json ? { responseMimeType: 'application/json' } : {}) }
  }
  const { json } = await jsonRequest(`${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, cfg, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: 300_000
  })
  const cand = (json.candidates as { content?: { parts?: GeminiPart[] }; finishReason?: string }[] | undefined)?.[0]
  const parts = cand?.content?.parts ?? []
  const usage = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined
  return {
    text: parts.flatMap((p) => (p.text ? [p.text] : [])).join(''),
    toolCalls: parts.flatMap((p, i) => (p.functionCall ? [{ id: `call_${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }] : [])),
    usage: { inputTokens: usage?.promptTokenCount ?? 0, outputTokens: usage?.candidatesTokenCount ?? 0 },
    stopReason: cand?.finishReason ?? 'STOP'
  }
}

/** Resumable upload to the Gemini Files API, then wait until the file is ACTIVE. */
export async function geminiUploadFile(cfg: ProviderConfig, bytes: Buffer, mime: string, displayName: string, signal?: AbortSignal): Promise<{ uri: string; name: string }> {
  if (!cfg.apiKey) throw new RelayError('unavailable', 'Gemini API key is not configured.')
  const base = cfg.baseUrl || GEMINI_BASE
  const host = new URL(base).hostname
  const start = await safeFetch(`${base}/upload/v1beta/files`, {
    method: 'POST',
    allowedHosts: [host],
    headers: {
      'x-goog-api-key': cfg.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal
  })
  const uploadUrl = start.headers['x-goog-upload-url']
  if (start.status >= 400 || !uploadUrl) throw new RelayError('failed', `Gemini upload could not start (HTTP ${start.status}).`)
  const done = await uploadBinary(uploadUrl, bytes, cfg.apiKey, signal)
  const file = (done as { file?: { uri: string; name: string; state?: string } }).file
  if (!file?.uri) throw new RelayError('failed', 'Gemini upload did not return a file reference.')
  for (let i = 0; i < 90; i++) {
    const { json } = await jsonRequest(`${base}/v1beta/${file.name}`, cfg, { method: 'GET', headers: { 'x-goog-api-key': cfg.apiKey }, signal })
    if (json.state === 'ACTIVE') return { uri: file.uri, name: file.name }
    if (json.state === 'FAILED') throw new RelayError('failed', 'Gemini could not process the video file.')
    await new Promise((r) => setTimeout(r, 4000))
  }
  throw new RelayError('failed', 'Timed out waiting for Gemini to process the video.')
}

async function uploadBinary(url: string, bytes: Buffer, apiKey: string, signal?: AbortSignal): Promise<unknown> {
  // safeFetch only sends string bodies; video bytes go through a dedicated guarded request.
  const { request } = await import('node:https')
  const u = new URL(url)
  if (u.protocol !== 'https:' || !u.hostname.endsWith('googleapis.com')) throw new RelayError('forbidden', 'Unexpected upload URL host.')
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'x-goog-api-key': apiKey },
        signal,
        timeout: 600_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 500) >= 400) return reject(new RelayError('failed', `Gemini upload failed (HTTP ${res.statusCode}).`))
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new RelayError('failed', 'Gemini upload returned an unexpected response.'))
          }
        })
      }
    )
    req.on('error', (e) => reject(new RelayError('failed', `Upload failed: ${(e as Error).message}`)))
    req.end(bytes)
  })
}

export const geminiAdapter: ProviderAdapter = { supportsTools: true, generate: (cfg, req) => geminiGenerate(cfg, req) }

// ---------------- OpenAI-compatible (OpenAI, local servers such as Ollama / LM Studio / vLLM) ----------------

export const openaiAdapter: ProviderAdapter = {
  supportsTools: true,
  async generate(cfg, req) {
    if (!cfg.baseUrl) throw new RelayError('unavailable', 'Base URL is not configured for this provider.')
    const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) {
      const texts = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)
      const calls = m.content.filter((p) => p.type === 'tool_call') as { id: string; name: string; args: Record<string, unknown> }[]
      const results = m.content.filter((p) => p.type === 'tool_result') as { id: string; content: string }[]
      if (m.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: texts.join('\n') || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {})
        })
      else {
        for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
        if (texts.length) messages.push({ role: 'user', content: texts.join('\n') })
      }
    }
    const { json } = await jsonRequest(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, cfg, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: req.model,
        messages,
        max_tokens: req.maxTokens,
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
        ...(req.json ? { response_format: { type: 'json_object' } } : {})
      }),
      signal: req.signal
    })
    const choice = (json.choices as { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[])?.[0]
    const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    return {
      text: choice?.message?.content ?? '',
      toolCalls: (choice?.message?.tool_calls ?? []).map((c) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(c.function.arguments || '{}')
        } catch {
          args = { __invalid_json: c.function.arguments }
        }
        return { id: c.id, name: c.function.name, args }
      }),
      usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 },
      stopReason: choice?.finish_reason ?? 'stop'
    }
  }
}

// ---------------- Local (Relay Python worker) ----------------

export function localAdapter(ctx: AppContext): ProviderAdapter {
  return {
    supportsTools: false,
    async generate(_cfg, req) {
      const prompt = req.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')).join('\n')}`)
        .join('\n\n')
      const r = await ctx.python.call<{ text: string; input_tokens: number; output_tokens: number }>(
        'generate',
        { model: req.model, system: req.system, prompt, max_new_tokens: Math.min(req.maxTokens, 1024) },
        { timeoutMs: 600_000, signal: req.signal }
      )
      return { text: r.text, toolCalls: [], usage: { inputTokens: r.input_tokens, outputTokens: r.output_tokens }, stopReason: 'end_turn' }
    }
  }
}

export function isLoopbackUrl(url: string | null): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || (net.isIP(h) !== 0 && isPrivateAddress(h))
  } catch {
    return false
  }
}
