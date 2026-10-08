import { describe, expect, it, vi } from 'vitest'

import {
  releaseSourceForReplacement,
  releaseSourceForReset,
  releaseSourceForUnmount,
} from './raw-workflow-resources'

type Ports = Parameters<typeof releaseSourceForReset>[0]

/**
 * Owners that record each call with the session fences they saw, so the
 * order and the moment each fence drops are both visible.
 */
function createPorts() {
  const order: string[] = []
  const runtimeWorkSessionIdRef = { current: 'session-1' as string | null }
  const pendingLoadSessionIdRef = { current: 'session-1' as string | null }
  const previewCopyCanvasRef = {
    current: document.createElement('canvas') as HTMLCanvasElement | null,
  }
  const fences = () =>
    `${String(runtimeWorkSessionIdRef.current)}/${String(pendingLoadSessionIdRef.current)}/canvas=${previewCopyCanvasRef.current ? 'set' : 'null'}`
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      const reason = args.length ? `(${String(args[0])})` : '()'
      order.push(`${name}${reason}:${fences()}`)
    })
  const ports = {
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    abortExportWork: record('abortExportWork'),
    abortRuntimeWork: record('abortRuntimeWork'),
    queueExportResultResourceDisposal: record('disposeExportResults'),
    revokeCurrentEmbeddedPreviewUrl: record('revokeEmbeddedPreviewUrl'),
  } satisfies Ports
  return { ports, order }
}

describe.each([
  {
    name: 'reset',
    release: releaseSourceForReset,
    disposal: 'disposeExportResults(reset-session)',
  },
  {
    name: 'replacement',
    release: releaseSourceForReplacement,
    disposal: 'disposeExportResults()',
  },
  {
    name: 'unmount',
    release: releaseSourceForUnmount,
    disposal: 'disposeExportResults()',
  },
])('releasing the outgoing source on $name', ({ release, disposal }) => {
  it('fences the outgoing work first, then calls each owner once in order', () => {
    const { ports, order } = createPorts()

    release(ports)

    expect(order).toEqual([
      'abortExportWork():null/null/canvas=set',
      'abortRuntimeWork():null/null/canvas=set',
      `${disposal}:null/null/canvas=set`,
      'revokeEmbeddedPreviewUrl():null/null/canvas=set',
    ])
    expect(ports.runtimeWorkSessionIdRef.current).toBeNull()
    expect(ports.pendingLoadSessionIdRef.current).toBeNull()
    expect(ports.previewCopyCanvasRef.current).toBeNull()
  })

  it('fences the refs a later load wrote after the ports were captured', () => {
    const { ports } = createPorts()
    ports.runtimeWorkSessionIdRef.current = null
    ports.pendingLoadSessionIdRef.current = null
    ports.previewCopyCanvasRef.current = null

    // A load writes its fences synchronously, before any rerender.
    ports.runtimeWorkSessionIdRef.current = 'session-2'
    ports.pendingLoadSessionIdRef.current = 'session-2'
    ports.previewCopyCanvasRef.current = document.createElement('canvas')

    release(ports)

    expect(ports.runtimeWorkSessionIdRef.current).toBeNull()
    expect(ports.pendingLoadSessionIdRef.current).toBeNull()
    expect(ports.previewCopyCanvasRef.current).toBeNull()
  })

  it('leaves idempotence to the owners: a repeated release calls each again', () => {
    const { ports, order } = createPorts()

    release(ports)
    release(ports)

    expect(order.slice(4)).toEqual([
      'abortExportWork():null/null/canvas=null',
      'abortRuntimeWork():null/null/canvas=null',
      `${disposal}:null/null/canvas=null`,
      'revokeEmbeddedPreviewUrl():null/null/canvas=null',
    ])
    expect(ports.abortRuntimeWork).toHaveBeenCalledTimes(2)
    expect(ports.revokeCurrentEmbeddedPreviewUrl).toHaveBeenCalledTimes(2)
  })

  it('stops a callback of the outgoing work that checks its fence from writing', () => {
    const { ports } = createPorts()
    const write = vi.fn()
    const obsoleteCallback = () => {
      if (ports.runtimeWorkSessionIdRef.current !== 'session-1') return
      write()
    }
    // The outgoing work settles while its owner is being cancelled.
    ports.abortRuntimeWork.mockImplementation(obsoleteCallback)

    release(ports)
    obsoleteCallback()

    expect(write).not.toHaveBeenCalled()
  })
})

describe('releasing the outgoing source on unmount', () => {
  it('returns the load it fenced while pending, read before the fence drops', () => {
    const { ports } = createPorts()

    expect(releaseSourceForUnmount(ports)).toBe('session-1')
    expect(ports.pendingLoadSessionIdRef.current).toBeNull()
    // A repeated release finds no pending load left to drop.
    expect(releaseSourceForUnmount(ports)).toBeNull()
  })
})
