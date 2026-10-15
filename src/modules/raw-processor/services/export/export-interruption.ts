import {
  isAbortError,
  isRetryableFullResExportFailure,
} from '../ingest/workflow-status'

type LockManagerLike = Pick<LockManager, 'request'>
type StorageLike = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

export type ExportInterruptionEnvironment = {
  getStorage: () => StorageLike | null | undefined
  getLocks: () => LockManagerLike | null | undefined
  createId: (kind: 'owner' | 'attempt') => string
  now: () => number
}

/** The file tuple a marker is located by; it never identifies content. */
export type ExportSourceTuple = {
  name: string
  size: number
  lastModified: number
}

/** How an export attempt ended, as told by the page that ran it. */
export type ExportAttemptOutcome =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'resource-failure'

export type ExportAttemptRegistration = {
  attempt: string
  /** False when no marker was written; the export proceeds regardless. */
  stored: boolean
}

export type ExportInterruptionHint = {
  /** An attempt on this tuple was left running by a page that is gone. */
  previousCrashLikeInterruption: boolean
  /** An attempt on this tuple ended because the device ran out of resources. */
  previousResourceFailure: boolean
  /** The attempts behind the hint, for `retire` once it has been used. */
  attempts: string[]
}

type ExportInterruptionMarker = {
  version: 1
  attempt: string
  owner: string
  /** Whether the owner held its lifetime lock when it wrote this marker. */
  ownerLocked: boolean
  source: string
  startedAt: number
  updatedAt: number
  terminal: 'resource-failure' | null
}

const MARKER_VERSION = 1
const KEY_PREFIX = 'lumaforge.export-interruption.v1.'
const OWNER_LOCK_PREFIX = 'lumaforge-export-attempt-owner:'
const ID_PATTERN = /^[\w-]{1,128}$/
/**
 * Markers each `begin` prunes the origin down to, and lock probes per read.
 * Pages that begin at the same moment can briefly leave a few more; the next
 * `begin` brings the count back down.
 */
export const EXPORT_INTERRUPTION_MARKER_LIMIT = 8
/** A marker older than this, or stamped this far ahead, is ignored. */
export const EXPORT_INTERRUPTION_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

const NO_HINT: ExportInterruptionHint = {
  previousCrashLikeInterruption: false,
  previousResourceFailure: false,
  attempts: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function markerKey(attempt: string) {
  return `${KEY_PREFIX}${attempt}`
}

function ownerLockName(owner: string) {
  return `${OWNER_LOCK_PREFIX}${owner}`
}

/**
 * The exact, delimiter-safe encoding of a file's name, size and
 * lastModified, or null when one of them is not an exact integer. Two files
 * that share the tuple share the hint; nothing about content is implied.
 */
export function encodeExportSourceHint(source: ExportSourceTuple) {
  const { name, size, lastModified } = source
  if (
    typeof name !== 'string' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(lastModified)
  ) {
    return null
  }
  return JSON.stringify([name, size, lastModified])
}

function parseMarker(
  key: string,
  text: string | null,
): ExportInterruptionMarker | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isRecord(value) ||
    value.version !== MARKER_VERSION ||
    typeof value.attempt !== 'string' ||
    markerKey(value.attempt) !== key ||
    !ID_PATTERN.test(value.attempt) ||
    typeof value.owner !== 'string' ||
    !ID_PATTERN.test(value.owner) ||
    typeof value.ownerLocked !== 'boolean' ||
    typeof value.source !== 'string' ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.terminal !== null && value.terminal !== 'resource-failure')
  ) {
    return null
  }
  return {
    version: MARKER_VERSION,
    attempt: value.attempt,
    owner: value.owner,
    ownerLocked: value.ownerLocked,
    source: value.source,
    startedAt: value.startedAt as number,
    updatedAt: value.updatedAt as number,
    terminal: value.terminal,
  }
}

function isCurrent(marker: ExportInterruptionMarker, now: number) {
  return Math.abs(now - marker.updatedAt) <= EXPORT_INTERRUPTION_MARKER_TTL_MS
}

