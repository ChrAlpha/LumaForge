import { materializeOutputBlob } from '@lumaforge/render-engine/export'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExportDebugEvent } from './execution-profile'
import type {
  OpfsOutputCollectionReport,
  OpfsOutputLifetimeEnvironment,
} from './opfs-output-lifetime'
import {
  createOpfsOutputLifetime,
  LEGACY_OPFS_OUTPUT_MAX_AGE_MS,
  OPFS_COLLECTION_ENTRY_BUDGET,
  OPFS_COLLECTION_SCAN_LIMIT,
} from './opfs-output-lifetime'
import {
  createOpfsFileBackedOutputResult,
  createOpfsOutputWritable,
} from './output-sink'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE = '.lumaforge-exports/active'

type MemoryFile = { kind: 'file'; bytes: Uint8Array; lastModified: number }
type MemoryDirectory = {
  kind: 'directory'
  children: Map<string, MemoryFile | MemoryDirectory>
}

function domError(name: string, message = name) {
  return new DOMException(message, name)
}

function toBytes(chunk: unknown) {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  throw new Error('unsupported chunk')
}

/**
 * An in-memory OPFS with real directories, recursive removal, iteration and
 * file timestamps. Paths are relative to the OPFS root.
 */
function createMemoryOpfs(clock: () => number = () => NOW) {
  const root: MemoryDirectory = { kind: 'directory', children: new Map() }
  const failures = {
    getDirectory: null as Error | null,
    list: new Map<string, Error>(),
    read: new Map<string, Error>(),
    remove: new Map<string, Error>(),
  }
  const removals: Array<{ path: string; recursive: boolean }> = []
  const onRemove: Array<(path: string) => void> = []

  function join(path: string, name: string) {
    return path ? `${path}/${name}` : name
  }

  function fileHandle(
    parent: MemoryDirectory,
    path: string,
    name: string,
  ): FileSystemFileHandle {
    return {
      kind: 'file',
      name,
      async getFile() {
        const failure = failures.read.get(path)
        if (failure) throw failure
        const node = parent.children.get(name)
        if (node?.kind !== 'file') throw domError('NotFoundError', path)
        const bytes = node.bytes.slice()
        return {
          name,
          size: bytes.byteLength,
          type: '',
          lastModified: node.lastModified,
          async arrayBuffer() {
            return bytes.slice().buffer
          },
          async text() {
            return new TextDecoder().decode(bytes)
          },
        } as unknown as File
      },
      async createWritable() {
        const chunks: Uint8Array[] = []
        return {
          async write(chunk: unknown) {
            chunks.push(toBytes(chunk).slice())
          },
          async abort() {
            chunks.length = 0
          },
          async close() {
            const length = chunks.reduce((sum, c) => sum + c.byteLength, 0)
            const bytes = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            parent.children.set(name, {
              kind: 'file',
              bytes,
              lastModified: clock(),
            })
          },
        } as unknown as FileSystemWritableFileStream
      },
    } as unknown as FileSystemFileHandle
  }

  function directoryHandle(
    node: MemoryDirectory,
    path: string,
  ): FileSystemDirectoryHandle {
    return {
      kind: 'directory',
      name: path.split('/').at(-1) ?? '',
      async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions,
      ) {
        const existing = node.children.get(name)
        if (existing?.kind === 'directory') {
          return directoryHandle(existing, join(path, name))
        }
        if (existing) throw domError('TypeMismatchError')
        if (!options?.create) {
          throw domError('NotFoundError', join(path, name))
        }
        const created: MemoryDirectory = {
          kind: 'directory',
          children: new Map(),
        }
        node.children.set(name, created)
        return directoryHandle(created, join(path, name))
      },
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        const existing = node.children.get(name)
        if (existing?.kind === 'directory') throw domError('TypeMismatchError')
        if (!existing && !options?.create) {
          throw domError('NotFoundError', join(path, name))
        }
        if (!existing) {
          node.children.set(name, {
            kind: 'file',
            bytes: new Uint8Array(),
            lastModified: clock(),
          })
        }
        return fileHandle(node, join(path, name), name)
      },
      async removeEntry(name: string, options?: FileSystemRemoveOptions) {
        const childPath = join(path, name)
        const failure = failures.remove.get(childPath)
        if (failure) throw failure
        const existing = node.children.get(name)
        if (!existing) throw domError('NotFoundError', childPath)
        if (
          existing.kind === 'directory' &&
          existing.children.size > 0 &&
          !options?.recursive
        ) {
          throw domError('InvalidModificationError', childPath)
        }
        for (const listener of onRemove) listener(childPath)
        removals.push({
          path: childPath,
          recursive: Boolean(options?.recursive),
        })
        node.children.delete(name)
      },
      async *entries() {
        const failure = failures.list.get(path)
        if (failure) throw failure
        // Chromium lists a directory in name order.
        const children = [...node.children].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )
        for (const [name, child] of children) {
          yield [
            name,
            child.kind === 'directory'
              ? directoryHandle(child, join(path, name))
              : fileHandle(node, join(path, name), name),
          ] as [string, FileSystemHandle]
        }
      },
    } as unknown as FileSystemDirectoryHandle
  }

  function resolve(path: string, create: boolean) {
    let node = root
    for (const segment of path.split('/').filter(Boolean)) {
      let next = node.children.get(segment)
      if (!next && create) {
        next = { kind: 'directory', children: new Map() }
        node.children.set(segment, next)
      }
      if (next?.kind !== 'directory') return null
      node = next
    }
    return node
  }

  const getDirectory = vi.fn(async () => {
    if (failures.getDirectory) throw failures.getDirectory
    return directoryHandle(root, '')
  })

  return {
    storage: { getDirectory } as Pick<StorageManager, 'getDirectory'>,
    getDirectory,
    failures,
    removals,
    onRemove,
    writeFile(path: string, content: string, lastModified = NOW) {
      const segments = path.split('/')
      const name = segments.pop()!
      const parent = resolve(segments.join('/'), true)!
      parent.children.set(name, {
        kind: 'file',
        bytes: new TextEncoder().encode(content),
        lastModified,
      })
    },
    makeDirectory(path: string) {
      resolve(path, true)
    },
    exists(path: string) {
      const segments = path.split('/')
      const name = segments.pop()!
      return Boolean(resolve(segments.join('/'), false)?.children.has(name))
    },
    entries(path: string) {
      return [...(resolve(path, false)?.children.keys() ?? [])].sort()
    },
  }
}

