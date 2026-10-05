/**
 * Shared segmented-control language for /raw chrome.
 *
 * The desktop LUT contract tabs (input/output) and the Adjust axis and
 * Transform tab groups render segmented controls on the photo-first dark
 * chrome. Before this contract they had three different
 * paints — paper-warm, on-photo depressed, and a glassy variant — which
 * drifted in readability and cross-platform consistency.
 *
 * The contract here is paint-only. Sizing is per-context (touch needs
 * h-11, mouse density goes h-9 / h-7) and the active-thumb animation
 * (motion `layoutId` plus a `data-segment-thumb` span) stays with each
 * consumer because the animation identity is tied to the surrounding
 * sheet, not to this style sheet.
 *
 * Active visibility uses the Linear pattern: a brighter wash on a dim
 * track plus a font-semibold label, NOT a depressed darker plate with a
 * glassy multi-shadow stack. A single inset top highlight matches the
 * seam idiom used by the topbar, tool rail, and tool cards.
 */

// Track: a 5% cool-white wash on the chrome surface defines the track's
// edge without a drawn border. The earlier border + dim bg-on-photo-bg
// fill was doing all the boundary work; on the mobile LUT sheet (flat
// substrate) the 1px hairline read as the dominant edge of the control,
// while on the desktop tool card (gradient + inset shadow) the same
// hairline became the third structural line in the same field and
// competed with the chrome's existing seams. Per §6 Inset Hairline
// Rule: chrome seams are inset washes, not drawn borders. Pair with a
// h-* and p-* per consumer density.
export const SEGMENTED_TRACK = 'rounded-md bg-[oklch(0.96_0.006_255/0.05)] p-1'

// Inactive item: text reads at /72 (AA on the dark chrome) and brightens
// to /92 on pointer hover so the segment under the cursor previews a lift
// before commit.
export const SEGMENTED_ITEM_TEXT =
  'font-medium text-lf-on-photo-ink/72 transition-colors duration-150 hover:text-lf-on-photo-ink/92'

// Active item: full hero-ink + font-semibold weight contrast so the active
// label wins even when the bg delta is subtle. The primitive intentionally
// does NOT set an active text color; consumers MUST supply this.
export const SEGMENTED_ITEM_TEXT_ACTIVE =
  'data-[state=active]:font-semibold data-[state=active]:text-lf-on-photo-ink'

// Active thumb: 10% cool-white wash + 1px inset top highlight. The wash
// hue intentionally matches the rest of the chrome's seam idiom
// (oklch(0.96 0.006 255 / *)) instead of pulling from --color-lf-on-photo-ink
// (which is warm) — the chrome's topbar, tool rail, tool cards, and
// export footer all use this cool near-white at varying opacities, so
// the thumb reads as one of the chrome's lifts and not as a foreign
// warm element.
//
// Apply to the SegmentItem className; it targets the `data-segment-thumb`
// span the primitive renders for the layoutId animation. Hand-rolled
// segmented controls (mobile + desktop LUT contract tabs) inline the same
// classes on their motion thumb span.
export const SEGMENTED_THUMB_BG =
  'bg-[oklch(0.96_0.006_255/0.10)] shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.14)]'

export const SEGMENTED_THUMB_ACTIVE_VIA_PARENT = `data-[state=active]:[&_span[data-segment-thumb]]:bg-[oklch(0.96_0.006_255/0.10)] data-[state=active]:[&_span[data-segment-thumb]]:shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.14)]`

export const SEGMENTED_FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80'
