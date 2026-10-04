import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { MobileMoreMenuItem } from './MobileMoreMenu'
import { MobileMoreMenu } from './MobileMoreMenu'

const appIcon = '/favicon.png'

export function MobileTopbar(props: {
  hasImage: boolean
  fileName: string
  fileMeta: string
  supportLevel: 'official' | 'experimental'
  moreMenuItems: MobileMoreMenuItem[]
  /** Terminal export action, rendered at the far right after More. */
  exportAction?: ReactNode
  scrubbing?: boolean
  /** Rendered height (px) so the stage can keep the photo below the topbar. */
  onHeightChange?: (height: number) => void
}) {
  const { t } = useI18n()
  const headerRef = useRef<HTMLElement>(null)
  const { onHeightChange } = props
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header || !onHeightChange) return
    onHeightChange(header.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      onHeightChange(header.offsetHeight)
    })
    observer.observe(header)
    return () => observer.disconnect()
  }, [onHeightChange])
  const title = props.hasImage ? props.fileName : t('raw.header.title')
  // The desktop empty subtitle invites a drop; a phone has nothing to drag.
  const meta = props.hasImage ? props.fileMeta : t('raw.mobile.empty.subtitle')
  const scrubbing = props.scrubbing === true
  // During a slider scrub the topbar yields its content slot to the
  // ScrubValueHud: same band, same solid backdrop. The file title, app mark,
  // and action cluster fade out instead of competing for the row, leaving
  // the plate alone to back the HUD readout.
  const fadeWhenScrubbing = clsxm(
    'transition-opacity duration-150',
    scrubbing && 'pointer-events-none opacity-0',
  )
  return (
    <header
      ref={headerRef}
      data-mobile-topbar
      data-scrubbing={scrubbing || undefined}
      // The photo is anchored below the topbar rather than under it, so the
      // plate is the solid stage base and only as tall as its content: the
      // top safe area, 12px, and one 44px row.
      className="pointer-events-none absolute inset-x-0 top-0 z-20 grid auto-rows-[minmax(2.75rem,auto)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 bg-[oklch(0.064_0.006_255)] px-3 pt-safe-offset-3 text-lf-on-photo-ink"
    >
      <img
        src={appIcon}
        alt=""
        className={clsxm(
          'size-6 shrink-0 rounded-[5px] object-cover ring-1 ring-inset ring-[oklch(0.96_0.006_255/0.2)]',
          scrubbing ? 'pointer-events-none' : 'pointer-events-auto',
          fadeWhenScrubbing,
        )}
      />
      <div
        className={clsxm(
          'min-w-0',
          scrubbing ? 'pointer-events-none' : 'pointer-events-auto',
          fadeWhenScrubbing,
        )}
      >
        <h1 className="m-0 truncate text-sm font-semibold leading-tight">
          {title}
        </h1>
        <p className="m-0 truncate text-[0.68rem] leading-tight text-lf-on-photo-ink/72 tabular-nums">
          {/* Glance cue only. The support level is named in the meta string
              beside it, so the state is never colour-alone. */}
          {props.hasImage && (
            <span
              aria-hidden="true"
              className={clsxm(
                'mr-1.5 inline-block size-[7px] translate-y-px rounded-full',
                props.supportLevel === 'official'
                  ? 'bg-lf-green shadow-[0_0_0_2px_oklch(0.59_0.15_153/0.28)]'
                  : 'bg-lf-amber',
              )}
            />
          )}
          {meta}
        </p>
      </div>
      <div
        className={clsxm(
          'inline-flex items-center gap-1',
          scrubbing ? 'pointer-events-none' : 'pointer-events-auto',
          fadeWhenScrubbing,
        )}
      >
        {/* Ghost actions: transparent at rest, a cool wash on hover, no
            per-button border. The locale switch and the histogram toggle live
            in the More menu so the meta line keeps room for the camera name;
            export is the one filled action, at the far right. */}
        <MobileMoreMenu
          ariaLabel={t('raw.mobile.more.menuAria')}
          items={props.moreMenuItems}
        />
        {props.exportAction}
      </div>
    </header>
  )
}
