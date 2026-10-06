import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import type {
  ActivateOnlineLutCatalogsOptions,
  OnlineLutEntryLoadProgress,
  UseOnlineLutSourcesResult,
} from '../../../hooks/useOnlineLutSources'
import type { OnlineLUTSourceActivation } from '../../../services/look/online-lut-sources'
import { LutIconButton } from './LutIconButton'
import { LutSourceWarning } from './LutSourceWarning'
import { OnlineLutCatalogEntryButton } from './OnlineLutCatalogEntryButton'

export { entryLoadPercent } from './OnlineLutCatalogEntryButton'

type OnlineLutResource = UseOnlineLutSourcesResult['state']['resources'][number]
type OnlineLutEntry = UseOnlineLutSourcesResult['state']['entries'][number]
type OnlineLutIssue = UseOnlineLutSourcesResult['state']['issues'][number]

const inlineEntryLimit = 4

/**
 * Where a row's catalog stands. Without per-source activation (a surface
 * fixture), a row reads as listed and loading only while it is the source
 * being resolved.
 */
function getRowActivation(
  resourceId: string,
  resourceActivation:
    | Readonly<Record<string, OnlineLUTSourceActivation>>
    | undefined,
  isLoading: boolean,
  activeResourceId: string | null,
): OnlineLUTSourceActivation {
  if (resourceActivation) return resourceActivation[resourceId] ?? 'inactive'
  return isLoading && activeResourceId === resourceId ? 'loading' : 'ready'
}

export function OnlineLutSourceResourceList({
  resources,
  isLoading,
  activeResourceId,
  loadingEntryId,
  failedEntryId,
  entryLoadProgress,
  entriesByResourceId,
  issuesByResourceId,
  resourceActivation,
  openResourceId,
  browserId,
  onOpenResource,
  onCloseResource,
  onRefreshResource,
  onRemoveResource,
  onActivateResource,
  onEntryLoad,
  onCancelEntryLoad,
  setOpenButtonRef,
}: {
  resources: OnlineLutResource[]
  isLoading: boolean
  activeResourceId: string | null
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  entriesByResourceId: ReadonlyMap<string, OnlineLutEntry[]>
  issuesByResourceId: ReadonlyMap<string, OnlineLutIssue[]>
  /** Catalog activation per source; a source missing here is inactive. */
  resourceActivation?: Readonly<Record<string, OnlineLUTSourceActivation>>
  openResourceId: string | null
  browserId: string
  onOpenResource: (resourceId: string) => void
  onCloseResource: (resourceId: string) => void
  onRefreshResource: (resourceId: string) => void
  onRemoveResource: (resourceId: string) => void
  /** Requests a source's catalog: Load when inactive, Retry after a failure. */
  onActivateResource?: (
    resourceId: string,
    options?: Pick<ActivateOnlineLutCatalogsOptions, 'retryFailed'>,
  ) => void
  onEntryLoad: (entryId: string) => void
  onCancelEntryLoad: () => void
  setOpenButtonRef: (resourceId: string, node: HTMLButtonElement | null) => void
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      {resources.map((resource) => (
        <OnlineLutSourceResourceRow
          key={resource.id}
          resource={resource}
          activation={getRowActivation(
            resource.id,
            resourceActivation,
            isLoading,
            activeResourceId,
          )}
          entries={entriesByResourceId.get(resource.id) ?? []}
          issues={issuesByResourceId.get(resource.id) ?? []}
          isOpen={openResourceId === resource.id}
          loadingEntryId={loadingEntryId}
          failedEntryId={failedEntryId}
          entryLoadProgress={entryLoadProgress}
          browserId={browserId}
          onOpen={() => onOpenResource(resource.id)}
          onClose={() => onCloseResource(resource.id)}
          onRefresh={() => onRefreshResource(resource.id)}
          onRemove={() => onRemoveResource(resource.id)}
          onActivate={(options) => onActivateResource?.(resource.id, options)}
          onEntryLoad={onEntryLoad}
          onCancelEntryLoad={onCancelEntryLoad}
          setOpenButtonRef={(node) => setOpenButtonRef(resource.id, node)}
        />
      ))}
    </div>
  )
}

