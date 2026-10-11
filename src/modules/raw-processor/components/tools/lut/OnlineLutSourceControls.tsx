import { Plus, Share2 } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'

import { Input } from '~/components/ui/input'
import { useScrollEdgeFade } from '~/hooks/common'
import { useI18n } from '~/lib/i18n'

import { useOnlineLutEntryLoader } from '../../../hooks/useOnlineLutEntryLoader'
import type { UseOnlineLutSourcesResult } from '../../../hooks/useOnlineLutSources'
import type { OnlineLutBrowserLayout } from './lut-browser-layout'
import { getViewportBoundedBrowserLayout } from './lut-browser-layout'
import { LutIconButton } from './LutIconButton'
import { LutSourceWarning } from './LutSourceWarning'
import { OnlineLutSourceBrowser } from './OnlineLutSourceBrowser'
import { OnlineLutSourceResourceList } from './OnlineLutSourceResourceList'
import { useOnlineLutResourceState } from './useOnlineLutResourceState'

export function OnlineLutSourceControls({
  onlineLutSources,
}: {
  onlineLutSources: UseOnlineLutSourcesResult
}) {
  const { t } = useI18n()
  const sourceInputId = useId()
  const browserId = useId()
  const { state } = onlineLutSources
  const [openResourceId, setOpenResourceId] = useState<string | null>(null)
  const [browserLayout, setBrowserLayout] =
    useState<OnlineLutBrowserLayout | null>(null)
  const [browserListEl, setBrowserListEl] = useState<HTMLDivElement | null>(
    null,
  )
  useScrollEdgeFade(browserListEl, { enabled: openResourceId != null })
  const openButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const { loadingEntryId, failedEntryId, loadOnlineLutEntry } =
    useOnlineLutEntryLoader(onlineLutSources)
  const {
    resourcesById,
    entriesByResourceId,
    issuesByResourceId,
    selectedResource: openResource,
    selectedEntries: openEntries,
    selectedIssues: openIssues,
  } = useOnlineLutResourceState({ state, resourceId: openResourceId })
  const closeBrowser = useCallback(
    (resourceId = openResourceId, options: { restoreFocus?: boolean } = {}) => {
      setOpenResourceId(null)
      // Layout is left in place so the dialog's exit animation can finish
      // against the same anchor before the next open recomputes it.

      if (options.restoreFocus && resourceId) {
        queueMicrotask(() => openButtonRefs.current.get(resourceId)?.focus())
      }
    },
    [openResourceId],
  )
  const { activateCatalogs } = onlineLutSources
  const activateResource = useCallback(
    (resourceId: string, options: { retryFailed?: boolean } = {}) => {
      activateCatalogs?.({ resourceIds: [resourceId], ...options })
    },
    [activateCatalogs],
  )
  // Opening a source is a request for its catalog: one not yet requested
  // starts loading as the browser opens. Activation skips a source that is
  // loading or ready, and a failed one waits for Retry or Refresh.
  const openBrowserForResource = useCallback(
    (resourceId: string) => {
      const trigger = openButtonRefs.current.get(resourceId)
      if (!trigger) return

      activateResource(resourceId)
      setBrowserLayout(getViewportBoundedBrowserLayout(trigger))
      setOpenResourceId(resourceId)
    },
    [activateResource],
  )
  const updateBrowserLayout = useCallback(() => {
    if (!openResourceId) return

    setBrowserLayout(
      getViewportBoundedBrowserLayout(
        openButtonRefs.current.get(openResourceId),
      ),
    )
  }, [openResourceId])

  useEffect(() => {
    if (!openResourceId) return

    if (!resourcesById.has(openResourceId)) {
      closeBrowser(openResourceId)
    }
  }, [closeBrowser, openResourceId, resourcesById])

  useLayoutEffect(() => {
    updateBrowserLayout()
  }, [updateBrowserLayout, openEntries.length, openIssues.length])

  useEffect(() => {
    if (!openResourceId) return

    const handleViewportChange = () => {
      updateBrowserLayout()
    }
    const trigger = openButtonRefs.current.get(openResourceId)
    const scrollTargets = [trigger?.closest('.raw-tool-surface')].filter(
      (target): target is Element => target instanceof Element,
    )

    window.addEventListener('resize', handleViewportChange)
    for (const target of scrollTargets) {
      target.addEventListener('scroll', handleViewportChange)
    }

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', handleViewportChange)
      }
    }
  }, [openResourceId, updateBrowserLayout])

  const dialogResource = openResource
  const openBrowser = dialogResource && browserLayout && (
    <OnlineLutSourceBrowser
      id={browserId}
      resource={dialogResource}
      entries={openEntries}
      issues={openIssues}
      layout={browserLayout}
      loadingEntryId={loadingEntryId}
      failedEntryId={failedEntryId}
      entryLoadProgress={onlineLutSources.entryLoadProgress}
      listRef={setBrowserListEl}
      restoreFocus={() =>
        openButtonRefs.current.get(dialogResource.id)?.focus()
      }
      triggerElement={openButtonRefs.current.get(dialogResource.id)}
      passthroughElements={() => openButtonRefs.current.values()}
      onClose={() => closeBrowser(dialogResource.id, { restoreFocus: true })}
      onEntryLoad={(entryId) => {
        void loadOnlineLutEntry(entryId, () =>
          closeBrowser(dialogResource.id, { restoreFocus: true }),
        )
      }}
      onCancelEntryLoad={onlineLutSources.cancelEntryLoad}
    />
  )

  return (
    <div className="grid min-w-0 gap-2 pt-1" data-raw-lut="source-controls">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_32px_32px] gap-1.5">
        <label htmlFor={sourceInputId} className="sr-only">
          {t('raw.lutSource.url')}
        </label>
        <Input
          id={sourceInputId}
          type="url"
          value={onlineLutSources.sourceUrlInput}
          placeholder="https://.../catalog.json"
          onChange={(event) =>
            onlineLutSources.setSourceUrlInput(event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              onlineLutSources.sourceUrlInput.trim()
            ) {
              event.preventDefault()
              void onlineLutSources.addSourceFromInput()
            }
          }}
          inputClassName="h-8 rounded-md border-transparent bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.04)] text-[0.78rem] text-lf-on-surface shadow-none placeholder:text-lf-on-surface/40 focus:border-transparent focus:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)] focus:ring-2 focus:ring-lf-green/25"
        />
        <LutIconButton
          label={t('raw.lutSource.add')}
          disabled={!onlineLutSources.sourceUrlInput.trim()}
          onClick={() => void onlineLutSources.addSourceFromInput()}
        >
          <Plus aria-hidden="true" />
        </LutIconButton>
        <LutIconButton
          label={t('raw.lutSource.copy')}
          disabled={!onlineLutSources.share.enabled}
          onClick={() => {
            onlineLutSources.share.copy().then(
              () => toast.success(t('raw.lutSource.copied')),
              () => toast.error(t('raw.lutSource.copyFailed')),
            )
          }}
        >
          <Share2 aria-hidden="true" />
        </LutIconButton>
      </div>

      {state.resources.length === 0 && (
        <p className="m-0 text-[0.72rem] leading-relaxed text-lf-on-surface/72">
          {t('raw.lutSource.emptyHint')}
        </p>
      )}

      {state.resources.length > 0 && (
        <OnlineLutSourceResourceList
          resources={state.resources}
          isLoading={state.isLoading}
          activeResourceId={state.activeResourceId}
          loadingEntryId={loadingEntryId}
          failedEntryId={failedEntryId}
          entryLoadProgress={onlineLutSources.entryLoadProgress}
          entriesByResourceId={entriesByResourceId}
          issuesByResourceId={issuesByResourceId}
          resourceActivation={onlineLutSources.resourceActivation}
          openResourceId={openResourceId}
          browserId={browserId}
          onOpenResource={openBrowserForResource}
          onCloseResource={(resourceId) =>
            closeBrowser(resourceId, { restoreFocus: true })
          }
          onRefreshResource={(resourceId) =>
            void onlineLutSources.refreshSource(resourceId)
          }
          onRemoveResource={(resourceId) => {
            if (openResourceId === resourceId) closeBrowser(resourceId)
            onlineLutSources.removeSource(resourceId)
          }}
          onActivateResource={activateResource}
          onEntryLoad={(entryId) => {
            void loadOnlineLutEntry(entryId)
          }}
          onCancelEntryLoad={onlineLutSources.cancelEntryLoad}
          setOpenButtonRef={(resourceId, node) => {
            if (node) {
              openButtonRefs.current.set(resourceId, node)
            } else {
              openButtonRefs.current.delete(resourceId)
            }
          }}
        />
      )}

      <AnimatePresence>{openBrowser}</AnimatePresence>

      <LutSourceWarning
        issues={state.issues.filter((issue) => !issue.resourceId)}
        surface="on-photo"
      />
    </div>
  )
}
