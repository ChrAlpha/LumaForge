import type { DecodedImage } from '~/lib/raw/decoder'

import { selectDisplaySource } from '../../model/derive-session'
import type { DisplaySource, ImageSession } from '../../model/session'

type PreviewReadyPayload = {
  width: number
  height: number
  objectUrl?: string
  mimeType?: string
}

export function applyPreviewLoadStarted(
  session: ImageSession,
  compareSplit: number,
): ImageSession {
  return {
    ...session,
    viewState: {
      ...session.viewState,
      mode: 'compare',
      compareSplit,
    },
    previewBundle: {
      ...session.previewBundle,
      quickDecodePreview: { status: 'loading' },
      boundedHqPreview: { status: 'loading' },
    },
    exportState: {
      ...session.exportState,
      fullResCapability: { status: 'probing' },
    },
  }
}

export function applyPreviewReady(
  session: ImageSession,
  source: Exclude<DisplaySource, 'none'>,
  payload: PreviewReadyPayload,
  decoded?: DecodedImage | null,
): ImageSession {
  const previewBundle = {
    ...session.previewBundle,
    embeddedPreview:
      source === 'embedded'
        ? {
            status: 'ready' as const,
            width: payload.width,
            height: payload.height,
            objectUrl: payload.objectUrl,
            mimeType: payload.mimeType,
          }
        : session.previewBundle.embeddedPreview,
    quickDecodePreview:
      source === 'quick'
        ? {
            status: 'ready' as const,
            width: payload.width,
            height: payload.height,
          }
        : session.previewBundle.quickDecodePreview,
    boundedHqPreview:
      source === 'bounded-hq'
        ? {
            status: 'ready' as const,
            width: payload.width,
            height: payload.height,
          }
        : session.previewBundle.boundedHqPreview,
  }

  return {
    ...session,
    sourceFile: decoded
      ? { ...session.sourceFile, metadata: decoded.metadata }
      : session.sourceFile,
    previewBundle: {
      ...previewBundle,
      displaySource: selectDisplaySource(previewBundle),
    },
  }
}

export function applyQuickPreviewFailure(session: ImageSession): ImageSession {
  const previewBundle = {
    ...session.previewBundle,
    quickDecodePreview: { status: 'failed' as const },
    boundedHqPreview: { status: 'failed' as const },
  }

  return {
    ...session,
    previewBundle: {
      ...previewBundle,
      displaySource: selectDisplaySource(previewBundle),
    },
    exportState: {
      ...session.exportState,
      fullResCapability: {
        status: 'unsupported',
        reason: 'Quick preview did not complete.',
      },
    },
  }
}

export function applyBoundedHqPreviewFailure(
  session: ImageSession,
): ImageSession {
  const previewBundle = {
    ...session.previewBundle,
    boundedHqPreview: { status: 'failed' as const },
  }

  return {
    ...session,
    previewBundle: {
      ...previewBundle,
      displaySource: selectDisplaySource(previewBundle),
    },
  }
}

export function applyBoundedHqPreviewSkipped(
  session: ImageSession,
  reason: string,
): ImageSession {
  const previewBundle = {
    ...session.previewBundle,
    boundedHqPreview: {
      status: 'skipped' as const,
      reason,
    },
  }

  return {
    ...session,
    previewBundle: {
      ...previewBundle,
      displaySource: selectDisplaySource(previewBundle),
    },
  }
}
