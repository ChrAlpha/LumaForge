export interface WebGPUFrameSchedulerStats {
  submitted: number
  coalesced: number
  inFlight: number
  /** Observed peak, bounded by the configured capacity. */
  maxInFlight: number
}

/** Bound submitted frames and retain only one request to draw the latest state. */
export class WebGPUFrameScheduler {
  private inFlight = 0
  private peakInFlight = 0
  private submitted = 0
  private coalesced = 0
  private pending = false
  private disposed = false
  private failure: { error: unknown } | null = null
  private readonly waiters = new Set<{
    resolve: () => void
    reject: (error: unknown) => void
  }>()

  constructor(
    private readonly draw: () => void,
    private readonly waitForSubmitted: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly maxInFlight = 2,
  ) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
      throw new Error('GPU_FRAME_LIMIT_INVALID')
  }

  /** True means a frame was submitted synchronously; false includes coalescing. */
  request(): boolean {
    if (this.disposed || this.failure) return false
    if (this.inFlight >= this.maxInFlight) {
      this.pending = true
      this.coalesced++
      return false
    }
    return this.submit()
  }

  /** Drain submitted work and its coalesced redraw without blocking the thread. */
  wait(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('WEBGPU_FRAME_SCHEDULER_DISPOSED'))
    if (this.failure) return Promise.reject(this.failure.error)
    if (this.inFlight === 0 && !this.pending) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waiters.add({ resolve, reject })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = false
    this.inFlight = 0
    this.rejectWaiters(new Error('WEBGPU_FRAME_SCHEDULER_DISPOSED'))
  }

  getStats(): WebGPUFrameSchedulerStats {
    return {
      submitted: this.submitted,
      coalesced: this.coalesced,
      inFlight: this.inFlight,
      maxInFlight: this.peakInFlight,
    }
  }

  private submit(): boolean {
    this.inFlight++
    try {
      this.draw()
      if (this.disposed || this.failure) return false
      this.submitted++
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
      void this.waitForSubmitted().then(
        () => this.complete(),
        (error: unknown) => this.fail(error),
      )
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  private complete(): void {
    if (this.disposed || this.failure) return
    this.inFlight--
    if (this.pending) {
      this.pending = false
      this.submit()
    }
    if (this.inFlight === 0 && !this.pending && !this.failure) {
      for (const waiter of this.waiters) waiter.resolve()
      this.waiters.clear()
    }
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failure) return
    this.failure = { error }
    this.pending = false
    this.inFlight = 0
    this.rejectWaiters(error)
    try {
      this.onError(error)
    } catch {
      // Error reporting cannot create an unhandled observer rejection.
    }
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }
}
