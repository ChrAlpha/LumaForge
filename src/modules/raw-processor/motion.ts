import type { Variants } from 'motion/react'
import { useReducedMotion } from 'motion/react'
import { useMemo } from 'react'

import { Spring } from '~/lib/spring'

// The handoff spec slides sheets in over --mrl-dur-sheet (320ms) with the
// smooth --mrl-ease and no overshoot. A bouncy spring read as off-substrate,
// so this is a no-bounce ~320ms spring instead of the snappy preset.
export const TAP_SPRING = Spring.snappy(0.25)

// Mode-dock panel reveal/collapse, the active-tab indicator slide, and the
// immersive chrome recede. Lighter than `sheetSpring` (reserved for full
// bottom sheets) so frequent dock + chrome transitions settle inside the
// product-register 200-260ms band instead of reading as a heavy sheet.
export const DOCK_SPRING = Spring.smooth(0.24)

// Lead time the dock-panel collapse gets before the chrome recedes into
// immersive (and the reverse on exit). A partial lead inside the DOCK_SPRING
// (~240ms) band so it reads as one "collapse, then recede" sequence rather than
// two separate animations. Bypassed under reduced motion (instant flip).
export const IMMERSIVE_STAGGER_MS = 140

export function useToolMotion() {
  const prefersReduced = useReducedMotion() ?? false

  const variants = useMemo(
    () => ({
      container: {
        hidden: {},
        visible: {
          transition: { staggerChildren: prefersReduced ? 0 : 0.045 },
        },
      } satisfies Variants,
      item: {
        hidden: { opacity: 0, ...(prefersReduced ? {} : { y: 12 }) },
        visible: {
          opacity: 1,
          y: 0,
          transition: Spring.presets.snappy,
        },
      } satisfies Variants,
    }),
    [prefersReduced],
  )

  return { prefersReduced, ...variants }
}