function OnlineLutSourceResourceRow({
  resource,
  activation,
  entries,
  issues,
  isOpen,
  loadingEntryId,
  failedEntryId,
  entryLoadProgress,
  browserId,
  onOpen,
  onClose,
  onRefresh,
  onRemove,
  onActivate,
  onEntryLoad,
  onCancelEntryLoad,
  setOpenButtonRef,
}: {
  resource: OnlineLutResource
  activation: OnlineLUTSourceActivation
  entries: OnlineLutEntry[]
  issues: OnlineLutIssue[]
  isOpen: boolean
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  browserId: string
  onOpen: () => void
  onClose: () => void
  onRefresh: () => void
  onRemove: () => void
  onActivate: (
    options?: Pick<ActivateOnlineLutCatalogsOptions, 'retryFailed'>,
  ) => void
  onEntryLoad: (entryId: string) => void
  onCancelEntryLoad: () => void
  setOpenButtonRef: (node: HTMLButtonElement | null) => void
}) {
  const { t } = useI18n()
  const isLoading = activation === 'loading'
  const formatEntryCount = (count: number) =>
    count === 1
      ? t('raw.lutSource.countOne')
      : count > 1
        ? t('raw.lutSource.countMany', { count })
        : t('raw.lutSource.countZero')
  const hasIssue = issues.length > 0

  return (
    <div className="grid min-w-0 gap-1" data-raw-lut="source-resource">
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
        data-raw-lut="source-resource-row"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-[0.78rem] font-medium text-lf-on-surface/85">
            {resource.label}
          </span>
          <span
            className="shrink-0 rounded-full bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)] px-1.5 py-0.5 text-[0.66rem] font-medium leading-none text-lf-on-surface/72 tabular-nums"
            data-raw-lut="source-count-chip"
          >
            {isLoading
              ? t('raw.lutSource.loading')
              : activation === 'inactive' && entries.length === 0
                ? t('raw.lutSource.notLoaded')
                : formatEntryCount(entries.length)}
          </span>
          {hasIssue && (
            <span className="shrink-0 rounded-full bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.14)] px-1.5 py-0.5 text-[0.66rem] font-medium leading-none text-lf-on-surface/80">
              {t('raw.lutSource.issue')}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <LutIconButton
            label={t('raw.lutSource.open', {
              label: resource.label,
            })}
            ariaControls={browserId}
            ariaExpanded={isOpen}
            ariaHasPopup="dialog"
            buttonRef={setOpenButtonRef}
            onClick={isOpen ? onClose : onOpen}
          >
            <FolderOpen aria-hidden="true" />
          </LutIconButton>
          <LutIconButton
            label={t('raw.lutSource.refresh', {
              label: resource.label,
            })}
            busy={isLoading}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
          </LutIconButton>
          <LutIconButton
            label={t('raw.lutSource.remove', {
              label: resource.label,
            })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </LutIconButton>
        </div>
      </div>
      {entries.length === 0 &&
        (activation === 'inactive' || activation === 'error') && (
          <OnlineLutSourceActivateButton
            label={resource.label}
            retry={activation === 'error'}
            onActivate={onActivate}
          />
        )}
      <OnlineLutSourceInlineEntries
        entries={entries}
        isResourceLoading={isLoading}
        loadingEntryId={loadingEntryId}
        failedEntryId={failedEntryId}
        entryLoadProgress={entryLoadProgress}
        browserId={browserId}
        onEntryLoad={onEntryLoad}
        onCancelEntryLoad={onCancelEntryLoad}
        onBrowseAll={onOpen}
      />
      <LutSourceWarning issues={issues} surface="on-photo" className="pt-1.5" />
    </div>
  )
}

/**
 * A source listed before its catalog is requested, or whose request failed,
 * has no rows to choose from; this asks for them without opening anything.
 */
function OnlineLutSourceActivateButton({
  label,
  retry,
  onActivate,
}: {
  label: string
  retry: boolean
  onActivate: (
    options?: Pick<ActivateOnlineLutCatalogsOptions, 'retryFailed'>,
  ) => void
}) {
  const { t } = useI18n()

  return (
    <button
      type="button"
      aria-label={
        retry
          ? t('raw.lutSource.retryAria', { label })
          : t('raw.lutSource.activateAria', { label })
      }
      onClick={() => onActivate(retry ? { retryFailed: true } : undefined)}
      className="justify-self-start rounded-md px-1.5 py-0.5 text-[0.7rem] font-medium text-lf-on-surface/60 transition-colors hover:text-lf-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green"
      data-raw-lut="source-activate"
    >
      {retry ? t('raw.lutSource.retry') : t('raw.lutSource.activate')}
    </button>
  )
}

function OnlineLutSourceInlineEntries({
  entries,
  isResourceLoading,
  loadingEntryId,
  failedEntryId,
  entryLoadProgress,
  browserId,
  onEntryLoad,
  onCancelEntryLoad,
  onBrowseAll,
}: {
  entries: OnlineLutEntry[]
  isResourceLoading: boolean
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  browserId: string
  onEntryLoad: (entryId: string) => void
  onCancelEntryLoad: () => void
  onBrowseAll: () => void
}) {
  const { t } = useI18n()
  if (entries.length === 0) {
    // Reserve the resting grid footprint while the catalog resolves so the
    // dropzone and strength controls below do not jump when entries land.
    if (!isResourceLoading) return null

    return (
      <div
        className="grid gap-1 sm:grid-cols-2"
        data-raw-lut="source-inline-entries"
        aria-hidden="true"
      >
        {Array.from({ length: inlineEntryLimit }, (_, slot) => (
          <span
            key={slot}
            data-raw-lut="entry-skeleton"
            className="min-h-9 animate-pulse rounded-md bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.035)] motion-reduce:animate-none"
          />
        ))}
      </div>
    )
  }

  const anotherLoading = loadingEntryId !== null
  const overflow = entries.length - inlineEntryLimit

  return (
    <div className="grid min-w-0 gap-1">
      <div
        className="grid gap-1 sm:grid-cols-2"
        data-raw-lut="source-inline-entries"
      >
        {entries.slice(0, inlineEntryLimit).map((entry) => (
          <OnlineLutCatalogEntryButton
            key={entry.id}
            entry={entry}
            isLoading={loadingEntryId === entry.id}
            isLocked={anotherLoading && loadingEntryId !== entry.id}
            isFailed={failedEntryId === entry.id}
            progress={
              entryLoadProgress?.entryId === entry.id ? entryLoadProgress : null
            }
            onLoad={() => onEntryLoad(entry.id)}
            onCancel={onCancelEntryLoad}
          />
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          aria-controls={browserId}
          onClick={onBrowseAll}
          className="justify-self-start rounded-md px-1.5 py-0.5 text-[0.7rem] font-medium text-lf-on-surface/60 transition-colors hover:text-lf-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green"
          data-raw-lut="source-inline-overflow"
        >
          {t('raw.lutSource.moreCount', { count: overflow })}
        </button>
      )}
    </div>
  )
}
