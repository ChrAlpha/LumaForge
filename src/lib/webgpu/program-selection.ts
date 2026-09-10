import type { WebGPUPrograms } from './programs'
import { getWebGPUPrograms } from './programs'
import type { ShaderSpecialization } from './specialization'
import {
  getShaderSpecializationKey,
  MAX_SHADER_SPECIALIZATIONS,
} from './specialization'

/** Generic programs remain correct while a new feature category compiles.
 * Numeric slider changes neither compile nor block. Only the newest request
 * can install a completed variant; disposal prevents late redraws. */
export class WebGPUProgramSelection {
  current: WebGPUPrograms
  activeKey = 'generic'
  private desiredKey = 'generic'
  private pending: Promise<WebGPUPrograms> | null = null
  private disposed = false
  private readonly ready = new Map<string, WebGPUPrograms>()
  private readonly inFlight = new Map<string, Promise<WebGPUPrograms>>()

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly generic: WebGPUPrograms,
    private readonly onReady: () => void,
  ) {
    this.current = generic
  }

  select(value: ShaderSpecialization): Promise<WebGPUPrograms> {
    if (this.disposed)
      return Promise.reject(new Error('WEBGPU_VARIANT_SELECTION_DISPOSED'))
    const key = getShaderSpecializationKey(value)
    if (this.desiredKey === key)
      return this.pending ?? Promise.resolve(this.current)
    this.desiredKey = key
    const cached = this.ready.get(key)
    this.current = cached ?? this.generic
    this.activeKey = cached ? key : 'generic'
    if (cached) {
      this.ready.delete(key)
      this.ready.set(key, cached)
      this.pending = null
      return Promise.resolve(cached)
    }
    const existing = this.inFlight.get(key)
    if (existing) {
      this.pending = existing
      return existing
    }
    const pending = getWebGPUPrograms(this.device, this.format, value)
      .then(
        (programs) => {
          if (this.disposed) return this.current
          this.ready.set(key, programs)
          if (this.ready.size > MAX_SHADER_SPECIALIZATIONS)
            this.ready.delete(this.ready.keys().next().value!)
          if (this.desiredKey === key) {
            this.current = programs
            this.activeKey = key
            this.onReady()
          }
          return programs
        },
        (error) => {
          if (this.disposed || this.desiredKey !== key) return this.current
          if (
            error instanceof Error &&
            error.message === 'WEBGPU_SPECIALIZATION_BUSY'
          ) {
            // The generic executor preserves all color behavior under compile load.
            this.desiredKey = 'generic'
            return this.generic
          }
          throw error
        },
      )
      .finally(() => {
        this.inFlight.delete(key)
        if (this.pending === pending) this.pending = null
      })
    this.inFlight.set(key, pending)
    this.pending = pending
    return pending
  }

  async wait() {
    await this.pending
  }

  dispose() {
    this.disposed = true
    this.pending = null
    this.ready.clear()
    this.inFlight.clear()
  }
}
