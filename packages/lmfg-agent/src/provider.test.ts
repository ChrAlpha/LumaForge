import { Buffer } from 'node:buffer'
import type { RequestListener } from 'node:http'
import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createProvider, ProviderResponseError, redact } from './provider.js'
import type { ProviderConfig } from './types.js'

async function endpoint(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const defaults: Omit<ProviderConfig, 'baseUrl'> = {
  apiKey: 'test-private-key',
  model: 'grok-4.6',
  reasoningEffort: 'high',
  maxOutputTokens: 8192,
  timeoutMs: 1000,
}

describe('vision provider protocol', () => {
  it('sends high effort, exact image and tool schemas and preserves usage', async () => {
    let observed: Record<string, unknown> = {}
    let authorization: string | undefined
    const service = await endpoint(async (req, res) => {
      authorization = req.headers.authorization
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      observed = JSON.parse(Buffer.concat(chunks).toString())
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'response-1',
          model: 'grok-4.6-build',
          usage: {
            prompt_tokens: 120,
            completion_tokens: 20,
            total_tokens: 190,
            completion_tokens_details: { reasoning_tokens: 50 },
          },
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'view', arguments: '{"id":"candidate"}' },
                  },
                ],
              },
            },
          ],
        }),
      )
    })
    try {
      const image = {
        type: 'image_url' as const,
        image_url: {
          url: 'data:image/jpeg;base64,/9j/',
          detail: 'high' as const,
        },
      }
      const response = await createProvider({
        ...defaults,
        baseUrl: service.baseUrl,
      })({ messages: [{ role: 'user', content: [image] }], tools: [] })
      expect(authorization).toBe('Bearer test-private-key')
      expect(observed).toMatchObject({
        model: 'grok-4.6',
        reasoning_effort: 'high',
        max_tokens: 8192,
        messages: [{ role: 'user', content: [image] }],
        tool_choice: 'auto',
        stream: false,
      })
      expect(response.message.tool_calls?.[0].id).toBe('call-1')
      expect(response.usage.total_tokens).toBe(190)
      expect(response.model).toBe('grok-4.6-build')
    } finally {
      await service.close()
    }
  })

  it.each([
    'required',
    { type: 'function', function: { name: 'submit_comparison' } },
  ] as const)(
    'sends an explicit tool choice through the HTTP protocol: %j',
    async (toolChoice) => {
      let observed: Record<string, unknown> = {}
      const service = await endpoint(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        observed = JSON.parse(Buffer.concat(chunks).toString())
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: null } }],
          }),
        )
      })
      try {
        const tools = [
          {
            type: 'function' as const,
            function: {
              name: 'submit_comparison',
              description: 'Submit the visual comparison.',
              parameters: { type: 'object' },
            },
          },
        ]
        await createProvider({ ...defaults, baseUrl: service.baseUrl })({
          messages: [],
          tools,
          toolChoice,
        })
        expect(observed.tool_choice).toEqual(toolChoice)
        expect(observed.tools).toEqual(tools)
      } finally {
        await service.close()
      }
    },
  )

  it('does not follow redirects with credentials or retry ambiguous requests', async () => {
    let requests = 0
    const service = await endpoint((_req, res) => {
      requests += 1
      res.writeHead(307, { Location: '/steal' })
      res.end('test-private-key')
    })
    try {
      await expect(
        createProvider({ ...defaults, baseUrl: service.baseUrl })({
          messages: [],
          tools: [],
        }),
      ).rejects.toThrow('307')
      expect(requests).toBe(1)
    } finally {
      await service.close()
    }
  })

  it('rejects malformed tool responses and redacts secrets and image payloads', async () => {
    const service = await endpoint((_req, res) =>
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { tool_calls: [{ id: 'a' }] },
            },
          ],
        }),
      ),
    )
    try {
      await expect(
        createProvider({ ...defaults, baseUrl: service.baseUrl })({
          messages: [],
          tools: [],
        }),
      ).rejects.toThrow('Malformed')
      const safe = JSON.stringify(
        redact(
          {
            message: 'test-private-key Bearer other-private-value',
            image: 'data:image/jpeg;base64,/9j/',
          },
          defaults.apiKey,
        ),
      )
      expect(safe).not.toContain(defaults.apiKey)
      expect(safe).not.toContain('other-private-value')
      expect(safe).not.toContain('/9j/')
      expect(safe).toContain('sha256')
    } finally {
      await service.close()
    }
  })

  it.each(['schema', 'duplicate', 'missing'])(
    'retains the received usage and identity when %s tool validation fails',
    async (failure) => {
      const call = {
        id: 'call-1',
        type: 'function',
        function: { name: 'view', arguments: '{}' },
      }
      const receipt = {
        id: 'receipt-known',
        model: 'grok-4.6-build',
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }
      let requests = 0
      const service = await endpoint((_req, res) => {
        requests += 1
        res.end(
          JSON.stringify({
            ...receipt,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: 'private-response-body',
                  reasoning_content: 'private-reasoning',
                  tool_calls:
                    failure === 'schema'
                      ? [{ id: 'broken' }]
                      : failure === 'duplicate'
                        ? [call, call]
                        : [],
                },
              },
            ],
          }),
        )
      })
      try {
        const error = await createProvider({
          ...defaults,
          baseUrl: service.baseUrl,
        })({ messages: [], tools: [] }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(ProviderResponseError)
        expect((error as ProviderResponseError).receipt).toEqual(receipt)
        const serialized = JSON.stringify(error)
        expect(serialized).not.toContain('private-response-body')
        expect(serialized).not.toContain('private-reasoning')
        expect(requests).toBe(1)
      } finally {
        await service.close()
      }
    },
  )

  it('limits failure receipts to redacted identifiers and finite numeric usage', async () => {
    const service = await endpoint((_req, res) => {
      res.end(
        JSON.stringify({
          id: `receipt-${defaults.apiKey}`,
          model: 'grok-4.6',
          usage: {
            prompt_tokens: 123,
            total_tokens: 'NONFINITE_NUMBER',
            api_key: defaults.apiKey,
            authorization: 99,
            [defaults.apiKey]: 99,
            reasoning_content: 'private-reasoning',
            completion_tokens_details: { reasoning_tokens: 30 },
            unexpected: ['private-response-body'],
            nested: { a: { b: { c: { private_payload: 99 } } } },
            ...Object.fromEntries(
              Array.from({ length: 100 }, (_, index) => [
                `counter_${index}`,
                index,
              ]),
            ),
          },
          choices: [],
        }).replace('"NONFINITE_NUMBER"', '1e999'),
      )
    })
    try {
      const error = await createProvider({
        ...defaults,
        baseUrl: service.baseUrl,
      })({ messages: [], tools: [] }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ProviderResponseError)
      const receipt = (error as ProviderResponseError).receipt
      expect(receipt.id).toBe('receipt-[REDACTED]')
      expect(receipt.usage).toMatchObject({
        prompt_tokens: 123,
        completion_tokens_details: { reasoning_tokens: 30 },
      })
      expect(receipt.usage).not.toHaveProperty('total_tokens')
      expect(receipt.usage).not.toHaveProperty('authorization')
      expect(Object.keys(receipt.usage ?? {}).length).toBeLessThanOrEqual(64)
      const serialized = JSON.stringify(error)
      for (const forbidden of [
        defaults.apiKey,
        'private-reasoning',
        'private-response-body',
        'private_payload',
      ])
        expect(serialized).not.toContain(forbidden)
    } finally {
      await service.close()
    }
  })

  it('keeps absent receipt fields unknown on unreadable HTTP 200 JSON', async () => {
    const service = await endpoint((_req, res) =>
      res.end('not-json-private-response-body'),
    )
    try {
      const error = await createProvider({
        ...defaults,
        baseUrl: service.baseUrl,
      })({ messages: [], tools: [] }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ProviderResponseError)
      expect((error as ProviderResponseError).receipt).toEqual({
        id: null,
        model: null,
        usage: null,
      })
      expect(JSON.stringify(error)).not.toContain('private-response-body')
    } finally {
      await service.close()
    }
  })
})
