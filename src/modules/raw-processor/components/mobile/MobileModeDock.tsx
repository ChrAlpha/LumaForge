import type { LucideIcon } from 'lucide-react'
import {
  Download,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Wand2,
} from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import { DOCK_SPRING, TAP_SPRING } from '../../motion'

export type MobileMode = 'look' | 'tone' | 'compare' | 'export'

const TABS: {
  id: MobileMode
  icon: LucideIcon
  labelKey: Parameters<Translate>[0]
  primary?: boolean
}[] = [
  { id: 'look', icon: Wand2, labelKey: 'raw.mobile.mode.look' },
  { id: 'tone', icon: SlidersHorizontal, labelKey: 'raw.mobile.mode.adjust' },
  {
    id: 'compare',
    icon: SplitSquareHorizontal,
    labelKey: 'raw.mobile.mode.compare',
  },
  {
    id: 'export',
    icon: Download,
    labelKey: 'raw.mobile.mode.export',
    primary: true,
  },
]

export function MobileModeDock(props: {
  mode: MobileMode
  expanded: boolean
  onModeChange: (mode: MobileMode) => void
  onCollapse: () => void
  onOpenMore?: () => void
  canExport: boolean
  disabled?: boolean
  scrubbing?: boolean
  panel: ReactNode
  /**
   * Height (px) the dock occupies from the bottom of the viewport: the tab
   * bar plus the expanded panel. The mobile chrome forwards it to the stage
   * so the photo re-fits above the dock instead of under it.
   */
  onInsetChange?: (inset: number) => void
}) {
  const { t } = useI18n()
  const disabled = props.disabled ?? false
  const prefersReduced = useReducedMotion() ?? false
  const panelVisible = props.expanded && !disabled
  const dockRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(0)
  const [panelHeight, setPanelHeight] = useState(0)
  const { onInsetChange } = props

  useLayoutEffect(() => {
    const dock = dockRef.current
    if (!dock || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setDockHeight(dock.offsetHeight)
      setPanelHeight(panelRef.current?.offsetHeight ?? 0)
    })
    observer.observe(dock)
    const panel = panelRef.current
    if (panel) observer.observe(panel)
    setDockHeight(dock.offsetHeight)
    setPanelHeight(panel?.offsetHeight ?? 0)
    return () => observer.disconnect()
    // Re-subscribe whenever the panel mounts or changes mode so the observer
    // tracks the live panel element.
  }, [panelVisible, props.mode])

  useLayoutEffect(() => {
    onInsetChange?.(dockHeight + (panelVisible ? panelHeight : 0))
  }, [dockHeight, onInsetChange, panelHeight, panelVisible])

  return (
    <div
      ref={dockRef}
      data-mobile-dock
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-[oklch(0.064_0.006_255/0.92)] via-[oklch(0.085_0.006_255/0.68)] to-transparent pb-[max(8px,calc(env(safe-area-inset-bottom)-24px))] text-lf-on-photo-ink"
    >
      <AnimatePresence initial={false}>
        {panelVisible && (
          <m.div
            key="dock-panel"
            ref={panelRef}
            data-mobile-dock-panel
            data-scrubbing={props.scrubbing || undefined}
            className={clsxm(
              'isolate absolute inset-x-0 bottom-full overflow-y-auto px-3.5 pb-2.5 pt-3.5',
              "before:absolute before:inset-0 before:-z-10 before:bg-gradient-to-t before:from-[oklch(0.085_0.006_255/0.82)] before:via-[oklch(0.118_0.006_255/0.56)] before:to-transparent before:transition-opacity before:duration-150 before:content-['']",
              props.scrubbing && 'before:opacity-10',
              // Tone mode locks to a fixed height so AdjustListPanel can
              // resolve `h-full` and manage its own internal scroll (chrome
              // outside the scroll, slider list inside). The height leaves a
              // 3:2 landscape photo at full width above the dock on a
              // 393x660 viewport; Tone and HSL lists scroll inside.
              // Other modes still use max-h since their content sizes
              // itself naturally.
              props.mode === 'tone'
                ? 'h-[min(38vh,264px)]'
                : props.mode === 'export'
                  ? 'max-h-[min(32vh,260px)]'
                  : 'max-h-[24vh]',
              props.mode === 'export' && 'pb-4',
            )}
            initial={{ opacity: 0, y: prefersReduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: prefersReduced ? 0 : 8 }}
            transition={DOCK_SPRING}
          >
            {props.panel}
          </m.div>
        )}
      </AnimatePresence>
      <div
        data-scrubbing={props.scrubbing || undefined}
        aria-label={t('raw.mobile.modes.aria')}
        role="tablist"
        className={clsxm(
          'grid grid-cols-4 gap-1 border-t border-lf-on-photo-bord-soft px-2.5 pb-2 pt-2 transition-opacity duration-150',
          props.scrubbing && 'opacity-45',
        )}
      >
        {TABS.map((tab) => {
          const active = props.mode === tab.id
          // When the dock is collapsed nothing is "active" — the panel that
          // an active tab represents isn't on screen, so showing the
          // indicator/highlight reads as a lie about the current state.
          const showActive = active && props.expanded && !disabled
          return (
            <m.button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={showActive}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              whileTap={disabled ? undefined : { scale: 0.96 }}
              transition={TAP_SPRING}
              onClick={() => {
                if (disabled) return
                if (props.mode === tab.id && props.expanded) {
                  props.onCollapse()
                  return
                }
                props.onModeChange(tab.id)
              }}
              className={clsxm(
                'relative grid min-h-[52px] grid-rows-[auto_auto] place-items-center gap-1 rounded-md px-1 py-1.5 text-[0.64rem] font-semibold uppercase tracking-wide transition-colors',
                disabled
                  ? 'cursor-not-allowed text-lf-on-photo-ink/35'
                  : showActive
                    ? 'text-lf-on-photo-ink'
                    : 'text-lf-on-photo-ink/68 hover:text-lf-on-photo-ink',
              )}
            >
              <span className="relative inline-flex">
                <tab.icon aria-hidden="true" className="size-[18px]" />
                {/* Export readiness is a fact about the pipeline, so it lives
                    on the action it gates rather than on the selection mark. */}
                {tab.primary && props.canExport && !disabled && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1 -top-0.5 size-1.5 rounded-lf-pill bg-lf-green shadow-[0_0_0_2px_oklch(0.59_0.15_153/0.26)]"
                  />
                )}
              </span>
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
                  // One hue for "this tab is selected". Green on the Export
                  // tab read as "export is safe" while export was blocked,
                  // and the shared indicator changed hue mid-slide.
                  className="absolute bottom-0 left-1/2 -ml-[11px] h-0.5 w-[22px] rounded-lf-pill bg-lf-amber"
                />
              )}
            </m.button>
          )
        })}
      </div>
    </div>
  )
}
