import type {
  ColorGraphIntent,
  HdrPreviewView,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  resolveExportColorGraph,
  resolveHdrGainMapSupport,
} from '@lumaforge/luma-color-runtime'

import type { PreviewHdrOutput } from '~/lib/preview/preview-view'

/**
 * What the preview shows while the HDR gain map is on: the SDR picture,
 * the HDR rendition itself where the surface shows values above SDR white,
 * or one of the views any display can show of it.
 */
export type HdrPreviewChoice = 'sdr' | 'hdr' | HdrPreviewView

/**
 * The choices a preview offers, its default first. A surface that shows
 * values above SDR white opens on the HDR rendition; any other on the SDR
 * picture, which is what it shows of the exported file.
 */
export function hdrPreviewChoices(
  hdrSurface: boolean,
): readonly HdrPreviewChoice[] {
  return hdrSurface
    ? ['hdr', 'sdr', 'above-sdr', 'stop-down']
    : ['sdr', 'above-sdr', 'stop-down']
}

/** The choice in effect: the one made, while the preview offers it. */
export function resolveHdrPreviewChoice(
  made: HdrPreviewChoice | null,
  choices: readonly HdrPreviewChoice[],
): HdrPreviewChoice {
  return made !== null && choices.includes(made) ? made : choices[0]
}

/**
 * Whether the look has the HDR rendition the gain-map export would write:
 * the export's own rule, so the preview never shows a rendition the export
 * refuses.
 */
export function hasHdrRendition(
  intent: ColorGraphIntent,
  lut: LUTData | null,
): boolean {
  return resolveHdrGainMapSupport(resolveExportColorGraph({ ...intent, lut }))
    .supported
}

/**
 * What the processed preview draws in place of the SDR picture, if
 * anything. Nothing unless the gain map is on and the look has an HDR
 * rendition, and nothing under a Transform overlay, which shows its own
 * SDR frame over the photo.
 */
export function resolvePreviewHdrOutput({
  hdrExport,
  hdrRendition,
  choice,
  transformOverlayShown,
}: {
  hdrExport: boolean
  hdrRendition: boolean
  choice: HdrPreviewChoice
  transformOverlayShown: boolean
}): PreviewHdrOutput | undefined {
  if (!hdrExport || !hdrRendition || transformOverlayShown) return undefined
  if (choice === 'sdr') return undefined
  return choice === 'hdr' ? 'extended' : choice
}

/**
 * The view the CPU preview draws for an output: it draws no extended
 * range, which only a WebGPU canvas configured for it shows.
 */
export function cpuHdrPreviewView(
  output: PreviewHdrOutput | undefined,
): HdrPreviewView | undefined {
  return output === 'above-sdr' || output === 'stop-down' ? output : undefined
}