function createDefaultId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  )
}

const DEFAULT_ENVIRONMENT: ExportInterruptionEnvironment = {
  getStorage: () => globalThis.localStorage ?? null,
  getLocks: () =>
    (globalThis.navigator as Navigator | undefined)?.locks ?? null,
  createId: createDefaultId,
  now: () => Date.now(),
}

/**
 * Attempt-scoped export interruption hints. Each attempt is one storage key
 * written and removed only by the page that began it, so pages never
 * read-modify-write a shared record and an older attempt's end never removes
 * a newer one. A page holds the exclusive Web Lock
 * `lumaforge-export-attempt-owner:<owner>` for its lifetime before naming
 * itself as an owner; an unfinished attempt is crash-like only when another
 * page is granted that lock, so a live or unverifiable page's attempt is
 * never called a crash. Markers carry the file tuple, timestamps, owner and
 * terminal classification only: nothing in them can replay, resume or
 * recover an export, and they never touch OPFS. Storage that is denied,
 * full or malformed yields no hint and never throws.
 */
export function createExportInterruptionMarkers(
  overrides: Partial<ExportInterruptionEnvironment> = {},
) {
  const environment = { ...DEFAULT_ENVIRONMENT, ...overrides }
  let owner: string | null = null
  let ownerLock: Promise<boolean> | null = null
  const ownAttempts = new Set<string>()

  function getOwner() {
    owner ??= environment.createId('owner')
    return owner
  }

  function getStorage() {
    try {
      return environment.getStorage() ?? null
    } catch {
      return null
    }
  }

  function getLocks() {
    try {
      return environment.getLocks() ?? null
    } catch {
      return null
    }
  }

  /** Resolves true once this page holds its owner lock, false if it never will. */
  function acquireOwnerLock(id: string) {
    const locks = getLocks()
    if (!locks || !ID_PATTERN.test(id)) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      try {
        void Promise.resolve(
          locks.request(
            ownerLockName(id),
            { mode: 'exclusive', ifAvailable: true },
            (lock) => {
              if (!lock) {
                resolve(false)
                return undefined
              }
              resolve(true)
              // Never settles, so the lock is held for the page lifetime.
              return new Promise<never>(() => {})
            },
          ),
        ).catch(() => resolve(false))
      } catch {
        resolve(false)
      }
    })
  }

  /** Every key under the marker prefix with its parsed marker, or null. */
  function readMarkers(storage: StorageLike) {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith(KEY_PREFIX)) keys.push(key)
    }
    return keys.map((key) => ({
      key,
      marker: parseMarker(key, storage.getItem(key)),
    }))
  }

  /**
   * Removes malformed and expired markers, then the oldest beyond room for
   * one more, terminal ones first. Another page pruning at the same time can
   * leave the origin briefly over the limit. Throws when storage cannot be
   * listed.
   */
  function prune(storage: StorageLike, now: number) {
    const kept: ExportInterruptionMarker[] = []
    for (const { key, marker } of readMarkers(storage)) {
      if (marker && isCurrent(marker, now)) kept.push(marker)
      else storage.removeItem(key)
    }
    const excess = kept.length - (EXPORT_INTERRUPTION_MARKER_LIMIT - 1)
    if (excess <= 0) return
    const evicted = kept
      .sort(
        (left, right) =>
          Number(right.terminal !== null) - Number(left.terminal !== null) ||
          left.updatedAt - right.updatedAt,
      )
      .slice(0, excess)
    for (const marker of evicted) storage.removeItem(markerKey(marker.attempt))
  }

  /**
   * Records an attempt before its export starts. It never rejects: when the
   * tuple cannot be encoded or storage refuses, it returns an unstored
   * attempt and the export goes ahead.
   */
  async function begin(
    source: ExportSourceTuple,
  ): Promise<ExportAttemptRegistration> {
    const id = getOwner()
    ownerLock ??= acquireOwnerLock(id)
    const ownerLocked = await ownerLock
    const attempt = environment.createId('attempt')
    ownAttempts.add(attempt)

    const encoded = encodeExportSourceHint(source)
    const storage = getStorage()
    if (
      encoded === null ||
      storage === null ||
      !ID_PATTERN.test(attempt) ||
      !ID_PATTERN.test(id)
    ) {
      return { attempt, stored: false }
    }

    try {
      const now = environment.now()
      prune(storage, now)
      const marker: ExportInterruptionMarker = {
        version: MARKER_VERSION,
        attempt,
        owner: id,
        ownerLocked,
        source: encoded,
        startedAt: now,
        updatedAt: now,
        terminal: null,
      }
      storage.setItem(markerKey(attempt), JSON.stringify(marker))
      return { attempt, stored: true }
    } catch {
      return { attempt, stored: false }
    }
  }

  /**
   * Ends one of this page's attempts. A resource failure stays as a terminal
   * hint for the next attempt on the same tuple; every other outcome removes
   * the marker. Only that attempt's key is touched.
   */
  function finish(attempt: string, outcome: ExportAttemptOutcome) {
    if (!ownAttempts.delete(attempt) || !ID_PATTERN.test(attempt)) return
    const storage = getStorage()
    if (!storage) return
    const key = markerKey(attempt)
    try {
      if (outcome !== 'resource-failure') {
        storage.removeItem(key)
        return
      }
      const marker = parseMarker(key, storage.getItem(key))
      // An evicted marker is not written back.
      if (!marker) return
      const ended: ExportInterruptionMarker = {
        ...marker,
        terminal: 'resource-failure',
        updatedAt: environment.now(),
      }
      storage.setItem(key, JSON.stringify(ended))
    } catch {
      // Hints are best-effort; the export already has its result.
    }
  }

  /** Whether another page was granted the owner lock, proving the owner gone. */
  async function isOwnerGone(locks: LockManagerLike, markerOwner: string) {
    try {
      return await locks.request(
        ownerLockName(markerOwner),
        { ifAvailable: true },
        (lock) => lock !== null,
      )
    } catch {
      return false
    }
  }

  /**
   * What a marker says once its owner is proven gone. Owner ids are unique to
   * one page lifetime, so the owner cannot write again, but it may have
   * ended the attempt between the listing and the probe: the marker is read
   * again and counts as a crash only while it is still the same unfinished,
   * current attempt. Anything unreadable makes no claim.
   */
  function rereadAfterOwnerGone(
    storage: StorageLike,
    listed: ExportInterruptionMarker,
  ): 'crash' | 'resource-failure' | null {
    try {
      const key = markerKey(listed.attempt)
      const marker = parseMarker(key, storage.getItem(key))
      if (
        !marker ||
        marker.owner !== listed.owner ||
        marker.source !== listed.source ||
        !isCurrent(marker, environment.now())
      ) {
        return null
      }
      return marker.terminal === null ? 'crash' : marker.terminal
    } catch {
      return null
    }
  }

  /**
   * The hint for a tuple from the newest current markers that match it. An
   * unfinished attempt counts only when its owner held a lock, that lock is
   * now free, and the marker is still unfinished once it is; this page's own
   * attempts and terminal markers need no probe. When two pages read at once,
   * one may find the dead owner's lock held by the other's probe and report
   * nothing, so not every page is guaranteed to see a crash hint.
   */
  async function inspect(
    source: ExportSourceTuple,
  ): Promise<ExportInterruptionHint> {
    const encoded = encodeExportSourceHint(source)
    const storage = getStorage()
    if (encoded === null || storage === null)
      return { ...NO_HINT, attempts: [] }

    let candidates: ExportInterruptionMarker[]
    try {
      const now = environment.now()
      candidates = readMarkers(storage)
        .map(({ marker }) => marker)
        .filter(
          (marker): marker is ExportInterruptionMarker =>
            marker !== null &&
            marker.source === encoded &&
            isCurrent(marker, now),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, EXPORT_INTERRUPTION_MARKER_LIMIT)
    } catch {
      return { ...NO_HINT, attempts: [] }
    }

    const self = getOwner()
    const hint: ExportInterruptionHint = { ...NO_HINT, attempts: [] }
    let locks: LockManagerLike | null | undefined
    for (const marker of candidates) {
      if (marker.terminal === 'resource-failure') {
        hint.previousResourceFailure = true
        hint.attempts.push(marker.attempt)
        continue
      }
      if (marker.owner === self || !marker.ownerLocked) continue
      locks ??= getLocks()
      if (!locks) continue
      if (!(await isOwnerGone(locks, marker.owner))) continue
      const confirmed = rereadAfterOwnerGone(storage, marker)
      if (confirmed === 'crash') hint.previousCrashLikeInterruption = true
      else if (confirmed === 'resource-failure')
        hint.previousResourceFailure = true
      else continue
      hint.attempts.push(marker.attempt)
    }
    return hint
  }

  /** Removes the markers behind a hint once it has been used. */
  function retire(attempts: readonly string[]) {
    const storage = getStorage()
    if (!storage) return
    for (const attempt of attempts) {
      if (!ID_PATTERN.test(attempt)) continue
      try {
        storage.removeItem(markerKey(attempt))
      } catch {
        // Expiry removes it later.
      }
    }
  }

  return { begin, finish, inspect, retire }
}

