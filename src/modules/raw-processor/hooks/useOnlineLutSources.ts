import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchJsonWithLimit } from '~/lib/profiles/fetch'
import type {
  ProfileSourceParseIssue,
  ProfileSourceResource,
} from '~/lib/profiles/source-url'
import {
  createLUTResourceShareUrl,
  normalizeProfileSourceUrl,
  parseLUTResourceQuery,
} from '~/lib/profiles/source-url'

import type {
  OnlineLUTSourceActivation,
  OnlineLUTSourceEntry,
  OnlineLUTSourceIssue,
  OnlineLUTSourceState,
} from '../services/look/online-lut-sources'
import {
  findOnlineLUTSourceResourceByUrl,
  getInitialOnlineLUTSourceResources,
  getOnlineLUTSourceResolutionActivation,
  getShareableOnlineLUTSourceResources,
  mergeOnlineLUTSourceResolution,
  persistOnlineLUTSourceRemoval,
  persistOnlineLUTSourceResource,
  removeOnlineLUTSourceResource,
  resolveOnlineLUTSourceEntry,
  resolveProfileSourceResource,
  summarizeOnlineLUTCatalogActivation,
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

export interface ActivateOnlineLutCatalogsOptions {
  /** Activate only these listed sources; every listed source otherwise. */
  resourceIds?: readonly string[]
  /** Request sources whose last catalog request failed once more. */
  retryFailed?: boolean
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
  /**
   * Fetches catalog metadata for listed sources that have none yet. Repeated
   * or concurrent calls never start a second request for a source that is
   * loading or ready, and a failed source waits for `retryFailed` or Refresh.
   * Activation only lists entries; it never applies a look.
   */
  activateCatalogs: (options?: ActivateOnlineLutCatalogsOptions) => void
  /** Activation per listed source; a source missing here is inactive. */
  resourceActivation: Readonly<Record<string, OnlineLUTSourceActivation>>
  /** Activation across every listed source. */
  catalogActivation: OnlineLUTSourceActivation
  share: {
    enabled: boolean
    url: string
    copy: () => Promise<void>
  }
}

// Default and saved sources are listed from the first render, before any
// catalog request, so a surface can show them while they are inactive.
function createInitialState(): OnlineLUTSourceState {
  return {
    resources: getInitialOnlineLUTSourceResources(),
    entries: [],
    issues: [],
    activeResourceId: null,
    isLoading: false,
  }
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

// A source's identity is its normalized URL: listed sources that share one
// URL share one catalog request and one activation.
function sourceKey(resource: ProfileSourceResource): string {
  try {
    return normalizeProfileSourceUrl(resource.url)
  } catch {
    return resource.url
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
  const [state, setState] = useState<OnlineLUTSourceState>(createInitialState)
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
  // Keyed by source URL. The ref answers "is this source already
  // requested?" synchronously, so intents racing in the same tick dedupe;
  // the state mirrors it for render. Inactive sources are absent from both.
  const activationRef = useRef(new Map<string, OnlineLUTSourceActivation>())
  const [sourceActivation, setSourceActivation] = useState<
    Readonly<Record<string, OnlineLUTSourceActivation>>
  >({})

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
      const key = sourceKey(resource)
      const existingId = resourceIdsByUrlRef.current.get(key)
      if (existingId) return existingId

      const existingResource = findOnlineLUTSourceResourceByUrl(
        stateRef.current.resources,
        resource.url,
      )
      if (existingResource) {
        resourceIdsByUrlRef.current.set(key, existingResource.id)
        return existingResource.id
      }

      const id = createResourceId()
      resourceIdsByUrlRef.current.set(key, id)

      return id
    },
    [createResourceId],
  )

  const setActivation = useCallback(
    (key: string, activation: OnlineLUTSourceActivation) => {
      if (activation === 'inactive') {
        activationRef.current.delete(key)
      } else {
        activationRef.current.set(key, activation)
      }
      setSourceActivation(Object.fromEntries(activationRef.current))
    },
    [],
  )

  // An aborted request leaves its source inactive, so the next activation
  // intent requests it again instead of waiting on a response that will be
  // ignored.
  const abortResourceRequest = useCallback(
    (key: string) => {
      const controller = resourceControllersRef.current.get(key)
      if (!controller) return

      controller.abort()
      resourceControllersRef.current.delete(key)
      setActivation(key, 'inactive')
      setState((current) => ({
        ...current,
        isLoading: resourceControllersRef.current.size > 0,
      }))
    },
    [setActivation],
  )

  // A resolution whose URL another listed source already holds merges into
  // that source; the activation follows the URL, so whichever source the
  // merge keeps reads it.
  const resolveResource = useCallback(
    async (resource: ProfileSourceResource) => {
      const key = sourceKey(resource)
      abortResourceRequest(key)

      const controller = new AbortController()
      resourceControllersRef.current.set(key, controller)
      setActivation(key, 'loading')
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

      resourceControllersRef.current.delete(key)
      setActivation(key, getOnlineLUTSourceResolutionActivation(resolution))
      setState((current) => ({
        ...mergeOnlineLUTSourceResolution(current, resolution),
        isLoading: resourceControllersRef.current.size > 0,
      }))
    },
    [abortResourceRequest, setActivation],
  )

  const activateResource = useCallback(
    (resource: ProfileSourceResource, retryFailed: boolean) => {
      const activation =
        activationRef.current.get(sourceKey(resource)) ?? 'inactive'
      if (activation === 'loading' || activation === 'ready') return
      if (activation === 'error' && !retryFailed) return

      void resolveResource(resource)
    },
    [resolveResource],
  )

  const activateCatalogs = useCallback(
    (options: ActivateOnlineLutCatalogsOptions = {}) => {
      const resourceIds = options.resourceIds
        ? new Set(options.resourceIds)
        : null

      for (const resource of stateRef.current.resources) {
        if (resourceIds && !resourceIds.has(resource.id)) continue
        activateResource(resource, options.retryFailed ?? false)
      }
    },
    [activateResource],
  )

  // Mounting requests no catalog: listed sources stay inactive until a
  // surface that shows their catalog asks for it, a ?luts= link names one, or
  // the user adds or refreshes one.
  //
  // A ?luts= resource is an explicit activation intent. One that names a
  // source already listed (the default or a saved source) activates that
  // source instead of listing and requesting the same catalog twice.
  useEffect(() => {
    const parsed = parseLUTResourceQuery(search)
    const resources = parsed.resources.filter(
      (resource) => !queryResourceUrlsRef.current.has(resource.url),
    )
    for (const resource of resources) {
      queryResourceUrlsRef.current.add(resource.url)
    }
    const issues = parseIssuesToSourceIssues(parsed.issues)

    setState((current) => withLooseIssues(current, issues))

    for (const resource of resources) {
      const listedResource = findOnlineLUTSourceResourceByUrl(
        stateRef.current.resources,
        resource.url,
      )
      if (listedResource) {
        activateResource(listedResource, false)
        continue
      }

      void resolveResource(
        retargetResource(resource, resolveResourceId(resource), true),
      )
    }
  }, [activateResource, resolveResource, resolveResourceId, search])

  useEffect(
    () => () => {
      for (const [
        key,
        controller,
      ] of resourceControllersRef.current.entries()) {
        controller.abort()
        activationRef.current.delete(key)
      }
      resourceControllersRef.current.clear()
      queryResourceUrlsRef.current.clear()
      setSourceActivation(Object.fromEntries(activationRef.current))

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

    setSourceUrlInput('')
    // Adding the listed default's URL refreshes the default; it never
    // becomes a second, saved source for the same URL.
    const listedResource = findOnlineLUTSourceResourceByUrl(
      stateRef.current.resources,
      parsedResource.url,
    )
    if (listedResource?.isDefault) {
      await resolveResource(listedResource)
      return
    }

    const resource = retargetResource(
      parsedResource,
      resolveResourceId(parsedResource),
      false,
    )
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
      // A source listed in this tick is not in the state ref yet; its id
      // was recorded against its URL when it was listed.
      const key = resource
        ? sourceKey(resource)
        : Array.from(resourceIdsByUrlRef.current.entries()).find(
            ([, id]) => id === resourceId,
          )?.[0]
      if (key) {
        abortResourceRequest(key)
        setActivation(key, 'inactive')
      }
      setState((current) => removeOnlineLUTSourceResource(current, resourceId))
    },
    [abortResourceRequest, setActivation],
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

  const resourceActivation = useMemo(() => {
    const byResource: Record<string, OnlineLUTSourceActivation> = {}
    for (const resource of state.resources) {
      const activation = sourceActivation[sourceKey(resource)]
      if (activation) byResource[resource.id] = activation
    }
    return byResource
  }, [sourceActivation, state.resources])

  const catalogActivation = useMemo(
    () =>
      summarizeOnlineLUTCatalogActivation(
        state.resources.map(
          (resource) => resourceActivation[resource.id] ?? 'inactive',
        ),
      ),
    [resourceActivation, state.resources],
  )

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
    activateCatalogs,
    resourceActivation,
    catalogActivation,
    share,
  }
}
