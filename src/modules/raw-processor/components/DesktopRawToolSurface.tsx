import type { ReactNode } from 'react'
import { useState } from 'react'

import { useScrollEdgeFade } from '~/hooks/common'
import { useI18n } from '~/lib/i18n'

import { useRawWorkflowContext } from './RawWorkflowContext'
import { AdjustTool } from './tools/AdjustTool'
import { CompareTool } from './tools/CompareTool'
import { ExportTool } from './tools/ExportTool'
import { FileFactsTool } from './tools/FileFactsTool'
import { HistogramTool } from './tools/HistogramTool'
import { LutContractTool } from './tools/lut/LutContractTool'
import { StrengthControl } from './tools/StrengthControl'
import { ToolCard, ToolCardStack } from './tools/ToolCard'

export function DesktopRawToolSurface() {
  const props = useRawWorkflowContext()
  const { t } = useI18n()
  const previewSuspended = props.previewSuspended === true
  const editorDisabled =
    !props.hasImage || props.isExporting === true || previewSuspended
  const lutDropDisabled = props.isExporting === true || previewSuspended
  const hasAppliedLut = Boolean(props.currentLutName)
  const strengthDisabled = editorDisabled || !hasAppliedLut
  const histogramMeta =
    props.histogram.state === 'ready'
      ? `Shadows ${props.histogram.clipping.shadowAnyChannel} · Highlights ${props.histogram.clipping.highlightAnyChannel}`
      : undefined

  return (
    <DesktopToolAside
      ariaLabel={t('raw.tools.aria')}
      exportBlock={
        <section
          aria-label={t('raw.export.title')}
          data-raw-export-block="persistent"
          data-raw-export-ready={props.canExport ? 'true' : 'false'}
          className="grid min-h-[104px] content-center bg-lf-on-photo-bg px-3 py-3"
        >
          <ExportTool
            canExport={props.canExport}
            disabledReason={props.disabledReason}
            canPreviewExport={props.canPreviewExport}
            previewExportDisabledReason={props.previewExportDisabledReason}
            isProcessing={props.isProcessing}
            onExport={props.onExport}
            onPreviewExport={props.onPreviewExport}
            exportResult={props.exportResult}
            exportShareCapability={props.exportShareCapability}
            recovery={props.recovery}
            onShareExport={props.onShareExport}
            onDownloadExport={props.onDownloadExport}
            onDownloadExportManifest={props.onDownloadExportManifest}
            onCopyExport={props.onCopyExport}
            onRecoverExportSource={props.onRecoverExportSource}
            embedded
          />
        </section>
      }
    >
      <ToolCardStack ariaLabel={t('raw.tools.aria')}>
        <ToolCard
          id="histogram"
          title={t('raw.histogram.title')}
          meta={histogramMeta}
        >
          <HistogramTool histogram={props.histogram} />
        </ToolCard>
        <ToolCard id="look" title={t('raw.lutContract.title')}>
          <LutContractTool
            currentLutName={props.currentLutName}
            disabled={lutDropDisabled}
            onLutLoad={props.onLutLoad}
            onLutClear={props.onLutClear}
            lutProfileSelection={props.lutProfileSelection}
            lutProfileResolution={props.lutProfileResolution}
            onLutProfileSelect={props.onLutProfileSelect}
            onlineLutSources={props.onlineLutSources}
          />
          <div className="mt-3 grid gap-1.5" data-raw-desktop-strength="row">
            <span className="text-[0.7rem] font-semibold uppercase tracking-[0.04em] text-lf-on-photo-ink/56">
              {t('raw.strength.title')}
            </span>
            <StrengthControl
              value={props.activeIntensity}
              onChange={props.onIntensitySelect}
              disabled={strengthDisabled}
            />
          </div>
        </ToolCard>
        <ToolCard id="adjust" title={t('raw.adjust.title')}>
          <AdjustTool
            tone={props.tone}
            color={props.color}
            selectiveColor={props.selectiveColor}
            disabled={editorDisabled}
            onToneChange={props.onToneChange}
            onToneReset={props.onToneReset}
            onColorChange={props.onColorChange}
            onColorReset={props.onColorReset}
            onSelectiveColorChange={props.onSelectiveColorChange}
            onSelectiveColorReset={props.onSelectiveColorReset}
          />
        </ToolCard>
        <ToolCard id="compare" title={t('raw.compare.title')}>
          <CompareTool
            disabled={editorDisabled}
            onCompareReset={props.onCompareReset}
          />
        </ToolCard>
        <ToolCard id="fileFacts" title={t('raw.fileFacts.title')}>
          <FileFactsTool
            supportLevel={props.supportLevel}
            metadata={props.metadata}
            stats={props.stats}
          />
        </ToolCard>
      </ToolCardStack>
    </DesktopToolAside>
  )
}

function DesktopToolAside({
  ariaLabel,
  children,
  exportBlock,
}: {
  ariaLabel: string
  children: ReactNode
  exportBlock: ReactNode
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  useScrollEdgeFade(scrollEl)

  return (
    <aside
      className="raw-tool-surface relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden bg-lf-on-photo-bg-strong p-0 text-lf-on-photo-ink backdrop-blur-background max-[980px]:max-h-[min(42svh,390px)]"
      data-raw-tool-surface="raw-finishing"
      data-raw-desktop-chrome="on-photo-tools"
      data-raw-desktop-density="linear-compact"
      data-raw-desktop-input="mouse-keyboard"
      aria-label={ariaLabel}
    >
      <div
        ref={setScrollEl}
        className="min-h-0 overflow-y-auto [scrollbar-gutter:stable] px-2.5 py-2"
        data-raw-tool-scroll
      >
        {children}
      </div>
      <div>{exportBlock}</div>
    </aside>
  )
}
