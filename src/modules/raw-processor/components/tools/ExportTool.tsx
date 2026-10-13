import { useAtomValue } from 'jotai'
import { Copy, Download, FileJson, LoaderCircle, Share2 } from 'lucide-react'
import { memo, useId, useState } from 'react'

import { Button } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import { formatBytes } from '../../format-bytes'
import { useRawToolProgress } from '../../hooks/useRawToolState'
import type {
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'
import { manifestActionTitleKey } from '../../services/export/manifest-state-copy'
import type { ExportPanelKind } from '../../services/surface/export-panel-state'
import {
  deriveExportPanelState,
  exportProgressPercent,
} from '../../services/surface/export-panel-state'
import type {
  FullExportActionReason,
  HqExportActionReason,
} from '../../services/surface/raw-reason'
import { exportCopyActionLabel } from '../../services/surface/raw-reason'
import { currentSessionAtom } from '../../state/session.atoms'
import type { ExportInterruptionNote } from '../RawWorkflowContext'
import { EXPORT_INTERRUPTION_NOTE_COPY } from '../RawWorkflowContext'

// Both export buttons refuse on one plate, so neither reads as the one still
// on offer.
const REFUSED_BUTTON_CLASS =
  'w-full [&_svg]:size-3.5 disabled:border-lf-on-photo-bord-soft disabled:bg-lf-on-photo-bg disabled:text-lf-on-photo-ink/35'

// A running export's button keeps its plate at full strength: the primitive's
// disabled fade would read as refused while it is the one thing working.
const RUNNING_BUTTON_CLASS =
  'overflow-hidden disabled:opacity-100 disabled:border-lf-on-photo-bord-soft disabled:bg-lf-on-photo-bg disabled:text-lf-on-photo-ink/85'

/**
 * The running export's face: a spinner, the percent, and a hairline that
 * fills along the button's foot. Only this reads the progress, so the panel
 * does not rerender as it moves.
 */
const ExportRunningFace = memo(() => {
  const { t } = useI18n()
  const percent = exportProgressPercent(useRawToolProgress()) ?? 0
  return (
    <>
      <LoaderCircle
        aria-hidden="true"
        className="animate-spin motion-reduce:animate-none"
      />
      <span className="tabular-nums">
        {t('raw.export.exportingPercent', { percent })}
      </span>
      <span
        aria-hidden="true"
        data-export-progress
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-lf-green transition-transform duration-200 ease-lf-standard motion-reduce:transition-none"
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </>
  )
})

type DeliveryAction = 'share' | 'copy' | 'manifest'

/**
 * A delivery action's icon, which turns into a spinner while the action is
 * still working. The swap waits 150ms, so an action that lands at once never
 * flickers.
 */
function DeliveryIcon({
  icon: Icon,
  pending,
}: {
  icon: typeof Copy
  pending: boolean
}) {
  return (
    <span aria-hidden="true" className="grid *:col-start-1 *:row-start-1">
      <Icon
        className={clsxm(
          'transition-opacity duration-150',
          pending && 'opacity-0 delay-150',
        )}
      />
      {pending && (
        <LoaderCircle className="animate-spin transition-opacity delay-150 duration-150 starting:opacity-0 motion-reduce:animate-none" />
      )}
    </span>
  )
}

export const ExportTool = memo(
  ({
    canExport,
    disabledReason,
    canPreviewExport = false,
    previewExportDisabledReason,
    isProcessing,
    isExporting = false,
    onExport,
    onPreviewExport,
    exportResult,
    exportShareCapability,
    onShareExport,
    onDownloadExport,
    onDownloadExportManifest,
    onCopyExport,
    interruptionNote,
  }: {
    canExport: boolean
    disabledReason?: FullExportActionReason
    canPreviewExport?: boolean
    previewExportDisabledReason?: HqExportActionReason
    isProcessing: boolean
    /** An export (full resolution or HQ preview) is running. */
    isExporting?: boolean
    onExport: () => void
    onPreviewExport?: () => void | Promise<void>
    exportResult: ExportResult | null
    exportShareCapability: ExportShareCapability
    onShareExport: () => void | Promise<void>
    onDownloadExport: () => void
    onDownloadExportManifest?: () => void | Promise<void>
    onCopyExport: () => void | Promise<void>
    /**
     * A hint for the next export the user starts, never an action: the panel
     * offers no file picker for it.
     */
    interruptionNote?: ExportInterruptionNote | null
  }) => {
    const { t } = useI18n()
    const fullReasonId = useId()
    const previewReasonId = useId()
    // Both exports run under one workflow status, so the panel remembers
    // which button started the one running.
    const [startedKind, setStartedKind] = useState<ExportPanelKind>('full')
    // One delivery at a time: a second press while one works (encoding a
    // copy, an open share sheet) does nothing.
    const [pendingDelivery, setPendingDelivery] =
      useState<DeliveryAction | null>(null)
    const deliver = (
      action: DeliveryAction,
      command: (() => void | Promise<void>) | undefined,
    ) => {
      if (!command || pendingDelivery) return
      const result = command()
      if (!(result instanceof Promise)) return
      setPendingDelivery(action)
      const settle = () => {
        setPendingDelivery((current) => (current === action ? null : current))
      }
      result.then(settle, settle)
    }
    const noteClassName =
      'm-0 text-[0.78rem] leading-relaxed text-lf-on-surface/72 transition-opacity duration-150 ease-lf-standard starting:opacity-0 motion-reduce:transition-none'
    const session = useAtomValue(currentSessionAtom)
    const isLowMemoryPlan =
      session?.exportState.activePlan?.runtimeMemoryProfile === 'low-memory'
    const panel = deriveExportPanelState(
      {
        canExport,
        disabledReason,
        canPreviewExport,
        previewExportDisabledReason,
        isProcessing,
        isExporting,
        startedKind,
        interruptionNote,
        resultKind: exportResult?.kind,
      },
      t,
    )
    const { runningKind, fullReason: unavailableReason, previewReason } = panel
    const copyButtonLabel = exportCopyActionLabel(
      exportResult?.copyCapability,
      t,
    )
    // Only a result that names its kind takes that kind's label; one that
    // names none is never taken for a full-resolution JPEG.
    const readyLabel =
      panel.resultKind === 'hq-preview'
        ? t('raw.export.previewReady')
        : panel.resultKind === 'full-resolution'
          ? t('raw.export.ready')
          : null

    return (
      <div className="grid min-w-0 gap-3">
        {exportResult ? (
          <div
            data-export-result
            className="grid min-w-0 gap-3 transition-[opacity,translate] duration-200 ease-lf-standard starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none"
          >
            <div className="grid min-w-0 gap-0.5">
              {readyLabel ? (
                <span className="text-[0.72rem] tracking-tight text-lf-on-surface/70">
                  {readyLabel}
                </span>
              ) : null}
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
                aria-busy={pendingDelivery === 'share' || undefined}
                onClick={() => deliver('share', onShareExport)}
                className="[&_svg]:size-3.5"
              >
                <DeliveryIcon
                  icon={Share2}
                  pending={pendingDelivery === 'share'}
                />
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
                  aria-busy={pendingDelivery === 'manifest' || undefined}
                  onClick={() => deliver('manifest', onDownloadExportManifest)}
                  title={t(manifestActionTitleKey(exportResult.manifestState))}
                  className="[&_svg]:size-3.5"
                >
                  <DeliveryIcon
                    icon={FileJson}
                    pending={pendingDelivery === 'manifest'}
                  />
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
                  aria-busy={pendingDelivery === 'copy' || undefined}
                  onClick={() => deliver('copy', onCopyExport)}
                  className="[&_svg]:size-3.5"
                >
                  <DeliveryIcon
                    icon={Copy}
                    pending={pendingDelivery === 'copy'}
                  />
                  {copyButtonLabel}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Every note sits above the buttons, keyed by its text, so a
                reason that changes fades in where the last one was and the
                buttons keep their place at the foot of the rail. */}
            {isLowMemoryPlan && (
              <p className={noteClassName}>{t('raw.export.lowMemory')}</p>
            )}
            {panel.interruptionNote && (
              <p data-export-interruption className={noteClassName}>
                {t(EXPORT_INTERRUPTION_NOTE_COPY[panel.interruptionNote.kind])}
              </p>
            )}
            {unavailableReason && (
              <p
                key={unavailableReason}
                id={fullReasonId}
                className={noteClassName}
              >
                {unavailableReason}
              </p>
            )}
            {previewReason && (
              <p
                key={previewReason}
                id={previewReasonId}
                className={noteClassName}
              >
                {previewReason}
              </p>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!canExport || isProcessing}
              aria-busy={runningKind === 'full' || undefined}
              aria-describedby={unavailableReason ? fullReasonId : undefined}
              onClick={() => {
                setStartedKind('full')
                onExport()
              }}
              // A blocked export must not read as Lab Green. The shared
              // primitive only drops opacity, which on the near-black darkroom
              // keeps the hue and says "safe to ship" while the rail says the
              // opposite. Mobile already de-greens; match it.
              className={clsxm(
                REFUSED_BUTTON_CLASS,
                runningKind === 'full' && RUNNING_BUTTON_CLASS,
              )}
            >
              {runningKind === 'full' ? (
                <ExportRunningFace />
              ) : (
                <>
                  <Download aria-hidden="true" />
                  {t('raw.export.run')}
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canPreviewExport || isProcessing || !onPreviewExport}
              aria-busy={runningKind === 'hq' || undefined}
              aria-describedby={
                previewReason
                  ? previewReasonId
                  : panel.previewRepeatsFull
                    ? fullReasonId
                    : undefined
              }
              onClick={() => {
                setStartedKind('hq')
                onPreviewExport?.()
              }}
              className={clsxm(
                REFUSED_BUTTON_CLASS,
                runningKind === 'hq' && RUNNING_BUTTON_CLASS,
              )}
            >
              {runningKind === 'hq' ? (
                <ExportRunningFace />
              ) : (
                <>
                  <Download aria-hidden="true" />
                  {t('raw.export.runPreview')}
                </>
              )}
            </Button>
          </>
        )}
      </div>
    )
  },
)
