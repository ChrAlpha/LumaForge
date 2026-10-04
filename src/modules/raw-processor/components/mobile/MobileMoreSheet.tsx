import { X } from 'lucide-react'
import { AnimatePresence, m, useDragControls } from 'motion/react'

import { IconButton } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

import { SHEET_SPRING, useToolMotion } from '../../motion'
import type {
  MobileDetailsRow as Row,
  MobileDetailsStep as Step,
} from './mobile-details-sheet'

// Facts sit in a borderless lift-soft well (DESIGN.md §6 "Borderless Track
// Rule"): the 5% cool-white fill carries the edge instead of a drawn hairline,
// which reads consistently on the flat sheet.
function FactRows({ rows }: { rows: Row[] }) {
  return (
    <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lf-control bg-[oklch(0.96_0.006_255/0.05)] px-3 py-2.5">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="m-0 truncate text-[0.72rem] tracking-tight text-lf-on-photo-ink/62">
            {r.label}
          </dt>
          <dd className="m-0 min-w-0 text-[0.78rem] font-medium tabular-nums text-lf-on-photo-ink/80 [overflow-wrap:anywhere]">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// The pipeline is the Contract Rail signature (DESIGN.md §5): ordered, numbered
// color-math steps with a connecting spine. Amber numbers per "Amber Explains
// Color"; the spine links the steps so they read as one sequence, not a list.
// Each step names its live state (camera and support, changed fields, LUT
// contract, transform, output) rather than a timing it cannot measure.
function PipelineRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="m-0 grid list-none gap-0 rounded-lf-control bg-[oklch(0.96_0.006_255/0.05)] px-3 py-1">
      {steps.map((step, i) => (
        <li
          key={step.index}
          className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2.5 py-2"
        >
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute left-[0.59rem] top-[1.85rem] h-[calc(100%-1.1rem)] w-px bg-lf-on-photo-bord-soft"
            />
          )}
          <span className="z-[1] grid size-5 place-items-center rounded-full bg-lf-amber/15 text-[0.62rem] font-semibold tabular-nums text-lf-amber">
            {step.index}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="text-[0.82rem] leading-5 text-lf-on-photo-ink">
              {step.label}
            </span>
            <span className="text-[0.72rem] leading-snug tabular-nums text-lf-on-photo-ink/72 [overflow-wrap:anywhere]">
              {step.detail}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

export function MobileMoreSheet(props: {
  open: boolean
  onClose: () => void
  pipelineSteps: Step[]
  lutRows: Row[]
  fileRows: Row[]
}) {
  const { t } = useI18n()
  const { prefersReduced } = useToolMotion()
  const dragControls = useDragControls()

  return (
    <AnimatePresence>
      {props.open && (
        <m.aside
          key="more-sheet"
          role="dialog"
          aria-modal="false"
          aria-label={t('raw.mobile.more.title')}
          data-mobile-substrate="ink-sheet"
          className="pointer-events-auto absolute inset-x-0 bottom-0 z-[46] grid max-h-[78%] grid-rows-[auto_minmax(0,1fr)] rounded-t-xl border-t border-lf-on-photo-bord-soft bg-[oklch(0.12_0.006_255/0.97)] pb-safe-offset-3 text-lf-on-photo-ink shadow-[0_-14px_36px_-6px_oklch(0.02_0.006_255/0.6)] backdrop-blur-background"
          initial={prefersReduced ? { opacity: 0 } : { y: '100%' }}
          animate={prefersReduced ? { opacity: 1 } : { y: '0%' }}
          exit={prefersReduced ? { opacity: 0 } : { y: '100%' }}
          transition={SHEET_SPRING}
          drag={prefersReduced ? false : 'y'}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.4 }}
          onDragEnd={(_, info) => {
            if (info.offset.y > 80 || info.velocity.y > 500) props.onClose()
          }}
        >
          <div
            className="grid gap-2 px-3.5 pb-3 pt-2.5"
            onPointerDown={(e) => dragControls.start(e)}
          >
            <div
              aria-hidden="true"
              className="mx-auto h-1 w-9 rounded-lf-pill bg-lf-on-photo-ink/25"
            />
            <div className="flex items-center justify-between gap-2.5">
              <h2 className="m-0 text-[0.95rem] font-semibold text-lf-on-photo-ink">
                {t('raw.mobile.more.title')}
              </h2>
              <IconButton
                icon={X}
                size="md"
                aria-label={t('raw.mobile.more.close')}
                onClick={props.onClose}
                className="size-[44px] rounded-md bg-transparent text-lf-on-photo-ink/55 transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink [&_svg]:size-5 [&_svg]:stroke-current"
              />
            </div>
          </div>
          <div className="grid min-h-0 gap-4 overflow-y-auto px-4 pb-5 pt-1">
            <section className="grid gap-2">
              <h3 className="m-0 text-[0.66rem] font-semibold uppercase tracking-wide text-lf-on-photo-ink/55">
                {t('raw.mobile.more.pipelineHeading')}
              </h3>
              <PipelineRail steps={props.pipelineSteps} />
            </section>
            <section className="grid gap-2">
              <h3 className="m-0 text-[0.66rem] font-semibold uppercase tracking-wide text-lf-on-photo-ink/55">
                {t('raw.mobile.more.lutHeading')}
              </h3>
              <FactRows rows={props.lutRows} />
            </section>
            <section className="grid gap-2">
              <h3 className="m-0 text-[0.66rem] font-semibold uppercase tracking-wide text-lf-on-photo-ink/55">
                {t('raw.mobile.more.fileHeading')}
              </h3>
              <FactRows rows={props.fileRows} />
            </section>
          </div>
        </m.aside>
      )}
    </AnimatePresence>
  )
}
