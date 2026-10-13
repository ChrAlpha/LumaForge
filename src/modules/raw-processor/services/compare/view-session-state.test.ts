import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import type { PreviewBackendState } from '~/lib/preview/gpu-backend'

import { createExportResult } from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import type { TestSessionOverrides } from '../../test-support/builders'
import {
  createLoadedTestSession,
  transformAt,
} from '../../test-support/builders'
import { captureExportResultIdentity } from '../export/export-result-identity'
import { heldTransformGeometry } from '../transform/transform-state'
import type { SessionViewCommand } from './view-session-state'
import {
  applyCompareSplitToSession,
  applyCompareViewResetToSession,
  applyViewModeToSession,
  canRunSessionViewCommand,
  isSessionPreviewReleased,
  sessionViewCommandForMode,
} from './view-session-state'

const SESSION_ID = 'session-view-state'

function createSession(overrides: TestSessionOverrides = {}): ImageSession {
  return createLoadedTestSession({ id: SESSION_ID, ...overrides })
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

const GPU: PreviewBackendState = {
  status: 'ready',
  facts: { backend: 'webgpu', maxTextureSize: 8192, reason: null },
}
const CPU: PreviewBackendState = {
  status: 'ready',
  facts: { backend: 'cpu', maxTextureSize: 0, reason: 'forced' },
}
const PENDING: PreviewBackendState = { status: 'pending' }
const COMMANDS: SessionViewCommand[] = ['originalView', 'split', 'splitReset']

function allowed(
  session: ImageSession,
  backend: PreviewBackendState,
  hasDecodedImage = true,
) {
  return COMMANDS.filter((command) =>
    canRunSessionViewCommand(command, { session, backend, hasDecodedImage }),
  )
}

function withExportState(
  exportState: Partial<ImageSession['exportState']>,
): ImageSession {
  return createSession({ exportState })
}

const ACTIVE_PLAN: NonNullable<ImageSession['exportState']['activePlan']> = {
  profileName: 'desktop-fast',
  preferredRows: 128,
  concurrency: 1,
  runtimeMemoryProfile: 'desktop',
  outputSink: 'blob-handoff',
  checkpointMode: 'safe-retry',
}
const RESULT = createExportResult({
  kind: 'full-resolution',
  output: createBlobOutputResult({
    filename: 'frame_fullres.jpg',
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
  }),
  width: 1600,
  height: 1200,
  copyCapability: { mode: 'full-resolution' },
  identity: captureExportResultIdentity({
    resultKind: 'full-resolution',
    attemptId: 'attempt-view-state',
    sessionId: SESSION_ID,
    sourceFile: new File(['raw'], 'frame.ARW'),
    intent: {
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0,
      ...NEUTRAL_USER_COLOR_INTENT,
    },
    lut: null,
    rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    geometry: null,
  }),
})

describe('session view command policy', () => {
  it('maps each view mode to the command it asks for', () => {
    expect(sessionViewCommandForMode('original')).toBe('originalView')
    expect(sessionViewCommandForMode('compare')).toBe('split')
    expect(sessionViewCommandForMode('processed')).toBeNull()
  })

  it('opens the original on the CPU preview and the split only on WebGPU', () => {
    expect(allowed(createSession(), GPU)).toEqual(COMMANDS)
    expect(allowed(createSession(), CPU)).toEqual(['originalView'])
    expect(allowed(createSession(), PENDING)).toEqual(['originalView'])
  })

  it('refuses the original and the split for a committed Transform', () => {
    const transform = transformAt('accepted', SESSION_ID)
    const session = createSession({
      transform,
      exportGeometry: heldTransformGeometry(transform),
    })

    expect(allowed(session, GPU)).toEqual([])
    expect(allowed(session, CPU)).toEqual([])
  })

  it('refuses the original and the split while export holds the preview released', () => {
    const running = withExportState({
      status: 'exporting',
      activePlan: ACTIVE_PLAN,
    })
    const released = withExportState({
      status: 'ready',
      activePlan: ACTIVE_PLAN,
      result: RESULT,
    })

    expect(isSessionPreviewReleased(running, true)).toBe(true)
    expect(allowed(running, GPU)).toEqual([])
    expect(isSessionPreviewReleased(released, false)).toBe(true)
    expect(allowed(released, GPU, false)).toEqual([])
    expect(allowed(released, CPU, false)).toEqual([])
  })

  it('treats a delivered export over a kept preview as not released', () => {
    const delivered = withExportState({
      status: 'ready',
      activePlan: ACTIVE_PLAN,
      result: RESULT,
    })
    const embedded: ImageSession = {
      ...delivered,
      previewBundle: {
        ...delivered.previewBundle,
        embeddedPreview: {
          status: 'ready',
          objectUrl: 'blob:embedded',
        },
      },
    }
    const planless = withExportState({ status: 'exporting' })

    expect(isSessionPreviewReleased(delivered, true)).toBe(false)
    expect(isSessionPreviewReleased(embedded, false)).toBe(false)
    expect(isSessionPreviewReleased(planless, false)).toBe(false)
    expect(allowed(delivered, GPU)).toEqual(COMMANDS)
  })

  it('resets mode, split and viewport together and keeps the rest of the session', () => {
    const session = createSession({
      viewState: {
        mode: 'original',
        compareSplit: 0.1,
        zoom: 4,
        panX: 12,
        panY: -8,
        fitMode: 'custom',
      },
    })

    const next = applyCompareViewResetToSession(session)

    expect(next.viewState).toEqual({
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    })
    expect(next.exportState).toBe(session.exportState)
    expect(next.previewBundle).toBe(session.previewBundle)
  })
})
