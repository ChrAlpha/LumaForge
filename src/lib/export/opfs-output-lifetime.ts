import type {
  ExportDebugEvent,
  ExportOpfsOutputCollectionDebugPayload,
} from './execution-profile'
import { emitExportDebugEvent } from './execution-profile'
import {
  OPFS_ACTIVE_DIRECTORY,
  OPFS_EXPORTS_DIRECTORY,
  OPFS_OUTPUT_FINALIZED_SUFFIX,
} from './output-sink'

type LockManagerLike = Pick<LockManager, 'request'>
type OpfsStorage = Pick<StorageManager, 'getDirectory'>

export type OpfsOutputCollectionReport = ExportOpfsOutputCollectionDebugPayload

export type OpfsOutputLifetimeEnvironment = {
  getLocks: () => LockManagerLike | null | undefined
  getStorage: () => OpfsStorage | null | undefined
  createTabId: () => string
  now: () => number
  /** Uniform in [0, 1); picks where a pass starts when it cannot cover all. */
  random: () => number
  scheduleIdle: (task: () => void) => void
  emitDebugEvent: (event: ExportDebugEvent) => void
}

type EntryOutcome = 'removed' | 'kept' | 'skipped'

const TAB_DIRECTORY_PREFIX = 'tab-'
/** Where a page that holds no tab lock writes; no collector removes it. */
const UNTRACKED_DIRECTORY_PREFIX = 'untracked-'
const TAB_LOCK_PREFIX = 'lumaforge-export-tab:'
const TAB_ID_PATTERN = /^[\w-]{1,128}$/
/** Entries of `active/` one pass may spend a lock probe or storage reads on. */
export const OPFS_COLLECTION_ENTRY_BUDGET = 64
/** Names of `active/` one pass may list; listing a name reads no files. */
export const OPFS_COLLECTION_SCAN_LIMIT = 4096
/** A pre-tab output is presumed abandoned once it is older than this. */
export const LEGACY_OPFS_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A pre-tab output directory held about four files (the output, its temp
 * file and marker, and a recovery journal); one with more than this is left
 * alone.
 */
const LEGACY_OUTPUT_FILE_BUDGET = 16
/**
 * Recovery journals earlier versions wrote share `active/`; a directory
 * holding one is never collected.
 */
const RECOVERY_JOURNAL_FILE = 'manifest.json'
const COLLECTION_IDLE_TIMEOUT_MS = 10_000

function tabLockName(tabId: string) {
  return `${TAB_LOCK_PREFIX}${tabId}`
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message
  }
  return String(error)
}

function isNotFoundError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  )
}

function count(
  report: OpfsOutputCollectionReport,
  name: string,
  outcome: EntryOutcome,
) {
  if (outcome === 'removed') report.removedEntries.push(name)
  else if (outcome === 'kept') report.keptEntries += 1
  else report.skippedEntries += 1
}

async function removeCollectedEntry(
  active: FileSystemDirectoryHandle,
  name: string,
) {
  try {
    await active.removeEntry(name, { recursive: true })
  } catch (error) {
    // Another page collected it first.
    if (!isNotFoundError(error)) throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBlobText(blob: Blob) {
  if (typeof blob.text === 'function') return blob.text()

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(reader.error ?? new Error('OPFS_OUTPUT_MARKER_READ_FAILED'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(blob)
  })
}

function createDefaultTabId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  )
}

function scheduleWhenIdle(task: () => void) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => task(), {
      timeout: COLLECTION_IDLE_TIMEOUT_MS,
    })
    return
  }

  globalThis.setTimeout(task, 0)
}

const DEFAULT_ENVIRONMENT: OpfsOutputLifetimeEnvironment = {
  getLocks: () =>
    (globalThis.navigator as Navigator | undefined)?.locks ?? null,
  getStorage: () => {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage
    return typeof storage?.getDirectory === 'function' ? storage : null
  },
  createTabId: createDefaultTabId,
  now: () => Date.now(),
  random: () => Math.random(),
  scheduleIdle: scheduleWhenIdle,
  emitDebugEvent: emitExportDebugEvent,
}

async function openActiveDirectory(storage: OpfsStorage) {
  const root = await storage.getDirectory()
  try {
    const exportsDirectory = await root.getDirectoryHandle(
      OPFS_EXPORTS_DIRECTORY,
    )
    return await exportsDirectory.getDirectoryHandle(OPFS_ACTIVE_DIRECTORY)
  } catch (error) {
    // Nothing was ever written, so there is nothing to collect.
    if (isNotFoundError(error)) return null
    throw error
  }
}

/**
 * Up to `count` items, consecutive and wrapping around from `start`. A pass
 * that cannot cover every candidate starts somewhere new each time, so
 * entries it can only keep or skip never hide the rest from every pass.
 */
function takeRotated<T>(items: T[], count: number, start: number) {
  if (items.length <= count) return items
  const first = Number.isSafeInteger(start) && start > 0 ? start : 0
  return Array.from(
    { length: count },
    (_, offset) => items[(first + offset) % items.length]!,
  )
}

