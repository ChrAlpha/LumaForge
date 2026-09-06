import { isSupportedRaw } from '~/lib/raw/decoder'

import type { PreviewFrame, PreviewSource } from './preview-types'
import {
  ImageInputError,
  MAX_IMAGE_BYTES,
  MAX_PREVIEW_EDGE,
  MAX_RAW_BYTES,
} from './preview-types'

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

export function validateImageInput(file: Pick<File, 'name' | 'size' | 'type'>) {
  const raw = isSupportedRaw(file.name)
  if (
    !raw &&
    !/^image\/(?:jpeg|png|webp)$/.test(file.type) &&
    !/\.(?:jpe?g|png|webp)$/i.test(file.name)
  ) {
    throw new ImageInputError('unsupported')
  }
  if (!file.size || file.size > (raw ? MAX_RAW_BYTES : MAX_IMAGE_BYTES)) {
    throw new ImageInputError(file.size ? 'too-large' : 'decode')
  }
  return raw ? 'raw' : 'image'
}

function drawPreview(
  source: CanvasImageSource,
  width: number,
  height: number,
): PreviewFrame {
  const dimensions = previewDimensions(width, height)
  const canvas = document.createElement('canvas')
  Object.assign(canvas, dimensions)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new ImageInputError('decode')
  context.drawImage(source, 0, 0, dimensions.width, dimensions.height)
  return {
    ...dimensions,
    data: context.getImageData(0, 0, dimensions.width, dimensions.height).data,
  }
}

export async function loadRasterPreview(
  file: Blob,
  name: string,
  signal: AbortSignal,
): Promise<PreviewSource> {
  signal.throwIfAborted()
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    image.src = url
    await image.decode()
    signal.throwIfAborted()
    return {
      frame: drawPreview(image, image.naturalWidth, image.naturalHeight),
      name,
      kind: 'image',
      originalWidth: image.naturalWidth,
      originalHeight: image.naturalHeight,
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ImageInputError) throw error
    throw new ImageInputError('decode')
  } finally {
    image.src = ''
    URL.revokeObjectURL(url)
  }
}

async function loadRawPreview(
  file: File,
  signal: AbortSignal,
): Promise<PreviewSource> {
  const [
    { rawRuntimeAdapter },
    { resolveExportColorGraph },
    { renderCpuPreviewFrame },
  ] = await Promise.all([
    import('~/lib/raw/runtime-adapter'),
    import('@lumaforge/luma-color-runtime'),
    import('@lumaforge/render-engine/preview'),
  ])
  signal.throwIfAborted()
  const session = await rawRuntimeAdapter.openSession(file, signal)
  try {
    const decoded = await session.decodeQuickRaw(undefined, signal)
    signal.throwIfAborted()
    const graph = resolveExportColorGraph({
      styleKind: 'none',
      intensity: 0,
      builtinPreset: null,
      lut: null,
      rawRenderExposure: decoded.renderExposure,
    })
    if (!graph.supported || !(decoded.data instanceof Uint16Array))
      throw new ImageInputError('decode')
    const rgba = renderCpuPreviewFrame({
      data: decoded.data,
      width: decoded.width,
      height: decoded.height,
      graph,
    })
    const canvas = document.createElement('canvas')
    canvas.width = decoded.width
    canvas.height = decoded.height
    const context = canvas.getContext('2d')
    if (!context) throw new ImageInputError('decode')
    context.putImageData(
      new ImageData(new Uint8ClampedArray(rgba), decoded.width, decoded.height),
      0,
      0,
    )
    return {
      frame: drawPreview(canvas, decoded.width, decoded.height),
      name: file.name,
      kind: 'raw',
      originalWidth: session.sourceDimensions.width ?? decoded.width,
      originalHeight: session.sourceDimensions.height ?? decoded.height,
    }
  } finally {
    session.dispose()
  }
}

export async function loadImageInput(
  file: File,
  signal: AbortSignal,
): Promise<PreviewSource> {
  return validateImageInput(file) === 'raw'
    ? loadRawPreview(file, signal)
    : loadRasterPreview(file, file.name, signal)
}
