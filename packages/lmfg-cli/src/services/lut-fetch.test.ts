// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

import { fetchLutFile, isNetworkAllowed } from './lut-fetch'

const CUBE =
  'TITLE "Identity"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
const CUBE_SHA = createHash('sha256').update(CUBE).digest('hex')

let server: Server
let base = ''
const openResponses = new Set<ServerResponse>()

beforeAll(async () => {
  server = createServer((request, response) => {
    switch (request.url) {
      case '/display.cube': {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(CUBE)
        return
      }
      case '/big.cube': {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('x'.repeat(200))
        return
      }
      case '/declared-big.cube': {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': '999999',
        })
        response.end()
        return
      }
      case '/busy.cube': {
        response.writeHead(503)
        response.end('busy')
        return
      }
      case '/slow.cube': {
        openResponses.add(response)
        return
      }
      default: {
        response.writeHead(404)
        response.end('missing')
      }
    }
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const address = server.address()
  base =
    typeof address === 'object' && address
      ? `http://127.0.0.1:${address.port}`
      : ''
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-lut-fetch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  for (const response of openResponses) response.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('isNetworkAllowed', () => {
  it('honours the flag and the environment switch', () => {
    expect(isNetworkAllowed(false, {})).toBe(false)
    expect(isNetworkAllowed(true, {})).toBe(true)
    expect(isNetworkAllowed(undefined, { LMFG_ALLOW_NETWORK: '1' })).toBe(true)
    expect(isNetworkAllowed(undefined, { LMFG_ALLOW_NETWORK: 'true' })).toBe(
      true,
    )
    expect(isNetworkAllowed(undefined, { LMFG_ALLOW_NETWORK: '0' })).toBe(false)
  })
})

describe('fetchLutFile', () => {
  it('refuses network access unless allowed, even before touching the server', async () => {
    await expect(
      fetchLutFile({
        url: `${base}/display.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'a.cube'),
        allowNetwork: false,
      }),
    ).rejects.toMatchObject({ code: 'network.not_allowed', exitCode: 5 })
    expect(await readdir(dir)).toEqual([])
  })

  it('downloads, verifies, writes atomically, then serves from cache without network', async () => {
    const destination = join(dir, 'cache', 'a.cube')
    const first = await fetchLutFile({
      url: `${base}/display.cube`,
      expectedSha256: CUBE_SHA,
      destination,
      allowNetwork: true,
    })
    expect(first).toEqual({
      path: destination,
      url: `${base}/display.cube`,
      sha256: CUBE_SHA,
      byte_size: CUBE.length,
      cached: false,
    })
    expect(await readFile(destination, 'utf8')).toBe(CUBE)
    expect(await readdir(join(dir, 'cache'))).toEqual(['a.cube'])
    const second = await fetchLutFile({
      url: `${base}/display.cube`,
      expectedSha256: CUBE_SHA,
      destination,
      allowNetwork: false,
    })
    expect(second.cached).toBe(true)
  })

  it('rejects hash mismatches without leaving a file behind', async () => {
    const destination = join(dir, 'b.cube')
    await expect(
      fetchLutFile({
        url: `${base}/display.cube`,
        expectedSha256: 'f'.repeat(64),
        destination,
        allowNetwork: true,
      }),
    ).rejects.toMatchObject({
      code: 'hash.mismatch',
      exitCode: 6,
      details: { actual_sha256: CUBE_SHA },
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('re-downloads when a cached file no longer matches', async () => {
    const destination = join(dir, 'stale.cube')
    await writeFile(destination, 'stale')
    const result = await fetchLutFile({
      url: `${base}/display.cube`,
      expectedSha256: CUBE_SHA,
      destination,
      allowNetwork: true,
    })
    expect(result.cached).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe(CUBE)
  })

  it('maps http failures to fetch.failed with retryability by status', async () => {
    await expect(
      fetchLutFile({
        url: `${base}/missing.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'c.cube'),
        allowNetwork: true,
      }),
    ).rejects.toMatchObject({
      code: 'fetch.failed',
      exitCode: 6,
      retryable: false,
      details: { status: 404 },
    })
    await expect(
      fetchLutFile({
        url: `${base}/busy.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'c.cube'),
        allowNetwork: true,
      }),
    ).rejects.toMatchObject({
      code: 'fetch.failed',
      retryable: true,
      details: { status: 503 },
    })
  })

  it('enforces declared and streamed size limits', async () => {
    await expect(
      fetchLutFile({
        url: `${base}/declared-big.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'd.cube'),
        allowNetwork: true,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: 'fetch.failed',
      details: { content_length: 999999 },
    })
    await expect(
      fetchLutFile({
        url: `${base}/big.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'd.cube'),
        allowNetwork: true,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: 'fetch.failed',
      details: { max_bytes: 100 },
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('times out slow servers', async () => {
    await expect(
      fetchLutFile({
        url: `${base}/slow.cube`,
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'e.cube'),
        allowNetwork: true,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'fetch.failed', retryable: true })
  })

  it('validates arguments before any I/O', async () => {
    await expect(
      fetchLutFile({
        url: 'ftp://example/x.cube',
        expectedSha256: CUBE_SHA,
        destination: join(dir, 'f.cube'),
        allowNetwork: true,
      }),
    ).rejects.toMatchObject({ code: 'args.invalid' })
    await expect(
      fetchLutFile({
        url: `${base}/display.cube`,
        expectedSha256: 'nope',
        destination: join(dir, 'f.cube'),
        allowNetwork: true,
      }),
    ).rejects.toMatchObject({ code: 'args.invalid' })
  })
})
