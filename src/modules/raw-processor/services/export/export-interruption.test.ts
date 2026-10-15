import { describe, expect, it } from 'vitest'

import { createFakeLocks } from '../../test-support/web-locks'
import type {
  ExportInterruptionEnvironment,
  ExportInterruptionHint,
  SourceInterruptionHint,
} from './export-interruption'
import {
  classifyExportAttemptOutcome,
  createExportInterruptionMarkers,
  encodeExportSourceHint,
  EXPORT_INTERRUPTION_MARKER_LIMIT,
  EXPORT_INTERRUPTION_MARKER_TTL_MS,
  interruptionForSource,
  isInterruptedSource,
  readSourceInterruption,
} from './export-interruption'

const KEY_PREFIX = 'lumaforge.export-interruption.v1.'

type StorageLike = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

/** A localStorage shared by every page of one origin. */
function createMemoryStorage() {
  const entries = new Map<string, string>()
  const storage: StorageLike & { entries: Map<string, string> } = {
    entries,
    get length() {
      return entries.size
    },
    key: (index) => Array.from(entries.keys())[index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, String(value))
    },
    removeItem: (key) => {
      entries.delete(key)
    },
  }
  return storage
}

const OWNER_LOCK_PREFIX = 'lumaforge-export-attempt-owner:'

const RAW = { name: 'frame.RAF', size: 42_000_000, lastModified: 1_700_000 }

function createPage(
  page: string,
  shared: {
    storage: StorageLike
    locks?: ReturnType<typeof createFakeLocks> | null
    now?: () => number
  },
  overrides: Partial<ExportInterruptionEnvironment> = {},
) {
  let attempts = 0
  return createExportInterruptionMarkers({
    getStorage: () => shared.storage as Storage,
    getLocks: () => (shared.locks ? shared.locks.forPage(page) : null),
    createId: (kind) =>
      kind === 'owner' ? page : `${page}-attempt-${++attempts}`,
    now: shared.now ?? (() => 1_000_000),
    ...overrides,
  })
}

function storedMarkers(storage: ReturnType<typeof createMemoryStorage>) {
  return Array.from(storage.entries.entries())
    .filter(([key]) => key.startsWith(KEY_PREFIX))
    .map(([, value]) => JSON.parse(value) as Record<string, unknown>)
}

describe('encodeExportSourceHint', () => {
  it('encodes name, size and lastModified deterministically', () => {
    expect(encodeExportSourceHint(RAW)).toBe(encodeExportSourceHint({ ...RAW }))
    expect(encodeExportSourceHint(RAW)).toBe('["frame.RAF",42000000,1700000]')
  })

  it('keeps tuples apart that a delimiter join would merge', () => {
    const left = encodeExportSourceHint({
      name: 'a",1,"b',
      size: 1,
      lastModified: 2,
    })
    const right = encodeExportSourceHint({
      name: 'a',
      size: 1,
      lastModified: 2,
    })
    expect(left).not.toBe(right)
  })

  it('refuses a tuple it cannot encode exactly', () => {
    expect(encodeExportSourceHint({ ...RAW, size: Number.NaN })).toBeNull()
    expect(encodeExportSourceHint({ ...RAW, lastModified: 1.5 })).toBeNull()
    expect(encodeExportSourceHint({ ...RAW, size: -1 })).toBeNull()
  })
})