type MemoryOpfs = ReturnType<typeof createMemoryOpfs>

/** Exclusive Web Locks with `ifAvailable`; a lock is released when its callback settles. */
function createFakeLockManager() {
  const held = new Set<string>()
  const requests: Array<{ name: string; options: LockOptions }> = []

  const locks = {
    async request(
      name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
      maybeCallback?: LockGrantedCallback<unknown>,
    ) {
      const options =
        typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
      const callback =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : maybeCallback!
      requests.push({ name, options })
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null)
        throw new Error(`fake lock manager does not queue: ${name}`)
      }
      held.add(name)
      try {
        return await callback({
          name,
          mode: options.mode ?? 'exclusive',
        } as Lock)
      } finally {
        held.delete(name)
      }
    },
  }

  return {
    locks: locks as unknown as LockManager,
    held,
    requests,
    /** Another page that is alive and holds its tab lock. */
    holdForAnotherTab(tabId: string) {
      held.add(`lumaforge-export-tab:${tabId}`)
    },
  }
}

type FakeLockManager = ReturnType<typeof createFakeLockManager>

function createLifetime(
  input: {
    opfs?: MemoryOpfs
    lockManager?: FakeLockManager | null
    tabId?: string
    environment?: Partial<OpfsOutputLifetimeEnvironment>
  } = {},
) {
  const opfs = input.opfs ?? createMemoryOpfs()
  const lockManager =
    input.lockManager === undefined
      ? createFakeLockManager()
      : input.lockManager
  const debugEvents: ExportDebugEvent[] = []
  const idleTasks: Array<() => void> = []
  const lifetime = createOpfsOutputLifetime({
    getLocks: () => lockManager?.locks ?? null,
    getStorage: () => opfs.storage,
    createTabId: () => input.tabId ?? 'self',
    now: () => NOW,
    random: () => 0,
    scheduleIdle: (task) => {
      idleTasks.push(task)
    },
    emitDebugEvent: (event) => {
      debugEvents.push(event)
    },
    ...input.environment,
  })

  return { lifetime, opfs, lockManager, debugEvents, idleTasks }
}

