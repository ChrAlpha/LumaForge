import { describe, expect, it } from 'vitest'

import type {
  OriginalGpuFrameStatus,
  PreviewFrameStatus,
} from './preview-compare-readiness'
import {
  derivePreviewCompareReadiness,
  derivePreviewFrameStatusTransition,
  derivePreviewTrackReadinessTransition,
  EMPTY_PREVIEW_FRAME_STATUS,
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
