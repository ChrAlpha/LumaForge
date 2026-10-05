import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { AnimatePresence, m } from 'motion/react'
import type { CSSProperties } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'

import type { ColorValue } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import type { ScrubFieldId } from './AdjustListPanel'
import { FloatingHistogramCard } from './FloatingHistogramCard'
import { ScrubValueHud } from './ScrubValueHud'

/**
 * The lens column the peek pill must keep clear of, on both sides so the
 * pill stays centred: 8px inset, the 32px circle, and an 8px gap.
 */
const PEEK_PILL_LENS_CLEARANCE_PX = 48
/** The pill's one-line width, with a little slack for the zh copy. */
const PEEK_PILL_MIN_ROW_WIDTH_PX = 200

export type PeekPillPlacement = 'row' | 'below'

/**
 * The peek pill shares the lens's row at the top centre of the photo while
 * the photo is wide enough to hold it clear of the lens; on a narrower photo
 * it drops just below the lens row. With no lens on screen the row is free.
 */
export function getPeekPillPlacement(
  photoWidth: number,
  lensVisible: boolean,
): PeekPillPlacement {
  if (!lensVisible || !(photoWidth > 0)) return 'row'
  return photoWidth - 2 * PEEK_PILL_LENS_CLEARANCE_PX >=
    PEEK_PILL_MIN_ROW_WIDTH_PX
    ? 'row'
    : 'below'
}

/**
 * The CPU preview notice reserves the lens column on its right (8px inset,
 * the 32px circle, an 8px gap); below this much room left of the lens it
 * would wrap past two lines, so it drops under the lens instead.
 */
const CPU_NOTICE_LENS_CLEARANCE_PX = 48
const CPU_NOTICE_MIN_SIDE_WIDTH_PX = 240

export type CpuNoticePlacement = 'full' | 'side' | 'below'

/**
 * The CPU preview notice sits on the photo, 8px inside its top edge, and
 * never covers the lens: beside it while the photo leaves room, below it on
 * a narrow photo, across the photo's width when no lens is on screen.
 */
export function getCpuNoticePlacement(
  photoWidth: number,
  lensVisible: boolean,
): CpuNoticePlacement {
  if (!lensVisible) return 'full'
  if (!(photoWidth > 0)) return 'side'
  return photoWidth - 8 - CPU_NOTICE_LENS_CLEARANCE_PX >=
    CPU_NOTICE_MIN_SIDE_WIDTH_PX
    ? 'side'
    : 'below'
}

// The photo rect never starts above the topbar's bottom edge (the empty
// state is full bleed, so its photo top is 0).
const CPU_NOTICE_TOP =
  'max(var(--raw-photo-top, 0px), var(--raw-topbar-height, 0px))'

/** Where the notice sits for each placement, in the photo-rect variables. */
export function getCpuNoticeStyle(
  placement: CpuNoticePlacement,
): CSSProperties {
  const lensRow = 'calc(var(--raw-compare-lens-size, 32px) + 8px)'
  return {
    top:
      placement === 'below'
        ? `calc(${CPU_NOTICE_TOP} + 8px + ${lensRow})`
        : `calc(${CPU_NOTICE_TOP} + 8px)`,
    left: 'calc(var(--raw-photo-left, 0px) + 8px)',
    right:
      placement === 'side'
        ? `calc(var(--raw-photo-right, 0px) + ${CPU_NOTICE_LENS_CLEARANCE_PX}px)`
        : 'calc(var(--raw-photo-right, 0px) + 8px)',
  }
}

export interface MobileFloatingOverlaysProps {
  immersive: boolean
  focusActive: boolean
  hasImage: boolean
  handoffActive: boolean
  peeking: boolean
  histogramOpen: boolean
  histogram: PreviewHistogramState
  scrubField: ScrubFieldId | null
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  manualTransform: ManualTransform | undefined
  /** How much of the applied LUT reaches the photo, 0..1. */
  lookIntensity?: number
  onExitImmersive: () => void
  /** Whether the compare lens is on screen beside the peek pill. */
  lensVisible?: boolean
  peekPlacement?: PeekPillPlacement
}

export function MobileFloatingOverlays({
  immersive,
  focusActive,
  hasImage,
  handoffActive,
  peeking,
  histogramOpen,
  histogram,
  scrubField,
  tone,
  color,
  selectiveColor,
  manualTransform,
  lookIntensity,
  onExitImmersive,
  lensVisible = false,
  peekPlacement = 'row',
}: MobileFloatingOverlaysProps) {
  const { t } = useI18n()
  const peekBelow = peekPlacement === 'below'

  return (
    <>
      <AnimatePresence>
        {immersive && !focusActive && hasImage && !handoffActive && (
          <m.button
            key="immersive-show"
            type="button"
            aria-label={t('raw.mobile.immersive.show')}
            onClick={onExitImmersive}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={surfaceFade}
            className="pointer-events-auto absolute bottom-safe-offset-4 left-1/2 z-[12] inline-flex min-h-[44px] -translate-x-1/2 items-center justify-center rounded-lf-pill border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-[0.7rem] font-semibold text-lf-on-photo-ink/82 backdrop-blur-background transition-colors hover:text-lf-on-photo-ink"
          >
            {t('raw.mobile.immersive.show')}
          </m.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {/* The pill names the state on screen, so unlike the chrome it
            stays in immersive (clear of the status bar there). A scrub and
            a handoff cannot peek. */}
        {peeking && hasImage && !handoffActive && !focusActive && (
          <m.div
            key="peek-hint"
            data-mobile-peek-hint={peekPlacement}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={surfaceFade}
            // Top centre of the photo rect, so the pill names what is on the
            // photo rather than floating in the stage around it. In the
            // lens's row it is a 32px pill like the lens circle, and its
            // width keeps it clear of the lens column on both sides.
            className={clsxm(
              'pointer-events-none absolute left-[calc(var(--raw-photo-left,0px)+var(--raw-photo-width,100vw)/2)] z-[12] inline-flex min-h-8 -translate-x-1/2 items-center justify-center rounded-lf-pill border border-lf-on-photo-bord bg-lf-on-photo-bg-strong px-2.5 py-1 text-center text-[0.7rem] font-semibold uppercase leading-snug tracking-wide text-lf-on-photo-ink',
              peekBelow
                ? 'top-[calc(var(--raw-compare-lens-top,8px)+var(--raw-compare-lens-size,32px)+8px)] w-max max-w-[calc(var(--raw-photo-width,100vw)-16px)]'
                : clsxm(
                    'top-[max(calc(var(--raw-photo-top,var(--raw-stage-inset-top,0px))+8px),calc(env(safe-area-inset-top)+8px))] w-max',
                    lensVisible
                      ? 'max-w-[calc(var(--raw-photo-width,100vw)-96px)]'
                      : 'max-w-[calc(var(--raw-photo-width,100vw)-16px)]',
                  ),
            )}
          >
            {t('raw.mobile.peek.hint')}
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {histogramOpen &&
          !focusActive &&
          !immersive &&
          hasImage &&
          !handoffActive && (
            <FloatingHistogramCard
              key="histogram"
              histogram={histogram}
              hidden={peeking}
            />
          )}
      </AnimatePresence>

      <ScrubValueHud
        field={scrubField}
        tone={tone}
        color={color}
        selectiveColor={selectiveColor}
        manualTransform={manualTransform}
        lookIntensity={lookIntensity}
      />
    </>
  )
}
