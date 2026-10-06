import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'

import { useDecodedPreviewResource } from './useDecodedPreviewResource'

function createDecodedImage(
  ev: number,
  data = new Float32Array(4),
  source: DecodedImage['source'] = 'bounded-hq',
): DecodedImage {
  return {
    width: 1,
    height: 1,
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
    const { result } = renderHook(() =>
      useDecodedPreviewResource({
        decodedImageRef,
        rawRenderExposureRef,
        resourceRegistryRef: { current: registry },
        setDecodedImageVersion: vi.fn(),
        invalidateExportGraph,
      }),
    )

    return {
      registry,
      decodedImageRef,
      rawRenderExposureRef,
      invalidateExportGraph,
      setDecodedImageRef: result.current.setDecodedImageRef,
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
})
