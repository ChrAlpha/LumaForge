import { toLUTData } from '@lumaforge/luma-color-runtime'
import { atom } from 'jotai'

import { createAtomHooks } from '~/lib/jotai'

import type { HdrPreviewChoice } from '../services/preview/hdr-preview-output'
import { hasHdrRendition } from '../services/preview/hdr-preview-output'
import { effectiveColorIntentAtom, lutAtom } from './workflow.atoms'

/**
 * The HDR preview choice the user made while the gain map is on; null keeps
 * the preview's default. View state: it changes what the preview draws,
 * never the color intent or the exported file.
 */
const baseHdrPreviewChoiceAtom = atom<HdrPreviewChoice | null>(null)

export const [
  ,
  ,
  useHdrPreviewChoiceValue,
  ,
  getHdrPreviewChoice,
  setHdrPreviewChoice,
] = createAtomHooks(baseHdrPreviewChoiceAtom)

/**
 * Whether the processed WebGPU preview's canvas shows values above SDR
 * white, as its published pipeline reports. False while no GPU pipeline is
 * published, so the CPU preview never offers the HDR rendition.
 */
const basePreviewExtendedRangeAtom = atom(false)

export const [, , usePreviewExtendedRangeValue, , , setPreviewExtendedRange] =
  createAtomHooks(basePreviewExtendedRangeAtom)

/**
 * Whether the look the photo renders with has the HDR rendition the gain-map
 * export writes. A boolean, so a scrub step that keeps it leaves its readers
 * alone.
 */
export const hdrRenditionAtom = atom((get) => {
  const lut = get(lutAtom)
  return hasHdrRendition(
    get(effectiveColorIntentAtom),
    lut ? toLUTData(lut) : null,
  )
})
