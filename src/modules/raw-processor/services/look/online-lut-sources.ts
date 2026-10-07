import type { OnlineLUTEntry, OnlineProfileIssue } from '~/lib/profiles/catalog'
import { parseReleaseCatalog, parseReleaseEntry } from '~/lib/profiles/catalog'
import type { fetchJsonWithLimit } from '~/lib/profiles/fetch'
import { OnlineProfileFetchError } from '~/lib/profiles/fetch'
import type { ProfileSourceResource } from '~/lib/profiles/source-url'
import { normalizeProfileSourceUrl } from '~/lib/profiles/source-url'

// Hard fetch budget for online LUT JSON documents. The producer keeps the
// scoped LUT catalog inside this budget (lumaforge-profiles lut-catalog.ts,
// LUT_CATALOG_MAX_BYTES) — both sides lock the same 1_000_000 literal in
// their contract tests, so a drift breaks the build on whichever side moved.
export const ONLINE_LUT_MAX_JSON_BYTES = 1_000_000
const defaultMaxJsonBytes = ONLINE_LUT_MAX_JSON_BYTES
export const ONLINE_LUT_SOURCE_STORAGE_KEY = 'lumaforge.raw.onlineLutSources.v1'
export const DEFAULT_LUMAFORGE_PROFILE_SOURCE: ProfileSourceResource = {
  id: 'lumaforge-default-profiles',
  // Channel-pinned LUT-scoped catalog (kind: "lut" entries only). The producer
  // keeps luts/catalog.json inside defaultMaxJsonBytes
  // (lumaforge-profiles lut-catalog.ts, LUT_CATALOG_MAX_BYTES) — see
  // lut-catalog-contract.test.ts for the locked boundary.
  url: 'https://luma-prof.ichr.me/channels/stable/luts/catalog.json',
  type: 'catalog',
  label: 'LumaForge Profiles',
  fromQuery: false,
  isDefault: true,
}

// URLs the default source pointed at before moving to the scoped LUT catalog.
// A user who removed the default while it lived at one of these must not see
// it resurrected just because the default URL changed.
const LEGACY_DEFAULT_LUT_SOURCE_URLS = [
  'https://luma-prof.ichr.me/channels/stable/catalog.json',
]

export type OnlineLUTSourceEntry = OnlineLUTEntry & { resourceId: string }

export interface OnlineLUTSourceIssue {
  code: string
  message: string
  resourceId?: string
  entryId?: string
  sourceUrl?: string
  raw?: string
}

export interface OnlineLUTSourceState {
  resources: ProfileSourceResource[]
  entries: OnlineLUTSourceEntry[]
  issues: OnlineLUTSourceIssue[]
  activeResourceId: string | null
  isLoading: boolean
}

/**
 * Where a source's catalog metadata stands. A source is listed (from the
 * defaults, storage or a query) before anything is fetched for it; it stays
 * `inactive` until a surface or query asks for its catalog.
 */
export type OnlineLUTSourceActivation =
  | 'inactive'
  | 'loading'
  | 'ready'
  | 'error'

export interface OnlineLUTLoadRequest {
  entryId: string
  signal?: AbortSignal
}

export interface OnlineLUTSourceResolution {
  resource: ProfileSourceResource
  entries: OnlineLUTSourceEntry[]
  issues: OnlineLUTSourceIssue[]
}

export interface OnlineLUTSourceEntryResolution {
  entry: OnlineLUTSourceEntry
  issues: OnlineLUTSourceIssue[]
}

interface StoredOnlineLUTSourceResource {
  url: string
  type: ProfileSourceResource['type']
  label: string
}

interface StoredOnlineLUTSourceRegistry {
  resources: StoredOnlineLUTSourceResource[]
  removedDefaultUrls: string[]
}

function emptyStoredRegistry(): StoredOnlineLUTSourceRegistry {
  return { resources: [], removedDefaultUrls: [] }
}

function getOnlineLUTSourceStorage(): Storage | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function isStoredResource(
  value: unknown,
): value is StoredOnlineLUTSourceResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const record = value as Record<string, unknown>

  return (
    typeof record.url === 'string' &&
    (record.type === 'catalog' ||
      record.type === 'entry' ||
      record.type === 'cube') &&
    typeof record.label === 'string'
  )
}

function normalizeStoredUrl(value: string): string | null {
  try {
    return normalizeProfileSourceUrl(value)
  } catch {
    return null
  }
}

