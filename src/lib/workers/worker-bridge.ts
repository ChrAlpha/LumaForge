export interface WorkerBridgeHandle<TApi> {
  api: TApi
  terminate: () => void | Promise<void>
}

export interface WorkerBridgeStartContext {
  /**
   * Generation the started handle is published under. Every start gets a fresh
   * one, including starts that are cancelled before they publish.
   */
  generation: number
}

export interface WorkerBridgeOptions<TApi> {
  startWorker: (
    context: WorkerBridgeStartContext,
  ) => WorkerBridgeHandle<TApi> | Promise<WorkerBridgeHandle<TApi>>
  idleMs?: number
}

export type WorkerBridgeTerminationReason = 'idle' | 'explicit' | 'abort'

export interface WorkerBridgeLifecycleSnapshot {
  /** Most recently published worker generation; 0 before the first start. */
  readonly generation: number
  /** Whether that generation's handle is still the bridge's live handle. */
  readonly alive: boolean
  readonly lastTermination: {
    readonly generation: number
    readonly reason: WorkerBridgeTerminationReason
  } | null
}

export type WorkerBridgeLifecycleListener<TSnapshot> = (
  snapshot: TSnapshot,
) => void

/**
 * Observers only read lifecycle snapshots; a throwing observer is reported and
 * skipped so it can neither break the bridge operation that published the
 * change nor starve the observers after it. An observer that changes the
 * lifecycle while being notified (for example by terminating) publishes the
 * newer snapshot to every observer itself, so the older one stops here and is
 * never delivered after it.
 */
export function notifyLifecycleListeners<TSnapshot>(
  listeners: ReadonlySet<WorkerBridgeLifecycleListener<TSnapshot>>,
  getSnapshot: () => TSnapshot,
) {
  const snapshot = getSnapshot()
  for (const listener of [...listeners]) {
    if (getSnapshot() !== snapshot) return
    try {
      listener(snapshot)
    } catch (error) {
      console.error('Worker bridge lifecycle listener failed.', error)
    }
  }
}

const INITIAL_LIFECYCLE_SNAPSHOT: WorkerBridgeLifecycleSnapshot = Object.freeze(
  { generation: 0, alive: false, lastTermination: null },
)

const DEFAULT_IDLE_MS = 10_000

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

function terminatedError() {
  return new DOMException('Worker bridge terminated', 'AbortError')
}

type WorkerBridgeMethod = (...args: any[]) => Promise<any>
type WorkerBridgeArgs<
  TApi,
  K extends keyof TApi,
> = TApi[K] extends WorkerBridgeMethod ? Parameters<TApi[K]> : never
type WorkerBridgeResult<
  TApi,
  K extends keyof TApi,
> = TApi[K] extends WorkerBridgeMethod ? Awaited<ReturnType<TApi[K]>> : never

export class WorkerBridge<TApi extends object> {
  private _queue: Promise<unknown> = Promise.resolve()
  private _handle: WorkerBridgeHandle<TApi> | null = null
  private _lifecycle = INITIAL_LIFECYCLE_SNAPSHOT
  private _lastStartedGeneration = 0
  // The start a queued call is waiting on; terminating cancels it.
  private _pendingStart: { cancel: () => void } | null = null
  private readonly _lifecycleListeners = new Set<
    WorkerBridgeLifecycleListener<WorkerBridgeLifecycleSnapshot>
  >()
  private _idleTimer: ReturnType<typeof setTimeout> | null = null
  private _activeCalls = 0
  // Results that keep talking to the worker outside this queue (an open RAW
  // session) hold a lease; the idle timer only runs once none are left.
  private readonly _leases = new Set<object>()
  private readonly _startWorker: WorkerBridgeOptions<TApi>['startWorker']
  private readonly _idleMs: number

  constructor(options: WorkerBridgeOptions<TApi>) {
    this._startWorker = options.startWorker
    this._idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  }

  call<K extends keyof TApi>(
    method: K,
    signal: AbortSignal,
    ...args: WorkerBridgeArgs<TApi, K>
  ): Promise<WorkerBridgeResult<TApi, K>> {
    return this._enqueue(signal, async (handle) => {
      const apiMethod = handle.api[method] as WorkerBridgeMethod
      return (await apiMethod(...args)) as WorkerBridgeResult<TApi, K>
    })
  }

  /**
   * Like `call`, but keeps the worker alive past the idle window until
   * `release` runs. An explicit `terminate()` (or an aborted call) still stops
   * the worker and drops every lease.
   */
  callRetained<K extends keyof TApi>(
    method: K,
    signal: AbortSignal,
    ...args: WorkerBridgeArgs<TApi, K>
  ): Promise<{ value: WorkerBridgeResult<TApi, K>; release: () => void }> {
    return this._enqueue(signal, async (handle) => {
      const apiMethod = handle.api[method] as WorkerBridgeMethod
      const value = (await apiMethod(...args)) as WorkerBridgeResult<TApi, K>
      return { value, release: this._retain(handle) }
    })
  }

