import type {
  ColorGraphIntent,
  LUTColorProfile,
  ParsedLUT,
} from '@lumaforge/luma-color-runtime'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'

import type { Translate } from '~/lib/i18n'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
} from '../../../model/session'
import { projectEffectiveColorIntent } from '../../../services/look/effective-color-intent'
import { resolveActiveLook } from '../../../services/look/look-session-state'
import type {
  LutLoadContext,
  LutNotification,
} from '../../../services/look/orchestrate-lut-load'
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
import { buildLUTContractSelectionState } from '../../../services/look/style-system'
import { rawWorkflowStore } from '../../../state/workflow.atoms'
import { useLatestTranslate } from '../../useLatestTranslate'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

type UseRawLookStageInput = {
  /** The color intent the photo renders with, before the session look is projected. */
  baseParams: ColorGraphIntent
  session: ImageSession | null
  lut: ParsedLUT | null
  scheduleToast: (notify: () => void) => void
  invalidateExportGraph: () => void
  canApplyLoadedLut: () => boolean
}

/**
 * Builds a LUT outcome's toast in the locale current when the load or choice
 * reports it. A parser's or runtime's own message, a LUT's title and a
 * profile id are shown as given.
 */
function lutToast(notification: LutNotification, t: Translate): () => void {
  switch (notification.kind) {
    case 'loaded': {
      const title = t('raw.lut.toast.loaded', { title: notification.title })
      const description = t('raw.lut.toast.grid', {
        size: notification.gridSize,
      })
      return () => toast.success(title, { description })
    }
    case 'unsupported-format': {
      const title = t('raw.lut.toast.unsupportedFormat')
      const description = t('raw.lut.toast.unsupportedFormatDescription')
      return () => toast.error(title, { description })
    }
    case 'load-failed': {
      const title = t('raw.lut.toast.loadFailed')
      const description =
        notification.message ?? t('raw.lut.toast.loadFallback')
      return () => toast.error(title, { description })
    }
    case 'unsupported-contract': {
      const title = t('raw.lut.toast.loadFailed')
      const description = t('raw.lut.toast.unsupportedContract')
      return () => toast.error(title, { description })
    }
    case 'no-lut': {
      const title = t('raw.lut.toast.noLut')
      return () => toast.error(title)
    }
    case 'incomplete-contract': {
      const title = t('raw.lut.toast.incompleteContract')
      const description = notification.profileId
      return () => toast.error(title, { description })
    }
  }
}

export function useRawLookStage({
  baseParams,
  session,
  lut,
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
  const currentLutName =
    activeStyle?.kind === 'custom' ? activeStyle.name : null

  const params = useMemo(
    () => projectEffectiveColorIntent(baseParams, session),
    [baseParams, session],
  )

  const t = useLatestTranslate()
  // A load decides what to report while it owns the session; the toast
  // itself waits for the scheduled post-commit task.
  const notify = useCallback(
    (notification: LutNotification) => {
      scheduleToast(lutToast(notification, t))
    },
    [scheduleToast, t],
  )

  // LUT loads read and write the session in the store, and contract choices
  // read the LUT there, so a load, reset, clear or look write landing before
  // this hook rerenders is what they see.
  const lutCtx = useMemo<LutLoadContext>(
    () => ({
      atoms: rawWorkflowStore,
      services: { notify, invalidateExportGraph, canApplyLoadedLut },
    }),
    [canApplyLoadedLut, invalidateExportGraph, notify],
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

      rawWorkflowStore.setSession((prev) => {
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
        rawWorkflowStore.setColorIntent((prev) => {
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
    [invalidateExportGraph],
  )

  const clearLUT = useCallback(() => {
    const hasLoadedLut = rawWorkflowStore.getLut() !== null
    let hasSession = false
    let shouldInvalidateExportGraph = false

    rawWorkflowStore.setSession((prev) => {
      if (!prev) return prev

      const change = computeSessionClearLUT(prev, hasLoadedLut)
      hasSession = true
      shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
      return change.session
    })
    // The session owns the look once it exists; before that, the detached
    // intent does.
    if (!hasSession) {
      rawWorkflowStore.setColorIntent((prev) => {
        const change = computeDetachedClearLUT(prev, hasLoadedLut)
        shouldInvalidateExportGraph = change.shouldInvalidateExportGraph
        return change.params
      })
    }

    rawWorkflowStore.setLut(null)
    if (shouldInvalidateExportGraph) {
      invalidateExportGraph()
    }
    const message = t('raw.lut.toast.cleared')
    scheduleToast(() => toast.info(message))
  }, [invalidateExportGraph, scheduleToast, t])

  const adjustmentActions = useRawAdjustmentActions(invalidateExportGraph)

  return {
    params,
    activeStyle: activeStyle as StyleAsset | null,
    lutProfileSelection:
      lutProfileSelection as LUTContractSelectionState | null,
    currentLutName,
    loadLUT,
    cancelLUTFileLoad,
    loadOnlineLUT,
    selectLUTProfile,
    setIntensity,
    clearLUT,
    ...adjustmentActions,
  }
}
