import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../model/session'
import {
  applyBoundedHqPreviewFailure,
  applyBoundedHqPreviewSkipped,
  applyPreviewLoadStarted,
  applyPreviewReady,
  applyQuickPreviewFailure,
} from './preview-session-state'

const baseSession: ImageSession = {
  id: 'session-1',
  createdAt: 1,
  sourceFile: {
    name: 'frame.ARW',
    extension: 'arw',
    sizeBytes: 123,
    supportLevel: 'experimental',
  },
  previewBundle: {
    embeddedPreview: { status: 'idle' },
    quickDecodePreview: { status: 'idle' },
    boundedHqPreview: { status: 'idle' },
    displaySource: 'none',
    boundedHqRequiredForExport: false,
  },
  activeStyle: null,
  viewState: {
    mode: 'processed',
    compareSplit: 0.5,
    zoom: 1,
    panX: 0,
    panY: 0,
    fitMode: 'screen',
  },
  renderState: { status: 'idle' },
  exportState: {
    status: 'idle',
    fullResCapability: { status: 'unknown' },
    retryRecommended: false,
  },
}

function createDecodedImage(
  source: 'quick' | 'bounded-hq',
  overrides: Partial<DecodedImage> = {},
): DecodedImage {
  return {
    width: source === 'quick' ? 800 : 4000,
    height: source === 'quick' ? 600 : 3000,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array([0, 1024, 65535]),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    timings: { total: source === 'quick' ? 20 : 120 },
    metadata: {
      make: 'Sony',
      model: 'A7',
      width: source === 'quick' ? 800 : 4000,
      height: source === 'quick' ? 600 : 3000,
    },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    ...overrides,
  }
}

describe('preview session state transitions', () => {
  it('starts RAW preview loading while preserving compare split and probing export capability', () => {
    expect(applyPreviewLoadStarted(baseSession, 0.8)).toMatchObject({
      viewState: {
        mode: 'compare',
        compareSplit: 0.8,
      },
      previewBundle: {
        quickDecodePreview: { status: 'loading' },
        boundedHqPreview: { status: 'loading' },
        displaySource: 'none',
      },
      renderState: { status: 'preparing' },
      exportState: {
        fullResCapability: { status: 'probing' },
      },
    })
  })

  it('publishes an embedded preview without marking the decoded render path ready', () => {
    const session = applyPreviewReady(baseSession, 'embedded', {
      width: 1600,
      height: 1067,
      objectUrl: 'blob:embedded-preview',
      mimeType: 'image/jpeg',
      timings: { total: 8 },
    })

    expect(session.previewBundle).toMatchObject({
      embeddedPreview: {
        status: 'ready',
        width: 1600,
        height: 1067,
        objectUrl: 'blob:embedded-preview',
        mimeType: 'image/jpeg',
        timings: { total: 8 },
      },
      displaySource: 'embedded',
    })
    expect(session.sourceFile).toEqual(baseSession.sourceFile)
    expect(session.renderState).toEqual(baseSession.renderState)
  })

  it('upgrades quick preview to display source and records decoded metadata', () => {
    const embeddedSession = applyPreviewReady(baseSession, 'embedded', {
      width: 1600,
      height: 1067,
      objectUrl: 'blob:embedded-preview',
      mimeType: 'image/jpeg',
    })
    const decoded = createDecodedImage('quick')

    const session = applyPreviewReady(
      embeddedSession,
      'quick',
      { width: 800, height: 600 },
      decoded,
    )

    expect(session.previewBundle).toMatchObject({
      embeddedPreview: { status: 'ready' },
      quickDecodePreview: {
        status: 'ready',
        width: 800,
        height: 600,
        timings: { total: 20 },
      },
      displaySource: 'quick',
    })
    expect(session.sourceFile).toMatchObject({
      cameraBrand: 'Sony',
      cameraModel: 'A7',
      rawFormat: 'arw',
      width: 800,
      height: 600,
      supportLevel: 'experimental',
    })
    expect(session.renderState).toEqual({
      status: 'ready',
      lastRenderSource: 'quick',
    })
  })

  it('keeps an unsupported source fact when decoded camera facts arrive', () => {
    const unsupportedSession: ImageSession = {
      ...baseSession,
      sourceFile: { ...baseSession.sourceFile, supportLevel: 'unsupported' },
    }

    const session = applyPreviewReady(
      unsupportedSession,
      'quick',
      { width: 800, height: 600 },
      createDecodedImage('quick'),
    )

    expect(session.sourceFile).toMatchObject({
      cameraBrand: 'Sony',
      cameraModel: 'A7',
      supportLevel: 'unsupported',
    })
  })

  it('makes bounded HQ the preferred display source when it becomes ready', () => {
    const quickSession = applyPreviewReady(
      baseSession,
      'quick',
      { width: 800, height: 600 },
      createDecodedImage('quick'),
    )

    const session = applyPreviewReady(
      quickSession,
      'bounded-hq',
      { width: 4000, height: 3000 },
      createDecodedImage('bounded-hq'),
    )

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: { status: 'ready' },
      boundedHqPreview: {
        status: 'ready',
        width: 4000,
        height: 3000,
        timings: { total: 120 },
      },
      displaySource: 'bounded-hq',
    })
    expect(session.renderState).toEqual({
      status: 'ready',
      lastRenderSource: 'bounded-hq',
    })
  })

  it('fails quick and bounded HQ previews while falling back to embedded display', () => {
    const embeddedSession = applyPreviewReady(baseSession, 'embedded', {
      width: 1600,
      height: 1067,
      objectUrl: 'blob:embedded-preview',
      mimeType: 'image/jpeg',
    })

    const session = applyQuickPreviewFailure(
      embeddedSession,
      'RAW_QUICK_DECODE_FAILED',
    )

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: {
        status: 'failed',
        errorCode: 'RAW_QUICK_DECODE_FAILED',
      },
      boundedHqPreview: {
        status: 'failed',
        errorCode: 'RAW_QUICK_DECODE_FAILED',
      },
      displaySource: 'embedded',
    })
    expect(session.renderState).toEqual({
      status: 'failed',
      lastErrorCode: 'RAW_QUICK_DECODE_FAILED',
    })
    expect(session.exportState.fullResCapability).toEqual({
      status: 'unsupported',
      reason: 'Quick preview did not complete.',
    })
  })

  it('records bounded HQ failure without disturbing the quick preview', () => {
    const quickSession = applyPreviewReady(
      baseSession,
      'quick',
      { width: 800, height: 600 },
      createDecodedImage('quick'),
    )

    const session = applyBoundedHqPreviewFailure(
      quickSession,
      'RAW_HQ_DECODE_FAILED',
    )

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: { status: 'ready' },
      boundedHqPreview: {
        status: 'failed',
        errorCode: 'RAW_HQ_DECODE_FAILED',
      },
      displaySource: 'quick',
    })
    expect(session.renderState).toEqual(quickSession.renderState)
    expect(session.exportState).toEqual(quickSession.exportState)
  })

  it('records bounded HQ skip reason without disturbing the quick preview', () => {
    const quickSession = applyPreviewReady(
      baseSession,
      'quick',
      { width: 800, height: 600 },
      createDecodedImage('quick'),
    )

    const session = applyBoundedHqPreviewSkipped(
      quickSession,
      'Source fits within quick preview cap 2500000.',
    )

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: { status: 'ready' },
      boundedHqPreview: {
        status: 'skipped',
        reason: 'Source fits within quick preview cap 2500000.',
      },
      displaySource: 'quick',
    })
    expect(session.renderState).toEqual(quickSession.renderState)
  })
})