  /**
   * Snapshot of the worker this bridge currently owns. The object identity is
   * stable until the next lifecycle change, so it can back an external store.
   */
  getLifecycleSnapshot(): WorkerBridgeLifecycleSnapshot {
    return this._lifecycle
  }

  /**
   * Observe worker starts and idle, explicit, or abort terminations. Observing
   * never retains the worker or delays its idle termination.
   */
  subscribeLifecycle(
    listener: WorkerBridgeLifecycleListener<WorkerBridgeLifecycleSnapshot>,
  ): () => void {
    this._lifecycleListeners.add(listener)
    return () => {
      this._lifecycleListeners.delete(listener)
    }
  }

  terminate(): Promise<void> {
    return this._terminate('explicit')
  }

  private async _terminate(reason: WorkerBridgeTerminationReason) {
    this._cancelIdleTimer()
    this._leases.clear()
    const pendingStart = this._pendingStart
    this._pendingStart = null
    pendingStart?.cancel()
    const handle = this._handle
    this._handle = null
    if (!handle) return
    const generation = this._lifecycle.generation
    this._publishLifecycle({
      generation,
      alive: false,
      lastTermination: { generation, reason },
    })
    await handle.terminate()
  }

  /**
   * Starts and publishes a new generation. An abort of the calling signal or a
   * termination while the start is in flight rejects the caller at once, so
   * the queue moves on; the handle that arrives later belongs to an obsolete
   * generation and is disposed exactly once without being published.
   */
  private _startWorkerGeneration(
    signal: AbortSignal,
  ): Promise<WorkerBridgeHandle<TApi>> {
    this._lastStartedGeneration += 1
    const generation = this._lastStartedGeneration
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = () => {
        if (settled) return false
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (this._pendingStart === pendingStart) this._pendingStart = null
        return true
      }
      const cancelWith = (error: DOMException) => {
        if (settle()) reject(error)
      }
      const pendingStart = { cancel: () => cancelWith(terminatedError()) }
      const onAbort = () => cancelWith(abortError())
      this._pendingStart = pendingStart
      signal.addEventListener('abort', onAbort, { once: true })

      let started: Promise<WorkerBridgeHandle<TApi>>
      try {
        started = Promise.resolve(this._startWorker({ generation }))
      } catch (error) {
        started = Promise.reject(error)
      }
      started.then(
        (handle) => {
          if (!settle()) {
            void this._disposeObsolete(handle)
            return
          }
          this._handle = handle
          this._publishLifecycle({
            generation,
            alive: true,
            lastTermination: this._lifecycle.lastTermination,
          })
          resolve(handle)
        },
        (error: unknown) => {
          if (settle()) reject(error)
        },
      )
    })
  }

  private async _disposeObsolete(handle: WorkerBridgeHandle<TApi>) {
    try {
      await handle.terminate()
    } catch (error) {
      console.error(
        'Worker bridge failed to dispose an obsolete worker.',
        error,
      )
    }
  }

  private _publishLifecycle(snapshot: WorkerBridgeLifecycleSnapshot) {
    this._lifecycle = Object.freeze(snapshot)
    notifyLifecycleListeners(this._lifecycleListeners, () => this._lifecycle)
  }

  private _enqueue<T>(
    signal: AbortSignal,
    invoke: (handle: WorkerBridgeHandle<TApi>) => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (signal.aborted) throw abortError()
      this._cancelIdleTimer()
      this._activeCalls += 1
      try {
        const handle =
          this._handle ?? (await this._startWorkerGeneration(signal))
        // Publishing a start notifies observers, which may abort the call
        // (while notified, or in a microtask queued then) or terminate the
        // worker before the operation runs. Either way the operation is
        // skipped. An abort here leaves the published worker live: it is
        // healthy and unused, so the next call reuses it and the idle timer
        // disposes it if none comes.
        if (signal.aborted) throw abortError()
        if (this._handle !== handle) throw terminatedError()
        // From here on an abort terminates the worker, but only while this
        // call's worker is still the live one; the listener is removed once
        // the operation settles, so an old signal never stops a replacement.
        const onAbort = () => {
          if (this._handle === handle) void this._terminate('abort')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          return await invoke(handle)
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } finally {
        this._activeCalls -= 1
        this._scheduleIdleTimer()
      }
    }

    const next = this._queue.catch(() => undefined).then(run)
    this._queue = next.catch(() => undefined)
    return next
  }

  private _retain(handle: WorkerBridgeHandle<TApi>) {
    // The worker this result belongs to is already gone (aborted mid-call).
    if (this._handle !== handle) return () => {}
    const lease = {}
    this._leases.add(lease)
    return () => {
      if (this._leases.delete(lease)) this._scheduleIdleTimer()
    }
  }

  private _scheduleIdleTimer() {
    this._cancelIdleTimer()
    if (this._activeCalls > 0 || this._leases.size > 0) return
    this._idleTimer = setTimeout(() => {
      void this._terminate('idle')
    }, this._idleMs)
  }

  private _cancelIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }
}
