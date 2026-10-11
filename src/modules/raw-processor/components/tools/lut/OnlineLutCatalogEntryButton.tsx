import { Aperture, Download, TriangleAlert, X } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import type {
  OnlineLutEntryLoadProgress,
  UseOnlineLutSourcesResult,
} from '../../../hooks/useOnlineLutSources'
import { entryLoadPercent } from '../../../services/look/lut-entry-progress'

type OnlineLutEntry = UseOnlineLutSourcesResult['state']['entries'][number]

// Single catalog-entry chrome shared by the inline 4-tile preview and the
// "browse all" dialog so both surfaces speak the same visual weight: same
// fill, hover, font size, icon size, click target, progress bar.
export function OnlineLutCatalogEntryButton({
  entry,
  isLoading,
  isLocked,
  isFailed,
  progress,
  onLoad,
  onCancel,
}: {
  entry: OnlineLutEntry
  isLoading: boolean
  isLocked: boolean
  isFailed: boolean
  progress: OnlineLutEntryLoadProgress | null
  onLoad: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const percent = isLoading ? entryLoadPercent(progress) : null

  return (
    <button
      type="button"
      aria-label={
        isLoading
          ? t('raw.lutSource.cancelDownload', { label: entry.title })
          : isFailed
            ? t('raw.lutSource.loadFailedRetry', { label: entry.title })
            : t('raw.lutSource.load', { label: entry.title })
      }
      aria-busy={isLoading || undefined}
      disabled={isLocked}
      onClick={isLoading ? onCancel : onLoad}
      data-raw-lut="catalog-entry"
      data-raw-lut-entry-loading={isLoading ? 'true' : undefined}
      data-raw-lut-entry-failed={isFailed ? 'true' : undefined}
      className={[
        'relative grid min-h-9 min-w-0 grid-cols-[16px_minmax(0,1fr)_16px] items-center gap-1.5 overflow-hidden rounded-md bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.035)] px-1.5 py-1 text-left text-[0.72rem] font-medium text-lf-on-surface/74 transition-colors hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.065)] hover:text-lf-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green',
        isLocked
          ? 'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.035)] disabled:hover:text-lf-on-surface/74'
          : '',
        isFailed
          ? 'bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.08)] hover:bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.12)]'
          : '',
      ].join(' ')}
    >
      <Aperture aria-hidden="true" className="size-4 text-lf-on-surface/40" />
      <span className="min-w-0 truncate">{entry.title}</span>
      {isLoading ? (
        <X aria-hidden="true" className="size-3.5" />
      ) : isFailed ? (
        <TriangleAlert aria-hidden="true" className="size-3.5 text-lf-amber" />
      ) : (
        <Download aria-hidden="true" className="size-3.5" />
      )}
      {isLoading && percent !== null && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('raw.lutSource.load', { label: entry.title })}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-[oklch(0.96_0.006_255/0.05)]"
        >
          <span
            className="block h-full bg-lf-green/70 transition-[width] duration-150 ease-out"
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
    </button>
  )
}
