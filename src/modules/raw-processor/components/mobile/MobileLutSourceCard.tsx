import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { LutSourceWarning } from '../tools/lut/LutSourceWarning'

type Resource = UseOnlineLutSourcesResult['state']['resources'][number]
type Issue = UseOnlineLutSourcesResult['state']['issues'][number]

const iconButton =
  'grid size-[44px] place-items-center rounded-md bg-transparent text-lf-on-photo-ink/55 transition-[color,background-color,translate] duration-[120ms] hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 enabled:active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-50'

/** A catalog with more looks than fit the strip earns a full catalog view. */
const FULL_CATALOG_MIN_ENTRIES = 2

export function MobileLutSourceCard(props: {
  resource: Resource
  entryCount: number
  isLoading: boolean
  issues: Issue[]
  onBrowse: () => void
  onRefresh: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const label = props.resource.label || props.resource.url

  return (
    <div
      className="grid gap-1 bg-transparent py-0.5 pl-1"
      data-raw-mobile-lut="source-card"
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="grid min-w-0 gap-0.5">
          <span className="min-w-0 truncate text-lf-control font-medium text-lf-on-photo-ink/88">
            {label}
          </span>
          {props.isLoading ? (
            <output className="text-[0.7rem] text-lf-on-photo-ink/62">
              {t('raw.lutSource.loading')}
            </output>
          ) : props.entryCount >= FULL_CATALOG_MIN_ENTRIES ? (
            <button
              type="button"
              data-raw-mobile-lut="source-all-entries"
              aria-label={t('raw.mobile.lut.allEntriesAria', {
                count: props.entryCount,
                label,
              })}
              onClick={props.onBrowse}
              className="-ml-1 inline-flex min-h-11 w-fit items-center gap-0.5 rounded-md px-1 text-[0.74rem] font-semibold text-lf-on-photo-ink/72 tabular-nums transition-[color,translate] duration-[120ms] hover:text-lf-on-photo-ink/92 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 active:translate-y-[0.5px]"
            >
              {t('raw.mobile.lut.allEntries', { count: props.entryCount })}
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </button>
          ) : (
            <span className="text-[0.7rem] text-lf-on-photo-ink/62 tabular-nums">
              {props.entryCount === 0
                ? t('raw.lutSource.countZero')
                : t('raw.lutSource.countOne')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            aria-label={t('raw.lutSource.refresh', { label })}
            aria-busy={props.isLoading}
            disabled={props.isLoading}
            onClick={props.onRefresh}
            className={iconButton}
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-5 ${props.isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`}
            />
          </button>
          <button
            type="button"
            aria-label={t('raw.lutSource.remove', { label })}
            onClick={props.onRemove}
            className={iconButton}
          >
            <Trash2 aria-hidden="true" className="size-5" />
          </button>
        </div>
      </div>
      {/* A source that fails is a problem to state, not a colour contract:
          neutral ink with its icon and words. */}
      <LutSourceWarning
        issues={props.issues}
        surface="on-photo"
        tone="neutral"
      />
    </div>
  )
}
