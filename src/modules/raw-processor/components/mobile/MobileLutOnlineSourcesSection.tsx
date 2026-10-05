import { Plus, Share2 } from 'lucide-react'
import { toast } from 'sonner'

import { Input } from '~/components/ui/input'
import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { MobileLutSourceCard } from './MobileLutSourceCard'

type OnlineEntry = UseOnlineLutSourcesResult['state']['entries'][number]
type OnlineIssue = UseOnlineLutSourcesResult['state']['issues'][number]

const iconButton =
  'grid size-[44px] shrink-0 place-items-center rounded-md bg-transparent text-lf-on-photo-ink/55 transition-[color,background-color,translate] duration-[120ms] hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 enabled:active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-50'

export interface MobileLutOnlineSourcesSectionProps {
  onlineLutSources?: UseOnlineLutSourcesResult
  sourceInputId: string
  entriesByResourceId: ReadonlyMap<string, OnlineEntry[]>
  issuesByResourceId: ReadonlyMap<string, OnlineIssue[]>
  onBrowseResource: (resourceId: string) => void
}

/**
 * Source administration: add a catalog URL, share the list, and per source
 * refresh, remove, read its issues, or open its full catalog.
 */
export function MobileLutOnlineSourcesSection({
  onlineLutSources,
  sourceInputId,
  entriesByResourceId,
  issuesByResourceId,
  onBrowseResource,
}: MobileLutOnlineSourcesSectionProps) {
  const { t } = useI18n()

  if (!onlineLutSources) return null

  return (
    <section className="grid gap-2" data-raw-mobile-lut="sources">
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (!onlineLutSources.sourceUrlInput.trim()) {
            return
          }
          void onlineLutSources.addSourceFromInput()
        }}
      >
        <label htmlFor={sourceInputId} className="sr-only">
          {t('raw.lutSource.url')}
        </label>
        <Input
          id={sourceInputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={onlineLutSources.sourceUrlInput}
          placeholder="https://.../catalog.json"
          onChange={(event) =>
            onlineLutSources.setSourceUrlInput(event.currentTarget.value)
          }
          inputClassName="h-[44px] rounded-md border-transparent bg-[oklch(0.96_0.006_255/0.05)] text-lf-control text-lf-on-photo-ink shadow-none placeholder:text-lf-on-photo-ink/40 focus:border-transparent focus:bg-[oklch(0.96_0.006_255/0.08)] focus:ring-2 focus:ring-lf-green/25"
        />
        <button
          type="submit"
          aria-label={t('raw.lutSource.add')}
          disabled={!onlineLutSources.sourceUrlInput.trim()}
          className={iconButton}
        >
          <Plus aria-hidden="true" className="size-5" />
        </button>
        <button
          type="button"
          aria-label={t('raw.lutSource.copy')}
          disabled={!onlineLutSources.share.enabled}
          onClick={() => {
            void onlineLutSources.share.copy().then(
              () => toast.success(t('raw.lutSource.copied')),
              () => toast.error(t('raw.lutSource.copyFailed')),
            )
          }}
          className={iconButton}
        >
          <Share2 aria-hidden="true" className="size-5" />
        </button>
      </form>
      {onlineLutSources.state.resources.length === 0 && (
        <p className="m-0 text-xs leading-relaxed text-lf-on-photo-ink/72">
          {t('raw.lutSource.emptyHint')}
        </p>
      )}
      <div className="grid gap-1" aria-busy={onlineLutSources.state.isLoading}>
        {/* Announce loading without inserting layout: the resource card's
            refresh spinner is the visual signal. */}
        <p className="sr-only" role="status">
          {onlineLutSources.state.isLoading ? t('raw.mobile.lut.loading') : ''}
        </p>
        {onlineLutSources.state.resources.map((resource) => {
          const entries = entriesByResourceId.get(resource.id) ?? []
          const resourceIssues = issuesByResourceId.get(resource.id) ?? []
          const isResourceLoading =
            onlineLutSources.state.isLoading &&
            onlineLutSources.state.activeResourceId === resource.id

          return (
            <MobileLutSourceCard
              key={resource.id}
              resource={resource}
              entryCount={entries.length}
              isLoading={isResourceLoading}
              issues={resourceIssues}
              onBrowse={() => onBrowseResource(resource.id)}
              onRefresh={() => void onlineLutSources.refreshSource(resource.id)}
              onRemove={() => onlineLutSources.removeSource(resource.id)}
            />
          )
        })}
      </div>
    </section>
  )
}
