import type { HTMLMotionProps } from 'motion/react'
import { m } from 'motion/react'
import type { Ref } from 'react'

import { useI18n } from '~/lib/i18n'
import { sheetSpring } from '~/lib/spring'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { GroupedEntries } from '../tools/lut/lut-source-grouping'
import { LutSourceWarning } from '../tools/lut/LutSourceWarning'
import { useOnlineLutEntryLoader } from '../tools/lut/useOnlineLutEntryLoader'
import { MobileLutCatalogEntryButton } from './MobileLutCatalogEntryButton'

type OnlineEntry = UseOnlineLutSourcesResult['state']['entries'][number]
type OnlineIssue = UseOnlineLutSourcesResult['state']['issues'][number]
type OnlineResource = UseOnlineLutSourcesResult['state']['resources'][number]
type ViewMotion = Pick<HTMLMotionProps<'div'>, 'animate' | 'exit' | 'initial'>

export interface MobileLutCatalogViewProps {
  bodyRef: Ref<HTMLDivElement>
  viewMotion: ViewMotion
  selectedResource: OnlineResource | null
  selectedEntries: OnlineEntry[]
  selectedIssues: OnlineIssue[]
  selectedResourceLoading: boolean
  selectedEntryGroups: GroupedEntries<OnlineEntry>
  disabled: boolean
  lutSources?: Pick<
    UseOnlineLutSourcesResult,
    'loadEntry' | 'loadingEntryId' | 'failedEntryId' | 'cancelEntryLoad'
  >
  entryLoadProgress: UseOnlineLutSourcesResult['entryLoadProgress']
  onCancelEntryLoad?: UseOnlineLutSourcesResult['cancelEntryLoad']
  onEntryLoaded: () => void
}

export function MobileLutCatalogView({
  bodyRef,
  viewMotion,
  selectedResource,
  selectedEntries,
  selectedIssues,
  selectedResourceLoading,
  selectedEntryGroups,
  disabled,
  lutSources,
  entryLoadProgress,
  onCancelEntryLoad,
  onEntryLoaded,
}: MobileLutCatalogViewProps) {
  const { t } = useI18n()
  const { loadingEntryId, failedEntryId, loadOnlineLutEntry } =
    useOnlineLutEntryLoader(lutSources, { replace: true })

  const renderCatalogEntry = (entry: OnlineEntry) => {
    const isEntryLoading = loadingEntryId === entry.id
    const isEntryFailed = failedEntryId === entry.id

    return (
      <MobileLutCatalogEntryButton
        key={entry.id}
        title={entry.title}
        loading={isEntryLoading}
        failed={isEntryFailed}
        progress={
          entryLoadProgress?.entryId === entry.id ? entryLoadProgress : null
        }
        onCancel={onCancelEntryLoad}
        disabled={disabled}
        ariaLabel={
          isEntryFailed
            ? t('raw.lutSource.loadFailedRetry', { label: entry.title })
            : t('raw.mobile.lut.loadEntry', { label: entry.title })
        }
        onClick={() => {
          void loadOnlineLutEntry(entry.id, onEntryLoaded)
        }}
      />
    )
  }

  return (
    <m.div
      key="catalog"
      ref={bodyRef}
      className="grid min-h-0 content-start gap-3 overflow-y-auto px-4 pb-5 pt-1"
      {...viewMotion}
      transition={sheetSpring}
    >
      {selectedResource && (
        <div className="grid gap-2 px-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="shrink-0 rounded-lf-pill border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-1.5 py-0.5 text-lf-eyebrow font-medium leading-none text-lf-on-photo-ink/62">
              {t('raw.mobile.lut.entryCount', {
                count: selectedEntries.length,
              })}
            </span>
            {selectedResourceLoading && (
              <output className="shrink-0 px-1.5 py-0.5 text-lf-eyebrow font-medium leading-none text-lf-on-photo-ink/62">
                {t('raw.lutSource.loading')}
              </output>
            )}
          </div>
          <LutSourceWarning
            issues={selectedIssues}
            surface="on-photo"
            tone="neutral"
          />
        </div>
      )}

      {selectedEntries.length > 0 ? (
        <>
          {selectedEntryGroups.families.map(({ family, items }) => (
            <section key={family} className="grid gap-1.5">
              <h3 className="m-0 px-1 text-[0.7rem] font-medium tracking-tight text-lf-on-photo-ink/50">
                {family}
              </h3>
              <div className="grid gap-1.5">
                {items.map(renderCatalogEntry)}
              </div>
            </section>
          ))}
          {selectedEntryGroups.others.length > 0 && (
            <section className="grid gap-1.5">
              <h3 className="m-0 px-1 text-[0.7rem] font-medium tracking-tight text-lf-on-photo-ink/50">
                {t('raw.lutSource.others')}
              </h3>
              <div className="grid gap-1.5">
                {selectedEntryGroups.others.map(renderCatalogEntry)}
              </div>
            </section>
          )}
        </>
      ) : (
        <p className="m-0 text-lf-control leading-relaxed text-lf-on-photo-ink/64">
          {selectedIssues.length > 0
            ? t('raw.lutSource.noneCompatible')
            : t('raw.lutSource.noneYet')}
        </p>
      )}
    </m.div>
  )
}
