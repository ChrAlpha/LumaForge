import type {
  ColorGraphIntent,
  NormalizedSelectiveColorBands,
} from '@lumaforge/luma-color-runtime'
import { atom, useAtomValue } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useMemo } from 'react'

import { jotaiStore } from '~/lib/jotai'

import type { ColorValue } from '../components/color-fields'
import type { ToneValue } from '../components/tone-fields'
import type { ProcessingStatus } from '../model/workflow'
import { projectEffectiveColorIntent } from '../services/look/effective-color-intent'
import { resolveActiveLook } from '../services/look/look-session-state'
import { DEFAULT_LOOK_INTENSITY } from '../services/look/style-system'
import { currentSessionAtom } from '../state/session.atoms'
import {
  lutAtom,
  processingParamsAtom,
  useProcessingStatusValue,
  useProgressValue,
} from '../state/workflow.atoms'

/** The workflow stage a tool surface shows. */
export interface RawToolStatus {
  status: ProcessingStatus
  isExporting: boolean
}

/** The adjustment values a tool surface edits, as the photo renders them. */
export interface RawToolAdjustments {
  /** How much of the look reaches the photo, 0..1. */
  activeIntensity: number
  tone: ToneValue
  color: ColorValue
  selectiveColor: NormalizedSelectiveColorBands
}

const storeOptions = { store: jotaiStore }

// Read-only projections of the stored intent, the session and the LUT. They
// hold no value of their own: each is recomputed from those atoms, and a
// reader rerenders only when the part it reads changes.
const effectiveIntentAtom = atom((get) =>
  projectEffectiveColorIntent(
    get(processingParamsAtom),
    get(currentSessionAtom),
  ),
)

function pickTone(intent: ColorGraphIntent): ToneValue {
  return {
    userExposureEv: intent.userExposureEv,
    userContrast: intent.userContrast,
    userHighlights: intent.userHighlights,
    userShadows: intent.userShadows,
    userWhites: intent.userWhites,
    userBlacks: intent.userBlacks,
  }
}

function pickColor(intent: ColorGraphIntent): ColorValue {
  return {
    userTemperature: intent.userTemperature,
    userTint: intent.userTint,
    userSaturation: intent.userSaturation,
    userVibrance: intent.userVibrance,
  }
}

function sameFields<Value extends object>(left: Value, right: Value) {
  return (Object.keys(left) as (keyof Value)[]).every((key) =>
    Object.is(left[key], right[key]),
  )
}

const toneAtom = selectAtom(effectiveIntentAtom, pickTone, sameFields)
const colorAtom = selectAtom(effectiveIntentAtom, pickColor, sameFields)
// The HSL record is copied by reference through every intent write, so a
// tone or colour edit leaves it the same record.
const selectiveColorAtom = selectAtom(
  effectiveIntentAtom,
  (intent): NormalizedSelectiveColorBands => intent.selectiveColor,
)
// The strength the look applies at, resolved the way the active look is: the
// session's look once a session exists, the detached LUT's before that.
const activeIntensityAtom = atom(
  (get) =>
    resolveActiveLook({
      session: get(currentSessionAtom),
      lut: get(lutAtom),
      intensity: get(processingParamsAtom).intensity,
    })?.currentIntensity ?? DEFAULT_LOOK_INTENSITY,
)

/** The workflow stage, without its progress. */
export function useRawToolStatus(): RawToolStatus {
  const status = useProcessingStatusValue()
  return useMemo(
    () => ({ status, isExporting: status === 'exporting' }),
    [status],
  )
}

/** Workflow progress, 0-100. Only a reader of it rerenders as it moves. */
export function useRawToolProgress(): number {
  return useProgressValue()
}

/**
 * The adjustments the photo renders with: the stored intent with the
 * current session's look projected over it. Each part keeps its identity
 * while its values are unchanged, so a session write that moves no
 * adjustment (Transform, export, view) changes nothing here.
 */
export function useRawToolAdjustments(): RawToolAdjustments {
  const activeIntensity = useAtomValue(activeIntensityAtom, storeOptions)
  const tone = useAtomValue(toneAtom, storeOptions)
  const color = useAtomValue(colorAtom, storeOptions)
  const selectiveColor = useAtomValue(selectiveColorAtom, storeOptions)
  return useMemo(
    () => ({ activeIntensity, tone, color, selectiveColor }),
    [activeIntensity, color, selectiveColor, tone],
  )
}

/** How much of the look reaches the photo, 0..1, alone: a tone or colour edit leaves its reader alone. */
export function useRawToolIntensity(): number {
  return useAtomValue(activeIntensityAtom, storeOptions)
}
