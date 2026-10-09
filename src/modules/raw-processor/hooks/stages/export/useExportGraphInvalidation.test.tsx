import { renderHook } from '@testing-library/react'
import { atom, createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
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
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState('session-export'),
  } satisfies ImageSession
}

/**
 * A session store whose writes the next read sees in the same tick, before
 * any rerender, as the workflow's session atom does.
 */
function createSessionStore(initial: ImageSession | null) {
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>(initial)
  const getSession = () => store.get(sessionAtom)
  const setSession: SetImageSession = (update) => store.set(sessionAtom, update)
  return { getSession, setSession }
}

function setup(
  initial: ImageSession | null,
  exportAbortController: AbortController | null = null,
) {
  const sessions = createSessionStore(initial)
  const exportGraphVersionRef = { current: 2 }
  const previewCopyCanvasRef = {
    current: document.createElement('canvas') as HTMLCanvasElement | null,
  }
  const abortExportWork = vi.fn()
  const queueExportResultResourceDisposal = vi.fn()
  const setStatus = vi.fn()
  const setProgress = vi.fn()
  const { result } = renderHook(() =>
    useExportGraphInvalidation({
      exportGraphVersionRef,
      previewCopyCanvasRef,
      exportAbortControllerRef: { current: exportAbortController },
      getSession: sessions.getSession,
      abortExportWork,
      queueExportResultResourceDisposal,
      setSession: sessions.setSession,
      setStatus,
      setProgress,
    }),
  )
  return {
    ...sessions,
    invalidateExportGraph: () => result.current.invalidateExportGraph(),
    exportGraphVersionRef,
    previewCopyCanvasRef,
    abortExportWork,
    queueExportResultResourceDisposal,
    setStatus,
    setProgress,
  }
}

describe('useExportGraphInvalidation', () => {
  it('increments graph version, clears preview copy, and resets active export progress', () => {
    const h = setup(createSession('exporting'), new AbortController())

    h.invalidateExportGraph()

    expect(h.exportGraphVersionRef.current).toBe(3)
    expect(h.previewCopyCanvasRef.current).toBeNull()
    expect(h.abortExportWork).toHaveBeenCalledTimes(1)
    expect(h.queueExportResultResourceDisposal).toHaveBeenCalledTimes(1)
    expect(h.setStatus).toHaveBeenCalledWith('ready')
    expect(h.setProgress).toHaveBeenCalledWith(0)
    expect(h.getSession()?.exportState.status).toBe('idle')
  })

  it('does not reset progress when no export is active', () => {
    const h = setup(createSession('idle'))

    h.invalidateExportGraph()

    expect(h.setStatus).not.toHaveBeenCalled()
    expect(h.setProgress).not.toHaveBeenCalled()
  })

  it('reads an export the store started in the same tick, before any rerender', () => {
    const h = setup(createSession('idle'))
    h.setSession((prev) =>
      prev
        ? { ...prev, exportState: { ...prev.exportState, status: 'exporting' } }
        : prev,
    )

    h.invalidateExportGraph()

    expect(h.setStatus).toHaveBeenCalledWith('ready')
    expect(h.setProgress).toHaveBeenCalledWith(0)
    expect(h.getSession()?.exportState.status).toBe('idle')
  })

  it('leaves progress alone once the store has settled an export in the same tick', () => {
    const h = setup(createSession('exporting'))
    h.setSession((prev) =>
      prev
        ? { ...prev, exportState: { ...prev.exportState, status: 'ready' } }
        : prev,
    )

    h.invalidateExportGraph()

    expect(h.setStatus).not.toHaveBeenCalled()
    expect(h.setProgress).not.toHaveBeenCalled()
  })
})