function finalizedMarker(finalizedAt: number | string) {
  return JSON.stringify({
    version: 1,
    outputFileName: 'output.jpg',
    byteLength: 3,
    sha256: 'f'.repeat(64),
    finalizedAt:
      typeof finalizedAt === 'number'
        ? new Date(finalizedAt).toISOString()
        : finalizedAt,
  })
}

/** A finished output left directly under `active/` by the pre-tab layout. */
function writeLegacyOutput(
  opfs: MemoryOpfs,
  exportId: string,
  input: { finalizedAt?: number | string; lastModified: number },
) {
  opfs.writeFile(`${ACTIVE}/${exportId}/output.jpg`, 'jpeg', input.lastModified)
  if (input.finalizedAt !== undefined) {
    opfs.writeFile(
      `${ACTIVE}/${exportId}/output.jpg.finalized.json`,
      finalizedMarker(input.finalizedAt),
      input.lastModified,
    )
  }
}

function writeTabOutput(
  opfs: MemoryOpfs,
  tabId: string,
  exportId: string,
  lastModified = NOW,
) {
  opfs.writeFile(
    `${ACTIVE}/tab-${tabId}/${exportId}/output.jpg`,
    'jpeg',
    lastModified,
  )
  opfs.writeFile(
    `${ACTIVE}/tab-${tabId}/${exportId}/output.jpg.finalized.json`,
    finalizedMarker(lastModified),
    lastModified,
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('tab-scoped OPFS outputs', () => {
  it('reserves one tab directory per page once its lock is held for the page lifetime', async () => {
    const { lifetime, lockManager, opfs } = createLifetime({ tabId: 'self' })

    const directory = await lifetime.reserveOutputDirectory()

    expect(directory).toBe('tab-self')
    expect(lockManager?.held.has('lumaforge-export-tab:self')).toBe(true)
    await expect(lifetime.reserveOutputDirectory()).resolves.toBe('tab-self')
    expect(lockManager?.requests).toEqual([
      { name: 'lumaforge-export-tab:self', options: { mode: 'exclusive' } },
    ])

    // The output protocol is unchanged apart from the tab prefix.
    const writable = await createOpfsOutputWritable({
      tabDirectory: directory,
      exportId: 'export-1',
      storage: opfs.storage,
    })
    await writable.write(new Uint8Array([1, 2, 3]))
    await writable.close()

    expect(opfs.entries(ACTIVE)).toEqual(['tab-self'])
    expect(opfs.entries(`${ACTIVE}/tab-self/export-1`)).toEqual([
      'output.jpg',
      'output.jpg.finalized.json',
    ])
    const result = createOpfsFileBackedOutputResult({
      tabDirectory: directory,
      exportId: 'export-1',
      filename: 'frame.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
      storage: opfs.storage,
    })
    await expect(
      (await materializeOutputBlob(result)).arrayBuffer(),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)
  })

  it('writes where no collector looks when the browser has no Web Locks', async () => {
    const { lifetime, debugEvents } = createLifetime({
      tabId: 'self',
      lockManager: null,
    })

    await expect(lifetime.reserveOutputDirectory()).resolves.toBe(
      'untracked-self',
    )
    expect(debugEvents).toEqual([])
  })

  it.each([
    {
      name: 'throws',
      request: () => {
        throw domError('SecurityError')
      },
    },
    {
      name: 'rejects',
      request: () => Promise.reject(domError('AbortError')),
    },
    {
      name: 'cannot be reached',
      getLocks: () => {
        throw new Error('lock accessor exploded')
      },
    },
  ])(
    "keeps a page's outputs from every collector when its tab lock request $name",
    async ({ request, getLocks }) => {
      const opfs = createMemoryOpfs()
      const failing = createLifetime({
        opfs,
        tabId: 'self',
        environment: {
          getLocks: getLocks ?? (() => ({ request }) as unknown as LockManager),
        },
      })

      const directory = await failing.lifetime.reserveOutputDirectory()

      expect(directory).toBe('untracked-self')
      expect(failing.debugEvents).toEqual([
        {
          type: 'opfs-output-tab-lock-failed',
          payload: { message: expect.any(String) },
        },
      ])
      const writable = await createOpfsOutputWritable({
        tabDirectory: directory,
        exportId: 'export-1',
        storage: opfs.storage,
      })
      await writable.write(new Uint8Array([1, 2, 3]))
      await writable.close()

      // Another page with working locks finds no lock held for it.
      const other = createLifetime({ opfs, tabId: 'other' })
      const report = await other.lifetime.collectAbandonedOutputs()

      expect(opfs.entries(`${ACTIVE}/untracked-self/export-1`)).toEqual([
        'output.jpg',
        'output.jpg.finalized.json',
      ])
      expect(other.lockManager?.requests).toEqual([])
      expect(report).toMatchObject({
        scannedEntries: 1,
        examinedEntries: 0,
        removedEntries: [],
        keptEntries: 1,
      })
    },
  )
})

describe('collectAbandonedOutputs', () => {
  it('removes the directory of a closed tab while holding its lock', async () => {
    const { lifetime, opfs, lockManager, debugEvents } = createLifetime()
    writeTabOutput(opfs, 'closed', 'export-1')
    writeTabOutput(opfs, 'closed', 'export-2')
    const heldDuringRemoval: boolean[] = []
    opfs.onRemove.push(() => {
      heldDuringRemoval.push(
        lockManager?.held.has('lumaforge-export-tab:closed') ?? false,
      )
    })

    const report = await lifetime.collectAbandonedOutputs()

    expect(opfs.entries(ACTIVE)).toEqual([])
    expect(opfs.removals).toEqual([
      { path: `${ACTIVE}/tab-closed`, recursive: true },
    ])
    expect(heldDuringRemoval).toEqual([true])
    expect(lockManager?.requests).toEqual([
      { name: 'lumaforge-export-tab:closed', options: { ifAvailable: true } },
    ])
    expect(lockManager?.held.size).toBe(0)
    expect(report).toEqual({
      scannedEntries: 1,
      examinedEntries: 1,
      removedEntries: ['tab-closed'],
      keptEntries: 0,
      skippedEntries: 0,
      truncated: false,
      failures: [],
    })
    expect(debugEvents).toEqual([
      { type: 'opfs-output-collection', payload: report },
    ])
  })

  it("never removes a live tab's outputs, however old, nor its own", async () => {
    const { lifetime, opfs, lockManager } = createLifetime({ tabId: 'self' })
    const ownDirectory = await lifetime.reserveOutputDirectory()
    writeTabOutput(opfs, 'self', 'export-own', NOW - 30 * DAY_MS)
    writeTabOutput(opfs, 'live', 'export-live', NOW - 30 * DAY_MS)
    lockManager?.holdForAnotherTab('live')

    const report = await lifetime.collectAbandonedOutputs()

    expect(ownDirectory).toBe('tab-self')
    expect(opfs.entries(ACTIVE)).toEqual(['tab-live', 'tab-self'])
    expect(opfs.removals).toEqual([])
    // Its own directory is never even probed.
    expect(lockManager?.requests.map(({ name }) => name)).toEqual([
      'lumaforge-export-tab:self',
      'lumaforge-export-tab:live',
    ])
    expect(lockManager?.held.has('lumaforge-export-tab:live')).toBe(true)
    expect(lockManager?.held.has('lumaforge-export-tab:self')).toBe(true)
    expect(report).toMatchObject({
      scannedEntries: 2,
      examinedEntries: 1,
      removedEntries: [],
      keptEntries: 2,
      skippedEntries: 0,
    })
  })

  it('removes pre-tab outputs only once they are older than seven days', async () => {
    const { lifetime, opfs } = createLifetime()
    const old = NOW - LEGACY_OPFS_OUTPUT_MAX_AGE_MS - 1
    const young = NOW - LEGACY_OPFS_OUTPUT_MAX_AGE_MS + DAY_MS
    // Dated by the finalized marker, whatever the file timestamps say.
    writeLegacyOutput(opfs, 'legacy-old-marker', {
      finalizedAt: old,
      lastModified: NOW,
    })
    writeLegacyOutput(opfs, 'legacy-young-marker', {
      finalizedAt: young,
      lastModified: old,
    })
    // Without a marker, dated by the newest file.
    writeLegacyOutput(opfs, 'legacy-old-unmarked', { lastModified: old })
    opfs.writeFile(`${ACTIVE}/legacy-old-unmarked/output.jpg.tmp`, 'x', old)
    writeLegacyOutput(opfs, 'legacy-young-unmarked', { lastModified: old })
    opfs.writeFile(`${ACTIVE}/legacy-young-unmarked/output.jpg.tmp`, 'x', young)

    const report = await lifetime.collectAbandonedOutputs()

    expect(opfs.entries(ACTIVE)).toEqual([
      'legacy-young-marker',
      'legacy-young-unmarked',
    ])
    expect(report).toMatchObject({
      scannedEntries: 4,
      examinedEntries: 4,
      removedEntries: ['legacy-old-marker', 'legacy-old-unmarked'],
      keptEntries: 2,
      skippedEntries: 0,
      failures: [],
    })
  })

  it('skips malformed entries and never touches the recovery journal', async () => {
    const { lifetime, opfs, lockManager } = createLifetime()
    const old = NOW - 30 * DAY_MS
    opfs.makeDirectory(`${ACTIVE}/tab-`)
    writeTabOutput(opfs, 'not a tab id!', 'export-1', old)
    opfs.writeFile(`${ACTIVE}/tab-file`, 'not a directory', old)
    opfs.writeFile(`${ACTIVE}/stray.json`, '{}', old)
    opfs.makeDirectory(`${ACTIVE}/legacy-empty`)
    writeLegacyOutput(opfs, 'legacy-bad-marker', {
      finalizedAt: 'not a date',
      lastModified: old,
    })
    opfs.writeFile(
      `${ACTIVE}/legacy-unparsable-marker/output.jpg.finalized.json`,
      '{',
      old,
    )
    writeLegacyOutput(opfs, 'legacy-nested', { lastModified: old })
    opfs.makeDirectory(`${ACTIVE}/legacy-nested/unexpected`)
    // An interrupted export's journal, alone or next to an old output.
    opfs.writeFile(`${ACTIVE}/journal-only/manifest.json`, '{}', old)
    writeLegacyOutput(opfs, 'journal-with-output', {
      finalizedAt: old,
      lastModified: old,
    })
    opfs.writeFile(`${ACTIVE}/journal-with-output/manifest.json`, '{}', old)
    const before = opfs.entries(ACTIVE)

    const report = await lifetime.collectAbandonedOutputs()

    expect(opfs.entries(ACTIVE)).toEqual(before)
    expect(opfs.removals).toEqual([])
    expect(lockManager?.requests).toEqual([])
    expect(report).toMatchObject({
      scannedEntries: before.length,
      // Files and malformed tab names are settled without reading anything.
      examinedEntries: before.length - 4,
      removedEntries: [],
      keptEntries: 0,
      skippedEntries: before.length,
      failures: [],
    })
  })

  it('does no collection at all without Web Locks', async () => {
    const { lifetime, opfs, debugEvents } = createLifetime({
      lockManager: null,
    })
    writeTabOutput(opfs, 'closed', 'export-1')
    writeLegacyOutput(opfs, 'legacy-old', {
      finalizedAt: NOW - 30 * DAY_MS,
      lastModified: NOW - 30 * DAY_MS,
    })

    await expect(lifetime.collectAbandonedOutputs()).resolves.toBeNull()

    expect(opfs.getDirectory).not.toHaveBeenCalled()
    expect(opfs.entries(ACTIVE)).toEqual(['legacy-old', 'tab-closed'])
    expect(debugEvents).toEqual([])
  })

  it('does nothing when no export ever wrote to OPFS', async () => {
    const { lifetime, opfs, debugEvents } = createLifetime()

    await expect(lifetime.collectAbandonedOutputs()).resolves.toMatchObject({
      examinedEntries: 0,
    })

    expect(opfs.entries('')).toEqual([])
    expect(debugEvents).toEqual([])
  })

  it('swallows storage errors and keeps collecting the other entries', async () => {
    const { lifetime, opfs, debugEvents } = createLifetime()
    const old = NOW - 30 * DAY_MS
    writeTabOutput(opfs, 'locked-file', 'export-1')
    writeTabOutput(opfs, 'closed', 'export-1')
    writeLegacyOutput(opfs, 'legacy-unreadable', { lastModified: old })
    writeLegacyOutput(opfs, 'legacy-unlistable', { lastModified: old })
    opfs.failures.remove.set(
      `${ACTIVE}/tab-locked-file`,
      domError('NoModificationAllowedError'),
    )
    opfs.failures.read.set(
      `${ACTIVE}/legacy-unreadable/output.jpg`,
      domError('NotReadableError'),
    )
    opfs.failures.list.set(
      `${ACTIVE}/legacy-unlistable`,
      domError('NotAllowedError'),
    )

    const report = await lifetime.collectAbandonedOutputs()

    expect(opfs.entries(ACTIVE)).toEqual([
      'legacy-unlistable',
      'legacy-unreadable',
      'tab-locked-file',
    ])
    expect(report).toMatchObject({
      scannedEntries: 4,
      examinedEntries: 4,
      removedEntries: ['tab-closed'],
      keptEntries: 0,
      skippedEntries: 3,
    })
    expect(report?.failures.map(({ entry }) => entry).sort()).toEqual([
      'legacy-unlistable',
      'legacy-unreadable',
      'tab-locked-file',
    ])
    expect(debugEvents).toEqual([
      { type: 'opfs-output-collection', payload: report },
    ])
  })

  it.each([
    {
      name: 'the OPFS root cannot open',
      fail(opfs: MemoryOpfs) {
        opfs.failures.getDirectory = domError('SecurityError')
      },
    },
    {
      name: 'the active directory cannot be listed',
      fail(opfs: MemoryOpfs) {
        opfs.failures.list.set(ACTIVE, domError('NotAllowedError'))
      },
    },
    {
      name: 'the storage accessor throws',
      fail() {},
      environment: {
        getStorage: () => {
          throw new Error('storage accessor exploded')
        },
      },
    },
  ])(
    'resolves with a reported failure when $name',
    async ({ fail, environment }) => {
      const { lifetime, opfs, debugEvents } = createLifetime({ environment })
      writeTabOutput(opfs, 'closed', 'export-1')
      fail(opfs)

      await expect(lifetime.collectAbandonedOutputs()).resolves.toMatchObject({
        removedEntries: [],
      })

      expect(opfs.entries(ACTIVE)).toEqual(['tab-closed'])
      expect(debugEvents).toEqual([
        {
          type: 'opfs-output-collection',
          payload: expect.objectContaining({
            removedEntries: [],
            failures: [{ entry: null, message: expect.any(String) }],
          }),
        },
      ])
    },
  )

  it('treats a directory another page removed first as collected', async () => {
    const { lifetime, opfs } = createLifetime()
    writeTabOutput(opfs, 'closed', 'export-1')
    writeLegacyOutput(opfs, 'legacy-old', {
      finalizedAt: NOW - 30 * DAY_MS,
      lastModified: NOW - 30 * DAY_MS,
    })
    for (const name of ['tab-closed', 'legacy-old']) {
      opfs.failures.remove.set(`${ACTIVE}/${name}`, domError('NotFoundError'))
    }

    const report = await lifetime.collectAbandonedOutputs()

    expect(report).toMatchObject({
      examinedEntries: 2,
      removedEntries: ['tab-closed', 'legacy-old'],
      failures: [],
    })
  })

  it('examines at most a fixed budget of entries per activation', async () => {
    const { lifetime, opfs, lockManager } = createLifetime()
    const total = OPFS_COLLECTION_ENTRY_BUDGET + 6
    for (let index = 0; index < total; index += 1) {
      writeTabOutput(opfs, `closed-${String(index).padStart(3, '0')}`, 'e')
    }

    const first = await lifetime.collectAbandonedOutputs()

    expect(OPFS_COLLECTION_ENTRY_BUDGET).toBe(64)
    expect(first).toMatchObject({
      scannedEntries: total,
      examinedEntries: 64,
      truncated: true,
    })
    expect(first?.removedEntries).toHaveLength(64)
    expect(lockManager?.requests).toHaveLength(64)
    expect(opfs.entries(ACTIVE)).toHaveLength(6)

    const second = await lifetime.collectAbandonedOutputs()

    expect(second).toMatchObject({ examinedEntries: 6, truncated: false })
    expect(opfs.entries(ACTIVE)).toEqual([])
  })

  it('lists at most a fixed number of names per activation', async () => {
    const { lifetime, opfs, lockManager } = createLifetime()
    for (let index = 0; index < OPFS_COLLECTION_SCAN_LIMIT; index += 1) {
      opfs.writeFile(`${ACTIVE}/a-${String(index).padStart(5, '0')}`, '')
    }
    writeTabOutput(opfs, 'closed', 'export-1')

    const report = await lifetime.collectAbandonedOutputs()

    expect(report).toMatchObject({
      scannedEntries: OPFS_COLLECTION_SCAN_LIMIT,
      examinedEntries: 0,
      skippedEntries: OPFS_COLLECTION_SCAN_LIMIT,
      truncated: true,
    })
    expect(lockManager?.requests).toEqual([])
    expect(opfs.exists(`${ACTIVE}/tab-closed`)).toBe(true)
  })
})

describe('scheduleAbandonedOutputCollection', () => {
  it('defers one collection per page and never runs it inline', async () => {
    const { lifetime, opfs, idleTasks } = createLifetime()
    writeTabOutput(opfs, 'closed', 'export-1')

    expect(lifetime.scheduleAbandonedOutputCollection()).toBeUndefined()
    lifetime.scheduleAbandonedOutputCollection()

    expect(idleTasks).toHaveLength(1)
    expect(opfs.getDirectory).not.toHaveBeenCalled()

    idleTasks[0]!()
    await vi.waitFor(() => {
      expect(opfs.entries(ACTIVE)).toEqual([])
    })
    lifetime.scheduleAbandonedOutputCollection()
    expect(idleTasks).toHaveLength(1)
  })

  it('swallows a scheduler that throws', () => {
    const { lifetime } = createLifetime({
      environment: {
        scheduleIdle: () => {
          throw new Error('no scheduler')
        },
      },
    })

    expect(() => lifetime.scheduleAbandonedOutputCollection()).not.toThrow()
  })

  it('waits for an idle period when the browser has requestIdleCallback', () => {
    const requestIdleCallback = vi.fn()
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    const lifetime = createOpfsOutputLifetime({
      getLocks: () => null,
      getStorage: () => null,
    })

    lifetime.scheduleAbandonedOutputCollection()

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: expect.any(Number),
    })
  })

  it('falls back to a timer without requestIdleCallback', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const opfs = createMemoryOpfs()
    const lockManager = createFakeLockManager()
    writeTabOutput(opfs, 'closed', 'export-1')
    const lifetime = createOpfsOutputLifetime({
      getLocks: () => lockManager.locks,
      getStorage: () => opfs.storage,
      emitDebugEvent: () => {},
    })

    lifetime.scheduleAbandonedOutputCollection()
    expect(opfs.getDirectory).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    await vi.waitFor(() => {
      expect(opfs.entries(ACTIVE)).toEqual([])
    })
  })
})

