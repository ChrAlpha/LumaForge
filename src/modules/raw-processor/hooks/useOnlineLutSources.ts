import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchJsonWithLimit } from '~/lib/profiles/fetch'
import type {
  ProfileSourceParseIssue,
  ProfileSourceResource,
} from '~/lib/profiles/source-url'
import {
  createLUTResourceShareUrl,
  parseLUTResourceQuery,
} from '~/lib/profiles/source-url'

import type {
  OnlineLUTSourceEntry,
  OnlineLUTSourceIssue,
  OnlineLUTSourceState,
} from '../services/look/online-lut-sources'
import {
  getInitialOnlineLUTSourceResources,
  getShareableOnlineLUTSourceResources,
  mergeOnlineLUTSourceResolution,
  persistOnlineLUTSourceRemoval,
  persistOnlineLUTSourceResource,
  removeOnlineLUTSourceResource,
  resolveOnlineLUTSourceEntry,
  resolveProfileSourceResource,
} from '../services/look/online-lut-sources'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'

export interface UseOnlineLutSourcesOptions {
  search: string
  pathname: string
  loadOnlineLUT: (
    entry: OnlineLUTEntry,
    options?: {
      signal?: AbortSignal
      onProgress?: (receivedBytes: number, totalBytes?: number) => void
    },
  ) => Promise<LutLoadOutcome>
  /**
   * SHA-256 of the LUT the session applies, if any. An entry that declares
   * no hash (a direct .cube URL) is known applied only by pairing its load
   * with the hash the session reports after it.
   */
  appliedLutSha256?: string | null
}

/**
 * The last entry this hook loaded, paired with the hash the session applied
 * for it. Kept here, not on a surface, so every surface's load is
 * remembered and a remounted surface still knows which tile is applied.
 */
export interface OnlineLutLoadedEntry {
  entryId: string
  sha256: string
}

export interface OnlineLutEntryLoadProgress {
  entryId: string
  receivedBytes: number
  totalBytes?: number
}

export interface UseOnlineLutSourcesResult {
  state: OnlineLUTSourceState
  sourceUrlInput: string
  setSourceUrlInput: (value: string) => void
  addSourceFromInput: () => Promise<void>
  refreshSource: (resourceId: string) => Promise<void>
  removeSource: (resourceId: string) => void
  loadEntry: (entryId: string) => Promise<LutLoadOutcome>
  /** Authoritative across every surface; at most one entry loads at a time. */
  loadingEntryId: string | null
  failedEntryId: string | null
  entryLoadProgress: OnlineLutEntryLoadProgress | null
  cancelEntryLoad: () => void
  /** The last loaded entry and the hash it applied; null before one. */
  loadedEntry: OnlineLutLoadedEntry | null
  share: {
    enabled: boolean
    url: string
    copy: () => Promise<void>
  }
}

const emptyState: OnlineLUTSourceState = {
  resources: [],
  entries: [],
  issues: [],
  activeResourceId: null,
  isLoading: false,
}

function parseIssuesToSourceIssues(
  issues: readonly ProfileSourceParseIssue[],
): OnlineLUTSourceIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    raw: issue.raw,
  }))
}

// Loose issues (no resourceId) are transient input/query validation feedback.
// Replace them on each parse so a fresh attempt refreshes the warning instead of
// stacking another copy on top of the last one. Resource-bound issues are owned
// by their resource and left untouched here.
function withLooseIssues(
  state: OnlineLUTSourceState,
  looseIssues: OnlineLUTSourceIssue[],
): OnlineLUTSourceState {
  return {
    ...state,
    issues: [
      ...state.issues.filter((issue) => issue.resourceId),
      ...looseIssues,
    ],
  }
}

function retargetResource(
  resource: ProfileSourceResource,
  id: string,
  fromQuery: boolean,
): ProfileSourceResource {
  return {
    ...resource,
    id,
    fromQuery,
  }
}

