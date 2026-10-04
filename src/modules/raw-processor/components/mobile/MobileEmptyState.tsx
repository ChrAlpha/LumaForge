import { FolderOpen } from 'lucide-react'
import { m } from 'motion/react'

import { clsxm } from '~/lib/cn'
import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'
import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'
import { surfaceFade } from '~/lib/spring'

import type { RawRuntimeReadinessState } from '../raw-runtime-readiness'
import { getRawRuntimeReadinessCopy } from '../raw-runtime-readiness'

/**
 * Formats the empty state names outright. The rest are counted from the
 * decoder's real support set, so the line never claims a format the lab
 * cannot open and never goes stale when the set changes.
 */
const HEADLINE_FORMATS = ['arw', 'nef', 'cr3', 'raf', 'dng', 'orf'] as const

export function getMobileEmptyFormats() {
  const named = HEADLINE_FORMATS.filter((format) =>
    SUPPORTED_RAW_EXTENSIONS.has(format),
  )
  return {
    named: named.map((format) => format.toUpperCase()),
    more: SUPPORTED_RAW_EXTENSIONS.size - named.length,
    total: SUPPORTED_RAW_EXTENSIONS.size,
  }
}

const STEPS: Array<{
  title: Parameters<Translate>[0]
  hint: Parameters<Translate>[0]
}> = [
  {
    title: 'raw.mobile.empty.step1.title',
    hint: 'raw.mobile.empty.step1.hint',
  },
  {
    title: 'raw.mobile.empty.step2.title',
    hint: 'raw.mobile.empty.step2.hint',
  },
  {
    title: 'raw.mobile.empty.step3.title',
    hint: 'raw.mobile.empty.step3.hint',
  },
]

export interface MobileEmptyStateProps {
  runtimeReadinessState?: RawRuntimeReadinessState
  onPrepareRuntime?: () => void
  onReplaceFile: () => void
}

/**
 * The first screen on a phone: what the lab does, in the order it does it,
 * and one action in the thumb zone. Copy reads top-down from the topbar; the
 * primary action is pinned to the bottom edge, where the dock sits once a
 * RAW is open.
 */
export function MobileEmptyState({
  runtimeReadinessState,
  onPrepareRuntime,
  onReplaceFile,
}: MobileEmptyStateProps) {
  const { t } = useI18n()
  const runtimeReadiness = runtimeReadinessState
    ? getRawRuntimeReadinessCopy(t, runtimeReadinessState)
    : null
  const formats = getMobileEmptyFormats()
  const browseDisabled =
    runtimeReadinessState !== 'ready' && runtimeReadinessState !== undefined

  return (
    <m.div
      key="mobile-empty"
      data-mobile-empty-state
      // Solid stage base: the topbar plate continues into the page with no
      // seam, and nothing glows behind the copy.
      className="pointer-events-auto absolute inset-0 z-[11] grid grid-rows-[minmax(0,1fr)_auto] bg-[oklch(0.064_0.006_255)] text-lf-on-photo-ink"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={surfaceFade}
    >
      <div
        data-mobile-empty-copy
        // Starts 24px below the measured topbar. Only scrolls if a very
        // short viewport cannot hold the copy above the action.
        className="min-h-0 overflow-y-auto px-4 pb-4 pt-[calc(var(--raw-topbar-height,56px)+24px)]"
      >
        <p className="m-0 text-[0.68rem] font-semibold uppercase leading-none tracking-[0.12em] text-lf-on-photo-ink/55">
          {t('raw.mobile.empty.eyebrow')}
        </p>
        <h1 className="m-0 mt-2.5 text-balance text-[1.45rem] font-[760] leading-[1.12] tracking-tight">
          {t('raw.mobile.empty.headline')}
        </h1>

        <ol
          data-mobile-empty-steps
          className="m-0 mt-6 grid list-none gap-3.5 p-0"
        >
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-3"
            >
              {/* The list carries the order for assistive tech; the
                  number is the visual cue. */}
              <span
                aria-hidden="true"
                className="mt-px grid size-[18px] place-items-center rounded-full bg-lf-amber/15 text-[0.66rem] font-bold leading-none text-lf-amber tabular-nums"
              >
                {index + 1}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <strong className="text-[0.86rem] font-semibold leading-snug">
                  {t(step.title)}
                </strong>
                <span className="text-[0.72rem] leading-snug text-lf-on-photo-ink/62">
                  {t(step.hint)}
                </span>
              </span>
            </li>
          ))}
        </ol>

        {runtimeReadiness && (
          <div
            aria-live="polite"
            data-raw-runtime-readiness
            data-state={runtimeReadinessState}
            // Reserves three lines so a state change never shifts the
            // formats line below it.
            className="mt-6 grid min-h-[2.875rem] grid-cols-[7px_minmax(0,1fr)] content-start items-center gap-x-2 gap-y-0.5"
          >
            {/* Green only once the engine is ready; the label names every
                state, so the dot is never the only signal. */}
            <span
              aria-hidden="true"
              data-mobile-empty-readiness-dot
              className={clsxm(
                'size-[7px] rounded-full',
                runtimeReadinessState === 'ready'
                  ? 'bg-lf-green'
                  : 'bg-lf-on-photo-ink/40',
                runtimeReadinessState === 'pending' &&
                  'motion-safe:animate-pulse',
              )}
            />
            <strong className="text-[0.74rem] font-semibold leading-snug">
              {runtimeReadiness.label}
            </strong>
            <span className="col-start-2 text-[0.68rem] leading-snug text-lf-on-photo-ink/62">
              {runtimeReadiness.detail}
            </span>
          </div>
        )}

        <p
          data-mobile-empty-formats
          className="m-0 mt-3 text-[0.68rem] font-semibold leading-snug text-lf-on-photo-ink/52"
        >
          {t('raw.mobile.empty.formats', {
            formats: formats.named.join(' · '),
            more: formats.more,
            total: formats.total,
          })}
        </p>
      </div>

      <div className="px-3 pb-safe-offset-4 pt-2">
        <button
          type="button"
          data-mobile-empty-cta
          disabled={browseDisabled}
          onClick={() => {
            onPrepareRuntime?.()
            onReplaceFile()
          }}
          onPointerEnter={onPrepareRuntime}
          onFocus={onPrepareRuntime}
          className={clsxm(
            'inline-flex h-12 w-full items-center justify-center gap-2 rounded-md text-[0.9rem] font-semibold',
            'transition-[background-color,color,translate] duration-[120ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
            'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
            // Dark slate on Lab Green while the engine is ready (~4.9:1);
            // a cool lift, not green, while it is not.
            'enabled:bg-lf-green enabled:text-lf-surface enabled:hover:bg-lf-green-hover enabled:active:translate-y-[0.5px]',
            'disabled:cursor-not-allowed disabled:bg-[oklch(0.96_0.006_255/0.08)] disabled:text-lf-on-photo-ink/45',
          )}
        >
          <FolderOpen aria-hidden="true" className="size-[18px]" />
          {t('raw.mobile.empty.browse')}
        </button>
      </div>
    </m.div>
  )
}
