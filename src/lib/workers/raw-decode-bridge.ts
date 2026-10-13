import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'

import type {
  WorkerBridgeLifecycleListener,
  WorkerBridgeLifecycleSnapshot,
} from './worker-bridge'
import { notifyLifecycleListeners, WorkerBridge } from './worker-bridge'

type RuntimeApi = Pick<LumaRawRuntime, 'init' | 'openSession'>

export interface RawDecodeBridgeOptions {
  runtimeFactory: () => LumaRawRuntime | Promise<LumaRawRuntime>
  idleMs?: number
}

export interface RawDecodeBridgeLifecycleSnapshot {
  /**
   * Most recently published runtime worker generation; 0 before the first. A
   * start cancelled before it publishes uses up a generation but never shows
   * here.
   */
  readonly generation: number
  /** A runtime handle exists for `generation`. */
  readonly workerAlive: boolean
  /** Runtime `init` succeeded on the live `generation`. */
  readonly initialized: boolean
  readonly lastTermination: WorkerBridgeLifecycleSnapshot['lastTermination']
}

export class RawDecodeBridge {
  private readonly bridge: WorkerBridge<RuntimeApi>
  private initializedGeneration = 0
  private lifecycle: RawDecodeBridgeLifecycleSnapshot
  private readonly lifecycleListeners = new Set<
    WorkerBridgeLifecycleListener<RawDecodeBridgeLifecycleSnapshot>
  >()

  constructor(options: RawDecodeBridgeOptions) {
    this.bridge = new WorkerBridge<RuntimeApi>({
      idleMs: options.idleMs,
      startWorker: async ({ generation }) => {
        const runtime = await options.runtimeFactory()
        const api: RuntimeApi = {
          init: async (...args) => {
            const result = await runtime.init(...args)
            this.markInitialized(generation)
            return result
          },
          openSession: runtime.openSession.bind(runtime),
        }

        return {
          api,
          terminate: () => runtime.dispose(),
        }
      },
    })
    this.lifecycle = this.deriveLifecycle()
    this.bridge.subscribeLifecycle(() => this.publishLifecycle())
  }

  /**
   * Liveness of the runtime worker as the bridge sees it now: an idle, abort,
   * or explicit termination clears `workerAlive` and `initialized` even when
   * an earlier prewarm succeeded. Stable identity between changes.
   */
  getLifecycleSnapshot(): RawDecodeBridgeLifecycleSnapshot {
    return this.lifecycle
  }

  subscribeLifecycle(
    listener: WorkerBridgeLifecycleListener<RawDecodeBridgeLifecycleSnapshot>,
  ): () => void {
    this.lifecycleListeners.add(listener)
    return () => {
      this.lifecycleListeners.delete(listener)
    }
  }

  prewarm(signal: AbortSignal): ReturnType<LumaRawRuntime['init']> {
    return this.bridge.call('init', signal)
  }

  /**
   * The session talks to the runtime worker directly (quick decode, export
   * probe, bounded HQ), never through this queue, so it holds the worker open
   * until `dispose()`; the idle timer would otherwise kill it mid-decode.
   */
  async openSession(
    signal: AbortSignal,
    ...args: Parameters<LumaRawRuntime['openSession']>
  ): ReturnType<LumaRawRuntime['openSession']> {
    const { value: session, release } = await this.bridge.callRetained(
      'openSession',
      signal,
      ...args,
    )
    return {
      ...session,
      dispose() {
        try {
          session.dispose()
        } finally {
          release()
        }
      },
    }
  }

  terminate(): Promise<void> {
    return this.bridge.terminate()
  }

  private markInitialized(generation: number) {
    // An init that settles after its worker was terminated belongs to an
    // obsolete generation and must not mark the current one initialized.
    const worker = this.bridge.getLifecycleSnapshot()
    if (!worker.alive || worker.generation !== generation) return
    if (this.initializedGeneration === generation) return
    this.initializedGeneration = generation
    this.publishLifecycle()
  }

  private deriveLifecycle(): RawDecodeBridgeLifecycleSnapshot {
    const worker = this.bridge.getLifecycleSnapshot()
    return Object.freeze({
      generation: worker.generation,
      workerAlive: worker.alive,
      initialized:
        worker.alive && this.initializedGeneration === worker.generation,
      lastTermination: worker.lastTermination,
    })
  }

  private publishLifecycle() {
    this.lifecycle = this.deriveLifecycle()
    notifyLifecycleListeners(this.lifecycleListeners, () => this.lifecycle)
  }
}
