import type { ScrubGainBand } from './slider-scrub-model'

/**
 * Copy for the precision bands a touch scrub can enter. `full` has no label:
 * normal speed is the absence of a hint, not a state worth naming.
 */
export const GAIN_LABEL_KEY: Record<
  Exclude<ScrubGainBand, 'full'>,
  | 'raw.mobile.adjustList.gain.half'
  | 'raw.mobile.adjustList.gain.quarter'
  | 'raw.adjust.gain.fine'
> = {
  half: 'raw.mobile.adjustList.gain.half',
  quarter: 'raw.mobile.adjustList.gain.quarter',
  fine: 'raw.adjust.gain.fine',
}
