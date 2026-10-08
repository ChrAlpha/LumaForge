import type { DecodedPreviewFrame } from './preview-frame'
import {
  isEligibleQuickPredecessor,
  isSameDecodedPreviewFrame,
  isSameDecodedPreviewSource,
} from './preview-frame'

const pinnedExposure = {
  kind: 'source-pin',
  value: { ev: 0.5, multiplier: 2 ** 0.5, source: 'image-statistics' },
} as const

const quickA: DecodedPreviewFrame = Object.freeze({
  sessionId: 'session-a',
  frameId: 'frame-a-1',
  stage: 'quick',
  width: 1600,
  height: 1000,
  exposure: pinnedExposure,
  quickPredecessorFrameId: null,
})

const hqA: DecodedPreviewFrame = Object.freeze({
  sessionId: 'session-a',
  frameId: 'frame-a-2',
  stage: 'bounded-hq',
  width: 4000,
  height: 2500,
  exposure: pinnedExposure,
  quickPredecessorFrameId: 'frame-a-1',
})

// Another source decoded at exactly the same size and exposure.
const quickB: DecodedPreviewFrame = Object.freeze({
  ...quickA,
  sessionId: 'session-b',
  frameId: 'frame-b-1',
})

describe('decoded preview frame', () => {
  it('tells sources apart by session, never by equal dimensions or exposure', () => {
    expect(isSameDecodedPreviewSource(quickA, hqA)).toBe(true)
    expect(isSameDecodedPreviewSource(quickA, quickB)).toBe(false)
    expect(isSameDecodedPreviewFrame(quickA, quickB)).toBe(false)
  })

  it('names one frame by its producer-supplied frame ID', () => {
    expect(isSameDecodedPreviewFrame(quickA, quickA)).toBe(true)
    expect(isSameDecodedPreviewFrame(quickA, { ...quickA })).toBe(true)
    expect(isSameDecodedPreviewFrame(quickA, hqA)).toBe(false)
    // A restored frame of the same source with the same pixels is a new frame.
    expect(
      isSameDecodedPreviewFrame(quickA, { ...quickA, frameId: 'frame-a-3' }),
    ).toBe(false)
  })

  it('treats a missing descriptor as no frame and no source', () => {
    expect(isSameDecodedPreviewFrame(null, null)).toBe(false)
    expect(isSameDecodedPreviewFrame(quickA, null)).toBe(false)
    expect(isSameDecodedPreviewSource(null, quickA)).toBe(false)
    expect(isEligibleQuickPredecessor(null, hqA)).toBe(false)
    expect(isEligibleQuickPredecessor(quickA, null)).toBe(false)
  })

  it('lets a bounded-HQ frame continue only the quick frame it names', () => {
    expect(isEligibleQuickPredecessor(quickA, hqA)).toBe(true)
  })

  it('refuses a quick frame of another source, even at equal dimensions', () => {
    expect(
      isEligibleQuickPredecessor(quickB, {
        ...hqA,
        quickPredecessorFrameId: quickB.frameId,
      }),
    ).toBe(false)
    expect(isEligibleQuickPredecessor(quickB, hqA)).toBe(false)
  })

  it('refuses a same-source quick frame the successor does not name', () => {
    const otherQuickA: DecodedPreviewFrame = {
      ...quickA,
      frameId: 'frame-a-0',
    }
    expect(isEligibleQuickPredecessor(otherQuickA, hqA)).toBe(false)
    expect(
      isEligibleQuickPredecessor(quickA, {
        ...hqA,
        quickPredecessorFrameId: null,
      }),
    ).toBe(false)
  })

  it('bridges only quick to bounded-HQ, never from or to an unknown stage', () => {
    // A quick frame is not a successor, and a bounded-HQ frame is not a
    // quick predecessor, whatever their links say.
    expect(
      isEligibleQuickPredecessor(quickA, {
        ...quickA,
        frameId: 'frame-a-2',
        quickPredecessorFrameId: quickA.frameId,
      }),
    ).toBe(false)
    expect(
      isEligibleQuickPredecessor(
        { ...hqA, frameId: 'frame-a-1', quickPredecessorFrameId: null },
        hqA,
      ),
    ).toBe(false)
    // A frame whose decoder named no stage is not guessed to be quick.
    expect(
      isEligibleQuickPredecessor({ ...quickA, stage: 'unknown' }, hqA),
    ).toBe(false)
    expect(
      isEligibleQuickPredecessor(quickA, { ...hqA, stage: 'unknown' }),
    ).toBe(false)
  })

  it('refuses a frame as its own predecessor', () => {
    expect(
      isEligibleQuickPredecessor(quickA, {
        ...hqA,
        frameId: quickA.frameId,
        quickPredecessorFrameId: quickA.frameId,
      }),
    ).toBe(false)
  })

  it('keeps an absent exposure pin explicit', () => {
    const unpinned: DecodedPreviewFrame = {
      ...hqA,
      exposure: {
        kind: 'unpinned',
        value: { ev: 0.2, multiplier: 2 ** 0.2, source: 'image-statistics' },
      },
      quickPredecessorFrameId: null,
    }
    expect(unpinned.exposure.kind).toBe('unpinned')
    expect(isSameDecodedPreviewSource(unpinned, quickA)).toBe(true)
  })
})
