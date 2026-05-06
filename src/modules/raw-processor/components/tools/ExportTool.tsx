import { useAtomValue } from 'jotai'
import { Copy, Download, FolderOpen, Share2 } from 'lucide-react'

import { localizeCopyLabel, localizeRawReason, useI18n } from '~/lib/i18n'

import type {
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'
import type {
  ActiveExportPlanState,
  ExportRecoveryState,
} from '../../model/session'
import { currentSessionAtom } from '../../state/session.atoms'
import { ToolSection } from './ToolSection'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ExportTool({
  canExport,
  disabledReason,
  isProcessing,
  onExport,
  exportResult,
  exportShareCapability,
  onShareExport,
  onDownloadExport,
  onCopyExport,
  onRecoverExportSource,
  activePlan,
  recovery,
  checkpointDurable,
}: {
  canExport: boolean
  disabledReason?: string
  isProcessing: boolean
  onExport: (options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
  }) => void
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  onShareExport: () => void | Promise<void>
  onDownloadExport: () => void
  onCopyExport: () => void | Promise<void>
  onRecoverExportSource?: () => void
  activePlan?: ActiveExportPlanState
  recovery?: ExportRecoveryState
  checkpointDurable?: boolean
}) {
  const { t } = useI18n()
  const session = useAtomValue(currentSessionAtom)
  const currentActivePlan = activePlan ?? session?.exportState.activePlan
  const currentRecovery = recovery ?? session?.exportState.recovery
  const currentCheckpointDurable =
    checkpointDurable ?? session?.exportState.checkpointDurable
  const isLowMemoryPlan =
    currentActivePlan?.runtimeMemoryProfile === 'low-memory'
  const unavailableReason =
    localizeRawReason(disabledReason, t) || t('raw.exportSourceLoading')
  const shareUnavailableReason =
    exportShareCapability.available === false
      ? localizeRawReason(exportShareCapability.reason, t)
      : undefined
  const copyCapability = exportResult?.copyCapability
  const copyUnavailableReason =
    copyCapability && copyCapability.mode !== 'full-resolution'
      ? localizeRawReason(copyCapability.reason, t)
      : undefined
  const copyButtonLabel = copyCapability
    ? copyCapability.mode === 'unavailable'
      ? t('raw.export.copy')
      : localizeCopyLabel(copyCapability.label, t)
    : t('raw.export.copy')

  return (
    <ToolSection
      title={t('raw.export.title')}
      eyebrow={t('raw.export.eyebrow')}
    >
      {exportResult ? (
        <div className="grid gap-2.5 min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.58)] p-2.5 bg-gradient-to-b from-[color:oklch(0.942_0.026_84)] to-[color:oklch(0.91_0.034_82)]">
          <div className="grid gap-1 min-w-0">
            <span className="text-[0.72rem] font-bold uppercase text-[color:--color-raw-green-deep]">
              {t('raw.export.ready')}
            </span>
            <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] font-bold text-[color:--color-raw-ink]">
              {exportResult.filename}
            </strong>
          </div>
          <dl className="grid grid-cols-2 gap-2 m-0">
            <div className="min-w-0 rounded-[5px] border border-[color:oklch(0.74_0.035_78_/_0.42)] p-2 bg-[color:oklch(0.962_0.018_86_/_0.58)]">
              <dt className="text-[0.68rem] uppercase text-[color:--color-raw-ink-soft]">
                {t('raw.export.dimensions')}
              </dt>
              <dd className="m-0 text-[0.82rem] tabular-nums text-[color:--color-raw-ink]">
                {exportResult.width} x {exportResult.height}
              </dd>
            </div>
            <div className="min-w-0 rounded-[5px] border border-[color:oklch(0.74_0.035_78_/_0.42)] p-2 bg-[color:oklch(0.962_0.018_86_/_0.58)]">
              <dt className="text-[0.68rem] uppercase text-[color:--color-raw-ink-soft]">
                {t('raw.export.fileSize')}
              </dt>
              <dd className="m-0 text-[0.82rem] tabular-nums text-[color:--color-raw-ink]">
                {formatBytes(exportResult.size)}
              </dd>
            </div>
          </dl>
          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-[color:oklch(0.54_0.14_153)] bg-[color:--color-raw-green] hover:not-disabled:border-[color:oklch(0.5_0.13_153)] hover:not-disabled:bg-[color:oklch(0.66_0.16_153)]"
              disabled={!exportShareCapability.available}
              onClick={onShareExport}
            >
              <Share2 aria-hidden="true" />
              {t('raw.export.share')}
            </button>
            <button
              type="button"
              className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 bg-[color:oklch(0.936_0.028_84)] hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.48)] hover:not-disabled:bg-[color:oklch(0.9_0.05_84)] hover:not-disabled:text-[color:--color-raw-green-deep]"
              onClick={onDownloadExport}
            >
              <Download aria-hidden="true" />
              {t('raw.export.download')}
            </button>
            {exportResult.copyCapability.mode === 'unavailable' ? (
              <button
                type="button"
                className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 bg-[color:oklch(0.936_0.028_84)] hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.48)] hover:not-disabled:bg-[color:oklch(0.9_0.05_84)] hover:not-disabled:text-[color:--color-raw-green-deep]"
                disabled
              >
                <Copy aria-hidden="true" />
                {copyButtonLabel}
              </button>
            ) : (
              <button
                type="button"
                className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 bg-[color:oklch(0.936_0.028_84)] hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.48)] hover:not-disabled:bg-[color:oklch(0.9_0.05_84)] hover:not-disabled:text-[color:--color-raw-green-deep]"
                onClick={onCopyExport}
              >
                <Copy aria-hidden="true" />
                {copyButtonLabel}
              </button>
            )}
          </div>
          {!exportShareCapability.available && (
            <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
              {shareUnavailableReason}
            </p>
          )}
          {exportResult.copyCapability.mode !== 'full-resolution' && (
            <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
              {copyUnavailableReason}
            </p>
          )}
        </div>
      ) : (
        <>
          {isLowMemoryPlan && (
            <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
              {t('raw.export.lowMemory')}
            </p>
          )}
          {currentCheckpointDurable === false && isLowMemoryPlan && (
            <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
              {t('raw.export.nonDurable')}
            </p>
          )}
          {currentRecovery?.status === 'source-required' && (
            <>
              <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
                {currentRecovery.message}
              </p>
              <button
                type="button"
                className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 bg-[color:oklch(0.936_0.028_84)] hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.48)] hover:not-disabled:bg-[color:oklch(0.9_0.05_84)] hover:not-disabled:text-[color:--color-raw-green-deep]"
                disabled={!onRecoverExportSource || isProcessing}
                onClick={onRecoverExportSource}
              >
                <FolderOpen aria-hidden="true" />
                {t('raw.export.reselect')}
              </button>
            </>
          )}
          <button
            type="button"
            className="inline-flex w-full min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] px-[11px] py-2 text-[0.74rem] font-semibold leading-tight text-[color:--color-raw-ink] transition-all duration-150 hover:not-disabled:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-[color:oklch(0.54_0.14_153)] bg-[color:--color-raw-green] hover:not-disabled:border-[color:oklch(0.5_0.13_153)] hover:not-disabled:bg-[color:oklch(0.66_0.16_153)]"
            disabled={!canExport || isProcessing}
            onClick={() => onExport({ quality: 'high', fidelity: 'balanced' })}
          >
            <Download aria-hidden="true" />
            {isProcessing ? t('raw.export.preparing') : t('raw.export.run')}
          </button>
          <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
            {canExport ? t('raw.export.sourcePath') : unavailableReason}
          </p>
        </>
      )}
    </ToolSection>
  )
}
