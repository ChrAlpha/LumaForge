import { atom } from 'jotai'

import type { ScrubGainBand } from '../components/tools/slider-scrub-model'

/**
 * Gain band of the slider scrub currently in progress (touch only).
 * Written by the active Adjust row, read by the mobile ScrubValueHud so the
 * readout can label half / quarter / fine precision without prop drilling
 * through the dock, list panel, and row layers.
 */
export const scrubGainBandAtom = atom<ScrubGainBand>('full')
