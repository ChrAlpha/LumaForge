import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import type { PreviewBackendState } from '~/lib/preview/gpu-backend'

import { createExportResult } from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import { captureExportResultIdentity } from '../export/export-result-identity'
import type { TransformEvent } from '../transform/transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  reduceTransformState,
} from '../transform/transform-state'
import type { SessionViewCommand } from './view-session-state'
import {
  applyCompareSplitToSession,
  applyCompareViewResetToSession,
  applyViewModeToSession,
  canRunSessionViewCommand,
  isSessionPreviewReleased,
  sessionViewCommandForMode,
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
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 1600, height: 1200 },
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState('session-view-state'),
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
  const session = createSession()
  return {
    ...session,
    exportState: { ...session.exportState, ...exportState },
  }
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
    sessionId: 'session-view-state',
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

/** A Transform whose edit the preview answered: a committed geometry. */
function acceptedTransform(sourceId: string) {
  const geometry = {
    matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
    constrainCrop: true,
  }
  const neutral = createTransformState(sourceId)
  const events: TransformEvent[] = [
    {
      type: 'edit',
      sourceId,
      intent: { manual: { ...neutral.intent.manual, rotate: 2 } },
    },
    { type: 'capture', sourceId, captureKey: 'k', clientEpoch: 1 },
    {
      type: 'request',
      sourceId,
      captureKey: 'k',
      clientEpoch: 1,
      requestId: 1,
      geometry,
    },
    {
      type: 'rendered',
      sourceId,
      captureKey: 'k',
      clientEpoch: 1,
      requestId: 1,
      geometry,
      frame: { width: 800, height: 600 },
    },
  ]
  const state = events.reduce(reduceTransformState, neutral)
  expect(deriveTransformStatus(state)).toBe('accepted')
  return state
}

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
    const transform = acceptedTransform('session-view-state')
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
