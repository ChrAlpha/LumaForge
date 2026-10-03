export interface WorkerBridgeHandle<TApi> {
  api: TApi
  terminate: () => void | Promise<void>
}

export interface WorkerBridgeOptions<TApi> {
  startWorker: () =>
    | WorkerBridgeHandle<TApi>
    | Promise<WorkerBridgeHandle<TApi>>
  idleMs?: number
}

const DEFAULT_IDLE_MS = 10_000

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

  async terminate(): Promise<void> {
    this._cancelIdleTimer()
    this._leases.clear()
    const handle = this._handle
    this._handle = null
    if (handle) await handle.terminate()
  }

  private _enqueue<T>(
    signal: AbortSignal,
    invoke: (handle: WorkerBridgeHandle<TApi>) => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      this._cancelIdleTimer()
      this._activeCalls += 1
      try {
        const handle = (this._handle ??= await this._startWorker())
        const onAbort = () => {
          void this.terminate()
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
      void this.terminate()
    }, this._idleMs)
  }

  private _cancelIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }
}
