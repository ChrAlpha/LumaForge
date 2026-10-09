import { describe, expect, it } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import type {
  OriginalGpuFrameStatus,
  PreviewFrameStatus,
} from './preview-compare-readiness'
import {
  derivePreviewCompareReadiness,
  derivePreviewFrameStatusTransition,
  derivePreviewTrackReadinessTransition,
  EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  EMPTY_PREVIEW_FRAME_STATUS,
  getOriginalGpuGenerationKey,
  getProcessedImageGenerationKey,
} from './preview-compare-readiness'

function frameDescriptor({
  sessionId = 'session-1',
  frameId,
  stage,
  width = 1600,
  height = 1200,
  quickPredecessorFrameId = null,
}: Pick<DecodedPreviewFrame, 'frameId' | 'stage'> &
  Partial<DecodedPreviewFrame>): DecodedPreviewFrame {
  return {
    sessionId,
    frameId,
    stage,
    width,
    height,
    exposure: {
      kind: 'source-pin',
      value: { ev: 0, multiplier: 1, source: 'identity' },
    },
    quickPredecessorFrameId,
  }
}

const quickFrame = frameDescriptor({
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: 800,
  height: 600,
})
const boundedHqFrame = frameDescriptor({
  frameId: 'decoded-frame-2',
  stage: 'bounded-hq',
  quickPredecessorFrameId: quickFrame.frameId,
})

const quickProcessedFrame: PreviewFrameStatus = {
  generationKey: getProcessedImageGenerationKey({ frame: quickFrame }),
  frame: quickFrame,
  state: 'ready',
}

const quickOriginalFrame: OriginalGpuFrameStatus = {
  generationKey: getOriginalGpuGenerationKey({
    frame: quickFrame,
    dualGpuAllowed: true,
    viewMode: 'compare',
    suspended: false,
  }),
  frame: quickFrame,
  state: 'ready',
}

const currentProcessedFrame: PreviewFrameStatus = {
  generationKey: getProcessedImageGenerationKey({ frame: boundedHqFrame }),
  frame: boundedHqFrame,
  state: 'ready',
}

function originalStatus(
  state: OriginalGpuFrameStatus['state'],
  overrides: Partial<Parameters<typeof getOriginalGpuGenerationKey>[0]> = {},
): OriginalGpuFrameStatus {
  const frame = overrides.frame === undefined ? boundedHqFrame : overrides.frame
  return {
    generationKey: getOriginalGpuGenerationKey({
      frame,
      dualGpuAllowed: true,
      viewMode: 'compare',
      suspended: false,
      ...overrides,
    }),
    frame,
    state,
  }
}

function derive(
  overrides: Partial<Parameters<typeof derivePreviewCompareReadiness>[0]> = {},
) {
  return derivePreviewCompareReadiness({
    frame: boundedHqFrame,
    displaySource: 'bounded-hq',
    hasImageData: true,
    trackReady: true,
    embeddedPreviewUrl: 'blob:embedded',
    viewMode: 'compare',
    dualGpuAllowed: true,
    suspended: false,
    supportsCssClip: true,
    originalGpuStatus: quickOriginalFrame,
    processedFrameStatus: quickProcessedFrame,
    ...overrides,
  })
}

describe('derivePreviewCompareReadiness', () => {
  it('keeps a synchronized quick compare pair active during bounded-HQ handoff', () => {
    expect(derive()).toMatchObject({
      currentProcessedFrameReady: false,
      originalGpuReady: false,
      retainedOriginalGpuFrameReady: true,
      retainedProcessedFrameReady: true,
      retainedCompareFrameReady: true,
      compareFrameBridgeReady: true,
      embeddedPreviewFallbackReady: false,
      shouldDelayProcessedCompareRender: true,
      shouldMountOriginalGpuLayer: true,
    })
  })

  it('keeps the compare pair while the processed HQ frame is still completing on the GPU', () => {
    // The original layer reports its bounded-HQ frame first; the processed
    // frame commits only after its own GPU completion.
    expect(
      derive({
        originalGpuStatus: originalStatus('ready'),
      }),
    ).toMatchObject({
      originalGpuReady: true,
      currentProcessedFrameReady: false,
      retainedCompareFrameReady: false,
      compareFrameBridgeReady: true,
      shouldDelayProcessedCompareRender: false,
    })
  })

  it('does not retain compare when only one side still has a quick frame', () => {
    expect(
      derive({
        processedFrameStatus: EMPTY_PREVIEW_FRAME_STATUS,
      }),
    ).toMatchObject({
      retainedOriginalGpuFrameReady: true,
      retainedProcessedFrameReady: false,
      retainedCompareFrameReady: false,
      compareFrameBridgeReady: false,
      embeddedPreviewFallbackReady: true,
      shouldDelayProcessedCompareRender: false,
    })
  })

  it('treats same-generation bounded-HQ processed and original frames as current', () => {
    expect(
      derive({
        processedFrameStatus: currentProcessedFrame,
        originalGpuStatus: originalStatus('ready'),
      }),
    ).toMatchObject({
      currentProcessedFrameReady: true,
      processedPreviewVisible: true,
      originalGpuReady: true,
      retainedCompareFrameReady: false,
      embeddedPreviewFallbackReady: false,
      shouldDelayProcessedCompareRender: false,
    })
  })

  it('uses embedded URL presence rather than display source alone for original layer eligibility', () => {
    expect(
      derive({
        displaySource: 'embedded',
        frame: quickFrame,
        embeddedPreviewUrl: null,
      }),
    ).toMatchObject({
      originalGpuLayerEligible: true,
      embeddedPreviewFallbackReady: false,
    })
  })
})

