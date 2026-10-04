import type {
  HSLBandId,
  HSLBandShift,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import { AnimatePresence, m } from 'motion/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import { DOCK_SPRING } from '../../motion'
import type { ColorValue } from '../color-fields'
import type { CpuPreviewNotice } from '../CpuPreviewBanner'
import { CpuPreviewBanner } from '../CpuPreviewBanner'
import type { RawRuntimeReadinessState } from '../raw-runtime-readiness'
import type { ToneValue } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import type { MobileDetailsSheet } from './mobile-details-sheet'
import { computeMobileStageLayout } from './mobile-stage-layout'
import {
  COMPARE_LENS_POSITION,
  getLensHintPlacement,
  MobileCompareLens,
} from './MobileCompareLens'
import { MobileEmptyState } from './MobileEmptyState'
import {
  getMobileExportActionState,
  MobileExportAction,
} from './MobileExportAction'
import {
  getPeekPillPlacement,
  MobileFloatingOverlays,
} from './MobileFloatingOverlays'
import { MobileLabModeDock } from './MobileLabModeDock'
import { MobileLabTopbar } from './MobileLabTopbar'
import type { MobileLutBrowserProps } from './MobileLutBrowser'
import { MobileLutBrowser } from './MobileLutBrowser'
import { isMobileDeckVisible } from './MobileModeDock'
import { MobileMoreSheet } from './MobileMoreSheet'
import type { MobileLabViewMode } from './useMobileLabChromeController'
import { useMobileLabChromeController } from './useMobileLabChromeController'

/** Stage geometry the chrome publishes on the shell, in px. */
const STAGE_LAYOUT_VARS = [
  '--raw-stage-inset-top',
  '--raw-stage-inset-bottom',
  '--raw-topbar-height',
  '--raw-photo-top',
  '--raw-photo-left',
  '--raw-photo-width',
  '--raw-photo-height',
  '--raw-photo-right',
] as const
type StageLayoutVar = (typeof STAGE_LAYOUT_VARS)[number]

export function MobileLabChrome(props: {
  transform?: RawTransformFeature
  canExport?: boolean
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
  /** False when the stage has no split surface (CPU preview). */
  compareSupported?: boolean
  histogram: PreviewHistogramState
  fileName: string
  fileMeta: string
  supportLevel: 'official' | 'experimental'
  onReplaceFile: () => void
  onResetSession: () => void
  isProcessing: boolean
  isExporting?: boolean
  /** Export progress, 0-100. */
  exportProgress?: number
  hasExportResult?: boolean
  runtimeReadinessState?: RawRuntimeReadinessState
  onPrepareRuntime?: () => void
  cpuPreviewNotice?: CpuPreviewNotice
  lutBrowser: Omit<MobileLutBrowserProps, 'open' | 'onClose'>
  /** Rendered in the deck while export is open; `onClose` hands it back. */
  exportPanel: (controls: { onClose: () => void }) => ReactNode
  moreSheet: MobileDetailsSheet
  previewSuspended?: boolean
  preferExportMode?: boolean
  previewFrameEl?: HTMLDivElement | null
  /** Width / height of the displayed preview; null while unknown. */
  photoAspect?: number | null
}) {
  const compareDisabled = props.transform?.active === true
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
    exportOpen,
    handoffActive,
    focusActive,
    setScrubField,
    setMoreOpen,
    setHistogramOpen,
    setDockExpanded,
    setCompareSplitMode,
    startLensPeek,
    endLensPeek,
    exitImmersive,
    openLutBrowser,
    openLutContractBrowser,
    closeLutBrowser,
    handleModeChange,
    openExport,
    closeExport,
  } = useMobileLabChromeController({
    hasImage: props.hasImage,
    isProcessing: props.isProcessing,
    previewSuspended: props.previewSuspended,
    preferExportMode: props.preferExportMode,
    previewFrameEl: props.previewFrameEl,
    viewMode: props.viewMode,
    onViewModeChange: props.onViewModeChange,
    compareDisabled,
  })
  const lensVisible =
    props.hasImage &&
    props.compareSupported !== false &&
    !immersive &&
    !focusActive &&
    !handoffActive

  const isExporting = props.isExporting === true
  const exportActionState = getMobileExportActionState({
    canExport: props.canExport === true,
    isProcessing: props.isProcessing,
    isExporting,
    hasResult: props.hasExportResult === true,
  })
  // The deck's own visibility rule: tools are disabled while the pipeline is
  // busy, but a running export keeps its panel on screen.
  const deckVisible = isMobileDeckVisible({
    expanded: dockExpanded && props.hasImage,
    disabled: !props.hasImage || props.isProcessing,
    panelVisibleWhileDisabled: exportOpen && isExporting,
  })
  const exportPanelVisible = exportOpen && deckVisible

  // Photo-first stage layout. The stage region is sized to the photo, so the
  // frame's centring anchors it under the topbar, and the deck takes what the
  // photo leaves. Inputs are chrome geometry and tool / deck state only: a
  // scrub never resizes the photo. The stage reads the insets from the shell
  // (raw-lab.css); overlays read the photo rect.
  const chromeRef = useRef<HTMLDivElement>(null)
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 })
  const [topbarHeight, setTopbarHeight] = useState(0)
  const [tabBarHeight, setTabBarHeight] = useState(0)
  const [deckNaturalHeight, setDeckNaturalHeight] = useState(0)
  const layout = computeMobileStageLayout({
    viewportWidth: shellSize.width,
    viewportHeight: shellSize.height,
    topbarHeight,
    dockBarHeight: tabBarHeight,
    photoAspect: props.photoAspect ?? null,
    tool: mode,
    deck: deckVisible ? 'expanded' : 'collapsed',
    exportOpen,
    deckNaturalHeight,
    immersive,
    hasImage: props.hasImage,
  })
  const { insetTop, insetBottom } = layout
  const {
    top: photoTop,
    left: photoLeft,
    width: photoWidth,
    height: photoHeight,
  } = layout.photoRect

  useLayoutEffect(() => {
    const chrome = chromeRef.current
    if (!chrome) return
    const shell = chrome.closest<HTMLElement>('[data-raw-lab-shell]') ?? chrome
    const measure = () =>
      setShellSize((current) =>
        current.width === shell.clientWidth &&
        current.height === shell.clientHeight
          ? current
          : { width: shell.clientWidth, height: shell.clientHeight },
      )
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  // Values are overwritten in place as the layout moves; removing them
  // between updates would let the stage start a transition toward 0.
  useLayoutEffect(() => {
    const shell = chromeRef.current?.closest<HTMLElement>(
      '[data-raw-lab-shell]',
    )
    if (!shell) return
    return () => {
      for (const name of STAGE_LAYOUT_VARS) shell.style.removeProperty(name)
    }
  }, [])

  useLayoutEffect(() => {
    const shell = chromeRef.current?.closest<HTMLElement>(
      '[data-raw-lab-shell]',
    )
    if (!shell) return
    const vars: Record<StageLayoutVar, number> = {
      '--raw-stage-inset-top': insetTop,
      '--raw-stage-inset-bottom': insetBottom,
      '--raw-topbar-height': topbarHeight,
      '--raw-photo-top': photoTop,
      '--raw-photo-left': photoLeft,
      '--raw-photo-width': photoWidth,
      '--raw-photo-height': photoHeight,
      '--raw-photo-right': Math.max(
        0,
        shellSize.width - photoLeft - photoWidth,
      ),
    }
    for (const [name, value] of Object.entries(vars)) {
      shell.style.setProperty(name, `${value}px`)
    }
  }, [
    insetBottom,
    insetTop,
    photoHeight,
    photoLeft,
    photoTop,
    photoWidth,
    shellSize.width,
    topbarHeight,
  ])

  return (
    <div
      ref={chromeRef}
      className="pointer-events-none absolute inset-0 z-20"
      data-mobile-lab-chrome
      data-stage-inset-top={insetTop}
      data-stage-inset-bottom={insetBottom}
      data-deck-height={layout.deckHeight}
      data-focus={focusActive ? 'true' : 'false'}
      data-peek={peeking || undefined}
      style={COMPARE_LENS_POSITION}
    >
      {/* Long-press peek on the photo is wired via `useMobilePreviewGestures`
          so it shares the DOM target with pinch / pan. The compare lens is
          the explicit RAW-vs-finished control: it is orthogonal to the dock
          tools, so the split survives tool switches. */}
      <AnimatePresence>
        {lensVisible && (
          <MobileCompareLens
            key="compare-lens"
            splitOn={compareSplitOpen}
            disabled={compareDisabled}
            onToggle={() => setCompareSplitMode(!compareSplitOpen)}
            onPeekStart={startLensPeek}
            onPeekEnd={endLensPeek}
            hintPlacement={getLensHintPlacement(photoWidth)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!props.hasImage && (
          <MobileEmptyState
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
        manualTransform={props.transform?.demo.manual}
        onExitImmersive={exitImmersive}
        lensVisible={lensVisible}
        peekPlacement={getPeekPillPlacement(photoWidth, lensVisible)}
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
              onOpenMore={() => setMoreOpen(true)}
              onResetSession={props.onResetSession}
              exportAction={
                props.hasImage ? (
                  <MobileExportAction
                    state={exportActionState}
                    progress={props.exportProgress}
                    expanded={exportPanelVisible}
                    disabled={props.isProcessing && !isExporting}
                    onClick={exportPanelVisible ? closeExport : openExport}
                  />
                ) : null
              }
              scrubbing={focusActive}
              onHeightChange={setTopbarHeight}
            />
            {/* Floats below the topbar instead of taking a row of the page
                grid. Stacks over the empty state (z 11), under the histogram
                card (15) and the sheets the user opens. */}
            {props.cpuPreviewNotice && (
              <CpuPreviewBanner
                {...props.cpuPreviewNotice}
                className="pointer-events-auto absolute inset-x-2 top-[calc(var(--raw-topbar-height,0px)+0.5rem)] z-[13]"
              />
            )}
            {/* No dock until a RAW is open: there is nothing for a tool to
                act on, so the empty state shows its one action instead of
                a row of disabled tabs. */}
            {props.hasImage && (
              <MobileLabModeDock
                transform={props.transform}
                mode={mode}
                exportOpen={exportOpen}
                exportBusy={isExporting}
                expanded={dockExpanded}
                disabled={props.isProcessing}
                onModeChange={handleModeChange}
                onCollapse={() => setDockExpanded(false)}
                onOpenMore={() => setMoreOpen(true)}
                scrubbing={focusActive}
                prefersReduced={prefersReduced}
                tone={props.tone}
                color={props.color}
                selectiveColor={props.selectiveColor}
                lutBrowser={props.lutBrowser}
                exportPanel={props.exportPanel({ onClose: closeExport })}
                onToneChange={props.onToneChange}
                onToneReset={props.onToneReset}
                onColorChange={props.onColorChange}
                onColorReset={props.onColorReset}
                onSelectiveColorChange={props.onSelectiveColorChange}
                onSelectiveColorReset={props.onSelectiveColorReset}
                onScrubChange={setScrubField}
                onOpenLutBrowser={openLutBrowser}
                onOpenLutContractBrowser={openLutContractBrowser}
                deckHeight={layout.deckHeight}
                onTabBarHeightChange={setTabBarHeight}
                onDeckNaturalHeightChange={setDeckNaturalHeight}
              />
            )}
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
