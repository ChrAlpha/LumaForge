import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WebGPUProgramSelection } from './program-selection'
import type { WebGPUPrograms } from './programs'
import { getWebGPUPrograms } from './programs'
import {
  getShaderSpecialization,
  getShaderSpecializationKey,
} from './specialization'
import { DEFAULT_PARAMS } from './uniforms'

vi.mock('./programs', () => ({ getWebGPUPrograms: vi.fn() }))

function deferred() {
  let resolve!: (program: WebGPUPrograms) => void
  let reject!: (error: Error) => void
  const promise = new Promise<WebGPUPrograms>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => vi.resetAllMocks())

describe('webGPU asynchronous program selection', () => {
  it('drains a newer category requested while waiting for the previous compilation', async () => {
    const a = deferred()
    const b = deferred()
    vi.mocked(getWebGPUPrograms)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      {} as WebGPUPrograms,
      vi.fn(),
    )
    const pendingA = selection.select(
      getShaderSpecialization(DEFAULT_PARAMS, null),
    )
    let completed = false
    const waiting = selection.wait().then(() => {
      completed = true
    })
    const pendingB = selection.select(
      getShaderSpecialization({ ...DEFAULT_PARAMS, userSaturation: 10 }, null),
    )
    a.resolve({} as WebGPUPrograms)
    await pendingA
    expect(completed).toBe(false)
    b.resolve({} as WebGPUPrograms)
    await pendingB
    await waiting
    expect(completed).toBe(true)
  })
  it('reuses an in-flight category after switching away and back without duplicate redraws', async () => {
    const a = deferred()
    const b = deferred()
    vi.mocked(getWebGPUPrograms)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
    const onReady = vi.fn()
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      {} as WebGPUPrograms,
      onReady,
    )
    const first = getShaderSpecialization(DEFAULT_PARAMS, null)
    const next = getShaderSpecialization(
      { ...DEFAULT_PARAMS, userSaturation: 10 },
      null,
    )
    const pendingA = selection.select(first)
    const pendingB = selection.select(next)
    expect(selection.select(first)).toBe(pendingA)
    a.resolve({} as WebGPUPrograms)
    await pendingA
    b.resolve({} as WebGPUPrograms)
    await pendingB
    expect(getWebGPUPrograms).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledOnce()
  })
  it('keeps a correct generic executor when compilation admission is busy and retries later', async () => {
    const generic = {} as WebGPUPrograms
    const specialized = {} as WebGPUPrograms
    vi.mocked(getWebGPUPrograms)
      .mockRejectedValueOnce(new Error('WEBGPU_SPECIALIZATION_BUSY'))
      .mockResolvedValueOnce(specialized)
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      generic,
      vi.fn(),
    )
    const key = getShaderSpecialization(DEFAULT_PARAMS, null)
    await selection.select(key)
    expect(selection.current).toBe(generic)
    expect(selection.activeKey).toBe('generic')
    await selection.select(key)
    expect(selection.current).toBe(specialized)
  })
  it('ignores stale compilation completions and reuses settled categories synchronously', async () => {
    const a = deferred()
    const b = deferred()
    vi.mocked(getWebGPUPrograms)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
    const generic = {} as WebGPUPrograms
    const first = {} as WebGPUPrograms
    const last = {} as WebGPUPrograms
    const onReady = vi.fn()
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      generic,
      onReady,
    )
    const firstKey = getShaderSpecialization(
      { ...DEFAULT_PARAMS, userSaturation: 10 },
      null,
    )
    const lastKey = getShaderSpecialization(
      { ...DEFAULT_PARAMS, userVibrance: 10 },
      null,
    )
    const pendingA = selection.select(firstKey)
    const pendingB = selection.select(lastKey)
    expect(selection.current).toBe(generic)
    b.resolve(last)
    await pendingB
    a.resolve(first)
    await pendingA
    expect(selection.current).toBe(last)
    expect(selection.activeKey).toBe(getShaderSpecializationKey(lastKey))
    expect(onReady).toHaveBeenCalledOnce()
    const reuse = selection.select(firstKey)
    expect(selection.current).toBe(first)
    await reuse
    expect(getWebGPUPrograms).toHaveBeenCalledTimes(2)
  })
  it('coalesces slider values in one category and suppresses a disposed late completion', async () => {
    const request = deferred()
    vi.mocked(getWebGPUPrograms).mockReturnValue(request.promise)
    const generic = {} as WebGPUPrograms
    const onReady = vi.fn()
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      generic,
      onReady,
    )
    const pending = selection.select(
      getShaderSpecialization({ ...DEFAULT_PARAMS, userSaturation: 10 }, null),
    )
    expect(
      selection.select(
        getShaderSpecialization(
          { ...DEFAULT_PARAMS, userSaturation: 90 },
          null,
        ),
      ),
    ).toBe(pending)
    selection.dispose()
    request.resolve({} as WebGPUPrograms)
    await pending
    expect(selection.current).toBe(generic)
    expect(onReady).not.toHaveBeenCalled()
    expect(getWebGPUPrograms).toHaveBeenCalledOnce()
  })
  it('does not report a stale failed category as the current renderer failure', async () => {
    const request = deferred()
    vi.mocked(getWebGPUPrograms)
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce({} as WebGPUPrograms)
    const selection = new WebGPUProgramSelection(
      {} as GPUDevice,
      'rgba8unorm',
      {} as WebGPUPrograms,
      vi.fn(),
    )
    const stale = selection.select(
      getShaderSpecialization({ ...DEFAULT_PARAMS, userSaturation: 10 }, null),
    )
    await selection.select(getShaderSpecialization(DEFAULT_PARAMS, null))
    request.reject(new Error('old compile failed'))
    await expect(stale).resolves.toBe(selection.current)
  })
})
