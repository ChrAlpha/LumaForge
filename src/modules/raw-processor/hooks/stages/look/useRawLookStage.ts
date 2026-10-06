import type {
  LUTColorProfile,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo, useRef } from 'react'
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
import type { SetColorIntent } from './useRawAdjustmentActions'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

type UseRawLookStageInput = {
  /** The params the photo renders with, before the session look is projected. */
  baseParams: ProcessingParams
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  lut: ParsedLUT | null
  setLut: (lut: ParsedLUT | null) => void
  /**
   * Writes the detached color intent. Look actions write color here and
   * nowhere else; the view has its own owner and is never part of a write.
   */
  setColorIntent: SetColorIntent
  lutDataRef: MutableRefObject<LUTData | null>
  setLutDataRef: (nextLutData: LUTData | null) => void
  scheduleToast: (notify: () => void) => void
  invalidateExportGraph: () => void
  canApplyLoadedLut: () => boolean
}

export function useRawLookStage({
  baseParams,
  session,
  sessionRef,
  setSession,
  lut,
  setLut,
  setColorIntent,
  lutDataRef,
  setLutDataRef,
  scheduleToast,
  invalidateExportGraph,
  canApplyLoadedLut,
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
        setColorIntent,
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
        canApplyLoadedLut,
      },
    }),
    [
      activeStyle,
      canApplyLoadedLut,
      invalidateExportGraph,
      lut,
      lutDataRef,
      scheduleToast,
      sessionRef,
      setColorIntent,
      setLut,
      setLutDataRef,
      setSession,
    ],
  )

  const fileLoadRef = useRef<AbortController | null>(null)
  const cancelLUTFileLoad = useCallback(() => {
    fileLoadRef.current?.abort()
    fileLoadRef.current = null
  }, [])
  // The newest local pick wins: a file still reading or parsing is dropped.
  const loadLUT = useCallback(
    async (file: File) => {
      fileLoadRef.current?.abort()
      const controller = new AbortController()
      fileLoadRef.current = controller
      try {
        return await orchestrateLutLoadFromFile(file, lutCtx, {
          signal: controller.signal,
        })
      } finally {
        if (fileLoadRef.current === controller) fileLoadRef.current = null
      }
    },
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

  // Look actions read the session and detached intent through updaters, which
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
      // The detached intent carries the amount whenever no session owns a
      // look, but decides the graph change only when no session projects over
      // it. The amount is stored as given (0..1), never snapped to a detent.
      if (!sessionOwnsLook) {
        setColorIntent((prev) => {
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
    [invalidateExportGraph, setColorIntent, setSession],
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
    // intent does.
    if (!hasSession) {
      setColorIntent((prev) => {
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
    setColorIntent,
    setLut,
    setLutDataRef,
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
    setColorIntent,
    invalidateExportGraph,
  })

  return {
    params,
    activeStyle: activeStyle as StyleAsset | null,
    lutProfileSelection:
      lutProfileSelection as LUTContractSelectionState | null,
    activeIntensity,
    currentLutName,
    loadLUT,
    cancelLUTFileLoad,
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
