import type {
  LUTColorProfile,
  LUTProfileResolution,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronDown, Download, SlidersHorizontal, X } from 'lucide-react'
import { m } from 'motion/react'
import type { ComponentProps } from 'react'
import { useCallback, useId, useRef, useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type {
  ExportResult,
  ExportShareCapability,
} from '../model/export-result'
import type {
  ExportRecoveryState,
  LUTProfileSelectionState,
} from '../model/session'
import { CompareTool } from './tools/CompareTool'
import { ExportTool } from './tools/ExportTool'
import { FileFactsTool } from './tools/FileFactsTool'
import { HistogramTool } from './tools/HistogramTool'
import { LutContractTool } from './tools/LutContractTool'
import type { StrengthLevel } from './tools/StrengthControl'
import { StrengthControl } from './tools/StrengthControl'
import type { ToneValue } from './tools/ToneTool'
import { ToneTool } from './tools/ToneTool'
import { ToolSection } from './tools/ToolSection'

type MobileToolPanel = 'style' | 'export'

export function RawToolSurface(props: {
  activeIntensity: StrengthLevel
  tone: ToneValue
  onIntensitySelect: (level: StrengthLevel) => void
  onToneChange: (value: Partial<ToneValue>) => void
  onToneReset: () => void
  onCompareReset: () => void
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onExport: (options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
  }) => void
  canExport: boolean
  disabledReason?: string
  isProcessing: boolean
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  histogram: PreviewHistogramState
  recovery?: ExportRecoveryState
  onShareExport: () => void
  onDownloadExport: () => void
  onCopyExport: () => void
  onRecoverExportSource?: () => void
  hasImage: boolean
  currentLutName?: string | null
  lutProfileSelection?: LUTProfileSelectionState | null
  lutProfileResolution?: LUTProfileResolution | null
  onlineLutSources?: UseOnlineLutSourcesResult
  supportLevel: 'official' | 'experimental'
  metadata: ComponentProps<typeof FileFactsTool>['metadata']
  stats: ComponentProps<typeof FileFactsTool>['stats']
}) {
  const { t } = useI18n()
  const [mobilePanel, setMobilePanel] = useState<MobileToolPanel | null>(null)
  const [toneExpanded, setToneExpanded] = useState(true)
  const mobileToolSheetId = useId()
  const disabled = !props.hasImage || props.isProcessing
  const mobilePanelTitle =
    mobilePanel === 'style'
      ? t('raw.mobileTools.style')
      : mobilePanel === 'export'
        ? t('raw.mobileTools.export')
        : ''
  const { canExport, isProcessing, exportResult, onExport } = props
  const canStartMobileExport = canExport && !isProcessing && !exportResult
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sheetDragY, setSheetDragY] = useState(0)
  const sheetDragStartRef = useRef<number | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)

  const handleMobilePanelToggle = useCallback((panel: MobileToolPanel) => {
    setMobilePanel((currentPanel) => (currentPanel === panel ? null : panel))
  }, [])

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const handleExportLongPressStart = useCallback(() => {
    clearLongPress()
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      if (canStartMobileExport) {
        onExport({ quality: 'high', fidelity: 'balanced' })
      }
    }, 500)
  }, [canStartMobileExport, clearLongPress, onExport])

  const handleSheetPointerDown = useCallback((event: React.PointerEvent) => {
    const el = event.currentTarget as HTMLElement
    el.setPointerCapture?.(event.pointerId)
    sheetDragStartRef.current = event.clientY
  }, [])

  const handleSheetPointerMove = useCallback((event: React.PointerEvent) => {
    if (sheetDragStartRef.current === null) return
    const delta = event.clientY - sheetDragStartRef.current
    setSheetDragY(Math.max(0, delta))
  }, [])

  const handleSheetPointerUp = useCallback((event: React.PointerEvent) => {
    const el = event.currentTarget as HTMLElement
    el.releasePointerCapture?.(event.pointerId)
    sheetDragStartRef.current = null

    const sheet = sheetRef.current
    const threshold = sheet ? Math.max(80, sheet.offsetHeight * 0.28) : 80

    if (sheetDragYRef.current > threshold) {
      setMobilePanel(null)
    }
    setSheetDragY(0)
  }, [])

  const handleSheetPointerCancel = useCallback((event: React.PointerEvent) => {
    const el = event.currentTarget as HTMLElement
    el.releasePointerCapture?.(event.pointerId)
    sheetDragStartRef.current = null
    setSheetDragY(0)
  }, [])

  const sheetDragYRef = useRef(sheetDragY)
  sheetDragYRef.current = sheetDragY

  const renderStyleTools = ({
    includeFileFacts = true,
  }: { includeFileFacts?: boolean } = {}) => (
    <>
      {/* Phase 1: LUT + Intensity — always visible */}
      <LutContractTool
        currentLutName={props.currentLutName}
        disabled={props.isProcessing}
        onLutLoad={props.onLutLoad}
        onLutClear={props.onLutClear}
        lutProfileSelection={props.lutProfileSelection}
        lutProfileResolution={props.lutProfileResolution}
        onLutProfileSelect={props.onLutProfileSelect}
        onlineLutSources={props.onlineLutSources}
      />
      <ToolSection title={t('raw.strength.title')}>
        <StrengthControl
          value={props.activeIntensity}
          onChange={props.onIntensitySelect}
          disabled={disabled}
        />
      </ToolSection>

      {/* Phase 2: Fine-tune — collapsible */}
      <Collapsible.Root open={toneExpanded} onOpenChange={setToneExpanded}>
        <Collapsible.Trigger className="flex w-full items-center justify-between rounded-lg border border-[color:--color-raw-hairline] px-3 py-2 text-[0.78rem] font-semibold text-[color:--color-raw-ink] transition-colors duration-150 hover:border-[color:--color-raw-green] hover:text-[color:--color-raw-green-deep]">
          {t('raw.tone.fineTune')}
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform duration-200"
            style={{ transform: toneExpanded ? 'rotate(180deg)' : undefined }}
          />
        </Collapsible.Trigger>
        <Collapsible.Content asChild>
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="pt-3">
              <ToneTool
                value={props.tone}
                disabled={disabled}
                onChange={props.onToneChange}
                onReset={props.onToneReset}
              />
              <HistogramTool histogram={props.histogram} />
            </div>
          </m.div>
        </Collapsible.Content>
      </Collapsible.Root>

      <CompareTool disabled={disabled} onCompareReset={props.onCompareReset} />

      {includeFileFacts && (
        <FileFactsTool
          supportLevel={props.supportLevel}
          metadata={props.metadata}
          stats={props.stats}
        />
      )}
    </>
  )

  const renderExportTools = () => (
    <ExportTool
      canExport={props.canExport}
      disabledReason={props.disabledReason}
      isProcessing={props.isProcessing}
      onExport={props.onExport}
      exportResult={props.exportResult}
      exportShareCapability={props.exportShareCapability}
      recovery={props.recovery}
      onShareExport={props.onShareExport}
      onDownloadExport={props.onDownloadExport}
      onCopyExport={props.onCopyExport}
      onRecoverExportSource={props.onRecoverExportSource}
    />
  )

  return (
    <aside
      className="grid grid-rows-[auto_minmax(0,1fr)] gap-3 min-w-0 min-h-0 overflow-hidden border-l border-[color:--color-raw-hairline] bg-gradient-to-b from-[color:oklch(0.942_0.024_86)] to-[color:oklch(0.91_0.03_84)] p-3.5"
      data-raw-tool-surface="raw-finishing"
      data-raw-tool-sheet={mobilePanel ? 'open' : 'closed'}
      data-raw-mobile-panel={mobilePanel ?? 'closed'}
      aria-label={t('raw.tools.aria')}
    >
      {/* Desktop scrollable content */}
      <div
        className="contain-paint min-h-0 overflow-y-auto pr-0.5 hidden @[981px]:block"
        data-raw-scroll-container
      >
        {renderStyleTools({ includeFileFacts: false })}

        {/* Phase 3: Export — sticky at bottom */}
        <div className="sticky bottom-0 -mx-3.5 -mb-3.5 border-t border-[color:--color-raw-hairline] bg-gradient-to-b from-[color:oklch(0.954_0.022_86)] to-[color:oklch(0.91_0.03_84)] px-3.5 py-3">
          {renderExportTools()}
        </div>

        <FileFactsTool
          supportLevel={props.supportLevel}
          metadata={props.metadata}
          stats={props.stats}
        />
      </div>

      {/* Mobile sheet */}
      <div
        id={mobileToolSheetId}
        ref={sheetRef}
        data-raw-mobile-sheet=""
        className={[
          'fixed inset-x-0 bottom-0 z-30 grid grid-rows-[auto_minmax(0,1fr)] min-h-0 overflow-hidden rounded-t-xl border-t border-[color:--color-raw-hairline] bg-gradient-to-b from-[color:oklch(0.954_0.022_86)] to-[color:oklch(0.91_0.03_84)] shadow-[0_-24px_54px_oklch(0.18_0.018_76_/_0.22)] transition-[transform,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:hidden',
          mobilePanel
            ? 'visible translate-y-0 pointer-events-auto'
            : 'invisible translate-y-full',
        ].join(' ')}
        style={
          sheetDragY > 0
            ? { transform: `translateY(${sheetDragY}px)`, transition: 'none' }
            : undefined
        }
      >
        <div
          className="touch-none"
          onPointerDown={handleSheetPointerDown}
          onPointerMove={handleSheetPointerMove}
          onPointerUp={handleSheetPointerUp}
          onPointerCancel={handleSheetPointerCancel}
        >
          <div className="flex justify-center pt-2" aria-hidden="true">
            <span className="block h-1 w-8 rounded-full bg-[color:oklch(0.74_0.035_78_/_0.64)]" />
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-[color:oklch(0.74_0.035_78_/_0.58)] px-3 py-2.5">
            <h2 className="m-0 text-[0.84rem] font-semibold leading-tight text-[color:--color-raw-ink]">
              {mobilePanelTitle}
            </h2>
            <button
              type="button"
              className="grid size-11 shrink-0 place-items-center rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.7)] bg-[color:--color-raw-paper] text-[color:--color-raw-ink]"
              aria-label={t('raw.mobileTools.close')}
              onClick={() => setMobilePanel(null)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto px-3 pb-3 [&_section:first-child]:pt-3">
          {mobilePanel === 'style' &&
            renderStyleTools({ includeFileFacts: false })}
          {mobilePanel === 'export' && renderExportTools()}
        </div>
      </div>

      {/* Mobile rail */}
      <nav
        className="z-[1] grid grid-cols-2 gap-2 border-t border-[color:--color-raw-hairline] px-2.5 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] bg-gradient-to-b from-[color:oklch(0.958_0.018_86)] to-[color:oklch(0.925_0.026_86)] shadow-[0_-14px_36px_oklch(0.18_0.018_76_/_0.18)] sm:hidden"
        aria-label={t('raw.mobileTools.aria')}
      >
        <button
          type="button"
          className="inline-flex min-w-0 min-h-[46px] items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.72)] bg-[color:--color-raw-paper] text-[0.78rem] font-bold leading-none text-[color:--color-raw-ink] data-[active=true]:border-[color:--color-raw-green-deep] data-[active=true]:bg-[color:oklch(0.86_0.065_145)] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2"
          data-mobile-tool-tab="style"
          data-active={mobilePanel === 'style'}
          aria-expanded={mobilePanel === 'style'}
          aria-controls={mobileToolSheetId}
          onClick={() => handleMobilePanelToggle('style')}
        >
          <SlidersHorizontal aria-hidden="true" />
          {t('raw.mobileTools.style')}
        </button>
        <button
          type="button"
          className="inline-flex min-w-0 min-h-[46px] items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.74_0.15_152)] bg-[color:--color-raw-green] text-[0.78rem] font-bold leading-none text-[color:--color-raw-ink] data-[active=true]:border-[color:--color-raw-green-deep] data-[active=true]:bg-[color:oklch(0.86_0.065_145)] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 aria-disabled:border-[color:oklch(0.74_0.035_78_/_0.72)] aria-disabled:bg-[color:oklch(0.92_0.026_86)] aria-disabled:text-[color:--color-raw-ink-soft]"
          data-mobile-tool-tab="export"
          data-active={mobilePanel === 'export'}
          aria-disabled={!props.canExport || props.isProcessing}
          aria-expanded={mobilePanel === 'export'}
          aria-controls={mobileToolSheetId}
          onClick={() => handleMobilePanelToggle('export')}
          onPointerDown={handleExportLongPressStart}
          onPointerUp={clearLongPress}
          onPointerLeave={clearLongPress}
          onPointerCancel={clearLongPress}
        >
          <Download aria-hidden="true" />
          {t('raw.mobileTools.export')}
        </button>
      </nav>
    </aside>
  )
}
