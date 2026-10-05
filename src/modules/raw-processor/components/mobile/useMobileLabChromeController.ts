import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { IMMERSIVE_STAGGER_MS } from '../../motion'
import type { ScrubFieldId } from './AdjustListPanel'
import type { MobileLookView } from './mobile-stage-layout'
import type { MobileMode } from './MobileModeDock'
import { useMobilePreviewGestures } from './useMobilePreviewGestures'

export type MobileLabViewMode = 'processed' | 'original' | 'compare'

/**
 * What the compare lens does. `split` opens the RAW / final split; the CPU
 * preview has no split surface, so there the lens is an `original` toggle
 * between the unprocessed and the processed photo.
 */
export type MobileCompareLensMode = 'split' | 'original'

interface UseMobileLabChromeControllerInput {
  hasImage: boolean
  isProcessing: boolean
  previewSuspended?: boolean
  compareDisabled?: boolean
  compareMode?: MobileCompareLensMode
  preferExportMode?: boolean
  previewFrameEl?: HTMLDivElement | null
  viewMode: MobileLabViewMode
  onViewModeChange: (mode: MobileLabViewMode) => void
  /**
   * Identifies the applied look (null without one). A change means a look
   * was applied or cleared, which drops a pinned original.
   */
  appliedLookKey?: string | null
}

