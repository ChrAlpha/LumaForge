import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../model/session'
import { createImageSession } from '../model/session-factory'
import { acceptTransformGeometry } from './transform-session.fixture'
import { useRawPreviewTransform } from './useRawPreviewTransform'

function createReadySession(): ImageSession {
  const session = createImageSession(new File(['raw'], 'frame.dng'))
  return {
    ...session,
    exportGeometry: null,
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

function setup(initialSession: ImageSession | null = createReadySession()) {
  let session = initialSession
  const getSession = () => session
  const setSession = (
    update: (session: ImageSession | null) => ImageSession | null,
  ) => {
    session = update(session)
  }
  const invalidateExportGraph = () => {}
  const hook = renderHook(() => {
    return useRawPreviewTransform({
      session,
      getSession,
      setSession,
      invalidateExportGraph,
    })
  })
  return { ...hook, getSession }
}

const SAMPLE_GEOMETRY: ExportGeometry = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useRawPreviewTransform - same-tick behavior', () => {
  it('reads Transform state from session.transform', () => {
    const session = createReadySession()
    const harness = setup(session)

    expect(harness.result.current.transform.state).toBe(session.transform)
    expect(harness.result.current.transform.state?.sourceId).toBe(session.id)
  })

  it('reads export geometry from session.exportGeometry', () => {
    const session = createReadySession()
    const harness = setup(session)

    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )

    expect(harness.getSession()?.exportGeometry).toEqual(SAMPLE_GEOMETRY)
  })

  it('derives active flag from session.exportGeometry existence', () => {
    const harness = setup()

    expect(harness.getSession()?.exportGeometry).toBeNull()

    act(() =>
      acceptTransformGeometry(
        harness.result.current.transform,
        SAMPLE_GEOMETRY,
      ),
    )

    expect(harness.getSession()?.exportGeometry).toEqual(SAMPLE_GEOMETRY)
  })

  it('provides sourceId from transform state', () => {
    const session = createReadySession()
    const harness = setup(session)

    expect(harness.result.current.transform.state?.sourceId).toBe(session.id)
  })

  it('returns null transform for no session', () => {
    const harness = setup(null)

    expect(harness.result.current.transform.state).toBeNull()
  })
})
