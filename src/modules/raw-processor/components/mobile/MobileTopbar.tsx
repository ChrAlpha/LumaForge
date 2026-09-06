import { BarChart3 } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'

import { LocaleToggle } from '~/components/common/LocaleToggle'
import { IconButton } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { MobileMoreMenuItem } from './MobileMoreMenu'
import { MobileMoreMenu } from './MobileMoreMenu'

const appIcon = '/favicon.png'

// Ghost action style per DESIGN.md §6 Topbar: transparent at rest, lift-medium
// cool-white wash on hover. No per-button border or fill — three bordered
// boxes read as competing chips over the photo; the slate scrim below carries
// legibility instead.
const ghostAction =
  'inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md bg-transparent text-lf-on-photo-ink transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] [&_svg]:size-5 [&_svg]:stroke-current'

export function MobileTopbar(props: {
  hasImage: boolean
  fileName: string
  fileMeta: string
  supportLevel: 'official' | 'experimental'
  histogramShown: boolean
  onToggleHistogram: () => void
  moreMenuItems: MobileMoreMenuItem[]
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
  const meta = props.hasImage ? props.fileMeta : t('raw.header.subtitleEmpty')
  const scrubbing = props.scrubbing === true
  // During a slider scrub the topbar yields its content slot to the
  // ScrubValueHud — same vertical band, same gradient backdrop. We fade the
  // file title, app mark, and action cluster instead of competing for the
  // safe-area row, keeping the gradient alone to back the HUD readout.
  const fadeWhenScrubbing = clsxm(
    'transition-opacity duration-150',
    scrubbing && 'pointer-events-none opacity-0',
  )
  return (
    <header
      ref={headerRef}
      data-mobile-topbar
      data-scrubbing={scrubbing || undefined}
      className="pointer-events-none absolute inset-x-0 top-0 z-20 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 bg-gradient-to-b from-[oklch(0.064_0.006_255/0.82)] via-[oklch(0.064_0.006_255/0.4)] to-transparent px-3 pb-5 pt-safe-offset-3 text-lf-on-photo-ink"
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
        <LocaleToggle
          className={clsxm(ghostAction, 'px-2.5 text-[0.72rem] font-semibold')}
        />
        <span
          aria-hidden="true"
          className="mx-0.5 h-5 w-px shrink-0 bg-[oklch(0.96_0.006_255/0.14)]"
        />
        {props.hasImage ? (
          <IconButton
            icon={BarChart3}
            size="md"
            data-mobile-histogram-slot
            aria-label={
              props.histogramShown
                ? t('raw.mobile.histogram.hide')
                : t('raw.mobile.histogram.show')
            }
            aria-pressed={props.histogramShown}
            onClick={props.onToggleHistogram}
            className={clsxm(
              'size-11 rounded-md transition-colors [&_svg]:size-5 [&_svg]:stroke-current',
              props.histogramShown
                ? 'bg-lf-amber/15 text-lf-amber-soft'
                : 'bg-transparent text-lf-on-photo-ink hover:bg-[oklch(0.96_0.006_255/0.06)]',
            )}
          />
        ) : (
          <span
            aria-hidden="true"
            data-mobile-histogram-slot
            className="size-11 shrink-0"
          />
        )}
        <MobileMoreMenu
          ariaLabel={t('raw.mobile.more.menuAria')}
          items={props.moreMenuItems}
        />
      </div>
    </header>
  )
}
