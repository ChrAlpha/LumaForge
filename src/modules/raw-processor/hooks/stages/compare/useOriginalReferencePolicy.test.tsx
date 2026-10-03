import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../../../model/session'
import type { OriginalReferenceSnapshotCapability } from '../../useOriginalReferenceSnapshot'
import { useOriginalReferencePolicy } from './useOriginalReferencePolicy'

function createSession(id = 'session-compare'): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      supportLevel: 'official',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 640, height: 480 },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'quick',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready', lastRenderSource: 'quick' },
    exportState: {
      status: 'idle',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'unknown' },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

const chromiumPthread: OriginalReferenceSnapshotCapability = {
  webKitClass: 'chromium',
  pthread: true,
}

const webkitNoPthread: OriginalReferenceSnapshotCapability = {
  webKitClass: 'webkit-mobile',
  pthread: false,
}

const webkitGpuBudgetNoPthread: OriginalReferenceSnapshotCapability = {
  webKitClass: 'webkit-mobile',
  pthread: false,
  previewGpuBudget: {
    boundedHqMaxPixels: 12_000_000,
    dualGpuAllowed: true,
    originalReferenceSnapshotMaxPixels: 12_000_000,
  },
}

describe('useOriginalReferencePolicy', () => {
  it('requests a CSS original-reference fallback for the active compare session', () => {
    const session = createSession()
    const sessionRef = { current: session }
    const { result, rerender } = renderHook(
      ({ previewSuspended }) =>
        useOriginalReferencePolicy({
          sessionId: session.id,
          sessionRef,
          viewMode: 'compare',
          previewSuspended,
          getCapability: () => chromiumPthread,
          supportsCssCompare: () => true,
        }),
      { initialProps: { previewSuspended: false } },
    )

    expect(result.current.dualGpuAllowed).toBe(true)
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)

    act(() => {
      result.current.requestOriginalReferenceFallback()
    })

    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(true)

    rerender({ previewSuspended: true })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)

    rerender({ previewSuspended: false })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)
  })

  it('prepares a CSS original-reference snapshot when dual GPU compare is unavailable', () => {
    const session = createSession()

    const { result } = renderHook(() =>
      useOriginalReferencePolicy({
        sessionId: session.id,
        sessionRef: { current: session },
        viewMode: 'compare',
        previewSuspended: false,
        getCapability: () => webkitNoPthread,
        supportsCssCompare: () => true,
      }),
    )

    expect(result.current.dualGpuAllowed).toBe(false)
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(true)
  })

  it('allows dual GPU on non-pthread engines when the GPU budget supports it', () => {
    const session = createSession()

    const { result } = renderHook(() =>
      useOriginalReferencePolicy({
        sessionId: session.id,
        sessionRef: { current: session },
        viewMode: 'compare',
        previewSuspended: false,
        getCapability: () => webkitGpuBudgetNoPthread,
        supportsCssCompare: () => true,
      }),
    )

    expect(result.current.dualGpuAllowed).toBe(true)
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)
  })
})
