import type { ColorGraphIntent, ParsedLUT } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import type { SetStateAction } from 'jotai'
import { atom, useAtomValue } from 'jotai'
import { selectAtom } from 'jotai/utils'

import { createAtomHooks, jotaiStore } from '~/lib/jotai'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'
import { projectEffectiveColorIntent } from '../services/look/effective-color-intent'
import { DEFAULT_LOOK_INTENSITY } from '../services/look/style-system'
import type { PipelineFacts } from '../services/preview/pipeline-stats'
import {
  areSamePipelineFacts,
  toPipelineFacts,
} from '../services/preview/pipeline-stats'
import { getCurrentView } from './preview-view.atoms'
import {
  currentSessionAtom,
  getCurrentSession,
  setCurrentSession,
} from './session.atoms'

/**
 * The stored color intent: the user's color, plus the look selection while no
 * session owns the look. It holds no view state; the session, or the detached
 * sample view before one exists, owns view mode and compare split.
 */
export const DEFAULT_COLOR_INTENT: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'none',
  builtinPreset: null,
  intensity: DEFAULT_LOOK_INTENSITY,
})

const baseProcessingParamsAtom = atom<ColorGraphIntent>({
  ...DEFAULT_COLOR_INTENT,
})

export const [
  processingParamsAtom,
  ,
  useProcessingParamsValue,
  ,
  getProcessingParams,
  setProcessingParams,
] = createAtomHooks(baseProcessingParamsAtom)

export type SetColorIntent = (value: SetStateAction<ColorGraphIntent>) => void

/**
 * The only write into the stored intent. It keeps the intent strict: whatever
 * a caller hands it is copied down to the color fields, so view state can
 * never land there. An updater that returns its input leaves the stored
 * intent untouched.
 */
export const setColorIntent: SetColorIntent = (value) => {
  jotaiStore.set(processingParamsAtom, (prev) => {
    const next = typeof value === 'function' ? value(prev) : value
    return next === prev ? prev : pickColorGraphIntent(next)
  })
}

/**
 * The color intent the photo renders and exports with: the stored intent
 * with the current session's look projected over it. Readers of the store
 * and of the rendered params both go through this one atom.
 */
export const effectiveColorIntentAtom = atom((get) =>
  projectEffectiveColorIntent(
    get(processingParamsAtom),
    get(currentSessionAtom),
  ),
)

/**
 * The effective intent read from the store when called; a write to the
 * stored intent or the session is visible here in the same tick, before any
 * rerender.
 */
export function getEffectiveColorIntent(): ColorGraphIntent {
  return jotaiStore.get(effectiveColorIntentAtom)
}

const baseLutAtom = atom<ParsedLUT | null>(null)

export const [lutAtom, , useLutValue, , getLut, setLut] =
  createAtomHooks(baseLutAtom)

const baseProcessingStatusAtom = atom<ProcessingStatus>('idle')

export const [, , useProcessingStatusValue, , , setProcessingStatus] =
  createAtomHooks(baseProcessingStatusAtom)

const baseErrorMessageAtom = atom<string | null>(null)

export const [, , useErrorMessageValue, , , setErrorMessage] =
  createAtomHooks(baseErrorMessageAtom)

const baseProgressAtom = atom<number>(0)

export const [, , useProgressValue, , , setProgress] =
  createAtomHooks(baseProgressAtom)

const basePipelineStatsAtom = atom<PipelineStats | null>(null)

export const [
  ,
  ,
  usePipelineStatsValue,
  useSetPipelineStats,
  getPipelineStats,
  setPipelineStats,
] = createAtomHooks(basePipelineStatsAtom)

// The pipeline facts alone keep their identity while only a frame's timing
// moves, so a reader of them renders when the pipeline changes, not a few
// times a second while an edit renders.
const pipelineFactsAtom = selectAtom(
  basePipelineStatsAtom,
  (stats): PipelineFacts | null => (stats ? toPipelineFacts(stats) : null),
  areSamePipelineFacts,
)

export function usePipelineFactsValue(): PipelineFacts | null {
  return useAtomValue(pipelineFactsAtom, { store: jotaiStore })
}

/**
 * The workflow's store accessors, all on the production store: a read sees a
 * write made in the same tick, before any rerender. Commands and the
 * services they drive take these instead of values from the last render.
 */
export const rawWorkflowStore = {
  getSession: getCurrentSession,
  setSession: setCurrentSession,
  /** The effective intent the photo renders and exports with. */
  getColorIntent: getEffectiveColorIntent,
  setColorIntent,
  getLut,
  setLut,
  getView: getCurrentView,
  setStatus: setProcessingStatus,
  setError: setErrorMessage,
  setProgress,
  setStats: setPipelineStats,
}
