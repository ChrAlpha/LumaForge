import {
  ImageInputError,
  MAX_PREVIEW_EDGE,
} from '~/lib/transform/preview-types'

/**
 * Bound a source to the Transform preview edge without upscaling. Both edges
 * stay at least one pixel; a non-finite or empty source is a decode failure.
 */
export function previewDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new ImageInputError('decode')
  }
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
