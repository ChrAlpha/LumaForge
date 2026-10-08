import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
} from '../../../model/session'
import { projectEffectiveColorIntent } from '../../../services/look/effective-color-intent'
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
} from '../../../services/look/orchestrate-params-update'
import {
  buildLUTContractSelectionState,
  DEFAULT_LOOK_INTENSITY,
} from '../../../services/look/style-system'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import type { SetColorIntent } from './useRawAdjustmentActions'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

type UseRawLookStageInput = {
  /** The color intent the photo renders with, before the session look is projected. */
  baseParams: ColorGraphIntent
  session: ImageSession | null
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

  const params = useMemo(
    () => projectEffectiveColorIntent(baseParams, session),
    [baseParams, session],
  )

  // LUT loads read and write the session in the store, so a load, reset or
  // look write landing before this hook rerenders is what they see.
  const lutCtx = useMemo<LutLoadContext>(
    () => ({
      atoms: {
        getSession: getCurrentSession,
        setLut,
        setSession: setCurrentSession,
        setColorIntent,
        lut,
      },
      refs: {
        lutDataRef,
      },
      services: {
        scheduleToast,
        invalidateExportGraph,
        setLutDataRef,
        canApplyLoadedLut,
      },
    }),
    [
      canApplyLoadedLut,
      invalidateExportGraph,
      lut,
      lutDataRef,
      scheduleToast,
      setColorIntent,
      setLut,
      setLutDataRef,
    ],
  )

  const fileLoadRef = useRef<AbortController | null>(null)
  const cancelLUTFileLoad = useCallback(() => {
    fileLoadRef.current?.abort()
    fileLoadRef.current = null
  }, [])
  // A local pick belongs to the workflow that started it: one still reading
  // or parsing when the workflow unmounts never lands on the session the
  // store keeps for a return to /raw.
  useEffect(() => cancelLUTFileLoad, [cancelLUTFileLoad])
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

      setCurrentSession((prev) => {
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
    [invalidateExportGraph, setColorIntent],
  )

  const clearLUT = useCallback(() => {
    const hasLoadedLut = Boolean(lut) || Boolean(lutDataRef.current)
    let hasSession = false
    let shouldInvalidateExportGraph = false

    setCurrentSession((prev) => {
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
