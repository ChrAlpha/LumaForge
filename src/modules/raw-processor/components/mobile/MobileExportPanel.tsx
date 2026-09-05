import {
  AlertTriangle,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  Share2,
} from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'

import { localizeCopyLabel, localizeRawReason, useI18n } from '~/lib/i18n'

import { formatBytes } from '../../format-bytes'
import type {
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'
import type { ExportRecoveryState } from '../../model/session'
import { manifestActionTitleKey } from '../../services/export/manifest-state-copy'

// Mirrors the handoff spec tokens: --mrl-ease + base 220ms duration so the
// idle/busy/done transitions feel like the design rather than a hard snap.
const MRL_EASE = [0.22, 1, 0.36, 1] as const
const PANEL_TRANSITION = { duration: 0.22, ease: MRL_EASE }

function BusySpinner() {
  const reduced = useReducedMotion() ?? false
  return (
    <m.span
      aria-hidden="true"
      className="size-4 rounded-full border-2 border-lf-on-surface/30 border-t-lf-on-surface"
      animate={reduced ? undefined : { rotate: 360 }}
      transition={
        reduced
          ? undefined
          : { duration: 0.8, ease: 'linear', repeat: Infinity }
      }
    />
  )
}

function MobileExportAction(props: {
  icon: typeof Share2
  label: string
  // Full descriptive name for assistive tech / hover when the visible face is
  // trimmed to fit the three-up row (e.g. "Copy" face, "Copy preview-size
  // image" accessible name). Visible label stays a substring so WCAG 2.5.3
  // (label in name) holds.
  srLabel?: string
  onClick?: () => void | Promise<void>
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.srLabel}
      title={props.srLabel ?? props.label}
      className="inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2 text-[0.74rem] font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft disabled:cursor-not-allowed disabled:opacity-45"
    >
      <props.icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{props.label}</span>
    </button>
  )
}