export type ExportInterruptionMarkers = ReturnType<
  typeof createExportInterruptionMarkers
>

/**
 * The interruption hint read for one source tuple. It belongs to that tuple
 * alone: another file never inherits its safer plan.
 */
export type SourceInterruptionHint = {
  /** The encoded file tuple the hint was read for. */
  source: string
  hint: ExportInterruptionHint
}

let pageMarkers: ExportInterruptionMarkers | null = null

/**
 * The page's one marker owner. Every export attempt and every hint read on
 * the page goes through it, so the page holds one owner lock for its life.
 */
export function getExportInterruptionMarkers() {
  pageMarkers ??= createExportInterruptionMarkers()
  return pageMarkers
}

function hasInterruption(hint: ExportInterruptionHint) {
  return hint.previousCrashLikeInterruption || hint.previousResourceFailure
}

/**
 * Reads the hint for a loaded source. It only reads: nothing here starts,
 * resumes or sizes an export.
 */
export async function readSourceInterruption(
  markers: Pick<ExportInterruptionMarkers, 'inspect'>,
  file: File,
): Promise<SourceInterruptionHint | null> {
  const source = encodeExportSourceHint(file)
  if (source === null) return null
  const hint = await markers.inspect(file)
  return hasInterruption(hint) ? { source, hint } : null
}

