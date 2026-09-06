import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { Complete, ProviderConfig } from './types.js'

const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
})
const ResponseSchema = z.object({
  id: z.string().default('unknown'),
  model: z.string().default('unknown'),
  usage: z.record(z.string(), z.unknown()).default({}),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string().nullable().default(null),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
})

export type ProviderReceipt = {
  id: string | null
  model: string | null
  usage: Record<string, unknown> | null
}

export class ProviderResponseError extends Error {
  readonly receipt: ProviderReceipt

  constructor(message: string, receipt: ProviderReceipt) {
    super(message)
    this.name = 'ProviderResponseError'
    this.receipt = receipt
  }
}

function numericUsage(
  value: unknown,
  apiKey: string,
  depth = 0,
  budget = { remaining: 64 },
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 4)
    return null
  const entries: Array<[string, unknown]> = []
  for (const [key, item] of Object.entries(value)) {
    if (budget.remaining-- <= 0) break
    if (
      !/^[a-z]\w{0,95}$/i.test(key) ||
      /^(?:apiKey|authorization|api_key)$/i.test(key) ||
      redact(key, apiKey) !== key
    )
      continue
    if (typeof item === 'number' && Number.isFinite(item)) {
      entries.push([key, item])
    } else {
      const nested = numericUsage(item, apiKey, depth + 1, budget)
      if (nested && Object.keys(nested).length) entries.push([key, nested])
    }
  }
  return Object.fromEntries(entries)
}

function providerReceipt(value: unknown, apiKey: string): ProviderReceipt {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const identity = (item: unknown): string | null => {
    if (typeof item !== 'string' || !/^[\w./:+-]{1,256}$/.test(item))
      return null
    return String(redact(item, apiKey))
  }
  return {
    id: identity(raw.id),
    model: identity(raw.model),
    usage: numericUsage(raw.usage, apiKey),
  }
}

export function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return {
        image: 'omitted',
        sha256: createHash('sha256').update(value).digest('hex'),
        encoded_bytes: value.length,
      }
    }
    return (apiKey ? value.replaceAll(apiKey, '[REDACTED]') : value)
      .replace(/sk-[\w-]+/g, '[REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'image' && typeof record.data === 'string') {
      return {
        type: 'image',
        mimeType: record.mimeType,
        sha256: createHash('sha256')
          .update(Buffer.from(record.data, 'base64'))
          .digest('hex'),
        encoded_bytes: record.data.length,
      }
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        /^(?:apiKey|authorization|api_key)$/i.test(key)
          ? '[REDACTED]'
          : redact(item, apiKey),
      ]),
    )
  }
  return value
}

export function createProvider(config: ProviderConfig): Complete {
  const url = new URL(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error(
      'Provider URL must use HTTPS or loopback HTTP, without credentials, query or fragment.',
    )
  }
  return async ({ messages, tools, toolChoice, signal }) => {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          reasoning_effort: config.reasoningEffort,
          max_tokens: config.maxOutputTokens,
          messages,
          tools,
          tool_choice: toolChoice ?? 'auto',
          stream: false,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
          : AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      throw new Error(
        `Provider request interrupted; completion and billing are unknown. No automatic retry. ${String(redact(error instanceof Error ? error.message : String(error), config.apiKey))}`,
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Provider HTTP ${response.status}; response body omitted. No automatic retry.`,
      )
    }
    let parsed: z.infer<typeof ResponseSchema>
    let receipt: ProviderReceipt = { id: null, model: null, usage: null }
    try {
      const raw: unknown = await response.json()
      receipt = providerReceipt(raw, config.apiKey)
      parsed = ResponseSchema.parse(raw)
    } catch {
      throw new ProviderResponseError(
        'Malformed provider response; expected one complete assistant message with valid tool calls.',
        receipt,
      )
    }
    const choice = parsed.choices[0]
    const calls = choice.message.tool_calls
    if (calls && new Set(calls.map((call) => call.id)).size !== calls.length)
      throw new ProviderResponseError(
        'Malformed provider response: duplicate tool call ids.',
        receipt,
      )
    if (choice.finish_reason === 'tool_calls' && !calls?.length)
      throw new ProviderResponseError(
        'Malformed provider response: missing tool calls.',
        receipt,
      )
    return {
      id: parsed.id,
      model: parsed.model,
      message: { role: 'assistant', ...choice.message },
      finishReason: choice.finish_reason,
      usage: parsed.usage,
    }
  }
}
