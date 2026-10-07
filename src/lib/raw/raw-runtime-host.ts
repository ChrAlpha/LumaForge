import { isWasmJpegRuntimeAvailable } from '@lumaforge/render-engine/export'

import type {
  RawDecodeBridgeLifecycleSnapshot,
  RawDecodeBridgeOptions,
} from '~/lib/workers/raw-decode-bridge'
import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'
import type { WorkerBridgeLifecycleListener } from '~/lib/workers/worker-bridge'
import { notifyLifecycleListeners } from '~/lib/workers/worker-bridge'

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
  RawRuntimeAdapter,
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

export interface RawRuntimeHost extends RawRuntimeAdapter {
  /** Stable identity until the next lifecycle change. */
  getSnapshot: () => RawRuntimeHostSnapshot
  /** Observing never retains the runtime or delays its idle termination. */
  subscribe: (listener: () => void) => () => void
  extractEmbeddedPreview: (
    file: File,
    signal?: AbortSignal,
  ) => ReturnType<RawRuntimeAdapter['extractEmbeddedPreview']>
  decodeQuickRaw: (
    file: File,
    onProgress?: Parameters<RawRuntimeAdapter['decodeQuickRaw']>[1],
    signal?: AbortSignal,
  ) => ReturnType<RawRuntimeAdapter['decodeQuickRaw']>
  decodeBoundedHqRaw: (
    file: File,
    options: { maxOutputPixels: number },
    onProgress?: Parameters<RawRuntimeAdapter['decodeBoundedHqRaw']>[2],
    signal?: AbortSignal,
  ) => ReturnType<RawRuntimeAdapter['decodeBoundedHqRaw']>
  /**
   * Terminates the runtime and forgets the prewarm history, including a
   * sticky failure; the host stays usable and starts afresh on the next call.
   */
  dispose: () => void
}

const READY_OUTCOME: PrewarmOutcome = Object.freeze({ status: 'ready' })

const SUPERSEDED_OUTCOME: PrewarmOutcome = Object.freeze({
  status: 'failed',
  reason: 'RAW runtime prewarm was superseded by a runtime termination.',
  recoverable: true,
})

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
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
    dispose() {
      inFlight = null
      initialization = 'idle'
      outcome = null
      publish()
      void bridge.terminate()
    },
  }
}