/**
 * The hint when it was read for this file's tuple, otherwise null. The
 * export applies only this, so a hint read for another file asks nothing.
 */
export function interruptionForSource(
  interruption: SourceInterruptionHint | null | undefined,
  file: File | null,
): ExportInterruptionHint | null {
  if (!interruption || !file || !hasInterruption(interruption.hint)) {
    return null
  }
  return encodeExportSourceHint(file) === interruption.source
    ? interruption.hint
    : null
}

/**
 * Whether surfaces note an interrupted export for this file, read from the
 * same hint the next explicit export uses. Only a crash-like interruption
 * reads as one; a resource failure already reported its own error.
 */
export function isInterruptedSource(
  interruption: SourceInterruptionHint | null | undefined,
  file: File | null,
): boolean {
  return (
    interruptionForSource(interruption, file)?.previousCrashLikeInterruption ===
    true
  )
}

/**
 * How a failed attempt ended. A cancellation is not an interruption; only a
 * failure a lighter plan addresses counts as a resource failure.
 */
export function classifyExportAttemptOutcome(input: {
  aborted: boolean
  errorCode: string
  error?: unknown
}): Exclude<ExportAttemptOutcome, 'completed'> {
  if (input.aborted || isAbortError(input.error)) return 'cancelled'
  return isRetryableFullResExportFailure(input.errorCode)
    ? 'resource-failure'
    : 'failed'
}