function readStoredOnlineLUTSourceRegistry(
  storage = getOnlineLUTSourceStorage(),
): StoredOnlineLUTSourceRegistry {
  if (!storage) return emptyStoredRegistry()

  try {
    const raw = storage.getItem(ONLINE_LUT_SOURCE_STORAGE_KEY)
    if (!raw) return emptyStoredRegistry()

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyStoredRegistry()
    }

    const record = parsed as Record<string, unknown>
    const seenResources = new Set<string>()
    const resources = Array.isArray(record.resources)
      ? record.resources.flatMap((resource) => {
          if (!isStoredResource(resource)) return []

          const normalizedUrl = normalizeStoredUrl(resource.url)
          if (!normalizedUrl || seenResources.has(normalizedUrl)) return []

          seenResources.add(normalizedUrl)
          return [
            {
              url: normalizedUrl,
              type: resource.type,
              label: resource.label,
            },
          ]
        })
      : []
    const removedDefaultUrls = Array.isArray(record.removedDefaultUrls)
      ? Array.from(
          new Set(
            record.removedDefaultUrls.flatMap((value) => {
              if (typeof value !== 'string') return []

              const normalizedUrl = normalizeStoredUrl(value)
              return normalizedUrl ? [normalizedUrl] : []
            }),
          ),
        )
      : []

    return { resources, removedDefaultUrls }
  } catch {
    return emptyStoredRegistry()
  }
}

function writeStoredOnlineLUTSourceRegistry(
  registry: StoredOnlineLUTSourceRegistry,
  storage = getOnlineLUTSourceStorage(),
) {
  if (!storage) return

  try {
    storage.setItem(ONLINE_LUT_SOURCE_STORAGE_KEY, JSON.stringify(registry))
  } catch {
    // Storage can be unavailable or quota-limited; online LUT sources still work in memory.
  }
}

function isDefaultSourceRemoved(
  registry: StoredOnlineLUTSourceRegistry,
  defaultUrl: string,
): boolean {
  return (
    registry.removedDefaultUrls.includes(defaultUrl) ||
    LEGACY_DEFAULT_LUT_SOURCE_URLS.some((legacyUrl) =>
      registry.removedDefaultUrls.includes(legacyUrl),
    )
  )
}

function getDefaultSourceUrl(defaultSource: ProfileSourceResource): string {
  return normalizeStoredUrl(defaultSource.url) ?? defaultSource.url
}

function toStoredResource(
  resource: ProfileSourceResource,
): StoredOnlineLUTSourceResource | null {
  if (resource.isDefault || resource.fromQuery) return null

  const normalizedUrl = normalizeStoredUrl(resource.url)
  if (!normalizedUrl) return null

  return {
    url: normalizedUrl,
    type: resource.type,
    label: resource.label,
  }
}

export function getInitialOnlineLUTSourceResources(
  options: {
    storage?: Storage | null
    defaultSource?: ProfileSourceResource
  } = {},
): ProfileSourceResource[] {
  const defaultSource =
    options.defaultSource ?? DEFAULT_LUMAFORGE_PROFILE_SOURCE
  const registry = readStoredOnlineLUTSourceRegistry(options.storage)
  const defaultUrl = getDefaultSourceUrl(defaultSource)
  const resources: ProfileSourceResource[] = []

  const removedDefault = isDefaultSourceRemoved(registry, defaultUrl)

  if (!removedDefault) {
    resources.push({ ...defaultSource, url: defaultUrl })
  }

  for (const [index, resource] of registry.resources.entries()) {
    // A URL is one source. While the default is listed, a saved copy of its
    // URL is the default itself, not a second source.
    if (!removedDefault && resource.url === defaultUrl) continue

    resources.push({
      id: `stored-lut-source-${index + 1}`,
      url: resource.url,
      type: resource.type,
      label: resource.label,
      fromQuery: false,
    })
  }

  return resources
}

export function persistOnlineLUTSourceResource(
  resource: ProfileSourceResource,
  options: { storage?: Storage | null } = {},
) {
  const storedResource = toStoredResource(resource)
  if (!storedResource) return

  const registry = readStoredOnlineLUTSourceRegistry(options.storage)
  const defaultUrl = getDefaultSourceUrl(DEFAULT_LUMAFORGE_PROFILE_SOURCE)
  if (
    storedResource.url === defaultUrl &&
    !isDefaultSourceRemoved(registry, defaultUrl)
  ) {
    return
  }

  const resources = registry.resources.filter(
    (item) => item.url !== storedResource.url,
  )

  writeStoredOnlineLUTSourceRegistry(
    {
      ...registry,
      resources: [...resources, storedResource],
    },
    options.storage,
  )
}