describe('createExportInterruptionMarkers', () => {
  it('stores no graph, LUT, geometry or rows, only the hint fields', async () => {
    const storage = createMemoryStorage()
    const page = createPage('page-a', { storage, locks: createFakeLocks() })

    const attempt = await page.begin(RAW)

    expect(attempt).toEqual({ attempt: 'page-a-attempt-1', stored: true })
    expect(storedMarkers(storage)).toEqual([
      {
        version: 1,
        attempt: 'page-a-attempt-1',
        owner: 'page-a',
        ownerLocked: true,
        source: '["frame.RAF",42000000,1700000]',
        startedAt: 1_000_000,
        updatedAt: 1_000_000,
        terminal: null,
      },
    ])
    expect(Array.from(storage.entries.keys())).toEqual([
      `${KEY_PREFIX}page-a-attempt-1`,
    ])
  })

  it('reports a closed page’s unfinished attempt on the matching source only', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    const crashed = createPage('page-a', { storage, locks })
    await crashed.begin(RAW)
    locks.closePage('page-a')

    const next = createPage('page-b', { storage, locks })

    expect(await next.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: true,
      previousResourceFailure: false,
      attempts: ['page-a-attempt-1'],
    })
    expect(
      await next.inspect({ ...RAW, lastModified: RAW.lastModified + 1 }),
    ).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: false,
      attempts: [],
    })
    expect(await next.inspect({ ...RAW, name: 'other.RAF' })).toMatchObject({
      previousCrashLikeInterruption: false,
    })
  })

  it('treats a colliding tuple as the same locate hint, never as content identity', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    await createPage('page-a', { storage, locks }).begin(RAW)
    locks.closePage('page-a')

    // A different file that shares name, size and lastModified gets the same
    // safer-plan hint; nothing about its content is asserted or reused.
    const sameTuple = new File(['different bytes'], RAW.name, {
      lastModified: RAW.lastModified,
    })
    Object.defineProperty(sameTuple, 'size', { value: RAW.size })

    const hint = await createPage('page-b', { storage, locks }).inspect(
      sameTuple,
    )
    expect(hint.previousCrashLikeInterruption).toBe(true)
    expect(Object.keys(hint).sort()).toEqual([
      'attempts',
      'previousCrashLikeInterruption',
      'previousResourceFailure',
    ])
  })

  it('never calls a live page’s running attempt a crash', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    await createPage('page-a', { storage, locks }).begin(RAW)

    const other = createPage('page-b', { storage, locks })

    expect(await other.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: false,
      attempts: [],
    })
    expect(locks.probes).toEqual(['lumaforge-export-attempt-owner:page-a'])
  })

  it('never calls this page’s own unfinished attempt a crash', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    const page = createPage('page-a', { storage, locks })
    await page.begin(RAW)

    expect((await page.inspect(RAW)).previousCrashLikeInterruption).toBe(false)
    expect(locks.probes).toEqual([])
  })

  it('cannot confirm a page ended without Web Locks, so asserts no crash', async () => {
    const storage = createMemoryStorage()
    const lockless = createPage('page-a', { storage, locks: null })
    expect(await lockless.begin(RAW)).toEqual({
      attempt: 'page-a-attempt-1',
      stored: true,
    })
    expect(storedMarkers(storage)[0]).toMatchObject({ ownerLocked: false })

    const locks = createFakeLocks()
    const other = createPage('page-b', { storage, locks })

    // The owner never held a lock, so a granted probe proves nothing.
    expect((await other.inspect(RAW)).previousCrashLikeInterruption).toBe(false)
    expect(locks.probes).toEqual([])
    expect(
      (await createPage('page-c', { storage, locks: null }).inspect(RAW))
        .previousCrashLikeInterruption,
    ).toBe(false)
  })

  it.each(['completed', 'cancelled', 'resource-failure'] as const)(
    'makes no crash claim when the owner ends %s before the probe is granted',
    async (outcome) => {
      const storage = createMemoryStorage()
      const locks = createFakeLocks()
      const owner = createPage('page-a', { storage, locks })
      const { attempt } = await owner.begin(RAW)

      let grantProbe!: () => void
      const probeGate = new Promise<void>((resolve) => {
        grantProbe = resolve
      })
      let probeWaiting!: () => void
      const probeStarted = new Promise<void>((resolve) => {
        probeWaiting = resolve
      })
      const other = createPage(
        'page-b',
        { storage, locks },
        {
          getLocks: () =>
            ({
              request: async (
                name: string,
                options: LockOptions,
                callback: LockGrantedCallback<unknown>,
              ) => {
                if (name !== `${OWNER_LOCK_PREFIX}page-b`) {
                  probeWaiting()
                  await probeGate
                }
                return locks
                  .forPage('page-b')
                  .request(name, options, callback as never)
              },
            }) as unknown as Pick<LockManager, 'request'>,
        },
      )

      // The reader lists the running marker, then waits on the owner lock
      // while the owner ends the attempt and closes.
      const pending = other.inspect(RAW)
      await probeStarted
      owner.finish(attempt, outcome)
      locks.closePage('page-a')
      grantProbe()

      expect(await pending).toEqual(
        outcome === 'resource-failure'
          ? {
              previousCrashLikeInterruption: false,
              previousResourceFailure: true,
              attempts: [attempt],
            }
          : {
              previousCrashLikeInterruption: false,
              previousResourceFailure: false,
              attempts: [],
            },
      )
    },
  )

  it('makes no crash claim when the marker cannot be read back after the probe', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    await createPage('page-a', { storage, locks }).begin(RAW)
    locks.closePage('page-a')

    let probed = false
    const other = createPage(
      'page-b',
      { storage, locks },
      {
        getLocks: () =>
          ({
            request: async (
              name: string,
              options: LockOptions,
              callback: LockGrantedCallback<unknown>,
            ) => {
              const result = await locks
                .forPage('page-b')
                .request(name, options, callback as never)
              if (name !== `${OWNER_LOCK_PREFIX}page-b`) probed = true
              return result
            },
          }) as unknown as Pick<LockManager, 'request'>,
        getStorage: () =>
          ({
            get length() {
              return storage.length
            },
            key: (index: number) => storage.key(index),
            getItem: (key: string) => {
              if (probed) throw new DOMException('denied', 'SecurityError')
              return storage.getItem(key)
            },
            setItem: (key: string, value: string) =>
              storage.setItem(key, value),
            removeItem: (key: string) => storage.removeItem(key),
          }) as unknown as Storage,
      },
    )

    expect(await other.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: false,
      attempts: [],
    })
    expect(probed).toBe(true)
  })

  it('keeps no crash claim when the lock probe itself fails', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    await createPage('page-a', { storage, locks }).begin(RAW)
    locks.closePage('page-a')

    const other = createPage(
      'page-b',
      { storage, locks },
      {
        getLocks: () =>
          ({
            request: () => Promise.reject(new Error('SecurityError')),
          }) as unknown as LockManager,
      },
    )

    expect((await other.inspect(RAW)).previousCrashLikeInterruption).toBe(false)
  })

  it('stores each attempt separately so two pages never lose each other’s records', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    const pageA = createPage('page-a', { storage, locks })
    const pageB = createPage('page-b', { storage, locks })

    await Promise.all([pageA.begin(RAW), pageB.begin(RAW)])
    await pageA.begin(RAW)

    expect(storedMarkers(storage).map(({ attempt }) => attempt)).toEqual([
      'page-a-attempt-1',
      'page-b-attempt-1',
      'page-a-attempt-2',
    ])

    locks.closePage('page-a')
    const pageC = createPage('page-c', { storage, locks })
    expect(await pageC.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: true,
      previousResourceFailure: false,
      attempts: ['page-a-attempt-1', 'page-a-attempt-2'],
    })
  })

  it('lets an older attempt’s completion remove only its own marker', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    const page = createPage('page-a', { storage, locks })
    const older = await page.begin(RAW)
    const newer = await page.begin(RAW)

    page.finish(older.attempt, 'completed')

    expect(storedMarkers(storage).map(({ attempt }) => attempt)).toEqual([
      newer.attempt,
    ])
  })

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'removes the marker of an attempt that ended %s',
    async (outcome) => {
      const storage = createMemoryStorage()
      const locks = createFakeLocks()
      const page = createPage('page-a', { storage, locks })
      const { attempt } = await page.begin(RAW)

      page.finish(attempt, outcome)
      locks.closePage('page-a')

      expect(storedMarkers(storage)).toEqual([])
      expect(
        await createPage('page-b', { storage, locks }).inspect(RAW),
      ).toEqual({
        previousCrashLikeInterruption: false,
        previousResourceFailure: false,
        attempts: [],
      })
    },
  )

  it('keeps a resource failure as a terminal hint, not a crash', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    let now = 1_000_000
    const page = createPage('page-a', { storage, locks, now: () => now })
    const { attempt } = await page.begin(RAW)
    now += 5_000

    page.finish(attempt, 'resource-failure')

    expect(storedMarkers(storage)).toEqual([
      expect.objectContaining({
        attempt,
        terminal: 'resource-failure',
        startedAt: 1_000_000,
        updatedAt: 1_005_000,
      }),
    ])
    // Its own page may read it immediately; it is no longer running.
    expect(await page.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
      attempts: [attempt],
    })
    // A terminal marker needs no liveness probe.
    expect(locks.probes).toEqual([])
  })

  it('retires exactly the attempts it is given', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    await createPage('page-a', { storage, locks }).begin(RAW)
    locks.closePage('page-a')
    const page = createPage('page-b', { storage, locks })
    const hint = await page.inspect(RAW)
    const running = await page.begin(RAW)

    page.retire(hint.attempts)

    expect(storedMarkers(storage).map(({ attempt }) => attempt)).toEqual([
      running.attempt,
    ])
  })

  it('ignores and prunes markers past their lifetime', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    let now = 1_000_000
    const shared = { storage, locks, now: () => now }
    await createPage('page-a', shared).begin(RAW)
    locks.closePage('page-a')

    now += EXPORT_INTERRUPTION_MARKER_TTL_MS + 1
    const page = createPage('page-b', shared)
    expect((await page.inspect(RAW)).previousCrashLikeInterruption).toBe(false)

    await page.begin({ ...RAW, name: 'other.RAF' })
    expect(storedMarkers(storage).map(({ attempt }) => attempt)).toEqual([
      'page-b-attempt-1',
    ])
  })

  it('ignores a marker stamped implausibly far in the future', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    let now = 1_000_000 + EXPORT_INTERRUPTION_MARKER_TTL_MS * 2
    const shared = { storage, locks, now: () => now }
    await createPage('page-a', shared).begin(RAW)
    locks.closePage('page-a')

    now = 1_000_000
    expect(
      (await createPage('page-b', shared).inspect(RAW))
        .previousCrashLikeInterruption,
    ).toBe(false)
  })

  it('keeps at most the newest markers when pages keep starting exports', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    let now = 1_000_000
    const page = createPage('page-a', { storage, locks, now: () => now })

    for (let index = 0; index < EXPORT_INTERRUPTION_MARKER_LIMIT + 3; index++) {
      now += 1
      await page.begin(RAW)
    }

    const attempts = storedMarkers(storage).map(({ attempt }) => attempt)
    expect(attempts).toHaveLength(EXPORT_INTERRUPTION_MARKER_LIMIT)
    expect(attempts).toContain(
      `page-a-attempt-${EXPORT_INTERRUPTION_MARKER_LIMIT + 3}`,
    )
    expect(attempts).not.toContain('page-a-attempt-1')
  })

  it('drops terminal markers before running ones when over the limit', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    let now = 1_000_000
    const page = createPage('page-a', { storage, locks, now: () => now })
    const { attempt: failed } = await page.begin(RAW)
    page.finish(failed, 'resource-failure')

    for (let index = 0; index < EXPORT_INTERRUPTION_MARKER_LIMIT; index++) {
      now += 1
      await page.begin(RAW)
    }

    const attempts = storedMarkers(storage).map(({ attempt }) => attempt)
    expect(attempts).toHaveLength(EXPORT_INTERRUPTION_MARKER_LIMIT)
    expect(attempts).not.toContain(failed)
    expect(attempts).toContain('page-a-attempt-2')
  })

  it('bounds lock probes to the marker limit', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    for (let index = 0; index < EXPORT_INTERRUPTION_MARKER_LIMIT + 4; index++) {
      const marker = {
        version: 1,
        attempt: `foreign-${index}`,
        owner: `owner-${index}`,
        ownerLocked: true,
        source: encodeExportSourceHint(RAW),
        startedAt: 1_000_000 - index,
        updatedAt: 1_000_000 - index,
        terminal: null,
      }
      storage.setItem(`${KEY_PREFIX}foreign-${index}`, JSON.stringify(marker))
    }

    const hint = await createPage('page-b', { storage, locks }).inspect(RAW)

    expect(locks.probes).toHaveLength(EXPORT_INTERRUPTION_MARKER_LIMIT)
    expect(hint.attempts).toHaveLength(EXPORT_INTERRUPTION_MARKER_LIMIT)
    expect(hint.attempts).not.toContain(
      `foreign-${EXPORT_INTERRUPTION_MARKER_LIMIT + 3}`,
    )
  })

  it('skips and prunes malformed markers without touching other keys', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    storage.setItem(`${KEY_PREFIX}broken`, '{not json')
    storage.setItem(
      `${KEY_PREFIX}mismatch`,
      JSON.stringify({ version: 1, attempt: 'other-key' }),
    )
    storage.setItem(
      `${KEY_PREFIX}future-version`,
      JSON.stringify({ version: 2, attempt: 'future-version' }),
    )
    storage.setItem('lumaforge.unrelated', 'keep me')
    const page = createPage('page-a', { storage, locks })

    expect(await page.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: false,
      attempts: [],
    })

    await page.begin(RAW)
    expect(Array.from(storage.entries.keys()).sort()).toEqual([
      `${KEY_PREFIX}page-a-attempt-1`,
      'lumaforge.unrelated',
    ])
  })

  it('never blocks an export when storage is denied', async () => {
    const denied = createPage(
      'page-a',
      { storage: createMemoryStorage(), locks: createFakeLocks() },
      {
        getStorage: () => {
          throw new DOMException('denied', 'SecurityError')
        },
      },
    )

    const attempt = await denied.begin(RAW)
    expect(attempt).toEqual({ attempt: 'page-a-attempt-1', stored: false })
    expect(() =>
      denied.finish(attempt.attempt, 'resource-failure'),
    ).not.toThrow()
    expect(() => denied.retire([attempt.attempt])).not.toThrow()
    expect(await denied.inspect(RAW)).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: false,
      attempts: [],
    })
  })

  it('never blocks an export when a write or read throws', async () => {
    const storage = createMemoryStorage()
    const throwing: StorageLike = {
      get length(): number {
        throw new DOMException('denied', 'SecurityError')
      },
      key: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    const page = createPage('page-a', {
      storage: throwing,
      locks: createFakeLocks(),
    })

    expect(await page.begin(RAW)).toEqual({
      attempt: 'page-a-attempt-1',
      stored: false,
    })
    expect(() => page.finish('page-a-attempt-1', 'completed')).not.toThrow()
    expect((await page.inspect(RAW)).attempts).toEqual([])
    expect(storage.entries.size).toBe(0)
  })

  it('stores nothing for a source it cannot encode, and still returns an attempt', async () => {
    const storage = createMemoryStorage()
    const page = createPage('page-a', { storage, locks: createFakeLocks() })

    expect(await page.begin({ ...RAW, size: Number.NaN })).toEqual({
      attempt: 'page-a-attempt-1',
      stored: false,
    })
    expect(storage.entries.size).toBe(0)
  })

  it('holds the owner lock before any marker names the owner', async () => {
    const storage = createMemoryStorage()
    const locks = createFakeLocks()
    const order: string[] = []
    const page = createPage(
      'page-a',
      { storage, locks },
      {
        getLocks: () =>
          ({
            request: (
              name: string,
              options: LockOptions,
              callback: LockGrantedCallback<unknown>,
            ) => {
              order.push(`lock:${name}`)
              return locks
                .forPage('page-a')
                .request(name, options, callback as never)
            },
          }) as unknown as Pick<LockManager, 'request'>,
        getStorage: () =>
          ({
            ...storage,
            get length() {
              return storage.length
            },
            setItem: (key: string, value: string) => {
              order.push(`write:${key}`)
              storage.setItem(key, value)
            },
          }) as unknown as Storage,
      },
    )

    await page.begin(RAW)
    await page.begin(RAW)

    expect(order).toEqual([
      'lock:lumaforge-export-attempt-owner:page-a',
      `write:${KEY_PREFIX}page-a-attempt-1`,
      `write:${KEY_PREFIX}page-a-attempt-2`,
    ])
  })
})

