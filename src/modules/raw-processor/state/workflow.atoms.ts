import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { atom } from 'jotai'

import { createAtomHooks } from '~/lib/jotai'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'

const DEFAULT_PROCESSING_PARAMS: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

const baseProcessingParamsAtom = atom<ProcessingParams>({
  ...DEFAULT_PROCESSING_PARAMS,
})

export const [
  processingParamsAtom,
  useProcessingParams,
  useProcessingParamsValue,
  useSetProcessingParams,
  getProcessingParams,
  setProcessingParams,
] = createAtomHooks(baseProcessingParamsAtom)

const baseLutAtom = atom<ParsedLUT | null>(null)

export const [, , useLutValue, useSetLut, getLut, setLut] =
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
  ,
  setPipelineStats,
] = createAtomHooks(basePipelineStatsAtom)

export function resetProcessorState(): void {
  setProcessingStatus('idle')
  setErrorMessage(null)
  setProgress(0)
  setPipelineStats(null)
}

export function resetToDefaults(): void {
  resetProcessorState()
  setLut(null)
  setProcessingParams({ ...DEFAULT_PROCESSING_PARAMS })
}
