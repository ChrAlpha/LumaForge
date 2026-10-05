import {
  AlertTriangle,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  Share2,
  X,
} from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { useId } from 'react'

import { localizeCopyLabel, localizeRawReason, useI18n } from '~/lib/i18n'

import { formatBytes } from '../../format-bytes'
import type {
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'
import type { ExportRecoveryState } from '../../model/session'
import { TAP_SPRING } from '../../motion'
import { manifestActionTitleKey } from '../../services/export/manifest-state-copy'
import type { MobileExportRecap } from './export-recap'

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

function ExportResultAction(props: {
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
      className="inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2 text-[0.74rem] font-semibold text-lf-on-photo-ink transition-colors enabled:hover:bg-[oklch(0.96_0.006_255/0.08)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <props.icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{props.label}</span>
    </button>
  )
}

/** Marks the look's name in its recap template; never part of a name. */
const LOOK_NAME_SLOT = '\u2063'

/**
 * Cut the localized look line around the name, so the name alone truncates
 * and the strength after it always shows, in whatever order a locale puts
 * them.
 */
function splitLookRecap(line: string, name: string) {
  const at = line.indexOf(LOOK_NAME_SLOT)
  if (at < 0) return { lead: line, name: '', tail: '' }
  return {
    lead: line.slice(0, at),
    name,
    tail: line.slice(at + LOOK_NAME_SLOT.length),
  }
}

/**
 * One quiet line pair before the export button that says what will be
 * written, from state only: the JPEG that can be written (and the
 * full-resolution size when known), then the look, the Adjust fields moved
 * off neutral, and an applied Transform. Nothing here is a promise the
 * export does not keep.
 */
function ExportRecapLines({ recap }: { recap: MobileExportRecap }) {
  const { t } = useI18n()
  const details = [
    recap.adjustments > 0
      ? recap.adjustments === 1
        ? t('raw.mobile.export.recap.adjustmentsOne')
        : t('raw.mobile.export.recap.adjustments', {
            count: recap.adjustments,
          })
      : null,
    recap.transformApplied ? t('raw.mobile.export.recap.transform') : null,
  ].filter((item): item is string => item !== null)
  const look = recap.look
    ? splitLookRecap(
        t('raw.mobile.export.recap.look', {
          name: LOOK_NAME_SLOT,
          strength:
            recap.look.percent === 0
              ? t('raw.strength.off')
              : `${recap.look.percent}%`,
        }),
        recap.look.name,
      )
    : null

  return (
    <p
      data-export-recap
      className="m-0 grid gap-0.5 px-0.5 text-[0.72rem] leading-snug text-lf-on-photo-ink/68 tabular-nums"
    >
      {/* Only what can be written: full resolution when it can run, the
          HQ preview when only that can, and no output line otherwise. */}
      {recap.output === 'full-resolution' ? (
        <span className="truncate">
          {t('raw.mobile.export.recap.fullRes')}
          {recap.size && (
            <>
              {' · '}
              {recap.size.width}×{recap.size.height}
            </>
          )}
        </span>
      ) : recap.output === 'hq-preview' ? (
        <span className="truncate">{t('raw.mobile.export.previewOnly')}</span>
      ) : null}
      {/* Each part is a flex item, and a flex item drops the white space
          it starts with: parts that open on a separator keep it with
          whitespace-pre. */}
      <span className="flex min-w-0 whitespace-nowrap">
        {look ? (
          <>
            <span className="min-w-0 truncate">
              {look.lead}
              {look.name}
            </span>
            <span className="shrink-0 whitespace-pre">{look.tail}</span>
          </>
        ) : (
          <span className="shrink-0">{t('raw.mobile.export.recap.noLut')}</span>
        )}
        {details.length > 0 && (
          <span className="shrink-0 whitespace-pre">{` · ${details.join(' · ')}`}</span>
        )}
      </span>
    </p>
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
  /** A full-resolution or HQ export is running (not just any processing). */
  isExporting?: boolean
  /** Export progress, 0-100, shown beside the title while exporting. */
  progress?: number
  /** Hands the deck back to the tool that held it before export opened. */
  onClose?: () => void
  /** What the full-resolution export will write; omitted, no recap. */
  recap?: MobileExportRecap
  /**
   * Set when the applied LUT's colour contract is what blocks export: the
   * panel offers to go and choose it.
   */
  onChooseLutContract?: () => void
}) {
  const { t } = useI18n()
  const previewReasonId = useId()
  const titleId = useId()
  const isExporting = props.isExporting === true
  const percent =
    typeof props.progress === 'number' && Number.isFinite(props.progress)
      ? Math.round(Math.min(100, Math.max(0, props.progress)))
      : null
  const resultKind = props.exportResult?.kind ?? 'full-resolution'
  // An HQ preview result is the bounded compromise: it never takes the
  // full-resolution "Exported" title.
  const title = isExporting
    ? t('raw.mobile.export.exporting')
    : props.exportResult
      ? resultKind === 'hq-preview'
        ? t('raw.mobile.export.previewDone')
        : t('raw.mobile.export.done')
      : t('raw.export.title')
  const unavailableReason =
    localizeRawReason(props.disabledReason, t) || t('raw.exportSourceLoading')
  const copyCapability = props.exportResult?.copyCapability
  const copyButtonLabel = copyCapability
    ? copyCapability.mode === 'unavailable'
      ? t('raw.export.copy')
      : localizeCopyLabel(copyCapability.label, t)
    : t('raw.export.copy')
  const showUnavailableReason = !props.isProcessing && !props.canExport
  // The HQ preview can be refused on its own terms while full resolution is
  // fine (a committed Transform does exactly that), so a disabled HQ button
  // names its reason instead of going quietly dark. A reason the full-res
  // box above already states is not repeated.
  const previewUnavailableReason = localizeRawReason(
    props.previewExportDisabledReason,
    t,
  )
  const previewExportDisabled =
    !props.canPreviewExport || props.isProcessing || !props.onPreviewExport
  const showPreviewUnavailableReason =
    !props.isProcessing &&
    !props.canPreviewExport &&
    Boolean(previewUnavailableReason) &&
    !(showUnavailableReason && previewUnavailableReason === unavailableReason)
  const showRecovery =
    !props.isProcessing && props.recovery?.status === 'source-required'
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
              : t('raw.export.fileReady', {
                  filename: props.exportResult.filename,
                })}
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
        <ExportResultAction
          icon={Share2}
          label={t('raw.export.share')}
          disabled={!props.exportShareCapability.available}
          onClick={props.onShareExport}
        />
        <ExportResultAction
          icon={Download}
          label={t('raw.export.download')}
          onClick={props.onDownloadExport}
        />
        <ExportResultAction
          icon={Copy}
          label={t('raw.export.copy')}
          srLabel={copyButtonLabel}
          disabled={props.exportResult.copyCapability.mode === 'unavailable'}
          onClick={props.onCopyExport}
        />
        {props.exportResult.manifestState ? (
          <ExportResultAction
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
      {/* A blocked export is a state to explain, not a destructive act:
          neutral lift-soft well (DESIGN.md One Accent Rule keeps rose for
          destructive intent), icon plus text so it never reads by colour. */}
      {showUnavailableReason && (
        <div
          data-export-unavailable-reason
          className="grid grid-cols-[18px_1fr] gap-2 rounded-md bg-[oklch(0.96_0.006_255/0.05)] px-2.5 py-2"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 text-lf-on-photo-ink/72"
          />
          <span className="block text-[0.72rem] leading-snug text-lf-on-photo-ink/80">
            {unavailableReason}
          </span>
        </div>
      )}
      {showUnavailableReason && props.onChooseLutContract && (
        <m.button
          type="button"
          data-export-choose-lut-contract
          whileTap={{ y: 0.5 }}
          transition={TAP_SPRING}
          onClick={props.onChooseLutContract}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md bg-[oklch(0.96_0.006_255/0.06)] px-3 text-[0.8rem] font-semibold text-lf-on-photo-ink transition-colors hover:bg-[oklch(0.96_0.006_255/0.1)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-lf-green/80"
        >
          {t('raw.mobile.lut.chooseContract')}
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </m.button>
      )}
      {showRecovery && (
        <button
          type="button"
          disabled={!props.onRecoverExportSource}
          onClick={props.onRecoverExportSource}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 text-sm font-semibold text-lf-on-photo-ink transition-colors enabled:hover:bg-[oklch(0.96_0.006_255/0.08)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FolderOpen aria-hidden="true" className="size-4" />
          {t('raw.export.reselect')}
        </button>
      )}
      {props.recap && <ExportRecapLines recap={props.recap} />}
      {/* The deck gives this panel its natural height when it can. Where it
          cannot (a short screen, a long localized reason), the actions hold
          the deck's bottom edge on its own tone and the notes above scroll
          under them, so the primary action never falls below the fold. */}
      <div
        data-export-actions
        className="sticky bottom-0 z-[1] grid gap-2 bg-[oklch(0.085_0.006_255)]"
      >
        <m.button
          type="button"
          disabled={!props.canExport || props.isProcessing}
          whileTap={
            !props.canExport || props.isProcessing ? undefined : { y: 0.5 }
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
          disabled={previewExportDisabled}
          aria-describedby={
            showPreviewUnavailableReason ? previewReasonId : undefined
          }
          whileTap={previewExportDisabled ? undefined : { y: 0.5 }}
          transition={PANEL_TRANSITION}
          onClick={() => props.onPreviewExport?.()}
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 text-[0.8rem] font-semibold text-lf-on-photo-ink transition-colors enabled:hover:bg-[oklch(0.96_0.006_255/0.08)] disabled:cursor-not-allowed disabled:bg-lf-on-photo-bg/60 disabled:text-lf-on-photo-ink/35"
        >
          <Download aria-hidden="true" className="size-4 shrink-0" />
          {t('raw.export.runPreview')}
        </m.button>
        {showPreviewUnavailableReason && (
          <p
            id={previewReasonId}
            className="m-0 px-0.5 text-[0.72rem] leading-snug text-lf-on-photo-ink/72"
          >
            {previewUnavailableReason}
          </p>
        )}
      </div>
    </m.div>
  )

  return (
    <section
      aria-labelledby={titleId}
      data-mobile-export-panel
      className="grid gap-1.5"
    >
      <div className="-mt-2 flex min-h-11 items-center justify-between gap-2">
        <h2
          id={titleId}
          className="m-0 min-w-0 truncate pl-0.5 text-[0.88rem] font-semibold text-lf-on-photo-ink"
        >
          {title}
          {isExporting && percent !== null && (
            <span className="ml-1.5 font-medium text-lf-on-photo-ink/80 tabular-nums">
              {percent}%
            </span>
          )}
        </h2>
        {props.onClose && (
          <m.button
            type="button"
            aria-label={t('raw.mobile.export.close')}
            data-mobile-export-close
            whileTap={{ y: 0.5 }}
            transition={TAP_SPRING}
            onClick={props.onClose}
            className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-lf-on-photo-ink/72 transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-lf-green/80 active:bg-[oklch(0.96_0.006_255/0.1)]"
          >
            <X aria-hidden="true" className="size-[18px]" />
          </m.button>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {body}
      </AnimatePresence>
    </section>
  )
}
