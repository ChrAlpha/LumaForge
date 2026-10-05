import type {
  LUTColorProfile,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
} from '../../../model/session'
import { resolveActiveLook } from '../../../services/look/look-session-state'
import type { LutLoadContext } from '../../../services/look/orchestrate-lut-load'
import {
  orchestrateLutLoadFromFile,
  orchestrateOnlineLutLoad,
  orchestrateProfileSelection,
} from '../../../services/look/orchestrate-lut-load'
import {
  computeClearLUT,
  computeIntensityChange,
} from '../../../services/look/orchestrate-params-update'
import {
  buildLUTContractSelectionState,
  DEFAULT_LOOK_INTENSITY,
} from '../../../services/look/style-system'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

type SetProcessingParams = (
  value: ProcessingParams | ((prev: ProcessingParams) => ProcessingParams),
) => void

type UseRawLookStageInput = {
  baseParams: ProcessingParams
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  lut: ParsedLUT | null
  setLut: (lut: ParsedLUT | null) => void
  setParams: SetProcessingParams
  getProcessingParams: () => ProcessingParams
  lutDataRef: MutableRefObject<LUTData | null>
  setLutDataRef: (nextLutData: LUTData | null) => void
  scheduleToast: (notify: () => void) => void
  invalidateExportGraph: () => void
  setViewMode?: (mode: ProcessingParams['viewMode']) => void
  setCompareSplit?: (split: number) => void
}

export function useRawLookStage({
  baseParams,
  session,
  sessionRef,
  setSession,
  lut,
  setLut,
  setParams,
  getProcessingParams,
  lutDataRef,
  setLutDataRef,
  scheduleToast,
  invalidateExportGraph,
  setViewMode,
  setCompareSplit,
}: UseRawLookStageInput) {
  const activeStyle = useMemo(
    () => resolveActiveLook({ session, lut, intensity: baseParams.intensity }),
    [baseParams.intensity, lut, session],
  )
  const lutProfileSelection =
    session?.lutProfileSelection ||
    (lut ? buildLUTContractSelectionState(lut) : null)
  const activeIntensity =
    activeStyle?.currentIntensity ?? DEFAULT_LOOK_INTENSITY
  const currentLutName =
    activeStyle?.kind === 'custom' ? activeStyle.name : null

  const params = useMemo<ProcessingParams>(() => {
    if (!session) return baseParams
    if (!session.activeStyle) {
      const nextParams: ProcessingParams = {
        ...baseParams,
        intensity: DEFAULT_LOOK_INTENSITY,
        styleKind: 'none',
        builtinPreset: null,
      }

      return baseParams.intensity === nextParams.intensity &&
        baseParams.styleKind === nextParams.styleKind &&
        baseParams.builtinPreset === nextParams.builtinPreset
        ? baseParams
        : nextParams
    }

    const intensity = session.activeStyle.currentIntensity
    const stylePatch =
      session.activeStyle.kind === 'custom'
        ? { styleKind: 'custom' as const, builtinPreset: null }
        : {}
    const nextParams = { ...baseParams, ...stylePatch, intensity }

    return baseParams.intensity === intensity &&
      baseParams.styleKind === nextParams.styleKind &&
      baseParams.builtinPreset === nextParams.builtinPreset
      ? baseParams
      : nextParams
  }, [baseParams, session])

  const lutCtx = useMemo<LutLoadContext>(
    () => ({
      atoms: {
        setLut,
        setSession,
        setParams,
        getProcessingParams,
        lut,
        activeStyle,
      },
      refs: {
        lutDataRef,
        sessionRef,
      },
      services: {
        scheduleToast,
        invalidateExportGraph,
        setLutDataRef,
      },
    }),
    [
      activeStyle,
      getProcessingParams,
      invalidateExportGraph,
      lut,
      lutDataRef,
      scheduleToast,
      sessionRef,
      setLut,
      setLutDataRef,
      setParams,
      setSession,
    ],
  )

  const loadLUT = useCallback(
    (file: File) => orchestrateLutLoadFromFile(file, lutCtx),
    [lutCtx],
  )

  const loadOnlineLUT = useCallback(
    (
      entry: OnlineLUTEntry,
      options?: {
        signal?: AbortSignal
        onProgress?: (receivedBytes: number, totalBytes?: number) => void
      },
    ) => orchestrateOnlineLutLoad(entry, options, lutCtx),
    [lutCtx],
  )

  const selectLUTProfile = useCallback(
    (profile: LUTColorProfile | string) =>
      orchestrateProfileSelection(profile, lutCtx),
    [lutCtx],
  )

  // A Strength scrub calls this on every pointer move, so the session is
  // updated from its latest state rather than this render's snapshot: a
  // render-state or export change landing mid-scrub must survive it.
  const setIntensity = useCallback(
    (value: number) => {
      const { params: nextParams, shouldInvalidateExportGraph } =
        computeIntensityChange(params, session, activeStyle, value)

      if (shouldInvalidateExportGraph) {
        invalidateExportGraph()
      }
      if (!session?.activeStyle) {
        setParams(nextParams)
      }
      setSession(
        (prev) =>
          computeIntensityChange(params, prev, prev?.activeStyle ?? null, value)
            .session,
      )
    },
    [
      activeStyle,
      invalidateExportGraph,
      params,
      session,
      setParams,
      setSession,
    ],
  )

  const clearLUT = useCallback(() => {
    const {
      params: nextParams,
      session: nextSession,
      shouldInvalidateExportGraph,
    } = computeClearLUT(
      params,
      session,
      activeStyle,
      Boolean(lut),
      Boolean(lutDataRef.current),
      Boolean(lutProfileSelection),
    )

    if (shouldInvalidateExportGraph) {
      invalidateExportGraph()
    }
    setLut(null)
    setLutDataRef(null)
    setSession(nextSession)
    if (!sessionRef.current) {
      setParams(nextParams)
    }
    scheduleToast(() => toast.info('LUT cleared'))
  }, [
    activeStyle,
    invalidateExportGraph,
    lut,
    lutDataRef,
    lutProfileSelection,
    params,
    scheduleToast,
    session,
    sessionRef,
    setLut,
    setLutDataRef,
    setParams,
    setSession,
  ])

  const {
    setParams: setProcessingParams,
    setToneParams,
    resetTone,
    setColorParams,
    resetColor,
    setSelectiveColorBand,
    resetSelectiveColor,
  } = useRawAdjustmentActions({
    params,
    setParams,
    invalidateExportGraph,
    setViewMode,
    setCompareSplit,
  })

  return {
    params,
    activeStyle: activeStyle as StyleAsset | null,
    lutProfileSelection:
      lutProfileSelection as LUTContractSelectionState | null,
    activeIntensity,
    currentLutName,
    loadLUT,
    loadOnlineLUT,
    selectLUTProfile,
    setIntensity,
    clearLUT,
    setParams: setProcessingParams,
    setToneParams,
    resetTone,
    setColorParams,
    resetColor,
    setSelectiveColorBand,
    resetSelectiveColor,
  }
}
