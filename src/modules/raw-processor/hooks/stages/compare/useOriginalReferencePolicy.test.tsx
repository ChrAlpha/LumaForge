import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ImageSession } from '../../../model/session'
import { setCurrentSession } from '../../../state/session.atoms'
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
      supportLevel: 'experimental',
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
      fullResCapability: { status: 'unknown' },
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
  beforeEach(() => {
    setCurrentSession(null)
  })

  afterEach(() => {
    setCurrentSession(null)
  })

  it('requests a CSS original-reference fallback for the active compare session', () => {
    const session = createSession()
    setCurrentSession(session)
    const { result, rerender } = renderHook(
      ({ previewSuspended }) =>
        useOriginalReferencePolicy({
          sessionId: session.id,
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
        viewMode: 'compare',
        previewSuspended: false,
        getCapability: () => webkitGpuBudgetNoPthread,
        supportsCssCompare: () => true,
      }),
    )

    expect(result.current.dualGpuAllowed).toBe(true)
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)
  })

  it('requests the fallback for a source that replaced the rendered one in the same tick', () => {
    const first = createSession('session-first')
    const replacement = createSession('session-replacement')
    setCurrentSession(first)
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useOriginalReferencePolicy({
          sessionId,
          viewMode: 'compare',
          previewSuspended: false,
          getCapability: () => chromiumPthread,
          supportsCssCompare: () => true,
        }),
      { initialProps: { sessionId: first.id } },
    )
    const request = result.current.requestOriginalReferenceFallback

    // The load writes the store before the hook rerenders, so a callback
    // held from the first render requests for the replacement.
    act(() => {
      setCurrentSession(replacement)
      request()
    })

    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)

    rerender({ sessionId: replacement.id })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(true)
  })

  it('does not carry a fallback request over to a replacement source', () => {
    const first = createSession('session-first')
    const replacement = createSession('session-replacement')
    setCurrentSession(first)
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useOriginalReferencePolicy({
          sessionId,
          viewMode: 'compare',
          previewSuspended: false,
          getCapability: () => chromiumPthread,
          supportsCssCompare: () => true,
        }),
      { initialProps: { sessionId: first.id } },
    )

    act(() => {
      result.current.requestOriginalReferenceFallback()
    })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(true)

    act(() => {
      setCurrentSession(replacement)
    })
    rerender({ sessionId: replacement.id })

    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)
  })

  it('requests nothing when a reset cleared the session in the same tick', () => {
    const session = createSession()
    setCurrentSession(session)
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useOriginalReferencePolicy({
          sessionId,
          viewMode: 'compare',
          previewSuspended: false,
          getCapability: () => chromiumPthread,
          supportsCssCompare: () => true,
        }),
      { initialProps: { sessionId: session.id as string | null } },
    )
    const request = result.current.requestOriginalReferenceFallback

    act(() => {
      setCurrentSession(null)
      request()
    })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)

    // The same source loaded again does not inherit a request made while
    // no session existed.
    act(() => {
      setCurrentSession(session)
    })
    rerender({ sessionId: session.id })
    expect(result.current.shouldPrepareOriginalReferenceSnapshot).toBe(false)
  })
})
