import {
  HDR_GAIN_MAP_GAMUT,
  HDR_NOMINAL_PEAK_NITS,
  HDR_REFERENCE_WHITE_NITS,
} from '@lumaforge/luma-color-runtime'

import { HDR_GAIN_MAP_JPEG_QUALITY } from '../export/jpeg/gain-map-container'
import type { OutputHdrGainMapIdentity } from './render-manifest'

/** The gain map every current export writes, as its manifest records it. */
export const OUTPUT_HDR_GAIN_MAP: OutputHdrGainMapIdentity = Object.freeze({
  format: 'iso-21496-1',
  gamut: HDR_GAIN_MAP_GAMUT,
  reference_white_nits: HDR_REFERENCE_WHITE_NITS,
  nominal_peak_nits: HDR_NOMINAL_PEAK_NITS,
  quality: Math.round(HDR_GAIN_MAP_JPEG_QUALITY * 100),
})
