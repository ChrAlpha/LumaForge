import { describe, expect, it, vi } from 'vitest'

import { WebGPUFrameScheduler } from './frame-scheduler'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function flushCompletion() {
  await Promise.resolve()
  await Promise.resolve()
}

function fixture(limit = 2) {
  const frames: ReturnType<typeof deferred>[] = []
  let latest = 0
  const drawn: number[] = []
  const onError = vi.fn()
  const scheduler = new WebGPUFrameScheduler(
    () => drawn.push(latest),
    () => {
      const frame = deferred()
      frames.push(frame)
      return frame.promise
    },
    onError,
    limit,
  )
  return {
    scheduler,
    frames,
    drawn,
    onError,
    request(value: number) {
      latest = value
      return scheduler.request()
    },
  }
}

describe('bounded WebGPU frame scheduling', () => {
  it('submits two frames synchronously and coalesces a burst to its latest state', async () => {
    const { scheduler, request, frames, drawn } = fixture()
    expect(request(1)).toBe(true)
    expect(request(2)).toBe(true)
    for (const value of [3, 4, 5]) expect(request(value)).toBe(false)
    expect(drawn).toEqual([1, 2])
    expect(scheduler.getStats()).toEqual({
      submitted: 2,
      coalesced: 3,
      inFlight: 2,
      maxInFlight: 2,
    })

    frames[0].resolve()
    await flushCompletion()
    expect(drawn).toEqual([1, 2, 5])
    expect(scheduler.getStats().inFlight).toBe(2)
    frames[1].resolve()
    frames[2].resolve()
    await scheduler.wait()
    expect(scheduler.getStats()).toEqual({
      submitted: 3,
      coalesced: 3,
      inFlight: 0,
      maxInFlight: 2,
    })
  })

  it('drains the pending redraw and supports multiple simultaneous waiters', async () => {
    const { scheduler, request, frames, drawn } = fixture()
    request(1)
    request(2)
    request(3)
    const completed = vi.fn()
    const first = scheduler.wait().then(completed)
    const second = scheduler.wait().then(completed)
    frames[0].resolve()
    frames[1].resolve()
    await flushCompletion()
    expect(drawn).toEqual([1, 2, 3])
    expect(completed).not.toHaveBeenCalled()
    frames[2].resolve()
    await Promise.all([first, second])
    expect(completed).toHaveBeenCalledTimes(2)
  })

  it('reports synchronous draw failure and makes subsequent waits reject', async () => {
    const error = new Error('draw failed')
    const waitForSubmitted = vi.fn()
    const onError = vi.fn()
    const scheduler = new WebGPUFrameScheduler(
      () => {
        throw error
      },
      waitForSubmitted,
      onError,
    )
    expect(scheduler.request()).toBe(false)
    expect(waitForSubmitted).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    await expect(scheduler.wait()).rejects.toBe(error)
    expect(scheduler.request()).toBe(false)
    expect(scheduler.getStats().inFlight).toBe(0)
  })

  it('handles synchronous completion-observer failure after a draw', async () => {
    const error = new Error('completion observer failed')
    const draw = vi.fn()
    const onError = vi.fn()
    const scheduler = new WebGPUFrameScheduler(
      draw,
      () => {
        throw error
      },
      onError,
    )
    expect(scheduler.request()).toBe(false)
    expect(draw).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    await expect(scheduler.wait()).rejects.toBe(error)
  })

  it('handles rejected GPU work and throwing error listeners without unhandled rejections', async () => {
    const first = deferred()
    const second = deferred()
    const error = new Error('device lost')
    const draw = vi.fn()
    const onError = vi.fn(() => {
      throw new Error('listener failed')
    })
    const waitForSubmitted = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const scheduler = new WebGPUFrameScheduler(draw, waitForSubmitted, onError)
    scheduler.request()
    scheduler.request()
    scheduler.request()
    const drained = expect(scheduler.wait()).rejects.toBe(error)
    first.reject(error)
    await drained
    second.reject(new Error('later failure'))
    await flushCompletion()
    expect(draw).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(scheduler.request()).toBe(false)
    expect(scheduler.getStats().inFlight).toBe(0)
  })

  it('rejects drain on disposal and suppresses late completion, redraw, and error callbacks', async () => {
    const { scheduler, request, frames, drawn, onError } = fixture()
    request(1)
    request(2)
    request(3)
    const drained = expect(scheduler.wait()).rejects.toThrow(
      'WEBGPU_FRAME_SCHEDULER_DISPOSED',
    )
    scheduler.dispose()
    await drained
    const stopped = scheduler.getStats()
    frames[0].resolve()
    frames[1].reject(new Error('late device loss'))
    await flushCompletion()
    scheduler.dispose()
    expect(request(4)).toBe(false)
    expect(drawn).toEqual([1, 2])
    expect(onError).not.toHaveBeenCalled()
    expect(scheduler.getStats()).toEqual(stopped)
    await expect(scheduler.wait()).rejects.toThrow(
      'WEBGPU_FRAME_SCHEDULER_DISPOSED',
    )
  })

  it('supports a single-flight limit and rejects invalid capacities', async () => {
    const { scheduler, request, frames, drawn } = fixture(1)
    await expect(scheduler.wait()).resolves.toBeUndefined()
    expect(request(1)).toBe(true)
    expect(request(2)).toBe(false)
    frames[0].resolve()
    await flushCompletion()
    expect(drawn).toEqual([1, 2])
    expect(scheduler.getStats().maxInFlight).toBe(1)
    frames[1].resolve()
    await scheduler.wait()
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity])
      expect(() => fixture(invalid)).toThrow('GPU_FRAME_LIMIT_INVALID')
  })
})
