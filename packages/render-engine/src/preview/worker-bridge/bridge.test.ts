import { describe, expect, it, vi } from 'vitest'

import type { CpuPreviewWorkerLike } from './bridge'
import { CpuPreviewClient } from './bridge'
import type { CpuPreviewRequest, CpuPreviewResponse } from './protocol'

function fakeWorker() {
  const posted: CpuPreviewRequest[] = []
  let onmessage: ((e: { data: CpuPreviewResponse }) => void) | null = null
  const worker: CpuPreviewWorkerLike = {
    postMessage: (msg: CpuPreviewRequest) => {
      posted.push(msg)
    },
    set onmessage(fn) {
      onmessage = fn
    },
    get onmessage() {
      return onmessage
    },
    set onerror(_fn) {},
    get onerror() {
      return null
    },
    terminate: vi.fn(),
  }
  const respond = (r: CpuPreviewResponse) => onmessage?.({ data: r })
  return { worker, posted, respond }
}

const graph = { steps: [] } as never

describe('cpuPreviewClient', () => {
  it('sends the source exactly once, then renders carry no source data', () => {
    const { worker, posted } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    const data = new Uint16Array(2 * 2 * 3)
    client.loadSource({ sourceId: 's1', width: 2, height: 2, data })
    client.requestRender({ variant: 'processed', graph })
    const loads = posted.filter((m) => m.type === 'loadSource')
    const renders = posted.filter((m) => m.type === 'render')
    expect(loads).toHaveLength(1)
    expect(renders).toHaveLength(1)
    expect('data' in renders[0]).toBe(false)
  })

  it('keeps at most one in-flight render + one pending-latest', () => {
    const { worker, posted, respond } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    client.loadSource({
      sourceId: 's1',
      width: 2,
      height: 2,
      data: new Uint16Array(12),
    })

    for (let i = 0; i < 5; i += 1)
      client.requestRender({ variant: 'processed', graph })
    expect(posted.filter((m) => m.type === 'render')).toHaveLength(1)

    const firstRender = posted.find((m) => m.type === 'render') as Extract<
      CpuPreviewRequest,
      { type: 'render' }
    >
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: firstRender.requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })
    expect(posted.filter((m) => m.type === 'render')).toHaveLength(2)
  })

  it('commits only the latest frame and ignores stale responses', () => {
    const { worker, posted, respond } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    const frames: number[] = []
    client.onFrame((f) => frames.push(f.requestId))
    client.loadSource({
      sourceId: 's1',
      width: 2,
      height: 2,
      data: new Uint16Array(12),
    })
    client.requestRender({ variant: 'processed', graph })
    client.requestRender({ variant: 'processed', graph })

    const renders = posted.filter((m) => m.type === 'render') as Array<
      Extract<CpuPreviewRequest, { type: 'render' }>
    >
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: renders[0].requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })
    const renders2 = posted.filter((m) => m.type === 'render') as Array<
      Extract<CpuPreviewRequest, { type: 'render' }>
    >
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: renders2[1].requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: renders[0].requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })
    expect(frames).toEqual([renders[0].requestId, renders2[1].requestId])
  })

  it('hands each frame the render request it answers', () => {
    const { worker, posted, respond } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    const answered: unknown[] = []
    client.onFrame((_frame, request) => answered.push(request))
    client.loadSource({
      sourceId: 's1',
      width: 2,
      height: 2,
      data: new Uint16Array(12),
    })

    const first = { variant: 'processed' as const, graph }
    const replaced = { variant: 'processed' as const, graph }
    const latest = { variant: 'neutral' as const, graph }
    client.requestRender(first)
    client.requestRender(replaced)
    client.requestRender(latest)

    const renderAt = (index: number) =>
      (
        posted.filter((m) => m.type === 'render') as Array<
          Extract<CpuPreviewRequest, { type: 'render' }>
        >
      )[index]
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: renderAt(0).requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })
    expect(renderAt(1).variant).toBe('neutral')
    respond({
      type: 'rendered',
      sourceId: 's1',
      requestId: renderAt(1).requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })

    expect(answered).toHaveLength(2)
    expect(answered[0]).toBe(first)
    expect(answered[1]).toBe(latest)
  })

  it('reports a render requested with no loaded source instead of dropping it', () => {
    const { worker, posted } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    const onError = vi.fn()
    client.onError(onError)

    client.requestRender({ variant: 'processed', graph })

    // Callers arm in-flight state before requesting; a silent drop would
    // leave that state wedged forever.
    expect(posted.filter((m) => m.type === 'render')).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith('render-failed')
  })

  it('reports worker construction failure without throwing to the caller', () => {
    const client = new CpuPreviewClient(() => {
      throw new Error('boom')
    })
    const errors: string[] = []
    client.onError((reason) => errors.push(reason))

    expect(() =>
      client.loadSource({
        sourceId: 's1',
        width: 2,
        height: 2,
        data: new Uint16Array(12),
      }),
    ).not.toThrow()
    expect(errors).toEqual(['worker-construction-failed'])
  })

  it('reports source transfer failure without throwing to the caller', () => {
    const { worker } = fakeWorker()
    worker.postMessage = () => {
      throw new Error('DataCloneError')
    }
    const client = new CpuPreviewClient(() => worker)
    const errors: string[] = []
    client.onError((reason) => errors.push(reason))

    expect(() =>
      client.loadSource({
        sourceId: 's1',
        width: 2,
        height: 2,
        data: new Uint16Array(12),
      }),
    ).not.toThrow()
    expect(errors).toEqual(['source-transfer-failed'])
  })

  it('ignores stale source errors without clearing the current in-flight render', () => {
    const { worker, posted, respond } = fakeWorker()
    const client = new CpuPreviewClient(() => worker)
    const frames: number[] = []
    const errors: string[] = []
    client.onFrame((f) => frames.push(f.requestId))
    client.onError((reason) => errors.push(reason))

    client.loadSource({
      sourceId: 's1',
      width: 2,
      height: 2,
      data: new Uint16Array(12),
    })
    client.requestRender({ variant: 'processed', graph })
    const staleRender = posted.find((m) => m.type === 'render') as Extract<
      CpuPreviewRequest,
      { type: 'render' }
    >

    client.loadSource({
      sourceId: 's2',
      width: 2,
      height: 2,
      data: new Uint16Array(12),
    })
    client.requestRender({ variant: 'processed', graph })
    const currentRender = posted
      .filter((m) => m.type === 'render')
      .at(-1) as Extract<CpuPreviewRequest, { type: 'render' }>

    respond({
      type: 'error',
      sourceId: 's1',
      requestId: staleRender.requestId,
      reason: 'render-failed',
    })
    respond({
      type: 'rendered',
      sourceId: 's2',
      requestId: currentRender.requestId,
      rgba: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    })

    expect(errors).toEqual([])
    expect(frames).toEqual([currentRender.requestId])
  })
})