describe('derivePreviewCompareReadiness retained quick frame', () => {
  const retainedFlags = {
    retainedOriginalGpuFrameReady: false,
    retainedProcessedFrameReady: false,
    retainedCompareFrameReady: false,
    compareFrameBridgeReady: false,
    shouldDelayProcessedCompareRender: false,
  }

  it.each([
    [
      'another source of equal size and stage',
      frameDescriptor({
        sessionId: 'session-2',
        frameId: 'decoded-frame-2',
        stage: 'bounded-hq',
        width: 800,
        height: 600,
        quickPredecessorFrameId: quickFrame.frameId,
      }),
    ],
    [
      'a restored frame that names no predecessor',
      frameDescriptor({ frameId: 'decoded-frame-3', stage: 'bounded-hq' }),
    ],
    [
      'a frame that names another quick frame',
      frameDescriptor({
        frameId: 'decoded-frame-3',
        stage: 'bounded-hq',
        quickPredecessorFrameId: 'decoded-frame-0',
      }),
    ],
    [
      'a frame of unknown stage',
      frameDescriptor({
        frameId: 'decoded-frame-3',
        stage: 'unknown',
        quickPredecessorFrameId: quickFrame.frameId,
      }),
    ],
    [
      'another quick frame',
      frameDescriptor({
        frameId: 'decoded-frame-3',
        stage: 'quick',
        quickPredecessorFrameId: quickFrame.frameId,
      }),
    ],
  ])('never bridges the quick pair into %s', (_, frame) => {
    expect(derive({ frame })).toMatchObject({
      ...retainedFlags,
      currentProcessedFrameReady: false,
      originalGpuReady: false,
    })
  })

  it('bridges nothing without an accepted descriptor or its pixels', () => {
    expect(derive({ frame: null })).toMatchObject({
      ...retainedFlags,
      originalGpuLayerEligible: false,
      shouldMountOriginalGpuLayer: false,
    })
    expect(derive({ hasImageData: false })).toMatchObject({
      ...retainedFlags,
      originalGpuLayerEligible: false,
    })
  })

  it('never retains a status that names no frame', () => {
    expect(
      derive({
        processedFrameStatus: { ...quickProcessedFrame, frame: null },
        originalGpuStatus: { ...quickOriginalFrame, frame: null },
      }),
    ).toMatchObject(retainedFlags)
  })
})

describe('derivePreviewCompareReadiness embedded camera reference', () => {
  const quickImage = {
    frame: quickFrame,
    displaySource: 'quick' as const,
    viewMode: 'processed' as const,
    originalGpuStatus: EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  }

  it('covers the stage with the embedded JPEG until the quick frame is visible', () => {
    expect(
      derive({
        ...quickImage,
        processedFrameStatus: EMPTY_PREVIEW_FRAME_STATUS,
      }),
    ).toMatchObject({
      showEmbeddedPreview: false,
      embeddedHandoffPreviewVisible: true,
    })
    expect(
      derive({ ...quickImage, processedFrameStatus: quickProcessedFrame }),
    ).toMatchObject({
      processedPreviewVisible: true,
      embeddedHandoffPreviewVisible: false,
    })
    // A frame behind a track that has not fit yet is not on screen.
    expect(
      derive({
        ...quickImage,
        trackReady: false,
        processedFrameStatus: quickProcessedFrame,
      }),
    ).toMatchObject({ embeddedHandoffPreviewVisible: true })
  })

  it('shows the embedded JPEG itself before any decoded image, without a handoff', () => {
    expect(
      derive({
        ...quickImage,
        displaySource: 'embedded',
        frame: null,
        hasImageData: false,
        processedFrameStatus: EMPTY_PREVIEW_FRAME_STATUS,
      }),
    ).toMatchObject({
      showEmbeddedPreview: true,
      embeddedHandoffPreviewVisible: false,
    })
    expect(
      derive({
        ...quickImage,
        embeddedPreviewUrl: null,
        processedFrameStatus: EMPTY_PREVIEW_FRAME_STATUS,
      }),
    ).toMatchObject({
      showEmbeddedPreview: false,
      embeddedHandoffPreviewVisible: false,
    })
  })
})