export function useMobileLabChromeController({
  hasImage,
  isProcessing,
  previewSuspended,
  compareDisabled,
  compareMode = 'split',
  preferExportMode,
  previewFrameEl,
  viewMode,
  onViewModeChange,
  appliedLookKey = null,
}: UseMobileLabChromeControllerInput) {
  const prefersReduced = useReducedMotion() ?? false
  const [mode, setMode] = useState<MobileMode>('look')
  const [scrubField, setScrubField] = useState<ScrubFieldId | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [lutBrowserOpen, setLutBrowserOpen] = useState(false)
  // The Look deck shows its strip or the LUT contract chosen inline.
  const [lookView, setLookView] = useState<MobileLookView>('strip')
  const [peeking, setPeeking] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [histogramOpen, setHistogramOpen] = useState(false)
  const [dockExpanded, setDockExpanded] = useState(true)
  const [compareSplitOpen, setCompareSplitOpen] = useState(false)
  // The original toggle (CPU preview): the view a peek hands back to.
  const [originalShown, setOriginalShown] = useState(false)
  const originalShownRef = useRef(false)
  // Export is a terminal action, not a tool: it borrows the deck slot while
  // open and hands it back to the tool that was there (`mode` is untouched).
  const [exportOpen, setExportOpen] = useState(false)
  const viewModeBeforePeek = useRef<MobileLabViewMode>('processed')
  const compareSplitOpenRef = useRef(false)
  const suppressNextPeekRestore = useRef(false)
  // Set while the compare lens is held: the lens owns this peek, and it ends
  // it on release no matter what the split is doing underneath.
  const lensPeekActive = useRef(false)
  const preferExportModeWasActive = useRef(false)
  const immersiveStaggerTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const expandedBeforeImmersive = useRef(false)
  // What a peek restores when it ends: the split, the pinned original, or
  // the processed photo.
  const restingViewMode = (): MobileLabViewMode =>
    compareSplitOpenRef.current
      ? 'compare'
      : originalShownRef.current
        ? 'original'
        : 'processed'
  const previewReleasedReady =
    hasImage && previewSuspended === true && !isProcessing
  const handoffActive = hasImage && (isProcessing || previewReleasedReady)
  const focusActive = scrubField !== null

  // The view mode this controller last asked the stage for. A view mode
  // that lands without being asked for came from elsewhere (Transform's
  // Lines and Grid ask for the processed photo, the CPU fallback drops the
  // split), and the lens state follows the stage instead of claiming a
  // split or an original that is no longer on screen.
  const requestedViewMode = useRef<MobileLabViewMode>(viewMode)
  const requestViewMode = useCallback(
    (mode: MobileLabViewMode) => {
      requestedViewMode.current = mode
      onViewModeChange(mode)
    },
    [onViewModeChange],
  )

  useEffect(() => {
    if (viewMode === requestedViewMode.current) return
    requestedViewMode.current = viewMode
    if (viewMode !== 'compare' && compareSplitOpenRef.current) {
      compareSplitOpenRef.current = false
      suppressNextPeekRestore.current = false
      setCompareSplitOpen(false)
    }
    if (viewMode !== 'original' && originalShownRef.current) {
      originalShownRef.current = false
      setOriginalShown(false)
    }
  }, [viewMode])

  // A pinned original (the CPU preview's lens) shows the unprocessed photo,
  // so it would hide every edit made under it. An edit drops it: a scrub
  // starting, a tool change, a look applied or cleared. A lens still held
  // restores the processed photo on release.
  const dropOriginalPin = useCallback(() => {
    if (!originalShownRef.current) return
    originalShownRef.current = false
    setOriginalShown(false)
    if (!lensPeekActive.current) requestViewMode('processed')
  }, [requestViewMode])

  const previousLookKey = useRef(appliedLookKey)
  useEffect(() => {
    if (previousLookKey.current === appliedLookKey) return
    previousLookKey.current = appliedLookKey
    dropOriginalPin()
  }, [appliedLookKey, dropOriginalPin])

  const startScrub = (field: ScrubFieldId | null) => {
    if (field !== null) dropOriginalPin()
    setScrubField(field)
  }

  // A new compare mode (the GPU preview falling back to the CPU one) has a
  // different lens: nothing the old one held carries over.
  const previousCompareMode = useRef(compareMode)
  useEffect(() => {
    if (previousCompareMode.current === compareMode) return
    previousCompareMode.current = compareMode
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    lensPeekActive.current = false
    originalShownRef.current = false
    setCompareSplitOpen(false)
    setOriginalShown(false)
    setPeeking(false)
    if (viewMode !== 'processed') requestViewMode('processed')
  }, [compareMode, requestViewMode, viewMode])

  useEffect(() => {
    if (!compareDisabled) return
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    lensPeekActive.current = false
    originalShownRef.current = false
    setOriginalShown(false)
    setCompareSplitOpen(false)
    setPeeking(false)
    if (viewMode !== 'processed') requestViewMode('processed')
  }, [compareDisabled, requestViewMode, viewMode])

  useEffect(() => {
    if (hasImage) return
    if (immersiveStaggerTimer.current !== null) {
      clearTimeout(immersiveStaggerTimer.current)
      immersiveStaggerTimer.current = null
    }
    expandedBeforeImmersive.current = false
    setScrubField(null)
    setImmersive(false)
    setLutBrowserOpen(false)
    setLookView('strip')
    setMoreOpen(false)
    setDockExpanded(true)
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    lensPeekActive.current = false
    originalShownRef.current = false
    setOriginalShown(false)
    setCompareSplitOpen(false)
    setHistogramOpen(false)
    setExportOpen(false)
    setMode('look')
  }, [hasImage])

  useEffect(() => {
    if (!handoffActive) return
    if (immersiveStaggerTimer.current !== null) {
      clearTimeout(immersiveStaggerTimer.current)
      immersiveStaggerTimer.current = null
    }
    expandedBeforeImmersive.current = false
    setScrubField(null)
    setImmersive(false)
    setLutBrowserOpen(false)
    setMoreOpen(false)
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    // A lens held into a handoff is not reset here: the lens leaves with the
    // handoff and ends its own peek, which restores the processed view.
    setCompareSplitOpen(false)
    setHistogramOpen(false)
    setPeeking(false)
  }, [handoffActive])

  useEffect(() => {
    if (!hasImage || compareSplitOpen || viewMode !== 'compare') return
    requestViewMode('processed')
  }, [compareSplitOpen, hasImage, requestViewMode, viewMode])

  useEffect(() => {
    const shouldActivate =
      preferExportMode === true &&
      !preferExportModeWasActive.current &&
      hasImage
    preferExportModeWasActive.current = preferExportMode === true

    if (!shouldActivate) return
    if (immersiveStaggerTimer.current !== null) {
      clearTimeout(immersiveStaggerTimer.current)
      immersiveStaggerTimer.current = null
    }
    expandedBeforeImmersive.current = false

    setExportOpen(true)
    setDockExpanded(true)
    setScrubField(null)
    setImmersive(false)
    setLutBrowserOpen(false)
    setMoreOpen(false)
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    setCompareSplitOpen(false)
    setHistogramOpen(false)
  }, [hasImage, preferExportMode])

  useEffect(
    () => () => {
      if (immersiveStaggerTimer.current !== null) {
        clearTimeout(immersiveStaggerTimer.current)
      }
    },
    [],
  )

  const closeSheets = () => {
    setLutBrowserOpen(false)
    setMoreOpen(false)
  }

  const onPeekChange = (p: boolean) => {
    if (p) {
      if (compareSplitOpenRef.current) return
      viewModeBeforePeek.current = 'processed'
      requestViewMode('original')
    } else {
      setPeeking(false)
      if (suppressNextPeekRestore.current) {
        suppressNextPeekRestore.current = false
        return
      }
      requestViewMode(
        compareSplitOpenRef.current
          ? viewModeBeforePeek.current
          : restingViewMode(),
      )
      return
    }
    setPeeking(p)
  }

  const setCompareSplitMode = (open: boolean) => {
    if (open && compareDisabled) return
    compareSplitOpenRef.current = open
    suppressNextPeekRestore.current = open
    viewModeBeforePeek.current = open ? 'compare' : 'processed'
    setPeeking(false)
    setCompareSplitOpen(open)
    requestViewMode(open ? 'compare' : 'processed')
  }

  // Holding the compare lens peeks the unprocessed RAW over the whole frame,
  // split or not, through the same view-mode path as the photo long-press.
  // Release restores whatever the lens toggle left in place.
  const startLensPeek = () => {
    if (compareDisabled || lensPeekActive.current) return
    lensPeekActive.current = true
    setPeeking(true)
    requestViewMode('original')
  }

  const endLensPeek = () => {
    if (!lensPeekActive.current) return
    lensPeekActive.current = false
    setPeeking(false)
    requestViewMode(restingViewMode())
  }

  // The CPU preview's lens: a tap pins the original or hands back the
  // processed photo. A hold still peeks, and its release returns here.
  const toggleOriginal = () => {
    if (compareDisabled || compareMode !== 'original') return
    const next = !originalShownRef.current
    originalShownRef.current = next
    setOriginalShown(next)
    requestViewMode(next ? 'original' : 'processed')
  }

  const clearImmersiveStagger = () => {
    if (immersiveStaggerTimer.current !== null) {
      clearTimeout(immersiveStaggerTimer.current)
      immersiveStaggerTimer.current = null
    }
  }

  const enterImmersive = () => {
    const wasStaggering = immersiveStaggerTimer.current !== null
    clearImmersiveStagger()
    if (!wasStaggering) {
      expandedBeforeImmersive.current = dockExpanded
    }
    if (dockExpanded && !prefersReduced) {
      setDockExpanded(false)
      immersiveStaggerTimer.current = setTimeout(() => {
        immersiveStaggerTimer.current = null
        setImmersive(true)
      }, IMMERSIVE_STAGGER_MS)
      return
    }
    setImmersive(true)
  }

  const exitImmersive = () => {
    clearImmersiveStagger()
    setImmersive(false)
    if (expandedBeforeImmersive.current) {
      if (prefersReduced) {
        setDockExpanded(true)
      } else {
        immersiveStaggerTimer.current = setTimeout(() => {
          immersiveStaggerTimer.current = null
          setDockExpanded(true)
        }, IMMERSIVE_STAGGER_MS)
      }
    }
  }

  const previewGesturesEnabled =
    hasImage && !handoffActive && !focusActive && !compareDisabled
  useMobilePreviewGestures(previewFrameEl ?? null, {
    enabled: previewGesturesEnabled,
    allowPeek: !compareSplitOpen && !lutBrowserOpen && !moreOpen,
    onPeekChange,
    onTap: () => {
      if (lutBrowserOpen || moreOpen) {
        closeSheets()
        return
      }
      if (immersive) exitImmersive()
      else enterImmersive()
    },
  })

  const openLutBrowser = () => {
    setLutBrowserOpen(true)
  }

  const closeLutBrowser = () => {
    setLutBrowserOpen(false)
  }

  // Tools own the deck; Compare is a lens over the photo, so switching tools
  // never touches the split.
  const handleModeChange = (nextMode: MobileMode) => {
    if (nextMode !== mode) dropOriginalPin()
    setExportOpen(false)
    setMode(nextMode)
    setLookView('strip')
    setDockExpanded(true)
  }

  // Export blocked on an unresolved LUT contract: hand the deck to Look and
  // open the contract there, with the photo still in view.
  const openLookContract = () => {
    closeSheets()
    setExportOpen(false)
    setMode('look')
    setLookView('contract')
    setDockExpanded(true)
  }

  const openExport = () => {
    closeSheets()
    setExportOpen(true)
    setDockExpanded(true)
  }

  const closeExport = () => {
    setExportOpen(false)
  }

  return {
    prefersReduced,
    mode,
    scrubField,
    moreOpen,
    lutBrowserOpen,
    lookView,
    peeking,
    immersive,
    histogramOpen,
    dockExpanded,
    compareSplitOpen,
    originalShown,
    exportOpen,
    previewReleasedReady,
    handoffActive,
    focusActive,
    setScrubField: startScrub,
    setMoreOpen,
    setHistogramOpen,
    setDockExpanded,
    setCompareSplitMode,
    toggleOriginal,
    startLensPeek,
    endLensPeek,
    exitImmersive,
    openLutBrowser,
    closeLutBrowser,
    setLookView,
    openLookContract,
    handleModeChange,
    openExport,
    closeExport,
  }
}
