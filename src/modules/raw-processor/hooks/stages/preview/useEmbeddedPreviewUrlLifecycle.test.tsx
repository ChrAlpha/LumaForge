import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
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

describe('useEmbeddedPreviewUrlLifecycle', () => {
  it('clears embedded preview URL state only for the matching session', () => {
    const sessionRef = { current: createSession('active-session') }
    const embeddedPreviewUrlRef = { current: 'blob:embedded-preview' }
    const setSession = applySessionUpdate(sessionRef)

    const { result } = renderHook(() =>
      useEmbeddedPreviewUrlLifecycle({
        embeddedPreviewUrlRef,
        sessionRef,
        setSession,
      }),
    )

    act(() => {
      result.current.clearSessionEmbeddedPreviewUrl('other-session')
    })
    expect(sessionRef.current?.previewBundle.embeddedPreview).toMatchObject({
      objectUrl: 'blob:embedded-preview',
    })

    act(() => {
      result.current.clearSessionEmbeddedPreviewUrl('active-session')
    })

    expect(sessionRef.current?.previewBundle.embeddedPreview).toEqual({
      status: 'idle',
    })
    expect(sessionRef.current?.previewBundle.displaySource).toBe('none')
  })

  it('revokes current embedded preview URLs once and clears refs plus session URL', () => {
    const sessionRef = { current: createSession() }
    const embeddedPreviewUrlRef = { current: 'blob:embedded-preview' }
    const setSession = applySessionUpdate(sessionRef)
    const revokeObjectUrls = vi.fn()

    const { result } = renderHook(() =>
      useEmbeddedPreviewUrlLifecycle({
        embeddedPreviewUrlRef,
        sessionRef,
        setSession,
        revokeObjectUrls,
      }),
    )

    act(() => {
      result.current.revokeCurrentEmbeddedPreviewUrl()
    })

    expect(revokeObjectUrls).toHaveBeenCalledWith(
      new Set(['blob:embedded-preview']),
    )
    expect(embeddedPreviewUrlRef.current).toBeNull()
    expect(sessionRef.current?.previewBundle.embeddedPreview).toEqual({
      status: 'idle',
    })
  })
})
