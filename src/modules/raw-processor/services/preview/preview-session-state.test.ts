import type { DecodedImage } from '~/lib/raw/decoder'

import {
  createTestDecodedImage,
  createTestSession,
} from '../../test-support/builders'
import {
  applyBoundedHqPreviewFailure,
  applyBoundedHqPreviewSkipped,
  applyPreviewLoadStarted,
  applyPreviewReady,
  applyQuickPreviewFailure,
} from './preview-session-state'

const baseSession = createTestSession({ viewState: { mode: 'processed' } })

function createDecodedImage(source: 'quick' | 'bounded-hq'): DecodedImage {
  const [width, height] = source === 'quick' ? [800, 600] : [4000, 3000]
  return createTestDecodedImage({
    width,
    height,
    source,
    data: new Uint16Array([0, 1024, 65535]),
    metadata: { make: 'Sony', model: 'A7', width, height },
  })
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
    })

    expect(session.previewBundle).toMatchObject({
      embeddedPreview: {
        status: 'ready',
        width: 1600,
        height: 1067,
        objectUrl: 'blob:embedded-preview',
        mimeType: 'image/jpeg',
      },
      displaySource: 'embedded',
    })
    expect(session.sourceFile).toEqual(baseSession.sourceFile)
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
      },
      displaySource: 'quick',
    })
    expect(session.sourceFile).toMatchObject({
      metadata: decoded.metadata,
      supportLevel: 'experimental',
    })
  })

  it('keeps an unsupported source fact when decoded camera facts arrive', () => {
    const unsupportedSession = createTestSession({
      viewState: { mode: 'processed' },
      sourceFile: { supportLevel: 'unsupported' },
    })

    const session = applyPreviewReady(
      unsupportedSession,
      'quick',
      { width: 800, height: 600 },
      createDecodedImage('quick'),
    )

    expect(session.sourceFile).toMatchObject({
      metadata: { make: 'Sony', model: 'A7' },
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
      },
      displaySource: 'bounded-hq',
    })
  })

  it('fails quick and bounded HQ previews while falling back to embedded display', () => {
    const embeddedSession = applyPreviewReady(baseSession, 'embedded', {
      width: 1600,
      height: 1067,
      objectUrl: 'blob:embedded-preview',
      mimeType: 'image/jpeg',
    })

    const session = applyQuickPreviewFailure(embeddedSession)

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: { status: 'failed' },
      boundedHqPreview: { status: 'failed' },
      displaySource: 'embedded',
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

    const session = applyBoundedHqPreviewFailure(quickSession)

    expect(session.previewBundle).toMatchObject({
      quickDecodePreview: { status: 'ready' },
      boundedHqPreview: { status: 'failed' },
      displaySource: 'quick',
    })
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
  })
})
