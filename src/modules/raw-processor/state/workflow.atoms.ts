import type { ColorGraphIntent, ParsedLUT } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
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
import { resetDetachedPreviewView } from './preview-view.atoms'
import { getCurrentSession } from './session.atoms'

/**
 * The stored color intent: the user's color, plus the look selection while no
 * session owns the look. It holds no view state; the session, or the detached
 * sample view before one exists, owns view mode and compare split.
 */
const DEFAULT_COLOR_INTENT: ColorGraphIntent = Object.freeze({
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
  useSetProcessingParams,
  getProcessingParams,
  setProcessingParams,
] = createAtomHooks(baseProcessingParamsAtom)

/**
 * The color intent the photo renders and exports with, read from the store
 * when called: the stored intent with the current session's look projected
 * over it, through the same projection the rendered params use. A write to
 * either atom is visible here in the same tick, before any rerender.
 */
export function getEffectiveColorIntent(): ColorGraphIntent {
  return projectEffectiveColorIntent(getProcessingParams(), getCurrentSession())
}

const baseLutAtom = atom<ParsedLUT | null>(null)

export const [lutAtom, , useLutValue, useSetLut, getLut, setLut] =
  createAtomHooks(baseLutAtom)

const baseProcessingStatusAtom = atom<ProcessingStatus>('idle')

export const [
  ,
  ,
  useProcessingStatusValue,
  useSetProcessingStatus,
  ,
  setProcessingStatus,
] = createAtomHooks(baseProcessingStatusAtom)

const baseErrorMessageAtom = atom<string | null>(null)

export const [, , useErrorMessageValue, useSetErrorMessage, , setErrorMessage] =
  createAtomHooks(baseErrorMessageAtom)

const baseProgressAtom = atom<number>(0)

export const [, , useProgressValue, useSetProgress, , setProgress] =
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

export function resetProcessorState(): void {
  setProcessingStatus('idle')
  setErrorMessage(null)
  setProgress(0)
  setPipelineStats(null)
}

export function resetToDefaults(): void {
  resetProcessorState()
  setLut(null)
  setProcessingParams({ ...DEFAULT_COLOR_INTENT })
  resetDetachedPreviewView()
}
