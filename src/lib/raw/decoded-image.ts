import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { LumaRawFrame } from '@lumaforge/luma-raw-runtime'

import type {
  DecodedImage,
  DecodeExposureOptions,
  ImageMetadata,
} from './decoder'

function formatLumaShutter(shutter?: number) {
  return typeof shutter === 'number' ? `${shutter}s` : undefined
}

export function metadataToImageMetadata(frame: LumaRawFrame): ImageMetadata {
  return {
    make: frame.metadata.make,
    model: frame.metadata.model,
    lens: frame.metadata.lens,
    iso: frame.metadata.iso,
    aperture: frame.metadata.aperture,
    focalLength: frame.metadata.focalLength,
    shutterSpeed: formatLumaShutter(frame.metadata.shutter),
    timestamp:
      typeof frame.metadata.timestamp === 'number'
        ? new Date(frame.metadata.timestamp * 1000)
        : undefined,
    width: frame.metadata.width ?? frame.width,
    height: frame.metadata.height ?? frame.height,
    orientation: frame.metadata.orientation ?? frame.orientation,
    baselineExposure: frame.metadata.baselineExposure,
  }
}

function resolveFrameRenderExposure(
  frame: LumaRawFrame,
  metadata: ImageMetadata,
  pinnedExposure: DecodeExposureOptions['pinnedExposure'],
) {
  if (pinnedExposure !== undefined) {
    return { ...pinnedExposure }
  }

  return resolveRawRenderExposure({
    metadata,
    image: {
      data: frame.data,
      width: frame.width,
      height: frame.height,
    },
  })
}

export function frameToDecodedImage(
  frame: LumaRawFrame,
  options: DecodeExposureOptions = {},
): DecodedImage {
  const metadata = metadataToImageMetadata(frame)

  return {
    width: frame.width,
    height: frame.height,
    data: frame.data,
    source: frame.source,
    metadata,
    renderExposure: resolveFrameRenderExposure(
      frame,
      metadata,
      options.pinnedExposure,
    ),
  }
}
