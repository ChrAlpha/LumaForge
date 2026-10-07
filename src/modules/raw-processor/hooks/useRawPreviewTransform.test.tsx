import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../model/export-result'
import type { ImageSession } from '../model/session'
import { createImageSession } from '../model/session-factory'
import { deriveFullResExportReadiness } from '../services/export/export-readiness'
import { deriveTransformStatus } from '../services/transform/transform-state'
import { useExportGraphInvalidation } from './stages/export/useExportGraphInvalidation'
import { useExportResultActions } from './stages/export/useExportResultActions'
import { acceptTransformGeometry } from './transform-session.fixture'
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
    const { previewTransform, transform } = useRawPreviewTransform({
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
    return { previewTransform, transform, session, setSession, actions }
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

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

/** A second geometry, rotated the other way. */
const OTHER_GEOMETRY = {
  matrix: [0.999, 0.035, -0.018, -0.035, 0.999, 0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useRawPreviewTransform', () => {
  it('invalidates cached exports and imperative result actions synchronously', async () => {
    const session = createReadySession()
    session.exportState.status = 'ready'
    session.exportState.result = createExportResult()
    const harness = setup(session)
    const actions = harness.result.current.actions

    await act(async () => {
      acceptTransformGeometry(harness.result.current.transform, SAMPLE_GEOMETRY)
      expect(harness.sessionRef.current?.exportGeometry).toEqual(
        SAMPLE_GEOMETRY,
      )
      expect(harness.sessionRef.current?.exportState.result).toBeUndefined()
      expect(harness.previewCopyCanvasRef.current).toBeNull()
      await actions.downloadExportResult()
      await actions.shareExportResult()
      await actions.copyExportResult()
    })

    expect(harness.result.current.previewTransform.active).toBe(true)
    expect(harness.result.current.session?.exportState.result).toBeUndefined()
    // The edit invalidates, and so does the geometry its answer moves.
    expect(harness.queueExportResultResourceDisposal).toHaveBeenCalledTimes(2)
    expect(harness.toast.error).not.toHaveBeenCalled()
    expect(harness.toast.success).not.toHaveBeenCalled()
  })

  it('aborts in-flight exports and invalidates each geometry move while already active', () => {
    const session = createReadySession()
    session.exportState.status = 'exporting'
    const harness = setup(session)

    act(() => {
      acceptTransformGeometry(harness.result.current.transform, SAMPLE_GEOMETRY)
      expect(harness.controller.signal.aborted).toBe(true)
      expect(harness.exportGraphVersionRef.current).toBe(2)
      expect(harness.sessionRef.current?.exportState.status).toBe('idle')
    })
    act(() =>
      acceptTransformGeometry(harness.result.current.transform, OTHER_GEOMETRY),
    )

    // Each accept is an edit and then a geometry move.
    expect(harness.exportGraphVersionRef.current).toBe(4)
    expect(harness.queueExportResultResourceDisposal).toHaveBeenCalledTimes(4)
    expect(harness.setStatus).toHaveBeenCalledWith('ready')
    expect(harness.setProgress).toHaveBeenCalledWith(0)
    expect(harness.result.current.previewTransform.geometry).toEqual(
      OTHER_GEOMETRY,
    )
  })

  it('keeps a delivered export when a new frame answers the same geometry', () => {
    const harness = setup()
    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )
    const result = createExportResult()
    act(() =>
      harness.result.current.setSession((previous) =>
        previous
          ? {
              ...previous,
              exportState: { ...previous.exportState, status: 'ready', result },
            }
          : previous,
      ),
    )
    const { state, dispatch } = harness.result.current.transform
    const sourceId = state!.sourceId
    const issued = state!.accepted!.issued
    // A new frame, its request and the worker's answer, each on its own.
    act(() => dispatch({ type: 'capture', sourceId, captureKey: 'frame-2' }))
    act(() =>
      dispatch({
        type: 'request',
        sourceId,
        captureKey: 'frame-2',
        requestId: 500,
        geometry: SAMPLE_GEOMETRY,
      }),
    )
    act(() =>
      dispatch({
        type: 'rendered',
        sourceId,
        captureKey: 'frame-2',
        requestId: 500,
        geometry: SAMPLE_GEOMETRY,
        frame: { width: 800, height: 600 },
      }),
    )

    expect(harness.exportGraphVersionRef.current).toBe(2)
    expect(harness.result.current.session?.exportState.result).toBe(result)
    const reanswered = harness.result.current.transform.state!
    expect(deriveTransformStatus(reanswered)).toBe('accepted')
    expect(reanswered.accepted?.issued).toBeGreaterThan(issued)
    expect(reanswered.accepted?.geometry).toEqual(SAMPLE_GEOMETRY)
  })

  it('invalidates on every real edit or reset while the held geometry stays, and on nothing else', () => {
    const harness = setup()
    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )
    const result = createExportResult()
    act(() =>
      harness.result.current.setSession((previous) =>
        previous
          ? {
              ...previous,
              exportState: { ...previous.exportState, status: 'ready', result },
            }
          : previous,
      ),
    )
    const { state, dispatch } = harness.result.current.transform
    const sourceId = state!.sourceId
    const original = state!.intent.manual
    const versionAfterAccept = harness.exportGraphVersionRef.current

    // Repeating the current intent asks for nothing new.
    act(() =>
      dispatch({ type: 'edit', sourceId, intent: { manual: original } }),
    )
    expect(harness.exportGraphVersionRef.current).toBe(versionAfterAccept)
    expect(harness.result.current.session?.exportState.result).toBe(result)

    // Away and back again: each is a new ask, and the geometry never moves.
    act(() =>
      dispatch({
        type: 'edit',
        sourceId,
        intent: { manual: { ...original, rotate: 30 } },
      }),
    )
    expect(harness.exportGraphVersionRef.current).toBe(versionAfterAccept + 1)
    expect(harness.sessionRef.current?.exportState.result).toBeUndefined()
    expect(harness.sessionRef.current?.exportGeometry).toEqual(SAMPLE_GEOMETRY)
    act(() =>
      dispatch({ type: 'edit', sourceId, intent: { manual: original } }),
    )
    expect(harness.exportGraphVersionRef.current).toBe(versionAfterAccept + 2)
    expect(harness.result.current.previewTransform.geometry).toEqual(
      SAMPLE_GEOMETRY,
    )

    // A reset moves the geometry as well, and invalidates once.
    act(() => dispatch({ type: 'reset', sourceId }))
    expect(harness.exportGraphVersionRef.current).toBe(versionAfterAccept + 3)
    expect(harness.result.current.previewTransform.geometry).toBeNull()

    // A request on a neutral intent asks for nothing, and resetting a neutral
    // Transform that a request is still out for changes no intent.
    act(() => dispatch({ type: 'capture', sourceId, captureKey: 'frame-n' }))
    act(() =>
      dispatch({
        type: 'request',
        sourceId,
        captureKey: 'frame-n',
        requestId: 700,
        geometry: SAMPLE_GEOMETRY,
      }),
    )
    const neutralIntent = harness.sessionRef.current?.transform?.intent
    act(() => dispatch({ type: 'reset', sourceId }))
    expect(harness.result.current.transform.state?.request).toBeNull()
    expect(harness.exportGraphVersionRef.current).toBe(versionAfterAccept + 3)
    // The same Transform keeps its intent object, so an export admitted for
    // it stays current.
    expect(harness.sessionRef.current?.transform?.intent).toBe(neutralIntent)
  })

  it('holds the accepted geometry as pending, not current, while a newer edit waits', () => {
    const harness = setup()
    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )
    const { state, dispatch } = harness.result.current.transform
    const sourceId = state!.sourceId
    const captureKey = state!.capture!.key
    act(() => {
      dispatch({
        type: 'edit',
        sourceId,
        intent: { manual: { ...state!.intent.manual, rotate: 9 } },
      })
      dispatch({
        type: 'request',
        sourceId,
        captureKey,
        requestId: state!.request!.requestId + 1,
        geometry: OTHER_GEOMETRY,
      })
    })

    // The export still names the last accepted geometry, so the status is
    // what keeps it from running as the Transform asked for now.
    const pending = harness.result.current.transform.state!
    expect(deriveTransformStatus(pending)).toBe('pending')
    expect(harness.result.current.previewTransform.geometry).toEqual(
      SAMPLE_GEOMETRY,
    )
    // The edit alone invalidated what was made for the accepted geometry.
    expect(harness.exportGraphVersionRef.current).toBe(3)

    // The answer to a request it replaced is not taken for it.
    act(() =>
      dispatch({
        type: 'rendered',
        sourceId,
        captureKey,
        requestId: state!.request!.requestId,
        geometry: SAMPLE_GEOMETRY,
        frame: { width: 800, height: 600 },
      }),
    )
    expect(deriveTransformStatus(harness.result.current.transform.state!)).toBe(
      'pending',
    )
  })

  it('restores original export readiness after neutral reset', () => {
    const harness = setup()
    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )
    const sourceId = harness.result.current.transform.state!.sourceId
    act(() =>
      harness.result.current.transform.dispatch({ type: 'reset', sourceId }),
    )
    const session = harness.result.current.session!

    expect(harness.result.current.previewTransform.active).toBe(false)
    expect(session.exportGeometry).toBeNull()
    expect(
      deriveFullResExportReadiness({
        sourceFile: session.sourceFile.file ?? null,
        session,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
      }).canExport,
    ).toBe(true)
  })

  it('starts a replacement source neutral and rejects events for the old source', () => {
    const harness = setup()
    const previous = harness.result.current.transform
    act(() => acceptTransformGeometry(previous, SAMPLE_GEOMETRY))
    const replacement = createReadySession()
    act(() => harness.result.current.setSession(replacement))
    act(() => acceptTransformGeometry(previous, SAMPLE_GEOMETRY))

    expect(harness.result.current.previewTransform.sourceId).toBe(
      replacement.id,
    )
    expect(harness.result.current.transform.state).toBe(replacement.transform)
    expect(harness.result.current.previewTransform.active).toBe(false)
    expect(harness.result.current.session?.exportGeometry).toBeUndefined()
    // Only the first source's edit and geometry move invalidated anything.
    expect(harness.exportGraphVersionRef.current).toBe(2)
  })

  it('starts a session without a Transform of its own neutral', () => {
    const { transform: _omitted, ...bare } = createReadySession()
    const harness = setup(bare)

    expect(harness.result.current.transform.state).toMatchObject({
      sourceId: bare.id,
      accepted: null,
    })
    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )
    expect(harness.result.current.session?.transform?.sourceId).toBe(bare.id)
    expect(harness.result.current.previewTransform.geometry).toEqual(
      SAMPLE_GEOMETRY,
    )
  })

  it('does not create a session or invalidate exports without a source', () => {
    const harness = setup(null)
    act(() =>
      harness.result.current.transform.dispatch({
        type: 'reset',
        sourceId: 'none',
      }),
    )

    expect(harness.result.current.transform.state).toBeNull()
    expect(harness.result.current.previewTransform.sourceId).toBeNull()
    expect(harness.result.current.previewTransform.active).toBe(false)
    expect(harness.result.current.session).toBeNull()
    expect(harness.exportGraphVersionRef.current).toBe(0)
  })
})