/**
 * When a pre-tab output was written: its finalized marker's timestamp, or
 * the newest file when it never finalized. Null when it cannot be dated.
 */
async function readLegacyOutputTime(
  files: Array<{ name: string; handle: FileSystemFileHandle }>,
) {
  const markers = files.filter(({ name }) =>
    name.endsWith(OPFS_OUTPUT_FINALIZED_SUFFIX),
  )
  if (markers.length > 0) {
    let newest = Number.NEGATIVE_INFINITY
    for (const marker of markers) {
      const text = await readBlobText(await marker.handle.getFile())
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return null
      }
      const finalizedAt =
        isRecord(parsed) && typeof parsed.finalizedAt === 'string'
          ? Date.parse(parsed.finalizedAt)
          : Number.NaN
      if (!Number.isFinite(finalizedAt)) return null
      newest = Math.max(newest, finalizedAt)
    }
    return newest
  }

  let newest = Number.NEGATIVE_INFINITY
  for (const { handle } of files) {
    const { lastModified } = await handle.getFile()
    if (!Number.isFinite(lastModified)) return null
    newest = Math.max(newest, lastModified)
  }
  return newest
}

/**
 * Owns this page's OPFS output directory and collects the directories of
 * pages that are gone. A page names one `tab-<id>` directory under `active/`
 * and holds the exclusive Web Lock `lumaforge-export-tab:<id>` until it dies,
 * when the browser releases it. A tab directory is removed only by a page
 * that was granted that lock, and only while it still holds it, so a live
 * page's outputs are never collected however old they are. A page that
 * cannot hold its lock writes to `untracked-<id>` instead, which no
 * collector removes; only owner cleanup does.
 */
