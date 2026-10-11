import type { HSLBandId } from '@lumaforge/luma-color-runtime'

import { HSL_BAND_ORDER, HSL_BAND_SWATCH } from '../fields/hsl-fields'

/**
 * Track gradient builders for direction-indicating sliders on the /raw
 * darkroom chrome.
 *
 * Returned strings are CSS `background` values intended for the Slider
 * primitive's `track` prop. Stops are tuned to keep the photo as the hero:
 * gradients sit at ~55% perceived brightness on the dark cool-slate surface,
 * with a neutral mid-shaft so the centre never has zero visual weight and
 * the named end stops pull the eye to the direction of the deviation.
 *
 * The Slider primitive renders a bipolar amber overlay on top of these
 * gradients to indicate "offset from neutral"; helpers here only describe
 * the resting/preview track itself.
 */

const TRACK_ALPHA = 0.55
const CENTER_ALPHA = 0.06

const NEUTRAL_MID = `oklch(from var(--color-lf-on-surface) l c h / ${CENTER_ALPHA})`

function neighborBand(band: HSLBandId, direction: -1 | 1): HSLBandId {
  const i = HSL_BAND_ORDER.indexOf(band)
  const len = HSL_BAND_ORDER.length
  return HSL_BAND_ORDER[(i + direction + len) % len]!
}

function withAlpha(swatch: string, alpha: number): string {
  return `oklch(from ${swatch} l c h / ${alpha})`
}

/**
 * Hue track: neighbour band on the left, band centre in the middle, next
 * neighbour band on the right. Mirrors LrC's "left/right previews the
 * deviation toward the adjacent hue" idiom.
 */
export function hslHueTrack(band: HSLBandId): string {
  const prev = withAlpha(HSL_BAND_SWATCH[neighborBand(band, -1)], TRACK_ALPHA)
  const here = withAlpha(HSL_BAND_SWATCH[band], TRACK_ALPHA)
  const next = withAlpha(HSL_BAND_SWATCH[neighborBand(band, 1)], TRACK_ALPHA)
  return `linear-gradient(to right, ${prev} 0%, ${here} 50%, ${next} 100%)`
}

/**
 * Saturation track: gray on the negative end, band-saturated on the
 * positive end, neutral midpoint that reads as "no change at 0".
 */
export function hslSaturationTrack(band: HSLBandId): string {
  const grayed = `oklch(from var(--color-lf-on-surface) l 0 h / ${TRACK_ALPHA})`
  const saturated = withAlpha(HSL_BAND_SWATCH[band], TRACK_ALPHA)
  return `linear-gradient(to right, ${grayed} 0%, ${NEUTRAL_MID} 50%, ${saturated} 100%)`
}

/**
 * Lightness track: dark band hue on the negative end, light band hue on
 * the positive end. L is moved via `oklch(from <swatch> 0.30 c h)` and
 * `0.88 c h` so the chroma and hue match the band identity exactly.
 */
export function hslLightnessTrack(band: HSLBandId): string {
  const swatch = HSL_BAND_SWATCH[band]
  const dark = `oklch(from ${swatch} 0.30 c h / ${TRACK_ALPHA})`
  const light = `oklch(from ${swatch} 0.88 c h / ${TRACK_ALPHA})`
  return `linear-gradient(to right, ${dark} 0%, ${NEUTRAL_MID} 50%, ${light} 100%)`
}

/**
 * White-balance temperature: blue (cool, negative) → neutral → yellow
 * (warm, positive). Mirrors Adobe Camera Raw / Lightroom Classic.
 */
export function temperatureTrack(): string {
  const blue = `oklch(0.55 0.18 240 / ${TRACK_ALPHA})`
  const yellow = `oklch(0.85 0.16 95 / ${TRACK_ALPHA})`
  return `linear-gradient(to right, ${blue} 0%, ${NEUTRAL_MID} 50%, ${yellow} 100%)`
}

/**
 * White-balance tint: magenta (negative) → neutral → green (positive).
 * Mirrors Adobe Camera Raw / Lightroom Classic.
 */
export function tintTrack(): string {
  const magenta = `oklch(0.66 0.22 340 / ${TRACK_ALPHA})`
  const green = `oklch(0.74 0.18 145 / ${TRACK_ALPHA})`
  return `linear-gradient(to right, ${magenta} 0%, ${NEUTRAL_MID} 50%, ${green} 100%)`
}

/**
 * Saturation track: gray (negative / desaturated) → neutral → vivid warm
 * (positive / saturated). Higher chroma endpoint (0.20) communicates the
 * full-spectrum nature of the control.
 */
export function saturationTrack(): string {
  const gray = `oklch(from var(--color-lf-on-surface) l 0 h / ${TRACK_ALPHA})`
  const saturated = `oklch(0.72 0.20 50 / ${TRACK_ALPHA})`
  return `linear-gradient(to right, ${gray} 0%, ${NEUTRAL_MID} 50%, ${saturated} 100%)`
}

/**
 * Vibrance track: same directional intent as saturationTrack but the
 * positive end uses a lower chroma (0.13 vs 0.20) to visually communicate
 * that Vibrance is the softer, more selective control.
 */
export function vibranceTrack(): string {
  const gray = `oklch(from var(--color-lf-on-surface) l 0 h / ${TRACK_ALPHA})`
  const saturated = `oklch(0.72 0.13 50 / ${TRACK_ALPHA})`
  return `linear-gradient(to right, ${gray} 0%, ${NEUTRAL_MID} 50%, ${saturated} 100%)`
}
