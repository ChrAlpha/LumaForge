import type { LucideIcon } from 'lucide-react'
import { Scan, SlidersHorizontal, Wand2 } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'

import { clsxm } from '~/lib/cn'
import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import { DOCK_SPRING, TAP_SPRING } from '../../motion'
import { DECK_PADDING_Y_PX, isMobileListDeck } from './mobile-stage-layout'

/**
 * The dock holds tools only. Compare is a lens over the photo and Export is a
 * terminal action in the topbar; neither is a mutually exclusive mode.
 */
export type MobileMode = 'look' | 'tone' | 'transform'

const TABS: {
  id: MobileMode
  icon: LucideIcon
  labelKey: Parameters<Translate>[0]
}[] = [
  { id: 'look', icon: Wand2, labelKey: 'raw.mobile.mode.look' },
  { id: 'tone', icon: SlidersHorizontal, labelKey: 'raw.mobile.mode.adjust' },
  { id: 'transform', icon: Scan, labelKey: 'raw.mobile.mode.transform' },
]

/**
 * Whether the deck is on screen. Tools are disabled while the pipeline is
 * busy, but a running export keeps its panel visible.
 */
export function isMobileDeckVisible(input: {
  expanded: boolean
  disabled?: boolean
  panelVisibleWhileDisabled?: boolean
}) {
  return (
    input.expanded &&
    (input.disabled !== true || input.panelVisibleWhileDisabled === true)
  )
}

