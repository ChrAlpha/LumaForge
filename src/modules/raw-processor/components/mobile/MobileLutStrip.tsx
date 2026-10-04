import { Check, CircleAlert, Plus } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { OnlineLutEntryLoadProgress } from '../../hooks/useOnlineLutSources'
import { entryLoadPercent } from '../tools/lut/OnlineLutSourceResourceList'
import type { LutStripEntryItem, LutStripItem } from './mobile-lut-strip'
import { getAppliedStripKey } from './mobile-lut-strip'

export type LutTileState =
  | 'idle'
  | 'loading'
  | 'applied'
  | 'failed'
  | 'needs-contract'
  | 'disabled'

/** Width (px) of the fade drawn on a side that has more tiles past it. */
const EDGE_FADE_PX = 20
/** Opaque stop for the mask: only its alpha matters. */
const MASK_OPAQUE = 'oklch(0.5 0.006 255)'

export interface MobileLutStripProps {
  items: readonly LutStripItem[]
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  /** Processing or exporting: no tile takes a tap. */
  disabled: boolean
  /** The applied LUT still needs its colour contract chosen. */
  appliedNeedsContract: boolean
  onSelectOriginal: () => void
  onSelectEntry: (entryId: string) => void
  onCancelEntry: () => void
  onImport: (files: File[]) => void
}

function edgeMask(left: boolean, right: boolean): CSSProperties | undefined {
  if (!left && !right) return undefined
  const image = `linear-gradient(to right, ${left ? 'transparent' : MASK_OPAQUE} 0, ${MASK_OPAQUE} ${EDGE_FADE_PX}px, ${MASK_OPAQUE} calc(100% - ${EDGE_FADE_PX}px), ${right ? 'transparent' : MASK_OPAQUE} 100%)`
  return { maskImage: image, WebkitMaskImage: image }
}

/**
 * Bring a tile into the strip's view along the inline axis only, the
 * nearest way. Scrolling the strip itself (never `scrollIntoView`) keeps
 * the deck and the page still.
 */
export function scrollTileIntoStrip(
  scroller: HTMLElement,
  tile: HTMLElement,
  behavior: ScrollBehavior,
  padding = 12,
) {
  const strip = scroller.getBoundingClientRect()
  const rect = tile.getBoundingClientRect()
  let delta = 0
  if (rect.left < strip.left + padding) {
    delta = rect.left - (strip.left + padding)
  } else if (rect.right > strip.right - padding) {
    delta = rect.right - (strip.right - padding)
  }
  if (delta === 0) return
  const left = scroller.scrollLeft + delta
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ left, behavior })
  } else {
    scroller.scrollLeft = left
  }
}

/**
 * The Look strip: every look the photo can wear, tried on the photo. A tap
 * applies a look (or cancels one still loading); the applied tile carries
 * a cool ring and a check, and the preview keeps the current look until a
 * new one is ready.
 */
