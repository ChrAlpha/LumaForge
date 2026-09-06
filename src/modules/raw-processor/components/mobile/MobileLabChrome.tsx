import type {
  HSLBandId,
  HSLBandShift,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import { AnimatePresence, m } from 'motion/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

import { DOCK_SPRING } from '../../motion'
import type { ColorValue } from '../color-fields'
import type { RawRuntimeReadinessState } from '../raw-runtime-readiness'
import type { ToneValue } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { MobileEmptyState } from './MobileEmptyState'
import { MobileFloatingOverlays } from './MobileFloatingOverlays'
import { MobileLabModeDock } from './MobileLabModeDock'
import { MobileLabTopbar } from './MobileLabTopbar'
import type { MobileLutBrowserProps } from './MobileLutBrowser'
import { MobileLutBrowser } from './MobileLutBrowser'
import { MobileMoreSheet } from './MobileMoreSheet'
import type { MobileLabViewMode } from './useMobileLabChromeController'
import { useMobileLabChromeController } from './useMobileLabChromeController'

type Row = { label: string; value: string }
type Step = { index: number; label: string; timing: string }

export function MobileLabChrome(props: {
  hasImage: boolean
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  onToneChange: (patch: Partial<ToneValue>) => void
  onToneReset: () => void
  onColorChange: (patch: Partial<ColorValue>) => void
  onColorReset: () => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onSelectiveColorReset: () => void
  viewMode: MobileLabViewMode
  onViewModeChange: (mode: MobileLabViewMode) => void
  histogram: PreviewHistogramState
  fileName: string
  fileMeta: string
  supportLevel: 'official' | 'experimental'
  onReplaceFile: () => void
  onResetSession: () => void
  isProcessing: boolean
  runtimeReadinessState?: RawRuntimeReadinessState
  onPrepareRuntime?: () => void
  lutBrowser: Omit<MobileLutBrowserProps, 'open' | 'onClose'>
  onCompareReset: () => void
  exportPanel: ReactNode
  moreSheet: { pipelineSteps: Step[]; lutRows: Row[]; fileRows: Row[] }
  previewSuspended?: boolean
  preferExportMode?: boolean
  previewFrameEl?: HTMLDivElement | null
}) {
  const {
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
  } = useMobileLabChromeController({
    hasImage: props.hasImage,
    isProcessing: props.isProcessing,
    previewSuspended: props.previewSuspended,
    preferExportMode: props.preferExportMode,
    previewFrameEl: props.previewFrameEl,
    viewMode: props.viewMode,
    onViewModeChange: props.onViewModeChange,
  })

  // Stage insets: the photo re-fits between the topbar and the dock while
  // the chrome is visible, and returns to full bleed in immersive or when no
  // image is loaded. The stage reads these from the shell (raw-lab.css).
  const chromeRef = useRef<HTMLDivElement>(null)
  const [topbarHeight, setTopbarHeight] = useState(0)
  const [dockInset, setDockInset] = useState(0)
  const insetsActive = props.hasImage && !immersive
  const insetTop = insetsActive ? topbarHeight : 0
  const insetBottom = insetsActive ? dockInset : 0
  useLayoutEffect(() => {
    const shell = chromeRef.current?.closest<HTMLElement>(
      '[data-raw-lab-shell]',
    )
    if (!shell) return
    shell.style.setProperty('--raw-stage-inset-top', `${insetTop}px`)
    shell.style.setProperty('--raw-stage-inset-bottom', `${insetBottom}px`)
    return () => {
      shell.style.removeProperty('--raw-stage-inset-top')
      shell.style.removeProperty('--raw-stage-inset-bottom')
    }
  }, [insetBottom, insetTop])

  return (
    <div
      ref={chromeRef}
      className="pointer-events-none absolute inset-0 z-20"
      data-mobile-lab-chrome
      data-stage-inset-top={insetTop}
      data-stage-inset-bottom={insetBottom}
      data-focus={focusActive ? 'true' : 'false'}
      data-peek={peeking || undefined}
    >
      {/* Peek (long-press) and the Compare split are alternate RAW-vs-finished
          affordances. Both are wired via `useMobilePreviewGestures` above so
          they share the same DOM target as pinch / pan and never block it. */}

      <AnimatePresence>
        {!props.hasImage && (
          <MobileEmptyState
            prefersReduced={prefersReduced}
            runtimeReadinessState={props.runtimeReadinessState}
            onPrepareRuntime={props.onPrepareRuntime}
            onReplaceFile={props.onReplaceFile}
          />
        )}
      </AnimatePresence>

      <MobileFloatingOverlays
        immersive={immersive}
        focusActive={focusActive}
        hasImage={props.hasImage}
        handoffActive={handoffActive}
        peeking={peeking}
        histogramOpen={histogramOpen}
        histogram={props.histogram}
        scrubField={scrubField}
        tone={props.tone}
        color={props.color}
        selectiveColor={props.selectiveColor}
        onExitImmersive={exitImmersive}
      />

      {/* Topbar + dock recede together as one surface when immersive takes over,
          instead of hard-unmounting behind the overlay.
          `initial={false}`: present on first load (no page-load choreography),
          fades only on the immersive toggle. */}
      <AnimatePresence initial={false}>
        {!immersive && (
          <m.div
            key="mobile-chrome"
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={DOCK_SPRING}
          >
            <MobileLabTopbar
              hasImage={props.hasImage}
              fileName={props.fileName}
              fileMeta={props.fileMeta}
              supportLevel={props.supportLevel}
              histogramShown={histogramOpen}
              onToggleHistogram={() => setHistogramOpen((v) => !v)}
              onReplaceFile={props.onReplaceFile}
              onOpenLutBrowser={openLutBrowser}
              onOpenMore={() => setMoreOpen(true)}
              onResetSession={props.onResetSession}
              scrubbing={focusActive}
              onHeightChange={setTopbarHeight}
            />
            <MobileLabModeDock
              mode={mode}
              expanded={dockExpanded && props.hasImage}
              disabled={!props.hasImage || props.isProcessing}
              onModeChange={handleModeChange}
              onCollapse={() => setDockExpanded(false)}
              onOpenMore={() => setMoreOpen(true)}
              scrubbing={focusActive}
              prefersReduced={prefersReduced}
              tone={props.tone}
              color={props.color}
              selectiveColor={props.selectiveColor}
              lutBrowser={props.lutBrowser}
              compareSplitOpen={compareSplitOpen}
              exportPanel={props.exportPanel}
              onToneChange={props.onToneChange}
              onToneReset={props.onToneReset}
              onColorChange={props.onColorChange}
              onColorReset={props.onColorReset}
              onSelectiveColorChange={props.onSelectiveColorChange}
              onSelectiveColorReset={props.onSelectiveColorReset}
              onScrubChange={setScrubField}
              onOpenLutBrowser={openLutBrowser}
              onOpenLutContractBrowser={openLutContractBrowser}
              onCompareReset={props.onCompareReset}
              onSplitOpenChange={setCompareSplitMode}
              onInsetChange={setDockInset}
            />
          </m.div>
        )}
      </AnimatePresence>

      <MobileLutBrowser
        open={!handoffActive && lutBrowserOpen}
        initialContractEditorOpen={lutBrowserStartsInContract}
        onClose={closeLutBrowser}
        {...props.lutBrowser}
      />

      <MobileMoreSheet
        open={props.hasImage && !handoffActive && moreOpen}
        onClose={() => setMoreOpen(false)}
        pipelineSteps={props.moreSheet.pipelineSteps}
        lutRows={props.moreSheet.lutRows}
        fileRows={props.moreSheet.fileRows}
      />
    </div>
  )
}