function exportIdFor(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

describe('collection across pages', () => {
  it('reaches a closed tab behind entries every pass keeps or skips', async () => {
    const opfs = createMemoryOpfs()
    const lockManager = createFakeLockManager()
    // A page of an earlier version finished 70 journaled exports, then
    // closed. A finished export dropped only its journal's manifest, so every
    // one left an empty journal directory named before `tab-`.
    for (let index = 0; index < 70; index += 1) {
      const exportId = exportIdFor(index)
      opfs.makeDirectory(`${ACTIVE}/${exportId}`)
      const writable = await createOpfsOutputWritable({
        tabDirectory: 'tab-closed',
        exportId,
        storage: opfs.storage,
      })
      await writable.write(new Uint8Array([1, 2, 3]))
      await writable.close()
    }
    // Journals interrupted exports of that version left behind.
    for (let index = 70; index < 78; index += 1) {
      opfs.writeFile(`${ACTIVE}/${exportIdFor(index)}/manifest.json`, '{}')
    }
    // Pages that are still open, named before the closed one.
    for (let index = 0; index < 3; index += 1) {
      writeTabOutput(opfs, `alive-${index}`, 'export-1', NOW - 30 * DAY_MS)
      lockManager.holdForAnotherTab(`alive-${index}`)
    }
    const entries = opfs.entries(ACTIVE)
    expect(entries.indexOf('tab-closed')).toBeGreaterThan(
      OPFS_COLLECTION_ENTRY_BUDGET,
    )

    // One pass per page, as each new page runs one.
    const reports: Array<OpfsOutputCollectionReport | null> = []
    for (const page of ['page-1', 'page-2', 'page-3']) {
      const { lifetime } = createLifetime({ opfs, lockManager, tabId: page })
      reports.push(await lifetime.collectAbandonedOutputs())
    }

    expect(opfs.exists(`${ACTIVE}/tab-closed`)).toBe(false)
    expect(reports[0]?.removedEntries).toEqual(['tab-closed'])
    expect(
      reports.every(
        (report) =>
          report !== null &&
          report.examinedEntries <= OPFS_COLLECTION_ENTRY_BUDGET,
      ),
    ).toBe(true)
    // Journals and live tabs are untouched.
    expect(opfs.entries(ACTIVE)).toEqual(
      entries.filter((name) => name !== 'tab-closed'),
    )
    for (let index = 70; index < 78; index += 1) {
      expect(opfs.exists(`${ACTIVE}/${exportIdFor(index)}/manifest.json`)).toBe(
        true,
      )
    }
  })

  it.each([
    {
      name: 'live tabs',
      fill(opfs: MemoryOpfs, lockManager: FakeLockManager) {
        for (let index = 0; index < 70; index += 1) {
          const tabId = `alive-${String(index).padStart(2, '0')}`
          writeTabOutput(opfs, tabId, 'export-1')
          lockManager.holdForAnotherTab(tabId)
        }
        writeTabOutput(opfs, 'closed', 'export-1')
        return 'tab-closed'
      },
    },
    {
      name: 'empty recovery journals',
      fill(opfs: MemoryOpfs) {
        for (let index = 0; index < 70; index += 1) {
          opfs.makeDirectory(`${ACTIVE}/${exportIdFor(index)}`)
        }
        writeLegacyOutput(opfs, 'ffffffff-legacy', {
          finalizedAt: NOW - 30 * DAY_MS,
          lastModified: NOW - 30 * DAY_MS,
        })
        return 'ffffffff-legacy'
      },
    },
  ])(
    'starts each pass somewhere new when more $name remain than it may examine',
    async ({ fill }) => {
      const opfs = createMemoryOpfs()
      const lockManager = createFakeLockManager()
      const abandoned = fill(opfs, lockManager)
      const before = opfs.entries(ACTIVE)
      expect(before.at(-1)).toBe(abandoned)

      // The first page starts at the first name and never reaches the last.
      const first = createLifetime({ opfs, lockManager, tabId: 'page-1' })
      const firstReport = await first.lifetime.collectAbandonedOutputs()

      expect(firstReport).toMatchObject({
        examinedEntries: OPFS_COLLECTION_ENTRY_BUDGET,
        removedEntries: [],
        truncated: true,
      })
      expect(opfs.exists(`${ACTIVE}/${abandoned}`)).toBe(true)

      // A later page starts elsewhere and wraps around past it.
      const second = createLifetime({
        opfs,
        lockManager,
        tabId: 'page-2',
        environment: { random: () => 0.99 },
      })
      const secondReport = await second.lifetime.collectAbandonedOutputs()

      expect(secondReport).toMatchObject({
        examinedEntries: OPFS_COLLECTION_ENTRY_BUDGET,
        removedEntries: [abandoned],
      })
      expect(opfs.entries(ACTIVE)).toEqual(before.slice(0, -1))
    },
  )
})