export function MobileLutStrip(props: MobileLutStripProps) {
  const { t } = useI18n()
  const reduced = useReducedMotion() ?? false
  const scrollerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const tileRefs = useRef(new Map<string, HTMLButtonElement>())
  const [edges, setEdges] = useState({ left: false, right: false })
  const appliedKey = getAppliedStripKey(props.items)
  const scrolledOnce = useRef(false)

  // Fades appear only on a side that has more tiles past it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      const max = scroller.scrollWidth - scroller.clientWidth
      const next = {
        left: scroller.scrollLeft > 1,
        right: max - scroller.scrollLeft > 1,
      }
      setEdges((current) =>
        current.left === next.left && current.right === next.right
          ? current
          : next,
      )
    }
    measure()
    scroller.addEventListener('scroll', measure, { passive: true })
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(scroller)
    }
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [props.items])

  // The applied tile comes into view when the deck opens (at once) and
  // whenever another look becomes the applied one (smoothly, unless the
  // user asked for reduced motion).
  useEffect(() => {
    const scroller = scrollerRef.current
    const tile = appliedKey ? tileRefs.current.get(appliedKey) : undefined
    if (!scroller || !tile) return
    const behavior: ScrollBehavior =
      !scrolledOnce.current || reduced ? 'instant' : 'smooth'
    scrolledOnce.current = true
    scrollTileIntoStrip(scroller, tile, behavior)
  }, [appliedKey, reduced])

  const tileRef = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) tileRefs.current.set(key, node)
    else tileRefs.current.delete(key)
  }

  const renderEntry = (item: LutStripEntryItem) => {
    const { entry } = item
    const loading = props.loadingEntryId === entry.id
    const failed = !loading && props.failedEntryId === entry.id
    const state: LutTileState = props.disabled
      ? 'disabled'
      : loading
        ? 'loading'
        : item.applied
          ? props.appliedNeedsContract
            ? 'needs-contract'
            : 'applied'
          : failed
            ? 'failed'
            : 'idle'
    const percent =
      loading && props.entryLoadProgress?.entryId === entry.id
        ? entryLoadPercent(props.entryLoadProgress)
        : null
    return (
      <LutTile
        key={item.key}
        ref={tileRef(item.key)}
        kind="entry"
        state={state}
        applied={item.applied}
        eyebrow={item.eyebrow}
        title={entry.title}
        percent={percent}
        ariaLabel={
          loading
            ? t('raw.lutSource.cancelDownload', { label: entry.title })
            : failed
              ? t('raw.lutSource.loadFailedRetry', { label: entry.title })
              : entry.title
        }
        onClick={() =>
          loading ? props.onCancelEntry() : props.onSelectEntry(entry.id)
        }
      />
    )
  }

  return (
    <div
      ref={scrollerRef}
      role="group"
      aria-label={t('raw.mobile.look.strip')}
      data-mobile-lut-strip
      data-fade-left={edges.left || undefined}
      data-fade-right={edges.right || undefined}
      style={edgeMask(edges.left, edges.right)}
      className={clsxm(
        // Bleeds to the deck's edges; the 12px scroll padding keeps a
        // snapped tile off them.
        '-mx-3.5 flex items-stretch gap-1.5 overflow-x-auto overscroll-x-contain px-3.5',
        '[scroll-padding-inline:12px] [scroll-snap-type:x_proximity]',
        '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {props.items.map((item) => {
        if (item.kind === 'original') {
          return (
            <LutTile
              key={item.key}
              ref={tileRef(item.key)}
              kind="original"
              state={
                props.disabled ? 'disabled' : item.applied ? 'applied' : 'idle'
              }
              applied={item.applied}
              title={t('raw.mobile.look.original')}
              ariaLabel={t('raw.mobile.look.original')}
              onClick={props.onSelectOriginal}
            />
          )
        }
        if (item.kind === 'custom') {
          return (
            <LutTile
              key={item.key}
              ref={tileRef(item.key)}
              kind="custom"
              state={
                props.disabled
                  ? 'disabled'
                  : props.appliedNeedsContract
                    ? 'needs-contract'
                    : 'applied'
              }
              applied
              eyebrow={t('raw.mobile.look.myFile')}
              title={item.title}
              ariaLabel={item.title}
              // A file only shows while it is the applied look.
              onClick={() => {}}
            />
          )
        }
        if (item.kind === 'import') {
          return (
            <LutTile
              key={item.key}
              kind="import"
              state={props.disabled ? 'disabled' : 'idle'}
              applied={false}
              title={t('raw.mobile.look.import')}
              ariaLabel={t('raw.mobile.look.import')}
              icon={<Plus aria-hidden="true" className="size-4" />}
              onClick={() => fileInputRef.current?.click()}
            />
          )
        }
        const tiles = item.entries.map(renderEntry)
        if (!item.labelled) return tiles
        return (
          <div
            key={item.key}
            role="group"
            aria-label={item.label}
            className="flex shrink-0 items-stretch gap-1.5"
          >
            <span
              aria-hidden="true"
              data-mobile-lut-source-label
              className="flex w-3.5 shrink-0 items-center justify-center overflow-hidden"
            >
              <span className="max-h-[60px] rotate-180 truncate text-[0.56rem] font-semibold uppercase tracking-wide text-lf-on-photo-ink/44 [writing-mode:vertical-rl]">
                {item.label}
              </span>
            </span>
            {tiles}
          </div>
        )
      })}
      <input
        ref={fileInputRef}
        type="file"
        accept=".cube"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        data-mobile-lut-import-input
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          // Let the same file be chosen again.
          event.currentTarget.value = ''
          if (files.length > 0) props.onImport(files)
        }}
      />
    </div>
  )
}

