import type { ReactNode } from 'react'

import { useI18n } from '~/lib/i18n'

import type {
  OnlineLutEntryLoadProgress,
  UseOnlineLutSourcesResult,
} from '../../../hooks/useOnlineLutSources'
import { groupEntriesByFamily } from '../../../services/look/lut-source-grouping'
import type { OnlineLutBrowserLayout } from './lut-browser-layout'
import { LutBrowserDialog } from './LutBrowserDialog'
import { OnlineLutCatalogEntryButton } from './OnlineLutCatalogEntryButton'

type OnlineLutResource = UseOnlineLutSourcesResult['state']['resources'][number]
type OnlineLutEntry = UseOnlineLutSourcesResult['state']['entries'][number]
type OnlineLutIssue = UseOnlineLutSourcesResult['state']['issues'][number]

export function OnlineLutSourceBrowser({
  id,
  resource,
  entries,
  issues,
  layout,
  loadingEntryId,
  failedEntryId,
  entryLoadProgress,
  listRef,
  triggerElement,
  passthroughElements,
  restoreFocus,
  onClose,
  onEntryLoad,
  onCancelEntryLoad,
}: {
  id: string
  resource: OnlineLutResource
  entries: OnlineLutEntry[]
  issues: OnlineLutIssue[]
  layout: OnlineLutBrowserLayout
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  listRef: (node: HTMLDivElement | null) => void
  triggerElement?: HTMLElement
  passthroughElements: () => Iterable<HTMLElement>
  restoreFocus: () => void
  onClose: () => void
  onEntryLoad: (entryId: string) => void
  onCancelEntryLoad: () => void
}) {
  const { t } = useI18n()
  const formatEntryCount = (count: number) =>
    count === 1
      ? t('raw.lutSource.countOne')
      : count > 1
        ? t('raw.lutSource.countMany', { count })
        : t('raw.lutSource.countZero')

  return (
    <LutBrowserDialog
      key={resource.id}
      open
      layout={layout}
      id={id}
      kind="source"
      className="grid-rows-[auto_minmax(0,1fr)]"
      dialogLabel={`${resource.label} LUTs`}
      title={resource.label}
      description={formatEntryCount(entries.length)}
      closeLabel={t('raw.lutSource.close')}
      restoreFocus={restoreFocus}
      triggerElement={triggerElement}
      passthroughElements={passthroughElements}
      fillHeight={false}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <div
        ref={listRef}
        className="grid min-h-0 content-start gap-2 overflow-y-auto overscroll-contain pr-0.5"
        data-raw-lut="source-browser-list"
        data-lut-source-scroll="internal"
      >
        {entries.length > 0 ? (
          <OnlineLutSourceEntryGroups
            entries={entries}
            loadingEntryId={loadingEntryId}
            failedEntryId={failedEntryId}
            entryLoadProgress={entryLoadProgress}
            onCancelEntryLoad={onCancelEntryLoad}
            onEntryLoad={onEntryLoad}
          />
        ) : (
          <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
            {issues.length > 0
              ? t('raw.lutSource.noneCompatible')
              : t('raw.lutSource.noneYet')}
          </p>
        )}
      </div>
    </LutBrowserDialog>
  )
}

function OnlineLutSourceEntryGroups({
  entries,
  loadingEntryId,
  failedEntryId,
  entryLoadProgress,
  onEntryLoad,
  onCancelEntryLoad,
}: {
  entries: OnlineLutEntry[]
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  onEntryLoad: (entryId: string) => void
  onCancelEntryLoad: () => void
}) {
  const { t } = useI18n()
  const { families, others } = groupEntriesByFamily(entries)
  const anotherLoading = loadingEntryId !== null
  const renderEntry = (entry: OnlineLutEntry) => {
    const isLoading = loadingEntryId === entry.id

    return (
      <OnlineLutCatalogEntryButton
        key={entry.id}
        entry={entry}
        isLoading={isLoading}
        isLocked={anotherLoading && !isLoading}
        isFailed={failedEntryId === entry.id}
        progress={
          entryLoadProgress?.entryId === entry.id ? entryLoadProgress : null
        }
        onLoad={() => onEntryLoad(entry.id)}
        onCancel={onCancelEntryLoad}
      />
    )
  }

  return (
    <>
      {families.map(({ family, items }) => (
        <OnlineLutSourceEntrySection key={family} title={family}>
          {items.map(renderEntry)}
        </OnlineLutSourceEntrySection>
      ))}
      {others.length > 0 && (
        <OnlineLutSourceEntrySection title={t('raw.lutSource.others')}>
          {others.map(renderEntry)}
        </OnlineLutSourceEntrySection>
      )}
    </>
  )
}

function OnlineLutSourceEntrySection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-1">
      <div className="px-1 text-[0.7rem] font-medium tracking-tight text-lf-on-surface/50">
        {title}
      </div>
      <div className="grid gap-1 sm:grid-cols-2">{children}</div>
    </div>
  )
}