export function MobileModeDock(props: {
  mode: MobileMode
  expanded: boolean
  onModeChange: (mode: MobileMode) => void
  onCollapse: () => void
  onOpenMore?: () => void
  disabled?: boolean
  showTransform?: boolean
  /**
   * The export panel has borrowed the deck. No tool panel is on screen, so
   * no tab reads as selected and tapping any tool hands the deck back.
   */
  exportOpen?: boolean
  /**
   * Keep the deck visible while the dock is otherwise disabled. Export
   * progress lives in the deck, and a running export disables the tools.
   */
  panelVisibleWhileDisabled?: boolean
  scrubbing?: boolean
  panel: ReactNode
  /**
   * Deck height (px) from the stage layout. List tools fill it; Look and
   * the export panel are sized to their content through it. Unset, the deck
   * follows its content.
   */
  deckHeight?: number
  /** Height (px) of the tab bar, safe-area padding included. */
  onTabBarHeightChange?: (height: number) => void
  /**
   * Natural height (px) of the deck's content, deck padding included, for
   * the panels that size the deck (Look and export).
   */
  onDeckNaturalHeightChange?: (height: number) => void
}) {
  const { t } = useI18n()
  const disabled = props.disabled ?? false
  const prefersReduced = useReducedMotion() ?? false
  const exportOpen = props.exportOpen === true
  const panelVisible = isMobileDeckVisible({
    expanded: props.expanded,
    disabled,
    panelVisibleWhileDisabled: props.panelVisibleWhileDisabled,
  })
  const fillsDeck = isMobileListDeck(props.mode, exportOpen)
  const dockRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { onTabBarHeightChange, onDeckNaturalHeightChange } = props

  // The panel is absolutely positioned above the dock, so the dock's own box
  // is the tab bar alone.
  useLayoutEffect(() => {
    const dock = dockRef.current
    if (!dock || !onTabBarHeightChange) return
    const report = () => onTabBarHeightChange(dock.offsetHeight)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [onTabBarHeightChange])

  // Content that sizes the deck is never stretched, so its box is its
  // natural height whatever height the deck currently has.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || fillsDeck || !onDeckNaturalHeightChange) return
    const report = () =>
      onDeckNaturalHeightChange(content.offsetHeight + DECK_PADDING_Y_PX)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(content)
    return () => observer.disconnect()
  }, [fillsDeck, onDeckNaturalHeightChange, panelVisible, props.mode])

  return (
    <div
      ref={dockRef}
      data-mobile-dock
      // A solid deck-tone plate under the photo region, its top seam a
      // lift-soft inset hairline rather than a drawn border.
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 bg-[oklch(0.085_0.006_255)] pb-[max(8px,calc(env(safe-area-inset-bottom)-24px))] text-lf-on-photo-ink shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.05)]"
    >
      <AnimatePresence initial={false}>
        {panelVisible && (
          <m.div
            key="dock-panel"
            data-mobile-dock-panel
            data-deck-fill={fillsDeck || undefined}
            data-scrubbing={props.scrubbing || undefined}
            // The stage layout owns the deck height. It moves on the same
            // 240ms curve as the stage insets, so a portrait photo and the
            // deck trade space in one motion instead of overlapping.
            style={
              props.deckHeight === undefined
                ? undefined
                : { height: props.deckHeight }
            }
            className={clsxm(
              // Padding is DECK_PADDING_Y_PX top + bottom; keep them in step.
              'isolate absolute inset-x-0 bottom-full flex flex-col overflow-y-auto px-3.5 pb-2.5 pt-3.5',
              'transition-[height] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              // The surface is its own layer so a scrub can fade it to 10%
              // while the rows above it dim to 45%: the stage reads through
              // and the value under the thumb stays legible. A 1px cool top
              // highlight seats it under the photo.
              "before:absolute before:inset-0 before:-z-10 before:bg-[oklch(0.085_0.006_255)] before:shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.08)] before:transition-opacity before:duration-150 before:content-['']",
              props.scrubbing && 'before:opacity-10',
            )}
            initial={{ opacity: 0, y: prefersReduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: prefersReduced ? 0 : 8 }}
            transition={DOCK_SPRING}
          >
            {/* List tools fill the deck so their rows scroll inside it with
                the section chrome held still. Look and export sit at their
                natural height, anchored to the bottom near the thumb; taller
                content scrolls the deck. */}
            <div
              ref={contentRef}
              data-mobile-deck-content
              className={fillsDeck ? 'h-full min-h-0' : 'mt-auto shrink-0'}
            >
              {props.panel}
            </div>
          </m.div>
        )}
      </AnimatePresence>
      <div
        data-scrubbing={props.scrubbing || undefined}
        aria-label={t('raw.mobile.modes.aria')}
        role="tablist"
        className={clsxm(
          // 48px tabs + 4px above and below; the dock adds the safe area.
          'grid gap-1 px-2.5 py-1 transition-opacity duration-150',
          props.showTransform ? 'grid-cols-3' : 'grid-cols-2',
          props.scrubbing && 'opacity-45',
        )}
      >
        {TABS.filter(
          (tab) => tab.id !== 'transform' || props.showTransform,
        ).map((tab) => {
          const tabDisabled = disabled
          const active = props.mode === tab.id && !exportOpen
          // When the dock is collapsed, or the export panel holds the deck,
          // nothing is "active": the panel that an active tab represents is
          // not on screen, so the indicator would lie about the current state.
          const showActive = active && props.expanded && !tabDisabled
          return (
            <m.button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={showActive}
              aria-disabled={tabDisabled || undefined}
              disabled={tabDisabled}
              whileTap={tabDisabled ? undefined : { scale: 0.96 }}
              transition={TAP_SPRING}
              onClick={() => {
                if (tabDisabled) return
                if (active && props.expanded) {
                  props.onCollapse()
                  return
                }
                props.onModeChange(tab.id)
              }}
              className={clsxm(
                // Sentence case at 0.7rem: uppercase tracking made the labels
                // collide at 393px when the dock carried five modes.
                'relative grid min-h-12 grid-rows-[auto_auto] place-items-center gap-1 rounded-md px-1 py-1.5 text-[0.7rem] font-semibold leading-tight tracking-normal transition-colors',
                tabDisabled
                  ? 'cursor-not-allowed text-lf-on-photo-ink/35'
                  : showActive
                    ? 'text-lf-on-photo-ink'
                    : 'text-lf-on-photo-ink/68 hover:text-lf-on-photo-ink',
              )}
            >
              <tab.icon aria-hidden="true" className="size-[18px]" />
              {t(tab.labelKey)}
              {showActive && (
                <m.span
                  // Shared-layout indicator: motion glides the same element from
                  // tab to tab instead of hard-cutting. `-ml` centers without a
                  // transform so the layout animation owns `transform` cleanly.
                  layoutId={
                    prefersReduced ? undefined : 'mobile-dock-indicator'
                  }
                  transition={DOCK_SPRING}
                  // One hue for "this tab is selected". Selection is
                  // structural, so it is the cool lift white: green marks
                  // ready / committed and amber explains colour contracts.
                  className="absolute bottom-0 left-1/2 -ml-[11px] h-0.5 w-[22px] rounded-lf-pill bg-[oklch(0.96_0.006_255/0.85)]"
                />
              )}
            </m.button>
          )
        })}
      </div>
    </div>
  )
}
