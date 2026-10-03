import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import type { ImageSession } from '../../../model/session'
import { useOriginalReferenceStage } from './useOriginalReferenceStage'

function createSession(viewMode: ProcessingParams['viewMode']): ImageSession {
  return {
    id: 'session-original-reference',
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 1,
      supportLevel: 'official',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: viewMode,
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 800, height: 600 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

describe('useOriginalReferenceStage', () => {
  it('exposes compare fallback controls and no snapshot before an image is available', () => {
    const session = createSession('compare')

    const { result } = renderHook(() =>
      useOriginalReferenceStage({
        sessionId: session.id,
        sessionRef: { current: session },
        viewMode: 'compare',
        previewSuspended: false,
        decodedImageRef: { current: null },
        decodedImageVersion: 0,
        displaySource: 'bounded-hq',
        resourceRegistryRef: { current: createResourceRegistry() },
      }),
    )

    expect(typeof result.current.dualGpuAllowed).toBe('boolean')
    expect(result.current.originalReferenceSnapshot).toBeNull()
    expect(result.current.originalReferenceFallbackReason).toBeNull()
    expect(typeof result.current.requestOriginalReferenceFallback).toBe(
      'function',
    )
  })
})
