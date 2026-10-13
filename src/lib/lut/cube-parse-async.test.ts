import type { LUTContractSelection } from '@lumaforge/luma-color-runtime'
import { parseCubeLUT as parseCubeLUTWithoutStorage } from '@lumaforge/luma-color-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CubeParseRequest, CubeParseResponse } from './cube-parse.worker'
import { parseCubeLUTOffThread } from './cube-parse-async'
import { parseCubeLUT } from './cube-parser'
import { storeLUTContractSelection } from './profile-resolution'

function cubeText(size: number): string {
  const lines = [`TITLE "Async Fixture"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

const noWorker = () => {
  throw new Error('no worker in this environment')
}

const userVLogContract: LUTContractSelection = {
  role: 'combined-look-output',
  inputProfile: 'panasonic-vgamut-vlog',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'bt709',
  outputRange: 'full',
}

/**
 * Stands in for the module worker, which has no localStorage: it runs the
 * package parser with no stored-profile lookup and replies asynchronously,
 * preceded by a reply addressed to some other request.
 */
function createStoragelessWorker() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  const requests: CubeParseRequest[] = []

  const worker = {
    postMessage: vi.fn((request: CubeParseRequest) => {
      requests.push(request)
      queueMicrotask(() => {
        const { id, source, sourceName } = request
        let response: CubeParseResponse
        try {
          const content =
            typeof source === 'string'
              ? source
              : new TextDecoder().decode(source)
          response = {
            id,
            ok: true,
            parsed: parseCubeLUTWithoutStorage(content, { sourceName }),
          }
        } catch (error) {
          response = { id, ok: false, message: (error as Error).message }
        }
        dispatch('message', {
          data: { id: id + 1000, ok: false, message: 'not this request' },
        })
        dispatch('message', { data: response })
      })
    }),
    terminate: vi.fn(),
    addEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener)
      },
    ),
  }

  return { worker, requests, factory: () => worker as never }
}

describe('parseCubeLUTOffThread', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('matches the synchronous parser when no worker is available', async () => {
    const content = cubeText(17)
    const expected = parseCubeLUT(content, { sourceName: 'fixture.cube' })

    const actual = await parseCubeLUTOffThread(content, {
      sourceName: 'fixture.cube',
      workerFactory: noWorker,
    })

    expect(actual.title).toBe(expected.title)
    expect(actual.size).toBe(expected.size)
    expect(actual.fingerprint).toBe(expected.fingerprint)
    expect(actual.profileResolution).toEqual(expected.profileResolution)
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data))
  })

  it('decodes byte input identically to string input', async () => {
    const content = cubeText(17)
    const bytes = new TextEncoder().encode(content)

    const fromString = await parseCubeLUTOffThread(content, {
      workerFactory: noWorker,
    })
    const fromBytes = await parseCubeLUTOffThread(bytes, {
      workerFactory: noWorker,
    })

    expect(fromBytes.fingerprint).toBe(fromString.fingerprint)
  })

  it('rejects with the parse error from the fallback path', async () => {
    await expect(
      parseCubeLUTOffThread('not a cube', {
        workerFactory: noWorker,
      }),
    ).rejects.toThrow()
  })

  it('falls back to the sync parser when the worker errors after creation', async () => {
    const workerLike = {
      postMessage: vi.fn(() => {
        throw new Error('postMessage exploded')
      }),
      terminate: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }

    const result = await parseCubeLUTOffThread(cubeText(17), {
      workerFactory: () => workerLike as never,
    })

    expect(result.size).toBe(17)
    expect(workerLike.terminate).toHaveBeenCalled()
  })

  it('restores a stored user contract after a storage-free worker parse', async () => {
    const content = cubeText(17)
    const { fingerprint } = parseCubeLUTWithoutStorage(content)
    storeLUTContractSelection(fingerprint, userVLogContract)
    const { worker, requests, factory } = createStoragelessWorker()

    const reloaded = await parseCubeLUTOffThread(content, {
      sourceName: 'renamed.cube',
      workerFactory: factory,
    })

    expect(requests).toEqual([
      { id: expect.any(Number), source: content, sourceName: 'renamed.cube' },
    ])
    expect(reloaded.fingerprint).toBe(fingerprint)
    expect(reloaded.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: {
        id: 'panasonic-vgamut-vlog',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.removeEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    )
  })

  it('rejects worker parse errors without consulting storage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')

    await expect(
      parseCubeLUTOffThread('LUT_3D_SIZE 2\n0 0 0', {
        workerFactory: createStoragelessWorker().factory,
      }),
    ).rejects.toThrow('Invalid .cube file: expected 8 entries, got 1')
    expect(getItem).not.toHaveBeenCalled()
  })
})

describe('cube parse worker', () => {
  afterEach(() => {
    globalThis.onmessage = null
    vi.doUnmock('./profile-resolution')
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('parses and transfers the LUT without loading app profile storage', async () => {
    vi.resetModules()
    vi.doMock('./profile-resolution', () => {
      throw new Error('the parse worker must not load app profile storage')
    })
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)
    const content = cubeText(2)
    const bytes = new TextEncoder().encode(content)

    await import('./cube-parse.worker')
    const onMessage = globalThis.onmessage as unknown as (event: {
      data: CubeParseRequest
    }) => void
    onMessage({ data: { id: 7, source: bytes, sourceName: 'fixture.cube' } })

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [response, transfer] = postMessage.mock.calls[0] as [
      Extract<CubeParseResponse, { ok: true }>,
      Transferable[],
    ]
    expect(response).toMatchObject({ id: 7, ok: true })
    expect(response.parsed.fingerprint).toBe(
      parseCubeLUTWithoutStorage(content, { sourceName: 'fixture.cube' })
        .fingerprint,
    )
    expect(response.parsed.profileResolution).toEqual({ kind: 'unknown' })
    expect(transfer).toEqual([response.parsed.data.buffer])
  })
})