export function persistOnlineLUTSourceRemoval(
  resource: ProfileSourceResource,
  options: { storage?: Storage | null } = {},
) {
  const registry = readStoredOnlineLUTSourceRegistry(options.storage)
  const normalizedUrl = normalizeStoredUrl(resource.url) ?? resource.url
  const nextRegistry: StoredOnlineLUTSourceRegistry = {
    resources: registry.resources.filter((item) => item.url !== normalizedUrl),
    removedDefaultUrls: registry.removedDefaultUrls,
  }

  if (resource.isDefault) {
    nextRegistry.removedDefaultUrls = Array.from(
      new Set([...nextRegistry.removedDefaultUrls, normalizedUrl]),
    )
  }

  writeStoredOnlineLUTSourceRegistry(nextRegistry, options.storage)
}

function withResourceId(
  entry: OnlineLUTEntry,
  resourceId: string,
): OnlineLUTSourceEntry {
  return { ...entry, resourceId }
}

function mapProfileIssues(
  issues: readonly OnlineProfileIssue[],
  resourceId: string,
  sourceUrl: string,
): OnlineLUTSourceIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    resourceId,
    entryId: issue.entryId,
    sourceUrl,
  }))
}

function mapFetchIssue(
  error: unknown,
  resourceId: string,
  sourceUrl: string,
  entryId?: string,
): OnlineLUTSourceIssue {
  if (error instanceof OnlineProfileFetchError) {
    return {
      code: error.code,
      message: error.message,
      resourceId,
      entryId,
      sourceUrl,
    }
  }

  if (error instanceof Error) {
    return {
      code: 'network',
      message: error.message,
      resourceId,
      entryId,
      sourceUrl,
    }
  }

  return {
    code: 'network',
    message: 'Failed to fetch online profile resource.',
    resourceId,
    entryId,
    sourceUrl,
  }
}

function directCubeTitle(resource: ProfileSourceResource): string {
  if (resource.label) return resource.label

  try {
    const url = new URL(resource.url)

    return url.pathname.split('/').filter(Boolean).at(-1) ?? resource.url
  } catch {
    return resource.url
  }
}

function normalizeResourceUrl(resource: ProfileSourceResource): string {
  try {
    return normalizeProfileSourceUrl(resource.url)
  } catch {
    return resource.url
  }
}

function retargetEntry(
  entry: OnlineLUTSourceEntry,
  resourceId: string,
): OnlineLUTSourceEntry {
  return entry.resourceId === resourceId ? entry : { ...entry, resourceId }
}

function retargetIssue(
  issue: OnlineLUTSourceIssue,
  resourceId: string,
): OnlineLUTSourceIssue {
  return issue.resourceId === resourceId ? issue : { ...issue, resourceId }
}

export async function resolveProfileSourceResource(
  resource: ProfileSourceResource,
  options: {
    fetchJson: typeof fetchJsonWithLimit
    signal?: AbortSignal
    maxJsonBytes?: number
  },
): Promise<OnlineLUTSourceResolution> {
  const maxBytes = options.maxJsonBytes ?? defaultMaxJsonBytes

  if (resource.type === 'cube') {
    const title = directCubeTitle(resource)

    return {
      resource,
      entries: [
        {
          id: resource.id,
          resourceId: resource.id,
          title,
          sourceUrl: resource.url,
          sourceType: 'direct-cube',
          cube: {
            url: resource.url,
            sha256: '',
            title,
          },
          tags: [],
        },
      ],
      issues: [],
    }
  }

  if (resource.type === 'entry') {
    try {
      const document = await options.fetchJson<unknown>(resource.url, {
        signal: options.signal,
        maxBytes,
      })
      const result = parseReleaseEntry(document, resource.url)

      if (!result.ok) {
        return {
          resource,
          entries: [],
          issues: mapProfileIssues(result.issues, resource.id, resource.url),
        }
      }

      return {
        resource,
        entries: [withResourceId(result.value, resource.id)],
        issues: [],
      }
    } catch (error) {
      return {
        resource,
        entries: [],
        issues: [mapFetchIssue(error, resource.id, resource.url)],
      }
    }
  }

  try {
    const document = await options.fetchJson<unknown>(resource.url, {
      signal: options.signal,
      maxBytes,
    })
    const catalog = parseReleaseCatalog(document, resource.url)

    if (!catalog.ok) {
      return {
        resource,
        entries: [],
        issues: mapProfileIssues(catalog.issues, resource.id, resource.url),
      }
    }

    return {
      resource,
      entries: catalog.value.map((entry) => withResourceId(entry, resource.id)),
      issues: [],
    }
  } catch (error) {
    return {
      resource,
      entries: [],
      issues: [mapFetchIssue(error, resource.id, resource.url)],
    }
  }
}

