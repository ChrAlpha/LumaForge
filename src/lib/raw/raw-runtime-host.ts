import type { LumaEmbeddedPreview } from '@lumaforge/luma-raw-runtime'
import { isWasmJpegRuntimeAvailable } from '@lumaforge/render-engine/export'

import type {
  RawDecodeBridgeLifecycleSnapshot,
  RawDecodeBridgeOptions,
} from '~/lib/workers/raw-decode-bridge'
import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'
import type { WorkerBridgeLifecycleListener } from '~/lib/workers/worker-bridge'
import { notifyLifecycleListeners } from '~/lib/workers/worker-bridge'

import type { DecodedImage, ProgressCallback } from './decoder'
import type { RawDecodeBridgePort } from './luma-runtime-adapter'
import {
  createDefaultLumaRawRuntime,
  createRuntimeSignal,
  decodeBoundedHqRawOnBridge,
  decodeQuickRawOnBridge,
  extractEmbeddedPreviewOnBridge,
  openRawSessionOnBridge,
  toPrewarmFailureOutcome,
} from './luma-runtime-adapter'
import type {
  JpegRuntimeAvailabilityProbe,
  PrewarmOutcome,
  PrewarmState,
  RawRuntimeSession,
} from './runtime-adapter'

/** The bridge surface a host drives and observes. */
export type RawRuntimeHostBridge = RawDecodeBridgePort &
  Pick<
    RawDecodeBridge,
    'terminate' | 'getLifecycleSnapshot' | 'subscribeLifecycle'
  >

export interface RawRuntimeHostOptions {
  /** Builds the RAW runtime for each worker generation. */
  runtimeFactory?: RawDecodeBridgeOptions['runtimeFactory']
  /** Builds the one decode bridge this host owns. */
  createBridge?: (options: RawDecodeBridgeOptions) => RawRuntimeHostBridge
  idleMs?: number
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe
}

export interface RawRuntimeHostSnapshot {
  /**
   * History of explicit prewarms on this host: `ready` means a prewarm once
   * initialized a runtime, even if that runtime has since been terminated.
   */
  readonly initialization: PrewarmState
  /** Outcome of the latest settled prewarm that still described a live runtime. */
  readonly outcome: PrewarmOutcome | null
  /** Liveness of the bridge's current worker generation right now. */
  readonly runtime: RawDecodeBridgeLifecycleSnapshot
}

/**
 * The RAW source session a host owns for one load, together with the
 * cancellation scope that load's native work runs under.
 */
export interface RawRuntimeSessionLease {
  /** Aborts when the lease is cancelled. */
  readonly signal: AbortSignal
  /**
   * Opens the lease's one source. A session that arrives after the lease
   * ended is disposed here, and the open rejects with an `AbortError`.
   */
  open: (file: File) => Promise<RawRuntimeSession>
  /** Ends the lease once its work settled: disposes the session, no abort. */
  release: () => void
  /** Ends the lease early: aborts work still in flight, then disposes. */
  cancel: () => void
}