describe('preview generation keys', () => {
  it('keys the processed frame by its accepted frame alone, never by the view', () => {
    // The processed surface redraws for the original view, but the image on
    // the GPU and its first-frame proof stay valid across view changes.
    const processedKey = getProcessedImageGenerationKey({
      frame: boundedHqFrame,
    })
    for (const viewMode of ['processed', 'original', 'compare'] as const) {
      expect(derive({ viewMode }).processedImageGenerationKey).toBe(
        processedKey,
      )
    }
    // The display source and the image ref's pixels name no frame.
    expect(
      derive({ displaySource: 'quick', hasImageData: false })
        .processedImageGenerationKey,
    ).toBe(processedKey)
  })

  it('gives every accepted frame its own key, whatever its size and stage', () => {
    const key = (frame: DecodedPreviewFrame | null) =>
      getProcessedImageGenerationKey({ frame })
    const restored = frameDescriptor({
      frameId: 'decoded-frame-3',
      stage: 'bounded-hq',
    })
    const otherSource = frameDescriptor({
      sessionId: 'session-2',
      frameId: boundedHqFrame.frameId,
      stage: 'bounded-hq',
    })
    const keys = [key(boundedHqFrame), key(restored), key(otherSource)]
    expect(new Set(keys).size).toBe(3)
    expect(key({ ...boundedHqFrame })).toBe(key(boundedHqFrame))
    expect(key(null)).not.toBe(key(boundedHqFrame))
    // An id that looks like a joined key cannot collide with another frame.
    expect(
      key(frameDescriptor({ sessionId: 'a:b', frameId: 'c', stage: 'quick' })),
    ).not.toBe(
      key(frameDescriptor({ sessionId: 'a', frameId: 'b:c', stage: 'quick' })),
    )
  })

  it('keys the original layer by its frame, view mode, compare policy, and suspension', () => {
    const base = {
      frame: boundedHqFrame,
      dualGpuAllowed: true,
      viewMode: 'compare' as const,
      suspended: false,
    }
    const key = getOriginalGpuGenerationKey(base)
    expect(
      getOriginalGpuGenerationKey({ ...base, frame: { ...boundedHqFrame } }),
    ).toBe(key)
    expect(
      getOriginalGpuGenerationKey({ ...base, frame: quickFrame }),
    ).not.toBe(key)
    expect(getOriginalGpuGenerationKey({ ...base, frame: null })).not.toBe(key)
    expect(
      getOriginalGpuGenerationKey({ ...base, viewMode: 'processed' }),
    ).not.toBe(key)
    expect(
      getOriginalGpuGenerationKey({ ...base, dualGpuAllowed: false }),
    ).not.toBe(key)
    expect(getOriginalGpuGenerationKey({ ...base, suspended: true })).not.toBe(
      key,
    )
  })
})

describe('derivePreviewCompareReadiness output selection', () => {
  it('keeps the processed frame ready across view modes while only compare mounts the original layer', () => {
    for (const viewMode of ['processed', 'original'] as const) {
      expect(
        derive({ viewMode, processedFrameStatus: currentProcessedFrame }),
      ).toMatchObject({
        currentProcessedFrameReady: true,
        processedPreviewVisible: true,
        originalGpuLayerEligible: false,
        shouldMountOriginalGpuLayer: false,
        retainedCompareFrameReady: false,
        compareFrameBridgeReady: false,
        embeddedPreviewFallbackReady: false,
        shouldDelayProcessedCompareRender: false,
      })
    }
  })

  it('never treats a ready original frame from another view as current', () => {
    expect(
      derive({
        viewMode: 'compare',
        processedFrameStatus: currentProcessedFrame,
        originalGpuStatus: originalStatus('ready', { viewMode: 'processed' }),
      }),
    ).toMatchObject({
      originalGpuReady: false,
      originalGpuFailed: false,
      retainedOriginalGpuFrameReady: false,
      embeddedPreviewFallbackReady: true,
    })
  })

  it('keeps processed visibility behind the aspect-fit track', () => {
    expect(
      derive({
        trackReady: false,
        processedFrameStatus: currentProcessedFrame,
      }),
    ).toMatchObject({
      currentProcessedFrameReady: true,
      processedPreviewVisible: false,
    })
  })
})

