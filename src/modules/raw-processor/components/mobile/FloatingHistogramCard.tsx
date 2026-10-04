import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { m, useReducedMotion } from 'motion/react'

import { clsxm } from '~/lib/cn'
import { surfaceFade } from '~/lib/spring'

import { HistogramTool } from '../tools/HistogramTool'

export function FloatingHistogramCard(props: {
  histogram: PreviewHistogramState
  hidden: boolean
}) {
  const prefersReduced = useReducedMotion() ?? false
  const lift = prefersReduced ? 0 : -6
  return (
    <m.div
      aria-hidden={props.hidden || undefined}
      // Motion owns opacity for both the enter/exit (AnimatePresence at the call
      // site) and the peek-hide, so the card never hard-cuts onto the photo.
      initial={{ opacity: 0, y: lift, scale: prefersReduced ? 1 : 0.98 }}
      animate={{ opacity: props.hidden ? 0 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: lift, scale: prefersReduced ? 1 : 0.98 }}
      transition={surfaceFade}
      className={clsxm(
        // A wide histogram strip that reads like the desktop tool-panel
        // histogram instead of a near-square box: the plot spans a landscape
        // surface, and the redundant RGB legend is dropped (channels are
        // already color-coded in the plot). Cool-slate glass so the photo tints
        // it through the backdrop blur (DESIGN.md §6). It hangs below the
        // compare lens and shares its right edge, reading the lens position
        // variables so the two never overlap.
        'pointer-events-none absolute right-[var(--raw-compare-lens-right,12px)] top-[calc(var(--raw-compare-lens-top,5rem)+var(--raw-compare-lens-size,32px)+8px)] z-[15] w-[min(72vw,256px)] rounded-lf-panel border border-lf-on-photo-bord-soft bg-[oklch(0.105_0.006_255/0.86)] px-3 py-2.5 text-lf-on-photo-ink backdrop-blur-background',
        'shadow-[0_10px_30px_oklch(0.02_0.006_255/0.5),inset_0_1px_0_oklch(0.96_0.006_255/0.08)]',
      )}
    >
      <HistogramTool histogram={props.histogram} heading />
    </m.div>
  )
}