export interface RawRuntimeHost {
  /** Stable identity until the next lifecycle change. */
  getSnapshot: () => RawRuntimeHostSnapshot
  /** Observing never retains the runtime or delays its idle termination. */
  subscribe: (listener: () => void) => () => void
  prewarm: () => Promise<PrewarmOutcome>
  getPrewarmState: () => PrewarmState
  openSession: (file: File, signal?: AbortSignal) => Promise<RawRuntimeSession>
  extractEmbeddedPreview: (
    file: File,
    signal?: AbortSignal,
  ) => Promise<LumaEmbeddedPreview | null>
  decodeQuickRaw: (
    file: File,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<DecodedImage>
  decodeBoundedHqRaw: (
    file: File,
    options: { maxOutputPixels: number },
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<DecodedImage>
  /** Terminates the runtime's current worker generation. */
  terminateDecodeBridge: () => Promise<void>
  /**
   * Cancels the active session lease, then hands out the next one: the host
   * owns at most one source session at a time.
   */
  beginSession: () => RawRuntimeSessionLease
  /** Cancels the active session lease, if any. */
  cancelSession: () => void
  /**
   * Cancels the active session lease, terminates the runtime, and forgets
   * the prewarm history, including a sticky failure; the host stays usable
   * and starts afresh on the next call.
   */
  dispose: () => void
}

const READY_OUTCOME: PrewarmOutcome = Object.freeze({ status: 'ready' })

const SUPERSEDED_OUTCOME: PrewarmOutcome = Object.freeze({
  status: 'failed',
  reason: 'RAW runtime prewarm was superseded by a runtime termination.',
  recoverable: true,
})

function sessionReleasedError() {
  return new DOMException(
    'The RAW session lease ended before its source opened.',
    'AbortError',
  )
}

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * The single-session slot a host owns: beginning a lease cancels the one
 * before it, and every lease disposes its session exactly once.
 */
export function createRawRuntimeSessionLeases(
  openSession: (file: File, signal: AbortSignal) => Promise<RawRuntimeSession>,
) {
  let activeLease: RawRuntimeSessionLease | null = null

  function begin(): RawRuntimeSessionLease {
    activeLease?.cancel()
    const controller = new AbortController()
    let opened = false
    let ended = false
    let session: RawRuntimeSession | null = null
    const end = (abort: boolean) => {
      if (ended) return
      ended = true
      if (activeLease === lease) activeLease = null
      if (abort) controller.abort()
      const owned = session
      session = null
      owned?.dispose()
    }
    const lease: RawRuntimeSessionLease = {
      signal: controller.signal,
      async open(file) {
        if (ended) throw sessionReleasedError()
        if (opened) throw new Error('A RAW session lease opens one source.')
        opened = true
        const next = await openSession(file, controller.signal)
        if (ended) {
          next.dispose()
          throw sessionReleasedError()
        }
        session = next
        return next
      },
      release: () => end(false),
      cancel: () => end(true),
    }
    activeLease = lease
    return lease
  }

  return {
    begin,
    cancel() {
      activeLease?.cancel()
    },
  }
}

/**
 * One RAW decode bridge plus its prewarm history. Hosts share nothing: each
 * owns its bridge, its runtime generations, and its subscribers.
 */
export function createRawRuntimeHost({
  runtimeFactory = createDefaultLumaRawRuntime,
  createBridge = (options) => new RawDecodeBridge(options),
  idleMs,
  jpegRuntimeAvailabilityProbe = isWasmJpegRuntimeAvailable,
}: RawRuntimeHostOptions = {}): RawRuntimeHost {
  const bridge = createBridge({ runtimeFactory, idleMs })
  const listeners = new Set<
    WorkerBridgeLifecycleListener<RawRuntimeHostSnapshot>
  >()

  let initialization: PrewarmState = 'idle'
  let outcome: PrewarmOutcome | null = null
  let inFlight: { readonly promise: Promise<PrewarmOutcome> } | null = null
  let snapshot = deriveSnapshot()

  function deriveSnapshot(): RawRuntimeHostSnapshot {
    return Object.freeze({
      initialization,
      outcome,
      runtime: bridge.getLifecycleSnapshot(),
    })
  }

  function publish() {
    snapshot = deriveSnapshot()
    notifyLifecycleListeners(listeners, () => snapshot)
  }

  bridge.subscribeLifecycle(publish)

  const sessions = createRawRuntimeSessionLeases((file, signal) =>
    openRawSessionOnBridge(bridge, file, signal, jpegRuntimeAvailabilityProbe),
  )

  function prewarm(): Promise<PrewarmOutcome> {
    if (outcome?.status === 'failed' && outcome.recoverable === false) {
      return Promise.resolve(outcome)
    }
    if (inFlight) return inFlight.promise
    if (
      outcome?.status === 'ready' &&
      bridge.getLifecycleSnapshot().initialized
    ) {
      return Promise.resolve(outcome)
    }

    const previous = { initialization, outcome }
    const terminationAtStart = bridge.getLifecycleSnapshot().lastTermination
    const settle = (next: PrewarmOutcome, describesLiveRuntime: boolean) => {
      // A dispose (or a newer attempt after it) owns the history now.
      if (inFlight === attempt) {
        inFlight = null
        initialization = describesLiveRuntime
          ? next.status
          : previous.initialization
        outcome = describesLiveRuntime ? next : previous.outcome
        publish()
        if (describesLiveRuntime) return next
      }
      return next.status === 'ready' ? SUPERSEDED_OUTCOME : next
    }
    const attempt = {
      promise: bridge.prewarm(createRuntimeSignal()).then(
        () => settle(READY_OUTCOME, bridge.getLifecycleSnapshot().initialized),
        (error: unknown) =>
          settle(
            toPrewarmFailureOutcome(error),
            // A runtime terminated under the attempt says nothing about
            // whether the next one can start.
            !isAbortError(error) &&
              bridge.getLifecycleSnapshot().lastTermination ===
                terminationAtStart,
          ),
      ),
    }
    inFlight = attempt
    initialization = 'pending'
    publish()
    return attempt.promise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    prewarm,
    getPrewarmState: () => snapshot.initialization,
    openSession(file, signal) {
      return openRawSessionOnBridge(
        bridge,
        file,
        signal,
        jpegRuntimeAvailabilityProbe,
      )
    },
    extractEmbeddedPreview(file, signal) {
      return extractEmbeddedPreviewOnBridge(bridge, file, signal)
    },
    decodeQuickRaw(file, onProgress, signal) {
      return decodeQuickRawOnBridge(bridge, file, onProgress, signal)
    },
    decodeBoundedHqRaw(file, options, onProgress, signal) {
      return decodeBoundedHqRawOnBridge(
        bridge,
        file,
        options,
        onProgress,
        signal,
      )
    },
    terminateDecodeBridge() {
      return bridge.terminate()
    },
    beginSession: sessions.begin,
    cancelSession: sessions.cancel,
    dispose() {
      sessions.cancel()
      inFlight = null
      initialization = 'idle'
      outcome = null
      publish()
      void bridge.terminate()
    },
  }
}
