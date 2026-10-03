import { acquireWebGPUDevice } from '~/lib/webgpu/device'

export type PreviewBackend = 'webgpu' | 'cpu'

/**
 * Why the interactive preview runs on the CPU executor:
 * - `webgpu-unavailable`: no WebGPU API, adapter or device, or the probe timed out.
 * - `gpu-preview-failed`: WebGPU was selected but initialization or the device failed.
 * - `forced`: a local validation build requested `?forcePreview=cpu`.
 */
export type CpuPreviewReason =
  | 'webgpu-unavailable'
  | 'gpu-preview-failed'
  | 'forced'

export interface PreviewBackendFacts {
  readonly backend: PreviewBackend
  readonly maxTextureSize: number
  readonly reason: CpuPreviewReason | null
}

export type PreviewBackendState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly facts: PreviewBackendFacts }

const INITIAL_STATE: PreviewBackendState = Object.freeze({ status: 'pending' })
const WEBGPU_PROBE_TIMEOUT_MS = 5000
const listeners = new Set<() => void>()
let state: PreviewBackendState = INITIAL_STATE
let pending: Promise<PreviewBackendFacts> | null = null
let generation = 0

function publish(next: PreviewBackendState) {
  state = Object.freeze(next)
  for (const listener of listeners) listener()
}

function cpuFacts(reason: CpuPreviewReason): PreviewBackendFacts {
  return Object.freeze({ backend: 'cpu', maxTextureSize: 0, reason })
}

/** `?forcePreview=cpu` is honored on dev builds and on localhost only. */
export function getPreviewBackendOverride(): 'cpu' | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('forcePreview')
  if (value !== 'cpu') return null
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    window.location.hostname,
  )
  return !import.meta.env.PROD || local ? 'cpu' : null
}

async function probeWebGPU(): Promise<PreviewBackendFacts> {
  // The probe owns its reference even when the caller stops waiting for it.
  const lease = await acquireWebGPUDevice()
  try {
    return Object.freeze({
      backend: 'webgpu',
      maxTextureSize: lease.device.limits.maxTextureDimension2D,
      reason: null,
    })
  } finally {
    lease.release()
  }
}

async function boundedWebGPUProbe() {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probeWebGPU(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('WebGPU probe timed out')),
          WEBGPU_PROBE_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function probeBackend(): Promise<PreviewBackendFacts> {
  if (getPreviewBackendOverride() === 'cpu') return cpuFacts('forced')
  try {
    return await boundedWebGPUProbe()
  } catch {
    return cpuFacts('webgpu-unavailable')
  }
}

export function resolvePreviewBackend(): Promise<PreviewBackendFacts> {
  if (state.status === 'ready') return Promise.resolve(state.facts)
  if (!pending) {
    const requestGeneration = generation
    pending = probeBackend().then((facts) => {
      if (requestGeneration !== generation) return facts
      // A runtime failure published while probing wins over a late probe.
      if (state.status === 'pending') publish({ status: 'ready', facts })
      return state.status === 'ready' ? state.facts : facts
    })
  }
  return pending
}

export function getPreviewBackendSnapshot(): PreviewBackendFacts | null {
  return state.status === 'ready' ? state.facts : null
}

export function getPreviewBackendState(): PreviewBackendState {
  return state
}
export function getServerPreviewBackendState(): PreviewBackendState {
  return INITIAL_STATE
}
export function subscribePreviewBackend(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Renderer initialization/device failures remount the existing CPU surface. */
export function reportGpuPreviewFailure(error?: unknown): void {
  if (state.status === 'ready' && state.facts.backend === 'cpu') return
  console.warn('WebGPU preview failed; continuing with the CPU preview.', error)
  publish({ status: 'ready', facts: cpuFacts('gpu-preview-failed') })
}

export function resetPreviewBackendForTest(): void {
  generation += 1
  pending = null
  state = INITIAL_STATE
}
