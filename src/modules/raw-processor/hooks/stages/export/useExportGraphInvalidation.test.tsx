import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
import type { SetImageSession } from './useExportGraphInvalidation'
import { useExportGraphInvalidation } from './useExportGraphInvalidation'

function createSession(status: ImageSession['exportState']['status']) {
  return {
    id: 'session-export',
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'none',
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
      status,
      fullResCapability: { status: 'unknown' },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  } satisfies ImageSession
}

function applySessionUpdate(sessionRef: {
  current: ImageSession | null
}): SetImageSession {
  return (update) => {
    sessionRef.current =
      typeof update === 'function' ? update(sessionRef.current) : update
  }
}

describe('useExportGraphInvalidation', () => {
  it('increments graph version, clears preview copy, and resets active export progress', () => {
    const exportAbortController = new AbortController()
    const exportGraphVersionRef = { current: 2 }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
    const sessionRef = { current: createSession('exporting') }
    const abortExportWork = vi.fn()
    const queueExportResultResourceDisposal = vi.fn()
    const setStatus = vi.fn()
    const setProgress = vi.fn()

    const { result } = renderHook(() =>
      useExportGraphInvalidation({
        exportGraphVersionRef,
        previewCopyCanvasRef,
        exportAbortControllerRef: { current: exportAbortController },
        sessionRef,
        abortExportWork,
        queueExportResultResourceDisposal,
        setSession: applySessionUpdate(sessionRef),
        setStatus,
        setProgress,
      }),
    )

    result.current.invalidateExportGraph()

    expect(exportGraphVersionRef.current).toBe(3)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(abortExportWork).toHaveBeenCalledTimes(1)
    expect(queueExportResultResourceDisposal).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledWith('ready')
    expect(setProgress).toHaveBeenCalledWith(0)
  })

  it('does not reset progress when no export is active', () => {
    const sessionRef = { current: createSession('idle') }
    const setStatus = vi.fn()
    const setProgress = vi.fn()

    const { result } = renderHook(() =>
      useExportGraphInvalidation({
        exportGraphVersionRef: { current: 0 },
        previewCopyCanvasRef: { current: null },
        exportAbortControllerRef: { current: null },
        sessionRef,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        setSession: applySessionUpdate(sessionRef),
        setStatus,
        setProgress,
      }),
    )

    result.current.invalidateExportGraph()

    expect(setStatus).not.toHaveBeenCalled()
    expect(setProgress).not.toHaveBeenCalled()
  })
})
