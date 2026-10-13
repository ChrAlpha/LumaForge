import type { LookSelection, ParsedLUT } from '@lumaforge/luma-color-runtime'

import type { PreviewView } from '~/lib/preview/preview-view'

import type { StyleAsset } from '../../model/session'
import type { RetainedSessionState } from '../../model/session-factory'
import { clampCompareSplit } from '../compare/compare-split'
import { preserveCustomLookIntensity } from '../look/look-session-state'
import {
  buildLUTContractSelectionState,
  DEFAULT_LOOK_INTENSITY,
  toCustomStyle,
} from '../look/style-system'

/**
 * What a new source starts from. The split comes from the view in effect when
 * the load starts; the look comes from the active look and the loaded LUT.
 * The returned patch writes the detached look selection only: it never
 * carries view state or user color.
 */
export function prepareRawLoadState(input: {
  view: PreviewView
  lut: ParsedLUT | null
  activeStyle: StyleAsset | null | undefined
}): {
  compareSplit: number
  retainedSessionState: RetainedSessionState
  lookSelectionPatch: Partial<LookSelection>
} {
  const compareSplit = clampCompareSplit(input.view.compareSplit)
  const preservedCustomStyle = input.lut
    ? preserveCustomLookIntensity(toCustomStyle(input.lut), input.activeStyle)
    : null
  const retainedSessionState = {
    activeStyle: preservedCustomStyle,
    lutProfileSelection: input.lut
      ? buildLUTContractSelectionState(input.lut)
      : undefined,
  }

  return {
    compareSplit,
    retainedSessionState,
    lookSelectionPatch: preservedCustomStyle
      ? {}
      : {
          intensity: DEFAULT_LOOK_INTENSITY,
          styleKind: 'none',
          builtinPreset: null,
        },
  }
}