function issueBelongsToEntry(
  issue: OnlineLUTSourceIssue,
  entry: OnlineLUTSourceEntry,
): boolean {
  if (issue.resourceId !== entry.resourceId) return false

  return issue.entryId === entry.id || issue.sourceUrl === entry.sourceUrl
}

/**
 * A resolved entry manifest replaces the listed entry, but the entry keeps
 * the title (and family) its catalog listed it under: the name the user
 * tapped must not change under them once the look loads.
 */
function mergeEntryResolution(
  state: OnlineLUTSourceState,
  requestedEntry: OnlineLUTSourceEntry,
  resolvedEntry: OnlineLUTSourceEntry,
  issues: OnlineLUTSourceIssue[],
): OnlineLUTSourceState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.resourceId === requestedEntry.resourceId &&
      entry.id === requestedEntry.id
        ? {
            ...resolvedEntry,
            title: entry.title || resolvedEntry.title,
            family: resolvedEntry.family ?? entry.family,
          }
        : entry,
    ),
    issues: [
      ...state.issues.filter(
        (issue) => !issueBelongsToEntry(issue, requestedEntry),
      ),
      ...issues,
    ],
  }
}

export function useOnlineLutSources({
  search,
  pathname,
  loadOnlineLUT,
  appliedLutSha256 = null,
}: UseOnlineLutSourcesOptions): UseOnlineLutSourcesResult {
  const [state, setState] = useState<OnlineLUTSourceState>(emptyState)
  const [sourceUrlInput, setSourceUrlInput] = useState('')
  const queryResourceUrlsRef = useRef(new Set<string>())
  const resourceIdsByUrlRef = useRef(new Map<string, string>())
  const nextResourceIdRef = useRef(1)
  const resourceControllersRef = useRef(new Map<string, AbortController>())
  const loadControllersRef = useRef(new Set<AbortController>())
  const [entryLoadProgress, setEntryLoadProgress] =
    useState<OnlineLutEntryLoadProgress | null>(null)
  const [loadingEntryId, setLoadingEntryId] = useState<string | null>(null)
  const [failedEntryId, setFailedEntryId] = useState<string | null>(null)
  const [loadedEntry, setLoadedEntry] = useState<OnlineLutLoadedEntry | null>(
    null,
  )
  // An entry whose load applied, waiting for the session to report the hash
  // it applied.
  const [justLoadedEntryId, setJustLoadedEntryId] = useState<string | null>(
    null,
  )
  const activeEntryLoadRef = useRef<{
    entryId: string
    controller: AbortController
  } | null>(null)
  const lastProgressEmitRef = useRef(0)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const hasShareCapability =
    typeof navigator !== 'undefined' &&
    (Boolean(navigator.clipboard?.writeText) || Boolean(navigator.share))

  const createResourceId = useCallback(() => {
    const id = `lut-source-${nextResourceIdRef.current}`
    nextResourceIdRef.current += 1
    return id
  }, [])

  const resolveResourceId = useCallback(
    (resource: ProfileSourceResource) => {
      const existingId = resourceIdsByUrlRef.current.get(resource.url)
      if (existingId) return existingId

      const existingResource = stateRef.current.resources.find(
        (item) => item.url === resource.url,
      )
      if (existingResource) {
        resourceIdsByUrlRef.current.set(resource.url, existingResource.id)
        return existingResource.id
      }

      const id = createResourceId()
      resourceIdsByUrlRef.current.set(resource.url, id)

      return id
    },
    [createResourceId],
  )

  const abortResourceRequest = useCallback((resourceId: string) => {
    const controller = resourceControllersRef.current.get(resourceId)
    if (!controller) return

    controller.abort()
    resourceControllersRef.current.delete(resourceId)
    setState((current) => ({
      ...current,
      isLoading: resourceControllersRef.current.size > 0,
    }))
  }, [])

  const resolveResource = useCallback(
    async (resource: ProfileSourceResource) => {
      abortResourceRequest(resource.id)

      const controller = new AbortController()
      resourceControllersRef.current.set(resource.id, controller)
      setState((current) => ({
        ...current,
        resources: [
          ...current.resources.filter((item) => item.id !== resource.id),
          resource,
        ],
        activeResourceId: resource.id,
        isLoading: true,
      }))

      const resolution = await resolveProfileSourceResource(resource, {
        fetchJson: fetchJsonWithLimit,
        signal: controller.signal,
      })

      if (controller.signal.aborted) return

      resourceControllersRef.current.delete(resource.id)
      setState((current) => ({
        ...mergeOnlineLUTSourceResolution(current, resolution),
        isLoading: resourceControllersRef.current.size > 0,
      }))
    },
    [abortResourceRequest],
  )

  useEffect(() => {
    for (const resource of getInitialOnlineLUTSourceResources()) {
      void resolveResource(resource)
    }
  }, [resolveResource])

  useEffect(() => {
    const parsed = parseLUTResourceQuery(search)
    const resources = parsed.resources
      .filter((resource) => !queryResourceUrlsRef.current.has(resource.url))
      .map((resource) => {
        queryResourceUrlsRef.current.add(resource.url)

        return retargetResource(resource, resolveResourceId(resource), true)
      })
    const issues = parseIssuesToSourceIssues(parsed.issues)

    setState((current) => withLooseIssues(current, issues))

    for (const resource of resources) {
      void resolveResource(resource)
    }
  }, [resolveResource, resolveResourceId, search])

  useEffect(
    () => () => {
      for (const controller of resourceControllersRef.current.values()) {
        controller.abort()
      }
      resourceControllersRef.current.clear()
      queryResourceUrlsRef.current.clear()

      for (const controller of loadControllersRef.current) {
        controller.abort()
      }
      loadControllersRef.current.clear()
    },
    [],
  )

  const addSourceFromInput = useCallback(async () => {
    const parsed = parseLUTResourceQuery(
      `luts=${encodeURIComponent(sourceUrlInput)}`,
    )
    const issues = parseIssuesToSourceIssues(parsed.issues)
    const [parsedResource] = parsed.resources

    setState((current) => withLooseIssues(current, issues))

    if (!parsedResource) return

    const resource = retargetResource(
      parsedResource,
      resolveResourceId(parsedResource),
      false,
    )
    setSourceUrlInput('')
    persistOnlineLUTSourceResource(resource)
    await resolveResource(resource)
  }, [resolveResource, resolveResourceId, sourceUrlInput])

  const refreshSource = useCallback(
    async (resourceId: string) => {
      const resource = state.resources.find((item) => item.id === resourceId)
      if (!resource) return

      await resolveResource(resource)
    },
    [resolveResource, state.resources],
  )

  const removeSource = useCallback(
    (resourceId: string) => {
      const resource = stateRef.current.resources.find(
        (item) => item.id === resourceId,
      )
      if (resource) persistOnlineLUTSourceRemoval(resource)
      abortResourceRequest(resourceId)
      setState((current) => removeOnlineLUTSourceResource(current, resourceId))
    },
    [abortResourceRequest],
  )

  const loadEntry = useCallback(
    async (entryId: string): Promise<LutLoadOutcome> => {
      // One entry load at a time across every surface (desktop inline, dialog,
      // mobile pills, mobile catalog). A second surface racing in must not
      // steal the active load's cancel handle or progress slot.
      if (activeEntryLoadRef.current) return 'aborted'

      const entry = stateRef.current.entries.find((item) => item.id === entryId)
      if (!entry) return 'failed'

      const controller = new AbortController()
      loadControllersRef.current.add(controller)
      activeEntryLoadRef.current = { entryId, controller }
      lastProgressEmitRef.current = 0
      setLoadingEntryId(entryId)
      setFailedEntryId(null)

      // The catalog-declared cube size is the trustworthy total; a CDN's
      // content-length reflects the compressed transfer instead.
      const declaredTotal = entry.cube.bytes
      const onProgress = (receivedBytes: number, totalBytes?: number) => {
        if (controller.signal.aborted) return

        const total = declaredTotal ?? totalBytes
        const now = Date.now()
        const isFinal = total !== undefined && receivedBytes >= total
        if (!isFinal && now - lastProgressEmitRef.current < 120) return

        lastProgressEmitRef.current = now
        setEntryLoadProgress({ entryId, receivedBytes, totalBytes: total })
      }

      try {
        const entryResolution = await resolveOnlineLUTSourceEntry(entry, {
          fetchJson: fetchJsonWithLimit,
          signal: controller.signal,
        })

        if (controller.signal.aborted) return 'aborted'

        if (entryResolution.entry !== entry || entryResolution.issues.length) {
          setState((current) =>
            mergeEntryResolution(
              current,
              entry,
              entryResolution.entry,
              entryResolution.issues,
            ),
          )
        }

        const outcome = await loadOnlineLUT(entryResolution.entry, {
          signal: controller.signal,
          onProgress,
        })
        if (outcome === 'failed') setFailedEntryId(entryId)
        if (outcome === 'loaded') setJustLoadedEntryId(entryId)
        return outcome
      } catch (error) {
        if (!controller.signal.aborted) setFailedEntryId(entryId)
        throw error
      } finally {
        loadControllersRef.current.delete(controller)
        // A cancelled load already handed its state back (and a newer load
        // may own it now, even for the same entry), so only a load that is
        // still the active one clears it.
        if (activeEntryLoadRef.current?.controller === controller) {
          activeEntryLoadRef.current = null
          setLoadingEntryId((current) => (current === entryId ? null : current))
          setEntryLoadProgress((current) =>
            current?.entryId === entryId ? null : current,
          )
        }
      }
    },
    [loadOnlineLUT],
  )

  // The session reports the applied hash once the load's style lands; pair
  // it with the entry that loaded it.
  useEffect(() => {
    if (!justLoadedEntryId || !appliedLutSha256) return
    setLoadedEntry({ entryId: justLoadedEntryId, sha256: appliedLutSha256 })
    setJustLoadedEntryId(null)
  }, [appliedLutSha256, justLoadedEntryId])

  // Cancelling releases the one-load lock at once, so a surface can cancel
  // and start another entry in the same tap. The aborted load never applies:
  // its pipeline checks the signal after every await, and its own cleanup
  // only clears state that is still its own.
  const cancelEntryLoad = useCallback(() => {
    const active = activeEntryLoadRef.current
    if (!active) return
    active.controller.abort()
    activeEntryLoadRef.current = null
    setLoadingEntryId((current) =>
      current === active.entryId ? null : current,
    )
    setEntryLoadProgress((current) =>
      current?.entryId === active.entryId ? null : current,
    )
  }, [])

  const shareResources = useMemo(
    () => getShareableOnlineLUTSourceResources(state),
    [state],
  )
  const shareUrl = useMemo(
    () => createLUTResourceShareUrl(pathname, shareResources),
    [pathname, shareResources],
  )

  const share = useMemo(
    () => ({
      enabled: shareResources.length > 0 && hasShareCapability,
      url: shareUrl,
      async copy() {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(shareUrl)
          return
        }

        if (navigator.share) {
          try {
            await navigator.share({ url: shareUrl })
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            throw error
          }
        }
      },
    }),
    [hasShareCapability, shareResources.length, shareUrl],
  )

  return {
    state,
    sourceUrlInput,
    setSourceUrlInput,
    addSourceFromInput,
    refreshSource,
    removeSource,
    loadEntry,
    loadingEntryId,
    failedEntryId,
    entryLoadProgress,
    cancelEntryLoad,
    loadedEntry,
    share,
  }
}
