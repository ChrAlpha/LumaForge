import { isWasmJpegRuntimeAvailable } from '@lumaforge/render-engine/export'

import type {
  RawDecodeBridgeLifecycleSnapshot,
  RawDecodeBridgeOptions,
} from '~/lib/workers/raw-decode-bridge'
import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'
import type { WorkerBridgeLifecycleListener } from '~/lib/workers/worker-bridge'
import { notifyLifecycleListeners } from '~/lib/workers/worker-bridge'

import {
  createDefaultLumaRawRuntime,
  isAbortError,
  openRawSessionOnBridge,
  rawJobCancelledError,
  toPrewarmFailureOutcome,
} from './luma-runtime-adapter'
import type {
  JpegRuntimeAvailabilityProbe,
  PrewarmOutcome,
  PrewarmState,
  RawRuntimeSession,
} from './runtime-adapter'

export interface RawRuntimeHostOptions {
  /** Builds the RAW runtime for each worker generation. */
  runtimeFactory?: RawDecodeBridgeOptions['runtimeFactory']
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
  /**
   * Liveness of the host's current runtime generation right now. Generations
   * count on across every bridge the host has owned.
   */
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
   * Warms the runtime the lease's source will open on. A lease cancelled
   * while it waits ends that runtime generation, so its successor warms a
   * fresh one instead of waiting on an init that may never answer; the wait
   * then rejects with `RAW_JOB_CANCELLED`.
   */
  prewarm: () => Promise<PrewarmOutcome>
  /**
   * Opens the lease's one source. A session that arrives after the lease
   * ended is disposed here, and the open rejects with `RAW_JOB_CANCELLED`.
   */
  open: (file: File) => Promise<RawRuntimeSession>
  /** Ends the lease once its work settled: disposes the session, no abort. */
  release: () => void
  /**
   * Ends the lease early: aborts work still in flight, disposes the session,
   * and ends the runtime generation the lease's native work runs on.
   */
  cancel: () => void
}

export interface RawRuntimeHost {
  /** Stable identity until the next lifecycle change. */
  getSnapshot: () => RawRuntimeHostSnapshot
  /** Observing never retains the runtime or delays its idle termination. */
  subscribe: (listener: () => void) => () => void
  prewarm: () => Promise<PrewarmOutcome>
  getPrewarmState: () => PrewarmState
  /**
   * Cancels the active session lease and ends the current runtime
   * generation; the next call starts a fresh one.
   */
  terminateDecodeBridge: () => Promise<void>
  /**
   * Cancels the active session lease, then hands out the next one: the host
   * owns at most one source session at a time.
   */
  beginSession: () => RawRuntimeSessionLease
  /** Cancels the active session lease, if any. */
  cancelSession: () => void
  /**
   * Cancels the active session lease, ends the runtime generation, and
   * forgets the prewarm history, including a sticky failure; the host stays
   * usable and starts afresh on the next call.
   */
  dispose: () => void
}

const READY_OUTCOME: PrewarmOutcome = Object.freeze({ status: 'ready' })

const SUPERSEDED_OUTCOME: PrewarmOutcome = Object.freeze({
  status: 'failed',
  reason: 'RAW runtime prewarm was superseded by a runtime termination.',
  recoverable: true,
})

function sessionEndedError() {
  return rawJobCancelledError(
    'The RAW session lease ended before its source opened.',
  )
}

function generationEndedError() {
  return rawJobCancelledError(
    'The RAW runtime generation ended before the request settled.',
  )
}

/**
 * Settles with `work`, or rejects with `cancelled()` as soon as `signal`
 * aborts, so a caller never waits on work that will not answer. Whatever
 * the work produces after that is dropped.
 */