describe('derivePreviewCompareReadiness obsolete work', () => {
  it('never marks a frame ready from an obsolete processed generation', () => {
    expect(
      derive({
        frame: frameDescriptor({
          frameId: 'decoded-frame-3',
          stage: 'bounded-hq',
        }),
        processedFrameStatus: currentProcessedFrame,
        originalGpuStatus: EMPTY_ORIGINAL_GPU_FRAME_STATUS,
      }),
    ).toMatchObject({
      currentProcessedFrameReady: false,
      processedPreviewVisible: false,
      // Retention bridges only a quick frame into its bounded-HQ successor.
      retainedProcessedFrameReady: false,
      compareFrameBridgeReady: false,
    })
  })

  it('isolates an obsolete original failure from the current compare', () => {
    expect(
      derive({
        originalGpuStatus: { ...quickOriginalFrame, state: 'failed' },
      }),
    ).toMatchObject({
      originalGpuFailed: false,
      shouldMountOriginalGpuLayer: true,
      retainedOriginalGpuFrameReady: false,
      retainedCompareFrameReady: false,
      shouldDelayProcessedCompareRender: false,
    })
  })

  it('unmounts only the original layer after its current generation fails', () => {
    const failed = derive({
      processedFrameStatus: currentProcessedFrame,
      originalGpuStatus: originalStatus('failed'),
    })
    expect(failed).toMatchObject({
      originalGpuFailed: true,
      originalGpuReady: false,
      originalGpuLayerEligible: true,
      shouldMountOriginalGpuLayer: false,
      currentProcessedFrameReady: true,
      processedPreviewVisible: true,
    })
  })

  it('withholds the original layer and retention while suspended', () => {
    expect(derive({ suspended: true })).toMatchObject({
      originalGpuGenerationKey: getOriginalGpuGenerationKey({
        frame: boundedHqFrame,
        dualGpuAllowed: true,
        viewMode: 'compare',
        suspended: true,
      }),
      originalGpuLayerEligible: false,
      shouldMountOriginalGpuLayer: false,
      retainedOriginalGpuFrameReady: false,
      retainedCompareFrameReady: false,
      shouldDelayProcessedCompareRender: false,
      embeddedPreviewFallbackReady: false,
    })
  })
})

describe('derivePreviewTrackReadinessTransition', () => {
  it('retains track readiness while a processed quick frame covers bounded-HQ handoff', () => {
    expect(
      derivePreviewTrackReadinessTransition({
        retainedTrackIdentity: '',
        processedTrackIdentity: '2:1600:1200',
        retainedProcessedFrameReady: true,
      }),
    ).toEqual({
      nextRetainedTrackIdentity: '2:1600:1200',
      resetTrackReady: false,
    })
  })

  it('does not reset track readiness while the retained handoff identity is still current', () => {
    expect(
      derivePreviewTrackReadinessTransition({
        retainedTrackIdentity: '2:1600:1200',
        processedTrackIdentity: '2:1600:1200',
        retainedProcessedFrameReady: false,
      }),
    ).toEqual({
      nextRetainedTrackIdentity: '2:1600:1200',
      resetTrackReady: false,
    })
  })

  it('retains track readiness while an embedded handoff image covers quick decode', () => {
    expect(
      derivePreviewTrackReadinessTransition({
        retainedTrackIdentity: '',
        processedTrackIdentity: '1:800:600',
        retainedProcessedFrameReady: false,
        handoffPreviewVisible: true,
      }),
    ).toEqual({
      nextRetainedTrackIdentity: '1:800:600',
      resetTrackReady: false,
    })
  })

  it('clears retained identity and resets track readiness for a new preview identity', () => {
    expect(
      derivePreviewTrackReadinessTransition({
        retainedTrackIdentity: '2:1600:1200',
        processedTrackIdentity: '3:1600:1200',
        retainedProcessedFrameReady: false,
      }),
    ).toEqual({
      nextRetainedTrackIdentity: '',
      resetTrackReady: true,
    })
  })
})

describe('derivePreviewFrameStatusTransition', () => {
  it('skips committing an unchanged processed frame status', () => {
    expect(
      derivePreviewFrameStatusTransition({
        currentStatus: quickProcessedFrame,
        nextStatus: quickProcessedFrame,
      }),
    ).toEqual({
      nextStatus: quickProcessedFrame,
      shouldCommit: false,
    })
  })

  it('commits a changed processed frame generation', () => {
    const nextStatus = currentProcessedFrame

    expect(
      derivePreviewFrameStatusTransition({
        currentStatus: quickProcessedFrame,
        nextStatus,
      }),
    ).toEqual({
      nextStatus,
      shouldCommit: true,
    })
  })

  it('commits reset when the current status is not already empty', () => {
    expect(
      derivePreviewFrameStatusTransition({
        currentStatus: quickProcessedFrame,
        nextStatus: EMPTY_PREVIEW_FRAME_STATUS,
      }),
    ).toEqual({
      nextStatus: EMPTY_PREVIEW_FRAME_STATUS,
      shouldCommit: true,
    })
  })
})
