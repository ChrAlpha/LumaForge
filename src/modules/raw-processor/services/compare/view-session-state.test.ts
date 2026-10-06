import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../../model/session'
import {
  applyCompareSplitToSession,
  applyViewModeToSession,
} from './view-session-state'

function createSession(overrides: Partial<ImageSession> = {}): ImageSession {
  return {
    id: 'session-view-state',
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 1600, height: 1200 },
      displaySource: 'bounded-hq',
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
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 1600, height: 1200 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
    ...overrides,
  }
}

describe('view session state transitions', () => {
  it('updates only the committed view mode on the session view state', () => {
    const session = createSession()

    const next = applyViewModeToSession(session, 'processed')

    expect(next).not.toBe(session)
    expect(next.viewState).toEqual({
      ...session.viewState,
      mode: 'processed',
    })
    expect(next.previewBundle).toBe(session.previewBundle)
    expect(next.exportState).toBe(session.exportState)
  })

  it('clamps compare split values into the session view state', () => {
    const session = createSession()

    const next = applyCompareSplitToSession(session, 2)

    expect(next.viewState).toEqual({
      ...session.viewState,
      compareSplit: 1,
    })
    expect(next.exportState).toBe(session.exportState)
  })

  it('falls back to centered compare split for non-finite values', () => {
    const session = createSession({
      viewState: {
        mode: 'compare',
        compareSplit: 0.8,
        zoom: 1,
        panX: 0,
        panY: 0,
        fitMode: 'screen',
      },
    })

    expect(
      applyCompareSplitToSession(session, Number.NaN).viewState.compareSplit,
    ).toBe(0.5)
  })
})
