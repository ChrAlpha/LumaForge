import { describe, expect, it } from 'vitest'

import { runAgent } from './loop.js'
import { ProviderResponseError } from './provider.js'
import type { AgentOptions, ChatMessage, ModelResponse } from './types.js'

function call(name: string, args = '{}'): ModelResponse {
  return {
    id: 'r',
    model: 'test',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: args },
        },
      ],
    },
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 100, total_tokens: 150 },
  }
}
function options(overrides: Partial<AgentOptions>): AgentOptions {
  return {
    complete: async () => call('finish_edit'),
    tools: ['view', 'edit', 'finish_edit'].map((name) => ({
      type: 'function',
      function: { name, description: name, parameters: { type: 'object' } },
    })),
    messages: [{ role: 'user', content: 'Edit this photo.' }],
    execute: async () => ({ result: { content: [] } }),
    record: async () => {},
    maxSteps: 8,
    contextWindow: 500000,
    maxOutputTokens: 8192,
    ...overrides,
  }
}

describe('autonomous editing loop', () => {
  it('does not dispatch a queued tool after cancellation during log persistence', async () => {
    const controller = new AbortController()
    let executed = 0
    const result = await runAgent(
      options({
        signal: controller.signal,
        record: async (event) => {
          if (event.event === 'tool_call') controller.abort()
        },
        execute: async () => {
          executed += 1
          return { result: { content: [] } }
        },
      }),
    )
    expect(executed).toBe(0)
    expect(result.reason).toBe('cancelled')
  })

  it('does not issue a model request after cancellation while recording it', async () => {
    const controller = new AbortController()
    let requested = 0
    const result = await runAgent(
      options({
        signal: controller.signal,
        record: async (event) => {
          if (event.event === 'model_request') controller.abort()
        },
        complete: async () => {
          requested += 1
          return call('finish_edit')
        },
      }),
    )
    expect(requested).toBe(0)
    expect(result.reason).toBe('cancelled')
  })

  it('stops the rest of a tool batch when cancellation arrives during a tool', async () => {
    const controller = new AbortController()
    const response = call('view')
    response.message.tool_calls!.push(call('edit').message.tool_calls![0])
    const executed: string[] = []
    const result = await runAgent(
      options({
        signal: controller.signal,
        complete: async () => response,
        execute: async (name) => {
          executed.push(name)
          controller.abort()
          return { result: { content: [] } }
        },
      }),
    )
    expect(executed).toEqual(['view'])
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled' })
  })

  it('records cancellation instead of completion when an in-flight finish returns', async () => {
    const controller = new AbortController()
    const result = await runAgent(
      options({
        signal: controller.signal,
        execute: async () => {
          controller.abort()
          return { result: { content: [] }, completion: { verified: true } }
        },
      }),
    )
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled' })
    expect(result.completion).toBeUndefined()
  })

  it('keeps the known billable receipt when the provider response is unusable', async () => {
    const events: Array<Record<string, unknown>> = []
    const receipt = {
      id: 'paid-request',
      model: 'grok-4.6-build',
      usage: { total_tokens: 168 },
    }
    const result = await runAgent(
      options({
        complete: async () => {
          throw new ProviderResponseError('Malformed tool call', receipt)
        },
        record: async (event) => {
          events.push(event)
        },
      }),
    )
    expect(result).toMatchObject({
      status: 'incomplete',
      reason: 'provider_error',
      usage: [{ total_tokens: 168 }],
    })
    expect(
      events.find((event) => event.event === 'model_error')?.receipt,
    ).toEqual(receipt)
  })
  it('delivers actual tool pixels before accepting the next model decision', async () => {
    const seen: ChatMessage[][] = []
    const sequence = [call('view'), call('finish_edit')]
    const result = await runAgent(
      options({
        complete: async ({ messages }) => {
          seen.push(structuredClone(messages))
          return sequence.shift()!
        },
        execute: async (name, _args, step) =>
          name === 'view'
            ? {
                result: {
                  content: [
                    { type: 'text', text: 'candidate A' },
                    { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
                  ],
                },
              }
            : { result: { content: [] }, completion: { verified: true, step } },
      }),
    )
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(2)
    expect(seen[1][2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-view',
      content: 'candidate A',
    })
    expect(JSON.stringify(seen[1][3])).toContain('data:image/jpeg;base64,/9j/')
    expect(result.usage).toHaveLength(2)
  })

  it('feeds errors back and lets the model repair its own call', async () => {
    const sequence = [
      call('edit', '{'),
      call('edit', '{"exposure_ev":1}'),
      call('finish_edit'),
    ]
    let edited = false
    const result = await runAgent(
      options({
        complete: async ({ messages }) => {
          if (sequence.length === 2)
            expect(messages.at(-1)?.content).toContain('Invalid tool arguments')
          return sequence.shift()!
        },
        execute: async (name) => {
          if (name === 'edit') edited = true
          return {
            result: { content: [] },
            ...(name === 'finish_edit' ? { completion: { edited } } : {}),
          }
        },
      }),
    )
    expect(result.completion).toEqual({ edited: true })
  })

  it('never calls an uncertain stateful tool twice and never calls a step limit complete', async () => {
    let calls = 0
    const uncertain = await runAgent(
      options({
        complete: async () => call('edit'),
        execute: async () => {
          calls += 1
          return { result: { content: [] }, terminal: 'tool_outcome_unknown' }
        },
      }),
    )
    expect(uncertain).toMatchObject({
      status: 'incomplete',
      reason: 'tool_outcome_unknown',
    })
    expect(calls).toBe(1)
    const limited = await runAgent(
      options({ maxSteps: 1, complete: async () => call('view') }),
    )
    expect(limited).toMatchObject({
      status: 'incomplete',
      reason: 'step_limit',
    })
  })

  it('refuses truncated responses and finishes batched before image feedback', async () => {
    let executions = 0
    const truncated = await runAgent(
      options({
        complete: async () => ({ ...call('edit'), finishReason: 'length' }),
        execute: async () => {
          executions += 1
          return { result: { content: [] } }
        },
      }),
    )
    expect(truncated.reason).toBe('output_limit')
    expect(executions).toBe(0)
    const batch = call('view')
    batch.message.tool_calls!.push(call('finish_edit').message.tool_calls![0])
    const result = await runAgent(
      options({
        maxSteps: 1,
        complete: async () => batch,
        execute: async (name) => {
          expect(name).toBe('view')
          return { result: { content: [] } }
        },
      }),
    )
    expect(result.status).toBe('incomplete')
  })

  it('counts image tokens without counting base64 bytes as prose', async () => {
    const result = await runAgent(
      options({
        contextWindow: 20000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${'A'.repeat(1000000)}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        execute: async () => ({
          result: { content: [] },
          completion: { valid: true },
        }),
      }),
    )
    expect(result.status).toBe('completed')
  })
})
