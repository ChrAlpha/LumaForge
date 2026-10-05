import { Aperture, CircleAlert, Download, X } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import type { OnlineLutEntryLoadProgress } from '../../hooks/useOnlineLutSources'
import { entryLoadPercent } from '../tools/lut/OnlineLutSourceResourceList'

export function MobileLutCatalogEntryButton(props: {
  title: string
  loading: boolean
  failed?: boolean
  progress?: OnlineLutEntryLoadProgress | null
  disabled: boolean
  ariaLabel: string
  onClick: () => void
  onCancel?: () => void
}) {
  const { t } = useI18n()
  const percent = props.loading
    ? entryLoadPercent(props.progress ?? null)
    : null
  const cancelLabel = t('raw.lutSource.cancelDownload', { label: props.title })

  return (
    <button
      type="button"
      aria-label={props.loading ? cancelLabel : props.ariaLabel}
      aria-busy={props.loading || undefined}
      disabled={props.disabled}
      onClick={
        props.loading ? (props.onCancel ?? props.onClick) : props.onClick
      }
      className="relative grid min-h-[52px] min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-lf-on-photo-bg-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green disabled:cursor-not-allowed disabled:opacity-50"
      data-raw-mobile-lut="catalog-entry"
      data-raw-mobile-lut-entry-loading={props.loading ? 'true' : undefined}
      data-raw-mobile-lut-entry-failed={props.failed ? 'true' : undefined}
    >
      <Aperture aria-hidden="true" className="size-5 text-lf-on-photo-ink/45" />
      <span className="min-w-0 truncate text-lf-control font-medium text-lf-on-photo-ink">
        {props.title}
      </span>
      {props.loading ? (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-lf-on-photo-text-soft">
          <X aria-hidden="true" className="size-4" />
          {t('raw.mobile.lut.cancel')}
        </span>
      ) : props.failed ? (
        // A failed download is not a colour contract: neutral ink, with
        // the icon and the word.
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-lf-on-photo-ink/80">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          {t('raw.mobile.lut.retry')}
        </span>
      ) : (
        <Download
          aria-hidden="true"
          className="size-4 text-lf-on-photo-ink/55"
        />
      )}
      {props.loading && percent !== null && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={props.ariaLabel}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-[oklch(0.96_0.006_255/0.05)]"
        >
          <span
            className="block h-full bg-[oklch(0.96_0.006_255/0.72)] transition-[width] duration-150 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
    </button>
  )
}
