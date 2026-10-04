import { Check, Download } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

export type MobileExportActionState = 'idle' | 'ready' | 'exporting' | 'done'

/**
 * One state for the topbar export action, derived from workflow facts. A
 * running export outranks a previous result, and readiness needs the
 * pipeline idle, so a blocked or busy session never reads as Lab Green.
 */
export function getMobileExportActionState(input: {
  canExport: boolean
  isProcessing: boolean
  isExporting: boolean
  hasResult: boolean
}): MobileExportActionState {
  if (input.isExporting) return 'exporting'
  if (input.hasResult) return 'done'
  if (input.canExport && !input.isProcessing) return 'ready'
  return 'idle'
}

// Width and label changes settle inside the product 150-250ms band with the
// standard LumaForge ease-out; no spring, so the pill never overshoots.
const PILL_EASE = [0.22, 1, 0.36, 1] as const
const PILL_TRANSITION = { duration: 0.18, ease: PILL_EASE }

function clampPercent(progress: number | undefined) {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return 0
  return Math.round(Math.min(100, Math.max(0, progress)))
}

function PillSpinner({ reduced }: { reduced: boolean }) {
  // Reduced motion keeps the ring as a static busy mark instead of a spin.
  return (
    <m.span
      aria-hidden="true"
      data-export-action-spinner
      className="size-3 shrink-0 rounded-full border-[1.5px] border-current/30 border-t-current"
      animate={reduced ? undefined : { rotate: 360 }}
      transition={
        reduced
          ? undefined
          : { duration: 0.8, ease: 'linear', repeat: Infinity }
      }
    />
  )
}

/**
 * Terminal action at the far right of the mobile topbar. Export is not a
 * tool, so it opens the export panel in the deck rather than taking a dock
 * tab. It stays tappable while blocked or running: the panel says why export
 * is blocked, or shows the running export.
 */
export function MobileExportAction(props: {
  state: MobileExportActionState
  /** Export progress, 0-100. Read only while exporting. */
  progress?: number
  /** The export panel is on screen. */
  expanded: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const { t } = useI18n()
  const reduced = useReducedMotion() ?? false
  const { state, expanded } = props
  const percent = clampPercent(props.progress)

  const accessibleName =
    state === 'ready'
      ? t('raw.mobile.export.actionReady')
      : state === 'exporting'
        ? t('raw.mobile.export.actionExporting', { percent })
        : state === 'done'
          ? t('raw.mobile.export.actionDone')
          : t('raw.mobile.export.actionIdle')

  const face =
    state === 'exporting' ? (
      <>
        <PillSpinner reduced={reduced} />
        <span className="tabular-nums">{percent}%</span>
      </>
    ) : state === 'done' ? (
      <>
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
        {t('raw.mobile.export.done')}
      </>
    ) : (
      <>
        <Download aria-hidden="true" className="size-3.5 shrink-0" />
        {t('raw.export.title')}
      </>
    )

  return (
    <button
      type="button"
      data-mobile-export-action
      data-state={state}
      aria-label={accessibleName}
      aria-expanded={expanded}
      disabled={props.disabled}
      onClick={props.onClick}
      // 44px hit area around a ~32px pill. The press is the shared 0.5px
      // `translate` shift (DESIGN.md Press Feedback), never a transform.
      className="group -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center px-1 outline-none transition-[translate] duration-[120ms] ease-[cubic-bezier(0.22,1,0.36,1)] enabled:active:translate-y-[0.5px] disabled:cursor-not-allowed"
    >
      <m.span
        layout={!reduced}
        transition={PILL_TRANSITION}
        // Motion corrects radius under its layout scale only when it owns it.
        style={{ borderRadius: 999 }}
        className={clsxm(
          'inline-flex h-8 items-center gap-1.5 overflow-hidden px-3 text-[0.78rem] font-semibold leading-none whitespace-nowrap',
          'transition-[background-color,color,box-shadow,opacity] duration-[180ms] ease-out',
          'group-focus-visible:outline-2 group-focus-visible:-outline-offset-1 group-focus-visible:outline-lf-green/80',
          'group-disabled:opacity-45',
          state === 'ready'
            ? // Dark slate on Lab Green: ~4.9:1, AA for this label size.
              'bg-lf-green text-lf-surface group-enabled:group-hover:bg-lf-green-hover'
            : state === 'done'
              ? // Ink on Deep Lab Green: ~9:1.
                'bg-lf-green-deep text-lf-on-photo-ink group-enabled:group-hover:bg-[oklch(from_var(--color-lf-green-deep)_calc(l+0.04)_c_h)]'
              : clsxm(
                  'text-lf-on-photo-ink/80 group-enabled:group-hover:text-lf-on-photo-ink',
                  expanded
                    ? 'bg-[oklch(0.96_0.006_255/0.14)]'
                    : 'bg-[oklch(0.96_0.006_255/0.1)] group-enabled:group-hover:bg-[oklch(0.96_0.006_255/0.14)]',
                ),
          // Open: the pill reads as lifted with a cool inset rim, whatever
          // its state colour.
          expanded &&
            'shadow-[inset_0_0_0_1px_oklch(0.96_0.006_255/0.32),0_0_0_3px_oklch(0.96_0.006_255/0.08)]',
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <m.span
            key={state}
            // A layout child is scale-corrected while the pill resizes, so
            // the label never stretches mid-transition.
            layout={reduced ? false : 'position'}
            className="inline-flex items-center gap-1.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={PILL_TRANSITION}
          >
            {face}
          </m.span>
        </AnimatePresence>
      </m.span>
    </button>
  )
}
