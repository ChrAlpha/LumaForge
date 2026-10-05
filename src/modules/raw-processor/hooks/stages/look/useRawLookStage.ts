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
  computeDetachedClearLUT,
  computeDetachedIntensityChange,
  computeSessionClearLUT,
  computeSessionIntensityChange,
  projectSessionLookIntensity,
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
        intensity: projectSessionLookIntensity(session),
        styleKind: 'none',
        builtinPreset: null,
      }

      return baseParams.intensity === nextParams.intensity &&
        baseParams.styleKind === nextParams.styleKind &&
        baseParams.builtinPreset === nextParams.builtinPreset
        ? baseParams
        : nextParams
    }

    const intensity = projectSessionLookIntensity(session)
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

  // Look actions read the session and detached params through updaters, which
  // the stores apply synchronously, so every decision is made against the
  // state current when the action fires rather than the render that created
  // the callback. Side effects run only after both updaters have returned. A
  // Strength scrub calls this on every pointer move, so a render-state or
  // export change landing mid-scrub must survive it.
  const setIntensity = useCallback(
    (value: number) => {
      let hasSession = false
      let sessionOwnsLook = false
      let shouldInvalidateExportGraph = false

      setSession((prev) => {
        if (!prev) return prev

        const change = computeSessionIntensityChange(prev, value)
        hasSession = true
        sessionOwnsLook = Boolean(prev.activeStyle)
        shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
        return change.session
      })
      // Detached params carry the amount whenever no session owns a look, but
      // decide the graph change only when no session projects over them.
      if (!sessionOwnsLook) {
        setParams((prev) => {
          const change = computeDetachedIntensityChange(prev, value)
          if (!hasSession) {
            shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
          }
          return change.params
        })
      }

      if (shouldInvalidateExportGraph) {
        invalidateExportGraph()
      }
    },
    [invalidateExportGraph, setParams, setSession],
  )

  const clearLUT = useCallback(() => {
    const hasLoadedLut = Boolean(lut) || Boolean(lutDataRef.current)
    let hasSession = false
    let shouldInvalidateExportGraph = false

    setSession((prev) => {
      if (!prev) return prev

      const change = computeSessionClearLUT(prev, hasLoadedLut)
      hasSession = true
      shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
      return change.session
    })
    // The session owns the look once it exists; before that, the detached
    // params do.
    if (!hasSession) {
      setParams((prev) => {
        const change = computeDetachedClearLUT(prev, hasLoadedLut)
        shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
        return change.params
      })
    }

    setLut(null)
    setLutDataRef(null)
    if (shouldInvalidateExportGraph) {
      invalidateExportGraph()
    }
    scheduleToast(() => toast.info('LUT cleared'))
  }, [
    invalidateExportGraph,
    lut,
    lutDataRef,
    scheduleToast,
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
