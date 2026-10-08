import { describe, expect, it } from 'vitest'

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

const quickProcessedFrame: PreviewFrameStatus = {
  generationKey: '1:quick:quick:800:600:data',
  displaySource: 'quick',
  source: 'quick',
  state: 'ready',
}

const quickOriginalFrame: OriginalGpuFrameStatus = {
  generationKey: '1:quick:dual:compare:active',
  displaySource: 'quick',
  state: 'ready',
}

function derive(
  overrides: Partial<Parameters<typeof derivePreviewCompareReadiness>[0]> = {},
) {
  return derivePreviewCompareReadiness({
    imageVersion: 2,
    displaySource: 'bounded-hq',
    imageSource: 'bounded-hq',
    imageWidth: 1600,
    imageHeight: 1200,
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
        originalGpuStatus: {
          generationKey: '2:bounded-hq:dual:compare:active',
          displaySource: 'bounded-hq',
          state: 'ready',
        },
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
    const currentProcessedFrame: PreviewFrameStatus = {
      generationKey: '2:bounded-hq:bounded-hq:1600:1200:data',
      displaySource: 'bounded-hq',
      source: 'bounded-hq',
      state: 'ready',
    }
    const currentOriginalFrame: OriginalGpuFrameStatus = {
      generationKey: '2:bounded-hq:dual:compare:active',
      displaySource: 'bounded-hq',
      state: 'ready',
    }

    expect(
      derive({
        processedFrameStatus: currentProcessedFrame,
        originalGpuStatus: currentOriginalFrame,
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
        imageSource: 'quick',
        embeddedPreviewUrl: null,
      }),
    ).toMatchObject({
      originalGpuLayerEligible: true,
      embeddedPreviewFallbackReady: false,
    })
  })
})

describe('preview generation keys', () => {
  const image = {
    imageVersion: 2,
    displaySource: 'bounded-hq' as const,
    imageSource: 'bounded-hq' as const,
    imageWidth: 1600,
    imageHeight: 1200,
    hasImageData: true,
  }

  it('keys the processed frame by its image alone, never by the view', () => {
    // The processed surface redraws for the original view, but the image on
    // the GPU and its first-frame proof stay valid across view changes.
    const processedKey = getProcessedImageGenerationKey(image)
    for (const viewMode of ['processed', 'original', 'compare'] as const) {
      expect(derive({ ...image, viewMode }).processedImageGenerationKey).toBe(
        processedKey,
      )
    }
    expect(processedKey).toBe('2:bounded-hq:bounded-hq:1600:1200:data')
    expect(
      getProcessedImageGenerationKey({ ...image, imageVersion: 3 }),
    ).not.toBe(processedKey)
    expect(
      getProcessedImageGenerationKey({ ...image, hasImageData: false }),
    ).not.toBe(processedKey)
  })

  it('keys the original layer by view mode, compare policy, and suspension', () => {
    const base = {
      imageVersion: 2,
      displaySource: 'bounded-hq' as const,
      dualGpuAllowed: true,
      viewMode: 'compare' as const,
      suspended: false,
    }
    const key = getOriginalGpuGenerationKey(base)
    expect(key).toBe('2:bounded-hq:dual:compare:active')
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
  const currentProcessedFrame: PreviewFrameStatus = {
    generationKey: '2:bounded-hq:bounded-hq:1600:1200:data',
    displaySource: 'bounded-hq',
    source: 'bounded-hq',
    state: 'ready',
  }

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
        originalGpuStatus: {
          generationKey: '2:bounded-hq:dual:processed:active',
          displaySource: 'bounded-hq',
          state: 'ready',
        },
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
        imageVersion: 3,
        processedFrameStatus: {
          generationKey: '2:bounded-hq:bounded-hq:1600:1200:data',
          displaySource: 'bounded-hq',
          source: 'bounded-hq',
          state: 'ready',
        },
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
        originalGpuStatus: {
          generationKey: '1:quick:dual:compare:active',
          displaySource: 'quick',
          state: 'failed',
        },
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
      processedFrameStatus: {
        generationKey: '2:bounded-hq:bounded-hq:1600:1200:data',
        displaySource: 'bounded-hq',
        source: 'bounded-hq',
        state: 'ready',
      },
      originalGpuStatus: {
        generationKey: '2:bounded-hq:dual:compare:active',
        displaySource: 'bounded-hq',
        state: 'failed',
      },
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
      originalGpuGenerationKey: '2:bounded-hq:dual:compare:suspended',
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
    const nextStatus: PreviewFrameStatus = {
      ...quickProcessedFrame,
      generationKey: '2:bounded-hq:bounded-hq:1600:1200:data',
      displaySource: 'bounded-hq',
      source: 'bounded-hq',
    }

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