describe('source-scoped interruption hints', () => {
  const SOURCE = new File(['raw'], 'frame.RAF', { lastModified: 123 })
  const OTHER_SOURCE = new File(['other raw'], 'other.RAF', {
    lastModified: 456,
  })

  function hintFor(
    file: File,
    hint: ExportInterruptionHint = {
      previousCrashLikeInterruption: true,
      previousResourceFailure: false,
      attempts: ['attempt-a'],
    },
  ): SourceInterruptionHint {
    const source = encodeExportSourceHint(file)
    if (source === null) throw new Error('Expected an encodable file tuple.')
    return { source, hint }
  }

  it('applies a hint only to the file tuple it was read for', () => {
    const interruption = hintFor(SOURCE)

    expect(interruptionForSource(interruption, SOURCE)).toBe(interruption.hint)
    // The same tuple on a fresh File object is the same hint location.
    expect(
      interruptionForSource(
        interruption,
        new File(['raw'], 'frame.RAF', { lastModified: 123 }),
      ),
    ).toBe(interruption.hint)
    expect(interruptionForSource(interruption, OTHER_SOURCE)).toBeNull()
    expect(
      interruptionForSource(
        interruption,
        new File(['raw'], 'frame.RAF', { lastModified: 124 }),
      ),
    ).toBeNull()
    expect(interruptionForSource(interruption, null)).toBeNull()
    expect(interruptionForSource(null, SOURCE)).toBeNull()
    expect(
      interruptionForSource(
        hintFor(SOURCE, {
          previousCrashLikeInterruption: false,
          previousResourceFailure: false,
          attempts: [],
        }),
        SOURCE,
      ),
    ).toBeNull()
  })

  it('notes only a crash-like interruption, keeping a resource failure for the plan', () => {
    const crash = hintFor(SOURCE)
    expect(isInterruptedSource(crash, SOURCE)).toBe(true)
    expect(isInterruptedSource(crash, OTHER_SOURCE)).toBe(false)
    expect(isInterruptedSource(null, SOURCE)).toBe(false)

    const failure = hintFor(SOURCE, {
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
      attempts: ['attempt-failed'],
    })
    expect(isInterruptedSource(failure, SOURCE)).toBe(false)
    expect(interruptionForSource(failure, SOURCE)).toBe(failure.hint)
  })

  it('reads a source hint from the markers without starting anything', async () => {
    const markers = createPage('page-a', { storage: createMemoryStorage() })

    await expect(readSourceInterruption(markers, SOURCE)).resolves.toBeNull()

    const { attempt } = await markers.begin(SOURCE)
    markers.finish(attempt, 'resource-failure')

    await expect(readSourceInterruption(markers, SOURCE)).resolves.toEqual({
      source: encodeExportSourceHint(SOURCE),
      hint: {
        previousCrashLikeInterruption: false,
        previousResourceFailure: true,
        attempts: [attempt],
      },
    })
    await expect(
      readSourceInterruption(markers, OTHER_SOURCE),
    ).resolves.toBeNull()
  })

  it.each([
    [
      { aborted: true, errorCode: 'FULL_RES_EXPORT_RESOURCE_FAILURE' },
      'cancelled',
    ],
    [
      {
        aborted: false,
        errorCode: 'EXPORT_RENDER_FAILED',
        error: new DOMException('Aborted', 'AbortError'),
      },
      'cancelled',
    ],
    [{ aborted: false, errorCode: 'EXPORT_ABORTED' }, 'failed'],
    [
      { aborted: false, errorCode: 'FULL_RES_EXPORT_RESOURCE_FAILURE' },
      'resource-failure',
    ],
    [
      { aborted: false, errorCode: 'FULL_RES_EXPORT_WORKER_FAILED' },
      'resource-failure',
    ],
    [{ aborted: false, errorCode: 'EXPORT_RENDER_FAILED' }, 'failed'],
    [{ aborted: false, errorCode: 'EXPORT_POLICY_CANNOT_COMPLETE' }, 'failed'],
  ] as const)('classifies a failed attempt %j as %s', (input, outcome) => {
    expect(classifyExportAttemptOutcome(input)).toBe(outcome)
  })
})
