export interface WebGPUDeviceLease {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  /** Idempotent; callers cancelled during acquisition must release after awaiting. */
  release: () => void
  /** Loss is delivered asynchronously, including to subscribers added after loss. */
  onLost: (listener: (info: GPUDeviceLostInfo) => void) => () => void
}

interface LossSubscription {
  active: boolean
  listener: (info: GPUDeviceLostInfo) => void
}

interface SharedDevice {
  ready: Promise<{ adapter: GPUAdapter; device: GPUDevice }>
  device: GPUDevice | null
  references: number
  retired: boolean
  loss: GPUDeviceLostInfo | null
  subscriptions: Set<LossSubscription>
}

let sharedDevice: SharedDevice | null = null

async function requestDevice(): Promise<{
  adapter: GPUAdapter
  device: GPUDevice
}> {
  if (typeof navigator === 'undefined' || !navigator?.gpu) {
    throw new Error('WEBGPU_UNAVAILABLE')
  }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('WEBGPU_ADAPTER_UNAVAILABLE')
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('float32-filterable')
      ? ['float32-filterable']
      : [],
    requiredLimits: {
      maxTextureDimension2D: Math.min(
        16384,
        adapter.limits.maxTextureDimension2D,
      ),
      maxTextureDimension3D: Math.min(
        256,
        adapter.limits.maxTextureDimension3D,
      ),
    },
  })
  return { adapter, device }
}

function notifyLoss(subscription: LossSubscription, info: GPUDeviceLostInfo) {
  // A callback cannot prevent another lease from observing the same loss, and
  // unsubscribe/release can suppress a notification before its microtask runs.
  queueMicrotask(() => {
    if (subscription.active) subscription.listener(info)
  })
}

function createSharedDevice(): SharedDevice {
  const shared: SharedDevice = {
    ready: requestDevice(),
    device: null,
    references: 0,
    retired: false,
    loss: null,
    subscriptions: new Set(),
  }
  shared.ready = shared.ready.then(
    (result) => {
      const { device } = result
      shared.device = device
      void device.lost.then((info) => {
        if (shared.retired) return
        shared.loss = info
        if (sharedDevice === shared) sharedDevice = null
        for (const subscription of shared.subscriptions) {
          notifyLoss(subscription, info)
        }
        shared.subscriptions.clear()
      })
      return result
    },
    (error: unknown) => {
      if (sharedDevice === shared) sharedDevice = null
      throw error
    },
  )
  return shared
}

function releaseReference(shared: SharedDevice): void {
  shared.references -= 1
  if (shared.references !== 0) return
  shared.retired = true
  if (sharedDevice === shared) sharedDevice = null
  shared.device?.destroy()
}

/**
 * Share one device across preview, original-reference, and snapshot renderers.
 * Reserve the reference before awaiting so another lease cannot destroy a
 * ready device while an acquisition is pending. Failed requests are retryable.
 */
export async function acquireWebGPUDevice(): Promise<WebGPUDeviceLease> {
  const shared = (sharedDevice ??= createSharedDevice())
  shared.references += 1
  let result: Awaited<SharedDevice['ready']>
  try {
    result = await shared.ready
    if (shared.loss) throw new Error('WEBGPU_DEVICE_LOST')
  } catch (error) {
    releaseReference(shared)
    throw error
  }

  let released = false
  const subscriptions = new Set<LossSubscription>()
  return {
    ...result,
    release() {
      if (released) return
      released = true
      for (const subscription of subscriptions) {
        subscription.active = false
        shared.subscriptions.delete(subscription)
      }
      subscriptions.clear()
      releaseReference(shared)
    },
    onLost(listener) {
      if (released) return () => {}
      const subscription = { active: true, listener }
      subscriptions.add(subscription)
      if (shared.loss) {
        notifyLoss(subscription, shared.loss)
      } else {
        shared.subscriptions.add(subscription)
      }
      return () => {
        subscription.active = false
        subscriptions.delete(subscription)
        shared.subscriptions.delete(subscription)
      }
    },
  }
}
