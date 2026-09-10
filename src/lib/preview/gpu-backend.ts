import { createWebGL2Context, detectCapabilities } from '~/lib/gl/context'
import { acquireWebGPUDevice } from '~/lib/webgpu/device'

export type PreviewBackend = 'webgpu' | 'webgl2' | 'cpu'
type CpuReason = 'webgl2-missing' | 'tone-float-precision-low'

export interface PreviewBackendFacts {
  readonly backend: PreviewBackend
  readonly maxTextureSize: number
  readonly maxRenderbufferSize: number
  readonly toneHighPrecision: boolean
  readonly reason: CpuReason | null
}

export type PreviewBackendState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly facts: PreviewBackendFacts }
  | { readonly status: 'failed'; readonly error: Error }

const INITIAL_STATE: PreviewBackendState = Object.freeze({ status: 'pending' })
const listeners = new Set<() => void>()
let state: PreviewBackendState = INITIAL_STATE
let pending: Promise<PreviewBackendFacts> | null = null
let generation = 0

function publish(next: PreviewBackendState) {
  state = Object.freeze(next)
  for (const listener of listeners) listener()
}

function cpuFacts(reason: CpuReason): PreviewBackendFacts {
  return Object.freeze({
    backend: 'cpu',
    maxTextureSize: 0,
    maxRenderbufferSize: 0,
    toneHighPrecision: false,
    reason,
  })
}

export function getPreviewBackendOverride(): PreviewBackend | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('forcePreview')
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    window.location.hostname,
  )
  if (value === 'cpu' && (!import.meta.env.PROD || local)) return value
  if (local && (value === 'webgpu' || value === 'webgl2')) return value
  return null
}

async function probeWebGPU(): Promise<PreviewBackendFacts> {
  // The probe owns its reference even when the caller stops waiting for it.
  const lease = await acquireWebGPUDevice()
  try {
    const maxTextureSize = lease.device.limits.maxTextureDimension2D
    return Object.freeze({
      backend: 'webgpu',
      maxTextureSize,
      maxRenderbufferSize: maxTextureSize,
      toneHighPrecision: true,
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
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function probeWebGL(): PreviewBackendFacts {
  if (typeof document === 'undefined') return cpuFacts('webgl2-missing')
  const canvas = document.createElement('canvas')
  const gl = createWebGL2Context(canvas)
  if (!gl) return cpuFacts('webgl2-missing')
  try {
    const capabilities = detectCapabilities(gl)
    if (!capabilities.toneHighPrecision)
      return cpuFacts('tone-float-precision-low')
    return Object.freeze({
      backend: 'webgl2',
      maxTextureSize: capabilities.maxTextureSize,
      maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
      toneHighPrecision: true,
      reason: null,
    })
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

async function probeBackend(): Promise<PreviewBackendFacts> {
  const forced = getPreviewBackendOverride()
  if (forced === 'cpu') return cpuFacts('tone-float-precision-low')
  if (forced !== 'webgl2') {
    try {
      return await boundedWebGPUProbe()
    } catch (error) {
      if (forced === 'webgpu')
        throw new Error('WebGPU preview is unavailable on this device.', {
          cause: error,
        })
    }
  }
  let facts: PreviewBackendFacts
  try {
    facts = probeWebGL()
  } catch {
    facts = cpuFacts('webgl2-missing')
  }
  if (forced === 'webgl2' && facts.backend !== 'webgl2') {
    throw new Error('WebGL2 preview is unavailable on this device.')
  }
  return facts
}

export function resolvePreviewBackend(): Promise<PreviewBackendFacts> {
  if (state.status === 'ready') return Promise.resolve(state.facts)
  if (state.status === 'failed') return Promise.reject(state.error)
  if (!pending) {
    const requestGeneration = generation
    pending = probeBackend().then(
      (facts) => {
        if (requestGeneration !== generation) return facts
        if (state.status === 'pending') publish({ status: 'ready', facts })
        if (state.status === 'failed') throw state.error
        return state.status === 'ready' ? state.facts : facts
      },
      (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error))
        if (requestGeneration === generation) {
          if (state.status === 'pending')
            publish({ status: 'failed', error: failure })
          if (state.status === 'ready') return state.facts
          if (state.status === 'failed') throw state.error
        }
        throw failure
      },
    )
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
  const forced = getPreviewBackendOverride()
  if (forced === 'webgpu' || forced === 'webgl2') {
    publish({
      status: 'failed',
      error:
        error instanceof Error ? error : new Error(`${forced} preview failed.`),
    })
    return
  }
  if (state.status === 'ready' && state.facts.backend === 'cpu') return
  publish({ status: 'ready', facts: cpuFacts('webgl2-missing') })
}

export function resetPreviewBackendForTest(): void {
  generation += 1
  pending = null
  state = INITIAL_STATE
}