export async function resolveOnlineLUTSourceEntry(
  entry: OnlineLUTSourceEntry,
  options: {
    fetchJson: typeof fetchJsonWithLimit
    signal?: AbortSignal
    maxJsonBytes?: number
  },
): Promise<OnlineLUTSourceEntryResolution> {
  if (entry.sourceType !== 'catalog-entry' || entry.trustedContract) {
    return { entry, issues: [] }
  }

  const maxBytes = options.maxJsonBytes ?? defaultMaxJsonBytes

  try {
    const document = await options.fetchJson<unknown>(entry.sourceUrl, {
      signal: options.signal,
      maxBytes,
    })
    const result = parseReleaseEntry(document, entry.sourceUrl)

    if (!result.ok) {
      return {
        entry,
        issues: mapProfileIssues(
          result.issues,
          entry.resourceId,
          entry.sourceUrl,
        ),
      }
    }

    return {
      entry: withResourceId(result.value, entry.resourceId),
      issues: [],
    }
  } catch (error) {
    return {
      entry,
      issues: [
        mapFetchIssue(error, entry.resourceId, entry.sourceUrl, entry.id),
      ],
    }
  }
}

/**
 * A resolution that produced no entries but reported issues failed; anything
 * else, an empty catalog included, is a settled answer that needs no retry.
 */
export function getOnlineLUTSourceResolutionActivation(
  resolution: OnlineLUTSourceResolution,
): OnlineLUTSourceActivation {
  return resolution.entries.length === 0 && resolution.issues.length > 0
    ? 'error'
    : 'ready'
}

/**
 * One activation for a set of sources: any request in flight reads as
 * loading, any untouched source as inactive, and the set is an error only
 * when every source failed. No sources leaves nothing to activate.
 */
export function summarizeOnlineLUTCatalogActivation(
  activations: readonly OnlineLUTSourceActivation[],
): OnlineLUTSourceActivation {
  if (activations.includes('loading')) return 'loading'
  if (activations.includes('inactive')) return 'inactive'
  if (activations.length > 0 && activations.every((item) => item === 'error')) {
    return 'error'
  }
  return 'ready'
}

export function findOnlineLUTSourceResourceByUrl(
  resources: readonly ProfileSourceResource[],
  url: string,
): ProfileSourceResource | undefined {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeProfileSourceUrl(url)
  } catch {
    return undefined
  }

  return resources.find(
    (resource) => normalizeResourceUrl(resource) === normalizedUrl,
  )
}

export function mergeOnlineLUTSourceResolution(
  state: OnlineLUTSourceState,
  resolution: OnlineLUTSourceResolution,
): OnlineLUTSourceState {
  const normalizedUrl = normalizeResourceUrl(resolution.resource)
  const duplicateResource = state.resources.find(
    (resource) =>
      resource.id !== resolution.resource.id &&
      normalizeResourceUrl(resource) === normalizedUrl,
  )
  const targetResource = duplicateResource ?? resolution.resource
  const targetResourceId = targetResource.id
  const obsoleteResourceIds = new Set([
    resolution.resource.id,
    targetResourceId,
  ])
  const entries = resolution.entries.map((entry) =>
    retargetEntry(entry, targetResourceId),
  )
  const issues = resolution.issues.map((issue) =>
    retargetIssue(issue, targetResourceId),
  )

  const resources = duplicateResource
    ? state.resources.filter(
        (resource) => resource.id !== resolution.resource.id,
      )
    : [
        ...state.resources.filter(
          (resource) => resource.id !== resolution.resource.id,
        ),
        resolution.resource,
      ]

  return {
    resources,
    entries: [
      ...state.entries.filter(
        (entry) => !obsoleteResourceIds.has(entry.resourceId),
      ),
      ...entries,
    ],
    issues: [
      ...state.issues.filter(
        (issue) =>
          !issue.resourceId || !obsoleteResourceIds.has(issue.resourceId),
      ),
      ...issues,
    ],
    activeResourceId: targetResourceId,
    isLoading: false,
  }
}

export function removeOnlineLUTSourceResource(
  state: OnlineLUTSourceState,
  resourceId: string,
): OnlineLUTSourceState {
  return {
    resources: state.resources.filter((resource) => resource.id !== resourceId),
    entries: state.entries.filter((entry) => entry.resourceId !== resourceId),
    issues: state.issues.filter((issue) => issue.resourceId !== resourceId),
    activeResourceId:
      state.activeResourceId === resourceId ? null : state.activeResourceId,
    isLoading: state.isLoading,
  }
}

export function getShareableOnlineLUTSourceResources(
  state: OnlineLUTSourceState,
): ProfileSourceResource[] {
  const resourceIdsWithEntries = new Set(
    state.entries.map((entry) => entry.resourceId),
  )

  return state.resources.filter(
    (resource) =>
      resourceIdsWithEntries.has(resource.id) && !resource.isDefault,
  )
}
