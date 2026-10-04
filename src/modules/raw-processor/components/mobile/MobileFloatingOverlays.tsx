import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { AnimatePresence, m } from 'motion/react'

import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'

import type { ColorValue } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import type { ScrubFieldId } from './AdjustListPanel'
import { FloatingHistogramCard } from './FloatingHistogramCard'
import { ScrubValueHud } from './ScrubValueHud'

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
  onExitImmersive: () => void
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
  onExitImmersive,
}: MobileFloatingOverlaysProps) {
  const { t } = useI18n()

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
        {peeking && hasImage && !handoffActive && (
          <m.div
            key="peek-hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={surfaceFade}
            // Top centre of the photo rect, so the pill names what is on the
            // photo rather than floating in the stage around it.
            className="pointer-events-none absolute left-[calc(var(--raw-photo-left,0px)+var(--raw-photo-width,100vw)/2)] top-[calc(var(--raw-photo-top,var(--raw-stage-inset-top,0px))+8px)] z-[12] -translate-x-1/2 rounded-lf-pill border border-lf-on-photo-bord bg-lf-on-photo-bg-strong px-2.5 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-lf-on-photo-ink"
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
      />
    </>
  )
}