export function MobileExportPanel(props: {
  canExport: boolean
  disabledReason?: string
  canPreviewExport?: boolean
  previewExportDisabledReason?: string
  isProcessing: boolean
  onExport: (options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
  }) => void
  onPreviewExport?: () => void | Promise<void>
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  recovery?: ExportRecoveryState
  onShareExport: () => void | Promise<void>
  onDownloadExport: () => void
  onDownloadExportManifest?: () => void | Promise<void>
  onCopyExport: () => void | Promise<void>
  onRecoverExportSource?: () => void
}) {
  const { t } = useI18n()
  const unavailableReason =
    localizeRawReason(props.disabledReason, t) || t('raw.exportSourceLoading')
  const copyCapability = props.exportResult?.copyCapability
  const copyButtonLabel = copyCapability
    ? copyCapability.mode === 'unavailable'
      ? t('raw.export.copy')
      : localizeCopyLabel(copyCapability.label, t)
    : t('raw.export.copy')
  const showUnavailableReason = !props.isProcessing && !props.canExport
  const showRecovery =
    !props.isProcessing && props.recovery?.status === 'source-required'
  const resultKind = props.exportResult?.kind ?? 'full-resolution'
  const resultReadyLabel =
    resultKind === 'hq-preview'
      ? t('raw.export.previewReady')
      : t('raw.export.ready')

  const body = props.exportResult ? (
    <m.div
      key="result"
      data-mobile-substrate="glass-panel"
      className="grid gap-3 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg p-3.5 text-lf-on-photo-ink"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={PANEL_TRANSITION}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5">
        <span className="grid size-5 place-items-center text-lf-green-soft">
          <Download aria-hidden="true" className="size-5" />
        </span>
        <div className="grid min-w-0 gap-1">
          <h3
            className="m-0 truncate text-[0.88rem] font-semibold"
            title={props.exportResult.filename}
          >
            {resultKind === 'hq-preview'
              ? resultReadyLabel
              : `${props.exportResult.filename} ready`}
          </h3>
          <p className="m-0 text-[0.7rem] text-lf-on-photo-ink/68 tabular-nums">
            {props.exportResult.width} x {props.exportResult.height} ·{' '}
            {formatBytes(props.exportResult.size)}
          </p>
        </div>
      </div>
      <div
        className={
          props.exportResult.manifestState
            ? 'grid grid-cols-2 gap-1.5'
            : 'grid grid-cols-3 gap-1.5'
        }
      >
        <MobileExportAction
          icon={Share2}
          label={t('raw.export.share')}
          disabled={!props.exportShareCapability.available}
          onClick={props.onShareExport}
        />
        <MobileExportAction
          icon={Download}
          label={t('raw.export.download')}
          onClick={props.onDownloadExport}
        />
        <MobileExportAction
          icon={Copy}
          label={t('raw.export.copy')}
          srLabel={copyButtonLabel}
          disabled={props.exportResult.copyCapability.mode === 'unavailable'}
          onClick={props.onCopyExport}
        />
        {props.exportResult.manifestState ? (
          <MobileExportAction
            icon={FileJson}
            label={t('raw.export.downloadManifest')}
            srLabel={t(
              manifestActionTitleKey(props.exportResult.manifestState),
            )}
            disabled={
              props.exportResult.manifestState.status !== 'ready' ||
              !props.onDownloadExportManifest
            }
            onClick={props.onDownloadExportManifest}
          />
        ) : null}
      </div>
    </m.div>
  ) : (
    <m.div
      key="idle"
      className="grid gap-2.5 px-0.5 py-0.5"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={PANEL_TRANSITION}
    >
      {showUnavailableReason && (
        <div className="grid grid-cols-[18px_1fr] gap-2 rounded-md border border-lf-rose/45 bg-lf-rose/10 px-2.5 py-2 text-lf-on-photo-ink">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 text-lf-rose"
          />
          <span className="block text-[0.72rem] leading-snug text-lf-on-photo-ink/72">
            {unavailableReason}
          </span>
        </div>
      )}
      {showRecovery && (
        <button
          type="button"
          disabled={!props.onRecoverExportSource}
          onClick={props.onRecoverExportSource}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 text-sm font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FolderOpen aria-hidden="true" className="size-4" />
          {t('raw.export.reselect')}
        </button>
      )}
      <div className="grid gap-2">
        <m.button
          type="button"
          disabled={!props.canExport || props.isProcessing}
          whileTap={
            !props.canExport || props.isProcessing ? undefined : { scale: 0.99 }
          }
          transition={PANEL_TRANSITION}
          onClick={() =>
            props.onExport({ quality: 'high', fidelity: 'balanced' })
          }
          className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-md border border-lf-green-deep/40 bg-lf-green px-3 text-sm font-semibold text-lf-on-surface transition-colors hover:bg-lf-green-hover disabled:cursor-not-allowed disabled:border-lf-on-photo-bord-soft disabled:bg-lf-on-photo-bg disabled:text-lf-on-photo-ink/35"
        >
          {props.isProcessing ? (
            <BusySpinner />
          ) : (
            <Download aria-hidden="true" className="size-4 shrink-0" />
          )}
          {props.isProcessing ? t('raw.export.preparing') : t('raw.export.run')}
        </m.button>
        <m.button
          type="button"
          disabled={
            !props.canPreviewExport ||
            props.isProcessing ||
            !props.onPreviewExport
          }
          whileTap={
            !props.canPreviewExport || props.isProcessing
              ? undefined
              : { scale: 0.99 }
          }
          transition={PANEL_TRANSITION}
          onClick={() => props.onPreviewExport?.()}
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 text-[0.8rem] font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft disabled:cursor-not-allowed disabled:bg-lf-on-photo-bg/60 disabled:text-lf-on-photo-ink/35"
        >
          <Download aria-hidden="true" className="size-4 shrink-0" />
          {t('raw.export.runPreview')}
        </m.button>
      </div>
    </m.div>
  )

  return (
    <AnimatePresence mode="wait" initial={false}>
      {body}
    </AnimatePresence>
  )
}