function untilAborted<T>(
  signal: AbortSignal,
  work: Promise<T>,
  cancelled: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The single-session slot a host owns: beginning a lease cancels the one
 * before it, and every lease disposes its session exactly once.
 *
 * `claimGeneration` runs as a lease starts native work (its prewarm or its
 * open) and returns what ends the runtime generation that work runs on.
 * Cancelling a lease that is warming, opening, or holds a source calls it:
 * native work in flight cannot be interrupted, so ending its generation is
 * what keeps that work from running ahead of the next lease. A lease
 * released once its work settled leaves the warm runtime to its successor.
 */
export function createRawRuntimeSessionLeases(
  openSession: (file: File, signal: AbortSignal) => Promise<RawRuntimeSession>,
  {
    prewarm = () => Promise.resolve(READY_OUTCOME),
    claimGeneration = () => () => {},
  }: {
    prewarm?: () => Promise<PrewarmOutcome>
    claimGeneration?: () => () => void
  } = {},
) {
  let activeLease: RawRuntimeSessionLease | null = null

  function begin(): RawRuntimeSessionLease {
    activeLease?.cancel()
    const controller = new AbortController()
    let opened = false
    let warming = 0
    let opening = false
    let ended = false
    let session: RawRuntimeSession | null = null
    let endGeneration: (() => void) | null = null
    const end = (abort: boolean) => {
      if (ended) return
      ended = true
      if (activeLease === lease) activeLease = null
      const nativeWork = abort && (warming > 0 || opening || session !== null)
      const owned = session
      session = null
      owned?.dispose()
      // End the generation before aborting, so its bridge records an explicit
      // termination rather than the lease's aborted call.
      if (nativeWork) endGeneration?.()
      if (abort) controller.abort()
    }
    const lease: RawRuntimeSessionLease = {
      signal: controller.signal,
      prewarm() {
        if (ended) return Promise.reject(sessionEndedError())
        warming += 1
        endGeneration = claimGeneration()
        const warmed = prewarm().finally(() => {
          warming -= 1
        })
        // A cancelled wait rejects at once, even if the init never answers.
        return untilAborted(controller.signal, warmed, sessionEndedError)
      },
      async open(file) {
        if (ended) throw sessionEndedError()
        if (opened) throw new Error('A RAW session lease opens one source.')
        opened = true
        opening = true
        endGeneration = claimGeneration()
        const adopted = openSession(file, controller.signal).then(
          (next) => {
            opening = false
            if (ended) {
              next.dispose()
              throw sessionEndedError()
            }
            session = next
            return next
          },
          (error: unknown) => {
            opening = false
            throw error
          },
        )
        // A cancelled open rejects at once, even if its source never answers.
        return untilAborted(controller.signal, adopted, sessionEndedError)
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

/** A decode bridge the host owns until it ends that bridge's generation. */
interface OwnedBridge {
  readonly bridge: RawDecodeBridge
  /** Aborts once the host ended this bridge's generation. */
  readonly retirement: AbortController
  readonly unsubscribe: () => void
  terminated: Promise<void> | null
}

interface PrewarmAttempt {
  readonly owner: OwnedBridge
  readonly previous: {
    readonly initialization: PrewarmState
    readonly outcome: PrewarmOutcome | null
  }
  readonly promise: Promise<PrewarmOutcome>
}

/**
 * One RAW decode bridge at a time plus its prewarm history. Hosts share
 * nothing: each owns its bridges, its runtime generations, and its
 * subscribers.
 */
export function createRawRuntimeHost({
  runtimeFactory = createDefaultLumaRawRuntime,
  idleMs,
  jpegRuntimeAvailabilityProbe = isWasmJpegRuntimeAvailable,
}: RawRuntimeHostOptions = {}): RawRuntimeHost {
  const listeners = new Set<
    WorkerBridgeLifecycleListener<RawRuntimeHostSnapshot>
  >()

  let initialization: PrewarmState = 'idle'
  let outcome: PrewarmOutcome | null = null
  let inFlight: PrewarmAttempt | null = null
  // Generations published by the bridges this host already ended, so the
  // numbering it reports keeps counting across them.
  let endedGenerations = 0
  let endedTermination: RawDecodeBridgeLifecycleSnapshot['lastTermination'] =
    null
  let owned = ownBridge()
  let snapshot = deriveSnapshot()

  function ownBridge(): OwnedBridge {
    const bridge = new RawDecodeBridge({ runtimeFactory, idleMs })
    return {
      bridge,
      retirement: new AbortController(),
      unsubscribe: bridge.subscribeLifecycle(publish),
      terminated: null,
    }
  }

  function deriveRuntime(): RawDecodeBridgeLifecycleSnapshot {
    const live = owned.bridge.getLifecycleSnapshot()
    return Object.freeze({
      generation: endedGenerations + live.generation,
      workerAlive: live.workerAlive,
      initialized: live.initialized,
      lastTermination: live.lastTermination
        ? Object.freeze({
            generation: endedGenerations + live.lastTermination.generation,
            reason: live.lastTermination.reason,
          })
        : endedTermination,
    })
  }

  function deriveSnapshot(): RawRuntimeHostSnapshot {
    return Object.freeze({
      initialization,
      outcome,
      runtime: deriveRuntime(),
    })
  }

  function publish() {
    snapshot = deriveSnapshot()
    notifyLifecycleListeners(listeners, () => snapshot)
  }

  /**
   * Ends `owner`'s runtime generation: terminates its worker, drops the
   * bridge with whatever it still has queued behind work that never
   * answers, and moves on to a fresh bridge. Nothing that bridge started can
   * publish afterwards, and ending a generation the host already replaced
   * leaves the replacement alone.
   */
  function endGeneration(owner: OwnedBridge): Promise<void> {
    if (owner.terminated) return owner.terminated
    owner.unsubscribe()
    // Terminate before aborting the generation's requests, so the bridge
    // records an explicit termination rather than an aborted call.
    owner.terminated = owner.bridge.terminate()
    owner.retirement.abort()
    const last = owner.bridge.getLifecycleSnapshot()
    if (last.lastTermination) {
      endedTermination = Object.freeze({
        generation: endedGenerations + last.lastTermination.generation,
        reason: last.lastTermination.reason,
      })
    }
    endedGenerations += last.generation
    owned = ownBridge()
    if (inFlight?.owner === owner) {
      initialization = inFlight.previous.initialization
      outcome = inFlight.previous.outcome
      inFlight = null
    }
    publish()
    return owner.terminated
  }

  const sessions = createRawRuntimeSessionLeases(
    (file, signal) =>
      openRawSessionOnBridge(
        owned.bridge,
        file,
        signal,
        jpegRuntimeAvailabilityProbe,
      ),
    {
      prewarm: () => prewarm(),
      claimGeneration() {
        const owner = owned
        return () => {
          void endGeneration(owner)
        }
      },
    },
  )

  function prewarm(): Promise<PrewarmOutcome> {
    if (outcome?.status === 'failed' && outcome.recoverable === false) {
      return Promise.resolve(outcome)
    }
    if (inFlight) return inFlight.promise
    const owner = owned
    const { bridge } = owner
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
    const retirement = owner.retirement.signal
    const attempt: PrewarmAttempt = {
      owner,
      previous,
      promise: untilAborted(
        retirement,
        bridge.prewarm(retirement),
        generationEndedError,
      ).then(
        () => settle(READY_OUTCOME, bridge.getLifecycleSnapshot().initialized),
        (error: unknown) =>
          retirement.aborted
            ? settle(SUPERSEDED_OUTCOME, false)
            : settle(
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
    terminateDecodeBridge() {
      const owner = owned
      sessions.cancel()
      return endGeneration(owner)
    },
    beginSession: sessions.begin,
    cancelSession: sessions.cancel,
    dispose() {
      const owner = owned
      sessions.cancel()
      void endGeneration(owner)
      inFlight = null
      initialization = 'idle'
      outcome = null
      publish()
    },
  }
}
