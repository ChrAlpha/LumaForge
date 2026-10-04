import { useCallback, useRef, useState } from 'react'

import type { UseOnlineLutSourcesResult } from '../../../hooks/useOnlineLutSources'

type EntryLoaderSource = Pick<
  UseOnlineLutSourcesResult,
  'loadEntry' | 'loadingEntryId' | 'failedEntryId'
> &
  Partial<Pick<UseOnlineLutSourcesResult, 'cancelEntryLoad'>>

export interface OnlineLutEntryLoaderOptions {
  /**
   * A tap on another entry while one is loading cancels that load and
   * starts the new one, instead of being ignored. The mobile Look strip
   * trades looks this way; a tap on the entry already loading stays a no-op.
   */
  replace?: boolean
}

/**
 * Per-surface shell over the shared entry-load lifecycle. Loading/failed
 * state and the one-load-at-a-time lock are owned by useOnlineLutSources so
 * every surface (desktop inline, dialog, mobile strip, mobile catalog) sees
 * the same lock and the cancel handle can never be stolen by a second
 * surface. The shell only adds a same-frame click ack (local pending state
 * bridged until the shared lock engages after the rAF yield) and gates the
 * success callback on the load outcome.
 */
export function useOnlineLutEntryLoader(
  source?: EntryLoaderSource,
  options: OnlineLutEntryLoaderOptions = {},
) {
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
  // The latest tap, read across the rAF yield so a replaced tap stands down.
  const pendingRef = useRef<string | null>(null)
  const loadingEntryId = source?.loadingEntryId ?? pendingEntryId
  const failedEntryId = source?.failedEntryId ?? null
  const replace = options.replace === true

  const loadOnlineLutEntry = useCallback(
    async (entryId: string, onLoaded?: () => void) => {
      if (!source) return
      const busyEntryId = source.loadingEntryId ?? pendingRef.current
      if (busyEntryId) {
        if (!replace || busyEntryId === entryId) return
        source.cancelEntryLoad?.()
      }

      pendingRef.current = entryId
      setPendingEntryId(entryId)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
      // Another tap took over during the yield.
      if (pendingRef.current !== entryId) return

      try {
        const outcome = await source
          .loadEntry(entryId)
          .catch((): 'failed' => 'failed')
        if (outcome === 'loaded') onLoaded?.()
      } finally {
        if (pendingRef.current === entryId) {
          pendingRef.current = null
          setPendingEntryId(null)
        }
      }
    },
    [source, replace],
  )

  return { loadingEntryId, failedEntryId, loadOnlineLutEntry }
}
