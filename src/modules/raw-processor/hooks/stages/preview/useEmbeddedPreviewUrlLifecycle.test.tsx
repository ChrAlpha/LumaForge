import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import type { SetImageSession } from './useEmbeddedPreviewUrlLifecycle'
import { useEmbeddedPreviewUrlLifecycle } from './useEmbeddedPreviewUrlLifecycle'

function createSession(
  id = 'session-embedded-preview',
  embeddedObjectUrl = 'blob:embedded-preview',
): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: {
        status: 'ready',
        objectUrl: embeddedObjectUrl,
        width: 1600,
        height: 1200,
        mimeType: 'image/jpeg',
      },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'embedded',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'idle' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'probing' },
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState(id),
  }
}

function applySessionUpdate(currentSessionRef: {
  current: ImageSession | null
}): SetImageSession {
  return (update) => {
    currentSessionRef.current =
      typeof update === 'function' ? update(currentSessionRef.current) : update
  }
}

const revokeObjectURL = vi.fn()

function revokedUrls() {
  return revokeObjectURL.mock.calls.map(([url]) => url)
}

describe('useEmbeddedPreviewUrlLifecycle', () => {
  beforeEach(() => {
    revokeObjectURL.mockReset()
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, { revokeObjectURL }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('revokes current embedded preview URLs once and clears refs plus session URL', () => {
    const sessionRef = { current: createSession() }
    const embeddedPreviewUrlRef = { current: 'blob:embedded-preview' }
    const setSession = applySessionUpdate(sessionRef)

    const { result } = renderHook(() =>
      useEmbeddedPreviewUrlLifecycle({
        embeddedPreviewUrlRef,
        getSession: () => sessionRef.current,
        setSession,
      }),
    )

    act(() => {
      result.current.revokeCurrentEmbeddedPreviewUrl()
    })

    expect(revokedUrls()).toEqual(['blob:embedded-preview'])
    expect(embeddedPreviewUrlRef.current).toBeNull()
    expect(sessionRef.current?.previewBundle.embeddedPreview).toEqual({
      status: 'idle',
    })
  })

  it('revokes and clears the source current when it runs, not one from an older render', () => {
    const sessionRef = {
      current: createSession(
        'rendered-session',
        'blob:rendered-preview',
      ) as ImageSession | null,
    }
    const embeddedPreviewUrlRef = { current: null as string | null }
    const setSession = applySessionUpdate(sessionRef)

    const { result } = renderHook(() =>
      useEmbeddedPreviewUrlLifecycle({
        embeddedPreviewUrlRef,
        getSession: () => sessionRef.current,
        setSession,
      }),
    )
    const revokeFromEarlierRender =
      result.current.revokeCurrentEmbeddedPreviewUrl

    sessionRef.current = createSession(
      'replacement-session',
      'blob:replacement-preview',
    )
    act(() => {
      revokeFromEarlierRender()
    })

    expect(revokedUrls()).toEqual(['blob:replacement-preview'])
    expect(sessionRef.current?.id).toBe('replacement-session')
    expect(sessionRef.current?.previewBundle.embeddedPreview).toEqual({
      status: 'idle',
    })
  })

  it('revokes a pending load URL without touching any session when no source is current', () => {
    const embeddedPreviewUrlRef = {
      current: 'blob:pending-preview' as string | null,
    }
    const setSession = vi.fn()

    const { result } = renderHook(() =>
      useEmbeddedPreviewUrlLifecycle({
        embeddedPreviewUrlRef,
        getSession: () => null,
        setSession,
      }),
    )

    act(() => {
      result.current.revokeCurrentEmbeddedPreviewUrl()
    })

    expect(revokedUrls()).toEqual(['blob:pending-preview'])
    expect(embeddedPreviewUrlRef.current).toBeNull()
    expect(setSession).not.toHaveBeenCalled()
  })
})
