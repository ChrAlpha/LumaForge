import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import {
  isEligibleQuickPredecessor,
  isSameDecodedPreviewFrame,
} from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { useDecodedPreviewResource } from './useDecodedPreviewResource'

function createDecodedImage(
  ev: number,
  data = new Float32Array(4),
  source: DecodedImage['source'] = 'bounded-hq',
  size = { width: 1, height: 1 },
): DecodedImage {
  return {
    width: size.width,
    height: size.height,
    channels: 4,
    bitsPerChannel: 32,
    data,
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source,
    metadata: { width: 1, height: 1 },
    renderExposure: {
      ev,
      multiplier: 2 ** ev,
      source: 'identity',
    },
  }
}

describe('useDecodedPreviewResource', () => {
  it('registers decoded previews and clears the active ref when the resource is disposed', async () => {
    const registry = createResourceRegistry()
    const decodedImageRef = { current: null as DecodedImage | null }
    const rawRenderExposureRef = {
      current: null as DecodedImage['renderExposure'] | null,
    }
    let version = 0

    const { result } = renderHook(() =>
      useDecodedPreviewResource({
        decodedImageRef,
        rawRenderExposureRef,
        resourceRegistryRef: { current: registry },
        setDecodedImageVersion: (updater) => {
          version = typeof updater === 'function' ? updater(version) : updater
        },
        invalidateExportGraph: vi.fn(),
        getSessionId: () => 'session-a',
      }),
    )

    const decoded = createDecodedImage(0)
    result.current.setDecodedImageRef(decoded)

    expect(decodedImageRef.current).toBe(decoded)
    expect(version).toBe(1)
    expect(registry.snapshot().live).toEqual([
      {
        id: 'decoded-preview-1',
        owner: 'preview',
        kind: 'array-buffer',
        estimatedBytes: decoded.data.byteLength,
      },
    ])

    await registry.disposeOwners(['preview'])

    expect(decodedImageRef.current).toBeNull()
    expect(version).toBe(2)
  })

  function renderResource() {
    const registry = createResourceRegistry()
    const decodedImageRef = { current: null as DecodedImage | null }
    const rawRenderExposureRef = {
      current: null as DecodedImage['renderExposure'] | null,
    }
    const invalidateExportGraph = vi.fn()
    const sessionIdRef = { current: 'session-a' as string | null }
    const { result, rerender } = renderHook(() =>
      useDecodedPreviewResource({
        decodedImageRef,
        rawRenderExposureRef,
        resourceRegistryRef: { current: registry },
        setDecodedImageVersion: vi.fn(),
        invalidateExportGraph,
        getSessionId: () => sessionIdRef.current,
      }),
    )

    return {
      registry,
      decodedImageRef,
      rawRenderExposureRef,
      invalidateExportGraph,
      sessionIdRef,
      setDecodedImageRef: result.current.setDecodedImageRef,
      /** The descriptor the hook publishes on its next render. */
      readFrame: () => {
        rerender()
        return result.current.decodedFrame
      },
    }
  }

  it('invalidates the export graph only when the source exposure changes unless preserving export result', () => {
    const { setDecodedImageRef, invalidateExportGraph } = renderResource()

    setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
    setDecodedImageRef(null)
    setDecodedImageRef(createDecodedImage(1, undefined, 'quick'), {
      preserveExportResult: true,
    })
    setDecodedImageRef(null)
    setDecodedImageRef(createDecodedImage(2, undefined, 'quick'))

    // First pin, two releases and the last pin; the preserved one is silent.
    expect(invalidateExportGraph).toHaveBeenCalledTimes(4)
  })

  it('pins the first quick exposure and carries it onto the bounded HQ frame', () => {
    const {
      setDecodedImageRef,
      decodedImageRef,
      rawRenderExposureRef,
      invalidateExportGraph,
    } = renderResource()
    const quick = createDecodedImage(0, undefined, 'quick')
    quick.renderExposure = { ev: 0, multiplier: 1, source: 'image-statistics' }

    setDecodedImageRef(quick)
    expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)

    const boundedHq = createDecodedImage(0.4)
    setDecodedImageRef(boundedHq)

    // An explicit 0 EV pin is a pin, not a missing value.
    expect(rawRenderExposureRef.current).toEqual({
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    })
    expect(decodedImageRef.current?.source).toBe('bounded-hq')
    expect(decodedImageRef.current?.data).toBe(boundedHq.data)
    expect(decodedImageRef.current?.renderExposure).toEqual({
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    })
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
  })

  it('does not pin an exposure estimated by a bounded HQ frame', () => {
    const { setDecodedImageRef, rawRenderExposureRef, invalidateExportGraph } =
      renderResource()

    setDecodedImageRef(createDecodedImage(0.4))

    expect(rawRenderExposureRef.current).toBeNull()
    expect(invalidateExportGraph).not.toHaveBeenCalled()
  })

  it('keeps the source pin through preview evacuation and clears it on release', async () => {
    const {
      registry,
      setDecodedImageRef,
      decodedImageRef,
      rawRenderExposureRef,
      invalidateExportGraph,
    } = renderResource()
    const quick = createDecodedImage(0.25, undefined, 'quick')

    setDecodedImageRef(quick)
    await registry.disposeOwners(['preview'])

    expect(decodedImageRef.current).toBeNull()
    expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)

    setDecodedImageRef(createDecodedImage(0.25, undefined, 'quick'), {
      preserveExportResult: true,
    })
    expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)

    setDecodedImageRef(null)
    expect(rawRenderExposureRef.current).toBeNull()
    expect(invalidateExportGraph).toHaveBeenCalledTimes(2)
  })

  describe('accepted frame descriptors', () => {
    it('mints one frozen descriptor per accepted frame after the exposure pin', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      expect(readFrame()).toBeNull()

      const quick = createDecodedImage(0.5, undefined, 'quick', {
        width: 160,
        height: 100,
      })
      setDecodedImageRef(quick)
      const frame = readFrame()

      expect(frame).toEqual({
        sessionId: 'session-a',
        frameId: expect.any(String),
        stage: 'quick',
        width: 160,
        height: 100,
        exposure: { kind: 'source-pin', value: quick.renderExposure },
        quickPredecessorFrameId: null,
      })
      expect(Object.isFrozen(frame)).toBe(true)
      expect(Object.isFrozen(frame?.exposure)).toBe(true)
      expect(Object.isFrozen(frame?.exposure.value)).toBe(true)
      // Renders without a new acceptance publish the same object.
      expect(readFrame()).toBe(frame)
    })

    it('records the pin, not the frame estimate, on a bounded HQ frame', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      const quick = createDecodedImage(0.5, undefined, 'quick')
      setDecodedImageRef(quick)
      setDecodedImageRef(createDecodedImage(1.5))

      expect(readFrame()?.exposure).toEqual({
        kind: 'source-pin',
        value: quick.renderExposure,
      })
    })

    it('keeps an unpinned frame on its own estimate', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      const boundedHq = createDecodedImage(1.5)
      setDecodedImageRef(boundedHq)

      expect(readFrame()?.exposure).toEqual({
        kind: 'unpinned',
        value: boundedHq.renderExposure,
      })
    })

    it('tells same-sized frames of two sources apart', () => {
      const { setDecodedImageRef, readFrame, sessionIdRef } = renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const first = readFrame()

      setDecodedImageRef(null)
      sessionIdRef.current = 'session-b'
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const second = readFrame()

      expect(second?.sessionId).toBe('session-b')
      expect(second?.width).toBe(first?.width)
      expect(second?.frameId).not.toBe(first?.frameId)
      expect(isSameDecodedPreviewFrame(first, second)).toBe(false)
    })

    it('gives a repeated decode of one source a new identity', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      // Each decode returns its own frame, however alike the pixels are.
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const first = readFrame()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const second = readFrame()

      expect(second?.sessionId).toBe(first?.sessionId)
      expect(isSameDecodedPreviewFrame(first, second)).toBe(false)
    })

    it('names the live quick frame as the bounded HQ predecessor only', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const quick = readFrame()
      setDecodedImageRef(createDecodedImage(0))
      const boundedHq = readFrame()

      expect(boundedHq?.stage).toBe('bounded-hq')
      expect(boundedHq?.quickPredecessorFrameId).toBe(quick?.frameId)
      expect(isEligibleQuickPredecessor(quick, boundedHq)).toBe(true)

      // A second bounded HQ frame replaces a bounded HQ frame, not a quick.
      setDecodedImageRef(createDecodedImage(0))
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()

      // A quick frame never names a predecessor.
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const nextQuick = readFrame()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()
      expect(nextQuick?.quickPredecessorFrameId).toBeNull()
    })

    it('does not guess a stage the decoder did not name', () => {
      const { setDecodedImageRef, readFrame, rawRenderExposureRef } =
        renderResource()
      const unnamed = createDecodedImage(0.5, undefined, undefined)
      delete unnamed.source
      setDecodedImageRef(unnamed)
      const unknown = readFrame()

      expect(unknown?.stage).toBe('unknown')
      expect(unknown?.exposure.kind).toBe('unpinned')
      expect(rawRenderExposureRef.current).toBeNull()

      setDecodedImageRef(createDecodedImage(0))
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()

      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      setDecodedImageRef(unnamed)
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()
    })

    it('ends source lineage when the source is released', () => {
      const { setDecodedImageRef, readFrame } = renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      setDecodedImageRef(null)
      expect(readFrame()).toBeNull()

      setDecodedImageRef(createDecodedImage(0))
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()
    })

    it('never links frames of different sessions', () => {
      const { setDecodedImageRef, readFrame, sessionIdRef } = renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      sessionIdRef.current = 'session-b'
      setDecodedImageRef(createDecodedImage(0))

      expect(readFrame()?.quickPredecessorFrameId).toBeNull()
    })

    it('mints nothing for a frame accepted without a source session', () => {
      const { setDecodedImageRef, readFrame, sessionIdRef, decodedImageRef } =
        renderResource()
      sessionIdRef.current = null
      const decoded = createDecodedImage(0, undefined, 'quick')
      setDecodedImageRef(decoded)

      expect(decodedImageRef.current).toBe(decoded)
      expect(readFrame()).toBeNull()
    })

    it('keeps the live descriptor when a replaced frame is disposed late', async () => {
      const { registry, setDecodedImageRef, readFrame } = renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      setDecodedImageRef(createDecodedImage(0))
      const live = readFrame()
      // The replaced frame's resource is already released; draining the
      // registry again reaches only the live frame's.
      await Promise.resolve()

      expect(readFrame()).toBe(live)
      await registry.disposeOwners(['preview'])
      expect(readFrame()).toBeNull()
    })

    it('keeps a frame accepted again when its previous resource is released', async () => {
      const {
        registry,
        setDecodedImageRef,
        readFrame,
        decodedImageRef,
        rawRenderExposureRef,
        invalidateExportGraph,
      } = renderResource()
      const quick = createDecodedImage(0.25, undefined, 'quick')
      setDecodedImageRef(quick)
      const first = readFrame()

      // The frame already carries the pin, so it is stored as the same object
      // and the replaced resource names the very pixels just accepted.
      setDecodedImageRef(quick)
      const second = readFrame()

      expect(decodedImageRef.current).toBe(quick)
      expect(second).not.toBeNull()
      expect(isSameDecodedPreviewFrame(first, second)).toBe(false)
      expect(second?.quickPredecessorFrameId).toBeNull()
      expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)
      expect(invalidateExportGraph).toHaveBeenCalledTimes(1)

      await Promise.resolve()
      await Promise.resolve()
      expect(readFrame()).toBe(second)
      expect(registry.snapshot().live).toEqual([
        {
          id: 'decoded-preview-2',
          owner: 'preview',
          kind: 'array-buffer',
          estimatedBytes: quick.data.byteLength,
        },
      ])

      // The current owner still releases the frame and its descriptor.
      await registry.disposeOwners(['preview'])
      expect(decodedImageRef.current).toBeNull()
      expect(readFrame()).toBeNull()
      expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)
      expect(registry.snapshot().live).toEqual([])
    })

    it('keeps the quick lineage when a bounded HQ frame is accepted again', async () => {
      const { registry, setDecodedImageRef, readFrame, decodedImageRef } =
        renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      const quick = readFrame()
      const boundedHq = createDecodedImage(0)
      setDecodedImageRef(boundedHq)
      const linked = readFrame()
      expect(linked?.quickPredecessorFrameId).toBe(quick?.frameId)

      setDecodedImageRef(boundedHq)
      const again = readFrame()

      expect(decodedImageRef.current).toBe(boundedHq)
      expect(again?.stage).toBe('bounded-hq')
      expect(isSameDecodedPreviewFrame(linked, again)).toBe(false)
      // A bounded HQ frame replaces a bounded HQ frame, not a quick one.
      expect(again?.quickPredecessorFrameId).toBeNull()
      await Promise.resolve()
      expect(registry.snapshot().live).toHaveLength(1)
    })

    it('clears the descriptor with evacuated pixels and keeps the pin', async () => {
      const {
        registry,
        setDecodedImageRef,
        readFrame,
        rawRenderExposureRef,
        invalidateExportGraph,
      } = renderResource()
      const quick = createDecodedImage(0.25, undefined, 'quick')
      setDecodedImageRef(quick)
      const accepted = readFrame()

      await registry.disposeOwners(['preview'])

      expect(readFrame()).toBeNull()
      expect(rawRenderExposureRef.current).toEqual(quick.renderExposure)

      // Restore decodes the source again: a fresh identity on the same pin,
      // with no predecessor because the evacuated frame is gone.
      setDecodedImageRef(createDecodedImage(0.25, undefined, 'quick'), {
        preserveExportResult: true,
      })
      const restored = readFrame()

      expect(restored?.sessionId).toBe(accepted?.sessionId)
      expect(restored?.frameId).not.toBe(accepted?.frameId)
      expect(restored?.exposure).toEqual({
        kind: 'source-pin',
        value: quick.renderExposure,
      })
      expect(restored?.quickPredecessorFrameId).toBeNull()
      expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
    })

    it('publishes nothing for a frame released outside the resource', () => {
      const { setDecodedImageRef, readFrame, decodedImageRef } =
        renderResource()
      setDecodedImageRef(createDecodedImage(0, undefined, 'quick'))
      decodedImageRef.current = null

      expect(readFrame()).toBeNull()
      setDecodedImageRef(createDecodedImage(0))
      expect(readFrame()?.quickPredecessorFrameId).toBeNull()
    })
  })
})
