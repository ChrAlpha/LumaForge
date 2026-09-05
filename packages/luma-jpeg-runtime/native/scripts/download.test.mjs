// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { downloadToFile, isRetryableStatus } from './download.mjs'

let server
let base
let flakyHits = 0
const openResponses = new Set()

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('hello fixture')
      return
    }
    if (request.url === '/flaky') {
      flakyHits += 1
      if (flakyHits === 1) {
        response.writeHead(503)
        response.end('busy')
        return
      }
      response.writeHead(200)
      response.end('recovered')
      return
    }
    if (request.url === '/slow') {
      openResponses.add(response)
      return
    }
    response.writeHead(404)
    response.end('missing')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

let dir
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lmfg-download-'))
  flakyHits = 0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  for (const response of openResponses) response.destroy()
  await new Promise((resolve) => server.close(resolve))
})

const noSleep = async () => {}

describe('downloadToFile', () => {
  it('downloads the first url on success', async () => {
    const destination = path.join(dir, 'a.bin')
    const result = await downloadToFile({ urls: [`${base}/ok`], destination, sleep: noSleep })
    expect(result).toEqual({ url: `${base}/ok`, attempt: 1 })
    expect(await readFile(destination, 'utf8')).toBe('hello fixture')
    expect(await readdir(dir)).toEqual(['a.bin'])
  })

  it('retries retryable statuses with backoff', async () => {
    const destination = path.join(dir, 'b.bin')
    const sleeps = []
    const result = await downloadToFile({
      urls: [`${base}/flaky`],
      destination,
      attempts: 3,
      backoffMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(result.attempt).toBe(2)
    expect(sleeps).toEqual([10])
    expect(await readFile(destination, 'utf8')).toBe('recovered')
  })

  it('falls through to a mirror when the primary is missing', async () => {
    const destination = path.join(dir, 'c.bin')
    const log = []
    const result = await downloadToFile({
      urls: [`${base}/missing`, `${base}/ok`],
      destination,
      attempts: 3,
      sleep: noSleep,
      log: (line) => log.push(line),
    })
    expect(result).toEqual({ url: `${base}/ok`, attempt: 1 })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/404/)
  })

  it('reports every failed attempt and leaves no temp file', async () => {
    const destination = path.join(dir, 'd.bin')
    await expect(
      downloadToFile({
        urls: [`${base}/missing`, `${base}/flaky-never`],
        destination,
        attempts: 2,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Failed to download .*d\.bin from 2 source\(s\)[\s\S]*404/)
    expect(await readdir(dir)).toEqual([])
  })

  it('honours the timeout', async () => {
    const destination = path.join(dir, 'e.bin')
    await expect(
      downloadToFile({ urls: [`${base}/slow`], destination, attempts: 1, timeoutMs: 100, sleep: noSleep }),
    ).rejects.toThrow(/timed out after 100ms/)
  })

  it('classifies retryable statuses', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
  })
})