function LutTile(props: {
  ref?: (node: HTMLButtonElement | null) => void
  kind: 'original' | 'custom' | 'entry' | 'import'
  state: LutTileState
  applied: boolean
  eyebrow?: string
  title: string
  ariaLabel: string
  icon?: ReactNode
  percent?: number | null
  onClick: () => void
}) {
  const { t } = useI18n()
  const { state } = props
  const loading = state === 'loading'
  const needsContract = state === 'needs-contract'
  const showRing = props.applied && state !== 'disabled'
  return (
    <button
      ref={props.ref}
      type="button"
      data-mobile-lut-tile={props.kind}
      data-state={state}
      data-lut-title={props.title}
      aria-label={props.ariaLabel}
      aria-pressed={props.kind === 'import' ? undefined : props.applied}
      aria-busy={loading || undefined}
      disabled={state === 'disabled'}
      onClick={props.onClick}
      className={clsxm(
        'group relative grid h-[60px] w-[72px] shrink-0 snap-start overflow-hidden rounded-md px-1.5 py-1.5 text-left',
        'bg-[oklch(0.96_0.006_255/0.05)] transition-[background-color,opacity,translate] duration-[120ms] ease-out',
        'enabled:hover:bg-[oklch(0.96_0.006_255/0.08)] enabled:active:translate-y-[0.5px]',
        // Inset so the strip's own clipping never cuts the ring.
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80',
        'disabled:cursor-not-allowed disabled:opacity-45',
        props.kind === 'import' || props.kind === 'original'
          ? 'place-content-center justify-items-center text-center'
          : 'content-between',
        state === 'failed' && 'opacity-60',
      )}
    >
      {/* Applied: a 1.5px cool-white ring, faded in over 150ms. */}
      <span
        aria-hidden="true"
        data-applied-ring
        className={clsxm(
          'pointer-events-none absolute inset-0 rounded-md shadow-[inset_0_0_0_1.5px_oklch(0.96_0.006_255/0.92)] transition-opacity duration-150 motion-reduce:transition-none',
          showRing ? 'opacity-100' : 'opacity-0',
        )}
      />
      {props.icon && (
        <span className="text-lf-on-photo-ink/80">{props.icon}</span>
      )}
      {props.eyebrow && (
        <span className="min-w-0 truncate pr-3 text-[0.56rem] font-semibold uppercase leading-none tracking-wide text-lf-on-photo-ink/52">
          {props.eyebrow}
        </span>
      )}
      <span
        className={clsxm(
          'line-clamp-2 min-w-0 break-words text-[0.68rem] font-medium leading-tight text-lf-on-photo-ink/88',
          loading && 'opacity-80',
        )}
      >
        {props.title}
      </span>

      {state === 'applied' && (
        <span
          aria-hidden="true"
          data-applied-check
          className="absolute right-1 top-1 grid size-3.5 place-items-center rounded-full bg-[oklch(0.96_0.006_255/0.92)] text-lf-surface"
        >
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      )}
      {/* Amber marks a colour contract that still needs a choice; the
          footer says which, and the name below says it without colour. */}
      {needsContract && (
        <>
          <span
            aria-hidden="true"
            data-needs-contract-dot
            className="absolute right-1.5 top-1.5 size-[7px] rounded-full bg-lf-amber"
          />
          <span className="sr-only">{t('raw.mobile.look.needsContract')}</span>
        </>
      )}
      {state === 'failed' && (
        <CircleAlert
          aria-hidden="true"
          data-failed-glyph
          className="absolute right-1 top-1 size-3.5 text-lf-on-photo-ink/80"
        />
      )}
      {loading && (
        <span
          aria-hidden="true"
          data-load-progress
          className="absolute inset-x-0 bottom-0 h-0.5 bg-[oklch(0.96_0.006_255/0.08)]"
        >
          <span
            className="block h-full bg-[oklch(0.96_0.006_255/0.72)] transition-[width] duration-150 ease-out motion-reduce:transition-none"
            style={{ width: `${Math.max(6, props.percent ?? 6)}%` }}
          />
        </span>
      )}
    </button>
  )
}
