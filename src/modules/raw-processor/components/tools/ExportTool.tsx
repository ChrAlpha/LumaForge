import { useAtomValue } from 'jotai'
import { Copy, Download, FileJson, Share2 } from 'lucide-react'

import { Button } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

import type {
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'
import type { ActiveExportPlanState } from '../../model/session'
import { manifestActionTitleKey } from '../../services/export/manifest-state-copy'
import type {
  FullExportActionReason,
  HqExportActionReason,
} from '../../services/surface/raw-reason'
import {
  exportCopyActionLabel,
  fullExportActionReasonText,
  hqExportActionReasonText,
} from '../../services/surface/raw-reason'
import { currentSessionAtom } from '../../state/session.atoms'
import type { ExportInterruptionNote } from '../RawWorkflowContext'
import { EXPORT_INTERRUPTION_NOTE_COPY } from '../RawWorkflowContext'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ExportTool({
  canExport,
  disabledReason,
  canPreviewExport = false,
  previewExportDisabledReason,
  isProcessing,
  onExport,
  onPreviewExport,
  exportResult,
  exportShareCapability,
  onShareExport,
  onDownloadExport,
  onDownloadExportManifest,
  onCopyExport,
  activePlan,
  interruptionNote,
}: {
  canExport: boolean
  disabledReason?: FullExportActionReason
  canPreviewExport?: boolean
  previewExportDisabledReason?: HqExportActionReason
  isProcessing: boolean
  onExport: () => void
  onPreviewExport?: () => void | Promise<void>
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  onShareExport: () => void | Promise<void>
  onDownloadExport: () => void
  onDownloadExportManifest?: () => void | Promise<void>
  onCopyExport: () => void | Promise<void>
  activePlan?: ActiveExportPlanState
  /**
   * A hint for the next export the user starts, never an action: the panel
   * offers no file picker for it.
   */
  interruptionNote?: ExportInterruptionNote | null
  embedded?: boolean
}) {
  const { t } = useI18n()
  const noteClassName = 'text-[0.78rem] leading-relaxed text-lf-on-surface/72'
  const session = useAtomValue(currentSessionAtom)
  const currentActivePlan = activePlan ?? session?.exportState.activePlan
  const isLowMemoryPlan =
    currentActivePlan?.runtimeMemoryProfile === 'low-memory'
  // The next export the user starts uses the current RAW and edits on a
  // safer plan; a running export already took it.
  const showInterruption = !isProcessing && Boolean(interruptionNote)
  const unavailableReason = disabledReason
    ? fullExportActionReasonText(disabledReason, t)
    : t('raw.exportSourceLoading')
  // The HQ preview can be refused on its own terms while full resolution is
  // fine (a committed Transform does exactly that). Without this the button
  // just goes dark and the reason prop is never read.
  const previewUnavailableReason =
    previewExportDisabledReason &&
    hqExportActionReasonText(previewExportDisabledReason, t)
  const copyButtonLabel = exportCopyActionLabel(exportResult?.copyCapability, t)
  const resultKind = exportResult?.kind ?? 'full-resolution'
  const readyLabel =
    resultKind === 'hq-preview'
      ? t('raw.export.previewReady')
      : t('raw.export.ready')

  const innerContent = (
    <div className="grid min-w-0 gap-3">
      {exportResult ? (
        <div className="grid min-w-0 gap-3">
          <div className="grid min-w-0 gap-0.5">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/70">
              {readyLabel}
            </span>
            <strong
              className="min-w-0 truncate text-[0.82rem] font-semibold text-lf-on-surface"
              title={exportResult.filename}
            >
              {exportResult.filename}
            </strong>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)_5rem_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[0.74rem]">
            <dt className="tracking-tight text-lf-on-surface/62">
              {t('raw.export.dimensions')}
            </dt>
            <dd className="font-medium tabular-nums text-lf-on-surface/85">
              {exportResult.width} x {exportResult.height}
            </dd>
            <dt className="tracking-tight text-lf-on-surface/62">
              {t('raw.export.fileSize')}
            </dt>
            <dd className="font-medium tabular-nums text-lf-on-surface/85">
              {formatBytes(exportResult.size)}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!exportShareCapability.available}
              onClick={onShareExport}
              className="[&_svg]:size-3.5"
            >
              <Share2 aria-hidden="true" />
              {t('raw.export.share')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDownloadExport}
              className="[&_svg]:size-3.5"
            >
              <Download aria-hidden="true" />
              {t('raw.export.download')}
            </Button>
            {exportResult.manifestState ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={
                  exportResult.manifestState.status !== 'ready' ||
                  !onDownloadExportManifest
                }
                onClick={onDownloadExportManifest}
                title={t(manifestActionTitleKey(exportResult.manifestState))}
                className="[&_svg]:size-3.5"
              >
                <FileJson aria-hidden="true" />
                {t('raw.export.downloadManifest')}
              </Button>
            ) : null}
            {exportResult.copyCapability.mode === 'unavailable' ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="[&_svg]:size-3.5"
              >
                <Copy aria-hidden="true" />
                {copyButtonLabel}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onCopyExport}
                className="[&_svg]:size-3.5"
              >
                <Copy aria-hidden="true" />
                {copyButtonLabel}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          {isLowMemoryPlan && (
            <p className={noteClassName}>{t('raw.export.lowMemory')}</p>
          )}
          {showInterruption && interruptionNote && (
            <p data-export-interruption className={noteClassName}>
              {t(EXPORT_INTERRUPTION_NOTE_COPY[interruptionNote.kind])}
            </p>
          )}
          {!canExport && !isProcessing && (
            <p className={noteClassName}>{unavailableReason}</p>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canExport || isProcessing}
            onClick={() => onExport()}
            // A blocked export must not read as Lab Green. The shared
            // primitive only drops opacity, which on the near-black darkroom
            // keeps the hue and says "safe to ship" while the rail says the
            // opposite. Mobile already de-greens; match it.
            className="w-full [&_svg]:size-3.5 disabled:border-lf-on-photo-bord-soft disabled:bg-lf-on-photo-bg disabled:text-lf-on-photo-ink/35"
          >
            <Download aria-hidden="true" />
            {isProcessing ? t('raw.export.preparing') : t('raw.export.run')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canPreviewExport || isProcessing || !onPreviewExport}
            onClick={() => onPreviewExport?.()}
            className="w-full [&_svg]:size-3.5"
          >
            <Download aria-hidden="true" />
            {t('raw.export.runPreview')}
          </Button>
          {!canPreviewExport &&
            !isProcessing &&
            previewUnavailableReason &&
            previewUnavailableReason !== unavailableReason && (
              <p className={noteClassName}>{previewUnavailableReason}</p>
            )}
        </>
      )}
    </div>
  )

  return innerContent
}
