import type { LucideIcon } from 'lucide-react'
import { MoreHorizontal } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { IconButton } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import { surfaceFade } from '~/lib/spring'

export type MobileMoreMenuItem =
  | {
      kind: 'item'
      icon: LucideIcon | (() => null)
      label: string
      /** Trailing secondary text, e.g. the current language on a Language item. */
      detail?: string
      onSelect: () => void
      disabled?: boolean
    }
  | { kind: 'separator' }

export function MobileMoreMenu(props: {
  ariaLabel: string
  items: MobileMoreMenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const prefersReduced = useReducedMotion() ?? false

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <IconButton
        icon={MoreHorizontal}
        size="md"
        aria-label={props.ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={clsxm(
          'size-11 rounded-md text-lf-on-photo-ink transition-colors [&_svg]:size-5 [&_svg]:stroke-current',
          open
            ? 'bg-[oklch(0.96_0.006_255/0.06)]'
            : 'bg-transparent hover:bg-[oklch(0.96_0.006_255/0.06)]',
        )}
      />
      <AnimatePresence>
        {open && (
          <m.div
            role="menu"
            data-mobile-substrate="ink-popover"
            // Pops from the trigger corner with the same restraint as the
            // desktop tool popovers, instead of hard-cutting onto the photo.
            initial={{
              opacity: 0,
              scale: prefersReduced ? 1 : 0.96,
              y: prefersReduced ? 0 : -4,
            }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{
              opacity: 0,
              scale: prefersReduced ? 1 : 0.96,
              y: prefersReduced ? 0 : -4,
            }}
            transition={surfaceFade}
            className="absolute right-0 top-[calc(100%+6px)] z-50 grid min-w-[12.25rem] origin-top-right gap-0.5 rounded-md border border-lf-on-photo-bord-soft bg-[oklch(0.11_0.006_255/0.94)] p-1.5 text-lf-on-photo-ink shadow-[0_18px_42px_oklch(0.02_0.006_255/0.6)] backdrop-blur-background"
          >
            {props.items.map((it, i) =>
              it.kind === 'separator' ? (
                <hr
                  key={`sep-${i}`}
                  className="my-1 h-px border-0 bg-lf-on-photo-bord-soft"
                />
              ) : (
                <button
                  key={it.label}
                  disabled={it.disabled}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    it.onSelect()
                  }}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[0.82rem] font-semibold text-lf-on-photo-ink transition-colors hover:bg-lf-on-photo-bg-strong disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <it.icon
                    aria-hidden="true"
                    className="size-[15px] shrink-0 text-lf-on-photo-ink/68"
                  />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.detail && (
                    <span className="shrink-0 text-[0.72rem] font-medium text-lf-on-photo-ink/56">
                      {it.detail}
                    </span>
                  )}
                </button>
              ),
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
