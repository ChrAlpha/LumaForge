import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'

export type DecodedImageSource = 'quick' | 'bounded-hq'

/**
 * A decoded preview frame: the RAW render as linear ProPhoto RGB16, three
 * channels per pixel, the one layout the RAW runtime decodes to.
 */
export interface DecodedImage {
  width: number
  height: number
  data: Uint16Array
  source?: DecodedImageSource
  metadata: ImageMetadata
  renderExposure: RawRenderExposure
}

export interface ImageMetadata {
  make?: string
  model?: string
  lens?: string
  iso?: number
  aperture?: number
  focalLength?: number
  shutterSpeed?: string
  timestamp?: Date
  width: number
  height: number
  orientation?: number
  baselineExposure?: number
}

export interface DecodeProgress {
  phase: 'loading' | 'decoding' | 'processing' | 'complete'
  progress: number
}

export type ProgressCallback = (progress: DecodeProgress) => void

/**
 * A source-level RAW render exposure the caller already resolved for this
 * file. When present (including an explicit 0 EV) the decoded frame carries a
 * copy of it instead of re-estimating from its own pixels; when absent the
 * frame is estimated on its own.
 */
export type DecodeExposureOptions = {
  pinnedExposure?: RawRenderExposure
}

export const SUPPORTED_RAW_EXTENSIONS = new Set([
  'cr2',
  'cr3',
  'crw',
  'nef',
  'nrw',
  'arw',
  'srf',
  'sr2',
  'raf',
  'rw2',
  'rwl',
  'orf',
  'pef',
  'ptx',
  'srw',
  'dng',
  'iiq',
  '3fr',
  'fff',
  'x3f',
  'dcr',
  'dcs',
  'kdc',
  'mos',
  'raw',
  'rwz',
  'erf',
  'mef',
  'mrw',
])

export function isSupportedRaw(file: File | string): boolean {
  const name = typeof file === 'string' ? file : file.name
  const ext = getFileExtension(name)
  return ext ? SUPPORTED_RAW_EXTENSIONS.has(ext) : false
}

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
}