export function createOpfsOutputLifetime(
  overrides: Partial<OpfsOutputLifetimeEnvironment> = {},
) {
  const environment = { ...DEFAULT_ENVIRONMENT, ...overrides }
  let tabId: string | null = null
  let reservation: Promise<string> | null = null
  let collectionScheduled = false

  function emit(event: ExportDebugEvent) {
    try {
      environment.emitDebugEvent(event)
    } catch {
      // Diagnostics must not affect export control flow.
    }
  }

  function reportTabLockFailure(error: unknown) {
    emit({
      type: 'opfs-output-tab-lock-failed',
      payload: { message: describeError(error) },
    })
  }

  /** Resolves true once this page holds its tab lock, false if it never will. */
  function acquireTabLock(locks: LockManagerLike, id: string) {
    return new Promise<boolean>((resolve) => {
      const fail = (error: unknown) => {
        reportTabLockFailure(error)
        resolve(false)
      }
      try {
        void Promise.resolve(
          locks.request(tabLockName(id), { mode: 'exclusive' }, () => {
            resolve(true)
            // Never settles, so the lock is held for the page lifetime.
            return new Promise<never>(() => {})
          }),
        ).catch(fail)
      } catch (error) {
        fail(error)
      }
    })
  }

  async function reserve() {
    const id = environment.createTabId()
    tabId = id
    let locks: LockManagerLike | null | undefined = null
    try {
      locks = environment.getLocks()
    } catch (error) {
      reportTabLockFailure(error)
    }
    if (locks && (await acquireTabLock(locks, id))) {
      return `${TAB_DIRECTORY_PREFIX}${id}`
    }
    // A tab directory with no lock behind it looks closed to every collector.
    return `${UNTRACKED_DIRECTORY_PREFIX}${id}`
  }

  /**
   * The `active/` subdirectory this page writes its OPFS outputs under,
   * reserved once per page. It is a collectable tab directory only once this
   * page holds its lock; the lock is requested before any output exists, so
   * no other page can be granted it first.
   */
  function reserveOutputDirectory() {
    reservation ??= reserve()
    return reservation
  }

  async function collectTabDirectory(
    locks: LockManagerLike,
    active: FileSystemDirectoryHandle,
    name: string,
    id: string,
  ): Promise<EntryOutcome> {
    return locks.request(
      tabLockName(id),
      { ifAvailable: true },
      async (lock): Promise<EntryOutcome> => {
        // No lock means the page that owns the directory is still alive.
        if (!lock) return 'kept'
        await removeCollectedEntry(active, name)
        return 'removed'
      },
    )
  }

  async function collectLegacyEntry(
    active: FileSystemDirectoryHandle,
    name: string,
    directory: FileSystemDirectoryHandle,
  ): Promise<EntryOutcome> {
    const files: Array<{ name: string; handle: FileSystemFileHandle }> = []
    for await (const [childName, child] of directory.entries()) {
      if (childName === RECOVERY_JOURNAL_FILE) return 'skipped'
      if (child.kind !== 'file' || files.length >= LEGACY_OUTPUT_FILE_BUDGET) {
        return 'skipped'
      }
      files.push({ name: childName, handle: child as FileSystemFileHandle })
    }
    if (files.length === 0) return 'skipped'

    const writtenAt = await readLegacyOutputTime(files)
    if (writtenAt === null) return 'skipped'
    if (environment.now() - writtenAt <= LEGACY_OPFS_OUTPUT_MAX_AGE_MS) {
      return 'kept'
    }
    await removeCollectedEntry(active, name)
    return 'removed'
  }

  async function examine(
    report: OpfsOutputCollectionReport,
    name: string,
    collectEntry: () => Promise<EntryOutcome>,
  ) {
    report.examinedEntries += 1
    try {
      count(report, name, await collectEntry())
    } catch (error) {
      report.skippedEntries += 1
      report.failures.push({ entry: name, message: describeError(error) })
    }
  }

  async function collect(
    locks: LockManagerLike,
    storage: OpfsStorage,
    report: OpfsOutputCollectionReport,
  ) {
    let active: FileSystemDirectoryHandle | null
    try {
      active = await openActiveDirectory(storage)
    } catch (error) {
      report.failures.push({ entry: null, message: describeError(error) })
      return true
    }
    if (!active) return false

    // List names before touching anything, so removals never race the
    // iterator and the budget goes to entries that need work wherever they
    // sort. Entries that need none are settled here.
    const tabs: Array<{ name: string; id: string }> = []
    const legacy: Array<{ name: string; handle: FileSystemDirectoryHandle }> =
      []
    try {
      for await (const [name, handle] of active.entries()) {
        if (report.scannedEntries >= OPFS_COLLECTION_SCAN_LIMIT) {
          report.truncated = true
          break
        }
        report.scannedEntries += 1
        const id = name.startsWith(TAB_DIRECTORY_PREFIX)
          ? name.slice(TAB_DIRECTORY_PREFIX.length)
          : null
        if (handle.kind !== 'directory') {
          count(report, name, 'skipped')
        } else if (id === null) {
          if (name.startsWith(UNTRACKED_DIRECTORY_PREFIX)) {
            count(report, name, 'kept')
          } else {
            legacy.push({ name, handle: handle as FileSystemDirectoryHandle })
          }
        } else if (id === tabId) {
          count(report, name, 'kept')
        } else if (TAB_ID_PATTERN.test(id)) {
          tabs.push({ name, id })
        } else {
          count(report, name, 'skipped')
        }
      }
    } catch (error) {
      report.failures.push({ entry: null, message: describeError(error) })
    }

    // Other tabs first: they are what exports leave behind now, and a probe
    // reads nothing unless that tab is gone.
    const tabBatch = takeRotated(
      tabs,
      OPFS_COLLECTION_ENTRY_BUDGET,
      Math.floor(environment.random() * tabs.length),
    )
    const legacyBatch = takeRotated(
      legacy,
      OPFS_COLLECTION_ENTRY_BUDGET - tabBatch.length,
      Math.floor(environment.random() * legacy.length),
    )
    if (tabBatch.length < tabs.length || legacyBatch.length < legacy.length) {
      report.truncated = true
    }

    for (const { name, id } of tabBatch) {
      await examine(report, name, () =>
        collectTabDirectory(locks, active, name, id),
      )
    }
    for (const { name, handle } of legacyBatch) {
      await examine(report, name, () =>
        collectLegacyEntry(active, name, handle),
      )
    }
    return report.scannedEntries > 0 || report.failures.length > 0
  }

  /**
   * Removes `tab-*` directories whose lock is free and pre-tab outputs left
   * directly under `active/` once they are older than seven days. Malformed
   * or unreadable entries, recovery journals and untracked directories are
   * left alone, nothing is collected without Web Locks, and it never
   * rejects: storage errors are reported as a debug event.
   */
  async function collectAbandonedOutputs(): Promise<OpfsOutputCollectionReport | null> {
    const report: OpfsOutputCollectionReport = {
      scannedEntries: 0,
      examinedEntries: 0,
      removedEntries: [],
      keptEntries: 0,
      skippedEntries: 0,
      truncated: false,
      failures: [],
    }

    let worked: boolean
    try {
      const locks = environment.getLocks()
      if (!locks) return null
      const storage = environment.getStorage()
      if (!storage) return null
      worked = await collect(locks, storage, report)
    } catch (error) {
      report.failures.push({ entry: null, message: describeError(error) })
      worked = true
    }

    if (worked) emit({ type: 'opfs-output-collection', payload: report })
    return report
  }

  /**
   * Schedules one collection per page for idle time. It is never awaited, so
   * it cannot delay or fail the export that triggered it.
   */
  function scheduleAbandonedOutputCollection() {
    if (collectionScheduled) return
    collectionScheduled = true
    try {
      environment.scheduleIdle(() => {
        void collectAbandonedOutputs()
      })
    } catch {
      // Collection is best-effort; owner cleanup does not depend on it.
    }
  }

  return {
    reserveOutputDirectory,
    collectAbandonedOutputs,
    scheduleAbandonedOutputCollection,
  }
}

const pageOutputLifetime = createOpfsOutputLifetime()

/** Reserves the `active/` subdirectory this page writes its OPFS outputs under. */
export function reserveOpfsOutputDirectory() {
  return pageOutputLifetime.reserveOutputDirectory()
}

/** Schedules one off-path collection per page; safe to call on every plan. */
export function scheduleAbandonedOpfsOutputCollection() {
  pageOutputLifetime.scheduleAbandonedOutputCollection()
}
