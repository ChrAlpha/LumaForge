import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../model/export-result'
import type { ImageSession } from '../model/session'
import { createImageSession } from '../model/session-factory'
import { deriveFullResExportReadiness } from '../services/export/export-readiness'
import { useExportGraphInvalidation } from './stages/export/useExportGraphInvalidation'
import { useExportResultActions } from './stages/export/useExportResultActions'
import { useRawPreviewTransform } from './useRawPreviewTransform'

function createReadySession(): ImageSession {
  const session = createImageSession(new File(['raw'], 'frame.dng'))
  return {
    ...session,
    previewBundle: {
      ...session.previewBundle,
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
    },
    exportState: {
      ...session.exportState,
      fullResCapability: { status: 'supported', width: 800, height: 600 },
    },
  }
}

function createExportResult(): ExportResult {
  return {
    kind: 'full-resolution',
    output: {
      kind: 'blob',
      filename: 'frame.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      byteLength: 4,
      mimeType: 'image/jpeg',
    },
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: 4,
    createdAt: 1,
    copyCapability: {
      mode: 'full-resolution',
      label: 'Copy full-resolution image',
    },
  }
}

function setup(initialSession: ImageSession | null = createReadySession()) {
  const sessionRef = { current: initialSession }
  const exportGraphVersionRef = { current: 0 }
  const controller = new AbortController()
  const exportAbortControllerRef = { current: controller }
  const previewCopyCanvasRef = {
    current: document.createElement('canvas') as HTMLCanvasElement | null,
  }
  const queueExportResultResourceDisposal = vi.fn()
  const setStatus = vi.fn()
  const setProgress = vi.fn()
  const toast = { success: vi.fn(), error: vi.fn() }
  const hook = renderHook(() => {
    const [session, setSession] = useState(initialSession)
    sessionRef.current = session
    const { invalidateExportGraph } = useExportGraphInvalidation({
      exportGraphVersionRef,
      previewCopyCanvasRef,
      exportAbortControllerRef,
      sessionRef,
      abortExportWork: () => controller.abort(),
      queueExportResultResourceDisposal,
      setSession,
      setStatus,
      setProgress,
    })
    const transform = useRawPreviewTransform({
      session,
      sessionRef,
      setSession,
      invalidateExportGraph,
    })
    const actions = useExportResultActions({
      sessionRef,
      pipelineRef: { current: null },
      previewCopyCanvasRef,
      scheduleToast: (notify) => notify(),
      toast,
    })
    return { transform, session, setSession, actions }
  })
  return {
    ...hook,
    sessionRef,
    exportGraphVersionRef,
    controller,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    setStatus,
    setProgress,
    toast,
  }
}

describe('useRawPreviewTransform', () => {
  it('invalidates cached exports and imperative result actions synchronously', async () => {
    const session = createReadySession()
    session.exportState.status = 'ready'
    session.exportState.result = createExportResult()
    const harness = setup(session)
    const actions = harness.result.current.actions

    await act(async () => {
      harness.result.current.transform.setActive(true)
      expect(harness.sessionRef.current?.previewTransformActive).toBe(true)
      expect(harness.sessionRef.current?.exportState.result).toBeUndefined()
      expect(harness.previewCopyCanvasRef.current).toBeNull()
      await actions.downloadExportResult()
      await actions.shareExportResult()
      await actions.copyExportResult()
    })

    expect(harness.result.current.transform.active).toBe(true)
    expect(harness.result.current.session?.exportState.result).toBeUndefined()
    expect(harness.queueExportResultResourceDisposal).toHaveBeenCalledTimes(1)
    expect(harness.toast.error).not.toHaveBeenCalled()
    expect(harness.toast.success).not.toHaveBeenCalled()
  })

  it('aborts in-flight exports and invalidates each edit while already active', () => {
    const session = createReadySession()
    session.exportState.status = 'exporting'
    const harness = setup(session)

    act(() => {
      harness.result.current.transform.setActive(true)
      expect(harness.controller.signal.aborted).toBe(true)
      expect(harness.exportGraphVersionRef.current).toBe(1)
      expect(harness.sessionRef.current?.exportState.status).toBe('idle')
    })
    act(() => harness.result.current.transform.setActive(true))

    expect(harness.exportGraphVersionRef.current).toBe(2)
    expect(harness.queueExportResultResourceDisposal).toHaveBeenCalledTimes(2)
    expect(harness.setStatus).toHaveBeenCalledWith('ready')
    expect(harness.setProgress).toHaveBeenCalledWith(0)
  })

  it('restores original export readiness after neutral reset', () => {
    const harness = setup()
    act(() => harness.result.current.transform.setActive(true))
    act(() => harness.result.current.transform.setActive(false))
    const session = harness.result.current.session!

    expect(harness.result.current.transform.active).toBe(false)
    expect(
      deriveFullResExportReadiness({
        sourceFile: session.sourceFile.file ?? null,
        session,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
      }).canExport,
    ).toBe(true)
  })

  it('starts a replacement source neutral and rejects callbacks for the old source', () => {
    const harness = setup()
    const previous = harness.result.current.transform
    act(() => previous.setActive(true))
    const replacement = createReadySession()
    act(() => harness.result.current.setSession(replacement))
    act(() => previous.setActive(true))

    expect(harness.result.current.transform.sourceId).toBe(replacement.id)
    expect(harness.result.current.transform.active).toBe(false)
    expect(
      harness.result.current.session?.previewTransformActive,
    ).toBeUndefined()
    expect(harness.exportGraphVersionRef.current).toBe(1)
  })

  it('does not create a session or invalidate exports without a source', () => {
    const harness = setup(null)
    act(() => harness.result.current.transform.setActive(true))

    expect(harness.result.current.transform.sourceId).toBeNull()
    expect(harness.result.current.transform.active).toBe(false)
    expect(harness.result.current.session).toBeNull()
    expect(harness.exportGraphVersionRef.current).toBe(0)
  })
})
