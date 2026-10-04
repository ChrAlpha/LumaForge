import { useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { IMMERSIVE_STAGGER_MS } from '../../motion'
import type { ScrubFieldId } from './AdjustListPanel'
import type { MobileMode } from './MobileModeDock'
import { useMobilePreviewGestures } from './useMobilePreviewGestures'

export type MobileLabViewMode = 'processed' | 'original' | 'compare'

interface UseMobileLabChromeControllerInput {
  hasImage: boolean
  isProcessing: boolean
  previewSuspended?: boolean
  compareDisabled?: boolean
  preferExportMode?: boolean
  previewFrameEl?: HTMLDivElement | null
  viewMode: MobileLabViewMode
  onViewModeChange: (mode: MobileLabViewMode) => void
}

export function useMobileLabChromeController({
  hasImage,
  isProcessing,
  previewSuspended,
  compareDisabled,
  preferExportMode,
  previewFrameEl,
  viewMode,
  onViewModeChange,
}: UseMobileLabChromeControllerInput) {
  const prefersReduced = useReducedMotion() ?? false
  const [mode, setMode] = useState<MobileMode>('look')
  const [scrubField, setScrubField] = useState<ScrubFieldId | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [lutBrowserOpen, setLutBrowserOpen] = useState(false)
  const [lutBrowserStartsInContract, setLutBrowserStartsInContract] =
    useState(false)
  const [peeking, setPeeking] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [histogramOpen, setHistogramOpen] = useState(false)
  const [dockExpanded, setDockExpanded] = useState(true)
  const [compareSplitOpen, setCompareSplitOpen] = useState(false)
  // Export is a terminal action, not a tool: it borrows the deck slot while
  // open and hands it back to the tool that was there (`mode` is untouched).
  const [exportOpen, setExportOpen] = useState(false)
  const viewModeBeforePeek = useRef<MobileLabViewMode>('processed')
  const compareSplitOpenRef = useRef(false)
  const suppressNextPeekRestore = useRef(false)
  const preferExportModeWasActive = useRef(false)
  const immersiveStaggerTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const expandedBeforeImmersive = useRef(false)
  const previewReleasedReady =
    hasImage && previewSuspended === true && !isProcessing
  const handoffActive = hasImage && (isProcessing || previewReleasedReady)
  const focusActive = scrubField !== null

  useEffect(() => {
    if (!compareDisabled) return
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    setCompareSplitOpen(false)
    setPeeking(false)
    if (viewMode !== 'processed') onViewModeChange('processed')
  }, [compareDisabled, onViewModeChange, viewMode])

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
    setLutBrowserStartsInContract(false)
    setMoreOpen(false)
    setDockExpanded(true)
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
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
    setLutBrowserStartsInContract(false)
    setMoreOpen(false)
    compareSplitOpenRef.current = false
    suppressNextPeekRestore.current = false
    setCompareSplitOpen(false)
    setHistogramOpen(false)
    setPeeking(false)
  }, [handoffActive])

  useEffect(() => {
    if (!hasImage || compareSplitOpen || viewMode !== 'compare') return
    onViewModeChange('processed')
  }, [compareSplitOpen, hasImage, onViewModeChange, viewMode])

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
    setLutBrowserStartsInContract(false)
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
    setLutBrowserStartsInContract(false)
    setMoreOpen(false)
  }

  const onPeekChange = (p: boolean) => {
    if (p) {
      if (compareSplitOpenRef.current) return
      viewModeBeforePeek.current = 'processed'
      onViewModeChange('original')
    } else {
      setPeeking(false)
      if (suppressNextPeekRestore.current) {
        suppressNextPeekRestore.current = false
        return
      }
      onViewModeChange(
        compareSplitOpenRef.current ? viewModeBeforePeek.current : 'processed',
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
    onViewModeChange(open ? 'compare' : 'processed')
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
    setLutBrowserStartsInContract(false)
    setLutBrowserOpen(true)
  }

  const openLutContractBrowser = () => {
    setLutBrowserStartsInContract(true)
    setLutBrowserOpen(true)
  }

  const closeLutBrowser = () => {
    setLutBrowserOpen(false)
    setLutBrowserStartsInContract(false)
  }

  // Tools own the deck; Compare is a lens over the photo, so switching tools
  // never touches the split.
  const handleModeChange = (nextMode: MobileMode) => {
    setExportOpen(false)
    setMode(nextMode)
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
    lutBrowserStartsInContract,
    peeking,
    immersive,
    histogramOpen,
    dockExpanded,
    compareSplitOpen,
    exportOpen,
    previewReleasedReady,
    handoffActive,
    focusActive,
    setScrubField,
    setMoreOpen,
    setHistogramOpen,
    setDockExpanded,
    setCompareSplitMode,
    exitImmersive,
    openLutBrowser,
    openLutContractBrowser,
    closeLutBrowser,
    handleModeChange,
    openExport,
    closeExport,
  }
}
