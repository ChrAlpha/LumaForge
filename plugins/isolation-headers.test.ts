import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import type { ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'

import { preserveIsolationHeaders } from '../../plugins/isolation-headers'

describe('isolation headers on cached worker responses', () => {
  it.each(['configureServer', 'configurePreviewServer'] as const)(
    '%s preserves policy on 200 and 304 responses',
    async (hook) => {
      let middleware!: (
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void,
      ) => void
      const policy = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }
      const install = preserveIsolationHeaders(policy)[hook] as (
        server: Pick<ViteDevServer, 'middlewares'>,
      ) => void
      const register = (handler: typeof middleware) => {
        middleware = handler
      }
      install({ middlewares: { use: register } } as unknown as Pick<
        ViteDevServer,
        'middlewares'
      >)
      const server = createServer((request, response) =>
        middleware(request, response, () => {
          response.setHeader('ETag', '"worker"')
          response.statusCode = request.headers['if-none-match'] ? 304 : 200
          response.end()
        }),
      )
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing test server address')
        const url = `http://127.0.0.1:${address.port}/worker.js`
        for (const status of [200, 304]) {
          const response = await fetch(url, {
            headers: status === 304 ? { 'If-None-Match': '"worker"' } : {},
          })
          expect(response.status).toBe(status)
          for (const [name, value] of Object.entries(policy))
            expect(response.headers.get(name)).toBe(value)
          await response.arrayBuffer()
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )
})
