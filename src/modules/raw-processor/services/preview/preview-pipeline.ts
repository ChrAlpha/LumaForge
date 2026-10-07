import type { ProgressivePreviewPlan } from '@lumaforge/render-engine/preview'

export type EmbeddedPreviewPayload = {
  width: number
  height: number
  data: Uint8Array
  mimeType: string
  timings?: Record<string, number | undefined>
}

export type PreviewEvent =
  | ({ type: 'embedded-ready' } & EmbeddedPreviewPayload)
  | { type: 'quick-ready'; width: number; height: number }
  | { type: 'quick-failed'; errorCode: string; message: string }
  | { type: 'bounded-hq-ready'; width: number; height: number }
  | { type: 'bounded-hq-failed'; errorCode: string }
  | { type: 'bounded-hq-skipped'; reason: string }

export type PreviewPipelineResult = {
  boundedHqPromise: Promise<void> | null
}

function toPreviewErrorCode(error: unknown, fallbackCode: string) {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }

  return fallbackCode
}

function toPreviewErrorMessage(error: unknown, fallbackMessage: string) {
  return error instanceof Error && error.message
    ? error.message
    : fallbackMessage
}

export async function runPreviewPipeline({
  runtimeSession,
  previewPlan,
  onEvent,
}: {
  runtimeSession: {
    extractEmbeddedPreview: () => Promise<EmbeddedPreviewPayload | null>
    decodeQuickRaw: () => Promise<{ width: number; height: number }>
    decodeBoundedHqRaw: (options: {
      maxOutputPixels: number
    }) => Promise<{ width: number; height: number }>
  }
  previewPlan: ProgressivePreviewPlan
  onEvent: (event: PreviewEvent) => void
}): Promise<PreviewPipelineResult> {
  let embedded: EmbeddedPreviewPayload | null = null
  try {
    embedded = await runtimeSession.extractEmbeddedPreview()
  } catch {
    embedded = null
  }

  if (embedded) {
    onEvent({ type: 'embedded-ready', ...embedded })
  }

  let quick: { width: number; height: number }
  try {
    quick = await runtimeSession.decodeQuickRaw()
  } catch (error) {
    onEvent({
      type: 'quick-failed',
      errorCode: toPreviewErrorCode(error, 'RAW_QUICK_DECODE_FAILED'),
      message: toPreviewErrorMessage(error, 'Quick preview decode failed'),
    })
    return { boundedHqPromise: null }
  }

  onEvent({ type: 'quick-ready', ...quick })
  await yieldToPreviewPaint()

  const boundedHqDecision = previewPlan.boundedHq
  if (boundedHqDecision.kind === 'skip') {
    onEvent({ type: 'bounded-hq-skipped', reason: boundedHqDecision.reason })
    return { boundedHqPromise: null }
  }

  const boundedHqPromise = (async () => {
    try {
      const boundedHq = await runtimeSession.decodeBoundedHqRaw({
        maxOutputPixels: boundedHqDecision.target.maxOutputPixels,
      })
      onEvent({ type: 'bounded-hq-ready', ...boundedHq })
    } catch (error) {
      onEvent({
        type: 'bounded-hq-failed',
        errorCode: toPreviewErrorCode(error, 'RAW_HQ_DECODE_FAILED'),
      })
    }
  })()

  return { boundedHqPromise }
}

function yieldToPreviewPaint() {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  ) {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 0)
      })
    })
  }

  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
