import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../../model/session'
import type { TestSessionOverrides } from '../../test-support/builders'
import { createLoadedTestSession } from '../../test-support/builders'
import { applyPreviewViewportToSession } from '../compare/view-session-state'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  panPreviewViewport,
  resetPreviewViewport,
  zoomPreviewViewportAtPoint,
} from './preview-viewport'

const geometry = {
  viewportWidth: 400,
  viewportHeight: 300,
  contentWidth: 400,
  contentHeight: 300,
}

function createSession(overrides: TestSessionOverrides = {}): ImageSession {
  return createLoadedTestSession({
    id: 'session-preview-viewport',
    exportState: { status: 'ready' },
    ...overrides,
  })
}

describe('preview viewport interaction math', () => {
  it('zooms around the pointer origin instead of changing processing params', () => {
    const next = zoomPreviewViewportAtPoint(DEFAULT_PREVIEW_VIEWPORT, {
      geometry,
      originX: 100,
      originY: 0,
      nextZoom: 2,
    })

    expect(next).toEqual({
      zoom: 2,
      panX: -100,
      panY: 0,
      fitMode: 'custom',
    })
  })

  it('clamps panning to the scaled preview content bounds', () => {
    const next = panPreviewViewport(
      { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
      {
        geometry,
        deltaX: 300,
        deltaY: -240,
      },
    )

    expect(next).toEqual({
      zoom: 2,
      panX: 200,
      panY: -150,
      fitMode: 'custom',
    })
  })

  it('returns to screen-fit when reset', () => {
    expect(resetPreviewViewport()).toEqual(DEFAULT_PREVIEW_VIEWPORT)
  })
})

describe('preview viewport session state', () => {
  it('updates only preview viewState and preserves export readiness/result state', () => {
    const session = createSession()

    const next = applyPreviewViewportToSession(session, {
      zoom: 2,
      panX: 40,
      panY: -20,
      fitMode: 'custom',
    })

    expect(next).not.toBe(session)
    expect(next.viewState).toEqual({
      ...session.viewState,
      zoom: 2,
      panX: 40,
      panY: -20,
      fitMode: 'custom',
    })
    expect(next.previewBundle).toBe(session.previewBundle)
    expect(next.exportState).toBe(session.exportState)
  })
})
