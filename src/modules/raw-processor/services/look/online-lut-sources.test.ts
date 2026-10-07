import { describe, expect, it, vi } from 'vitest'

import type { fetchJsonWithLimit } from '~/lib/profiles/fetch'
import type { ProfileSourceResource } from '~/lib/profiles/source-url'

import type {
  OnlineLUTSourceEntry,
  OnlineLUTSourceIssue,
  OnlineLUTSourceState,
} from './online-lut-sources'
import {
  DEFAULT_LUMAFORGE_PROFILE_SOURCE,
  findOnlineLUTSourceResourceByUrl,
  getInitialOnlineLUTSourceResources,
  getOnlineLUTSourceResolutionActivation,
  getShareableOnlineLUTSourceResources,
  mergeOnlineLUTSourceResolution,
  persistOnlineLUTSourceResource,
  removeOnlineLUTSourceResource,
  resolveOnlineLUTSourceEntry,
  resolveProfileSourceResource,
  summarizeOnlineLUTCatalogActivation,
} from './online-lut-sources'

const sha256 =
  '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab'

const catalogUrl =
  'https://profiles.example.com/releases/v2026.05.01/catalog.json'
const entryUrl =
  'https://profiles.example.com/releases/v2026.05.01/entries/kodak-2383-rec709.json'
const secondEntryUrl =
  'https://profiles.example.com/releases/v2026.05.01/entries/ektachrome-e100.json'
const cubeUrl = `https://profiles.example.com/blobs/sha256/9c/56/${sha256}.cube`

const primaryAsset = {
  role: 'cube-lut',
  mediaType: 'application/x-cube-lut',
  size: 12,
  sha256,
  url: cubeUrl,
}

function resource(
  overrides: Partial<ProfileSourceResource>,
): ProfileSourceResource {
  return {
    id: 'source-1',
    url: catalogUrl,
    type: 'catalog',
    label: 'Catalog from profiles.example.com',
    fromQuery: true,
    ...overrides,
  }
}

function entryManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'kodak-2383-rec709',
    kind: 'lut',
    format: 'cube',
    version: '1.0.0',
    title: 'Kodak 2383 Rec.709',
    description: null,
    license: 'NOASSERTION',
    author: 'Unknown',
    source: 'Unknown',
    sourceUrl: null,
    redistributionAllowed: true,
    targets: {},
    manifestPath: 'profiles/kodak-2383-rec709/manifest.json',
    entryUrl,
    primaryAsset,
    assets: [],
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    lut: {
      intent: 'combined-look-output',
      input: { gamut: 'arri-wide-gamut-3', transfer: 'logc3', range: 'full' },
      output: { gamut: 'rec709', transfer: 'gamma24', range: 'legal' },
    },
    tags: ['film-print'],
    ...overrides,
  }
}

function catalogDocument(
  entries: Record<string, unknown>[] = [
    {
      id: 'kodak-2383-rec709',
      kind: 'lut',
      version: '1.0.0',
      title: 'Kodak 2383 Rec.709',
      license: 'NOASSERTION',
      redistributionAllowed: true,
      primaryAsset,
      entryUrl,
    },
  ],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entries,
  }
}

function emptyState(
  overrides: Partial<OnlineLUTSourceState> = {},
): OnlineLUTSourceState {
  return {
    resources: [],
    entries: [],
    issues: [],
    activeResourceId: null,
    isLoading: false,
    ...overrides,
  }
}

function createFetchJson(fixtures: Record<string, unknown>) {
  const mock = vi.fn(
    async (
      url: string,
      _options: { signal?: AbortSignal; maxBytes: number },
    ): Promise<unknown> => {
      if (url.endsWith('.cube')) {
        throw new Error(`CUBE bytes must not be fetched: ${url}`)
      }

      if (!(url in fixtures)) {
        throw new Error(`Missing fixture for ${url}`)
      }

      return fixtures[url]
    },
  )

  return mock as typeof fetchJsonWithLimit & typeof mock
}

describe('online LUT source metadata service', () => {
  it('adds a catalog resource by fetching only catalog JSON and keeping entryUrl for lazy load', async () => {
    const fetchJson = createFetchJson({
      [catalogUrl]: catalogDocument(),
    })

    const resolution = await resolveProfileSourceResource(resource({}), {
      fetchJson,
      maxJsonBytes: 1234,
    })
    const state = mergeOnlineLUTSourceResolution(emptyState(), resolution)

    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenNthCalledWith(1, catalogUrl, {
      signal: undefined,
      maxBytes: 1234,
    })
    expect(state.entries).toMatchObject([
      {
        id: 'kodak-2383-rec709',
        resourceId: 'source-1',
        sourceUrl: entryUrl,
        cube: { url: cubeUrl, sha256 },
        trustedContract: undefined,
      },
    ])
    expect(state.issues).toEqual([])
  })

  it('does not report entry manifest fetch failures while only catalog rows are being listed', async () => {
    const fetchJson = createFetchJson({
      [catalogUrl]: catalogDocument(),
    })

    const resolution = await resolveProfileSourceResource(resource({}), {
      fetchJson,
      maxJsonBytes: 1234,
    })

    expect(resolution.entries).toMatchObject([
      {
        id: 'kodak-2383-rec709',
        resourceId: 'source-1',
        sourceUrl: entryUrl,
        trustedContract: undefined,
      },
    ])
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(resolution.issues).toEqual([])
  })

  it('resolves a selected catalog row by fetching only that entry manifest', async () => {
    const fetchJson = createFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const catalogResolution = await resolveProfileSourceResource(resource({}), {
      fetchJson,
      maxJsonBytes: 1234,
    })
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([catalogUrl])

    fetchJson.mockClear()
    const [catalogEntry] = catalogResolution.entries
    const entryResolution = await resolveOnlineLUTSourceEntry(catalogEntry, {
      fetchJson,
      maxJsonBytes: 2345,
    })

    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenCalledWith(entryUrl, {
      signal: undefined,
      maxBytes: 2345,
    })
    expect(entryResolution).toMatchObject({
      entry: {
        id: 'kodak-2383-rec709',
        resourceId: 'source-1',
        sourceUrl: entryUrl,
        cube: { url: cubeUrl, sha256 },
        trustedContract: { inputTransfer: 'logc3' },
        tags: ['film-print'],
      },
      issues: [],
    })
  })

  it('falls back to catalog summary rows when a selected entry manifest cannot be fetched', async () => {
    const fetchJson = createFetchJson({})
    const catalogEntry: OnlineLUTSourceEntry = {
      id: 'kodak-2383-rec709',
      resourceId: 'source-1',
      title: 'Kodak 2383 Rec.709',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256, bytes: 12, title: 'Kodak 2383 Rec.709' },
      tags: [],
    }

    const entryResolution = await resolveOnlineLUTSourceEntry(catalogEntry, {
      fetchJson,
      maxJsonBytes: 2345,
    })

    expect(entryResolution.entry).toEqual(catalogEntry)
    expect(entryResolution.issues).toMatchObject([
      {
        code: 'network',
        resourceId: 'source-1',
        entryId: 'kodak-2383-rec709',
        sourceUrl: entryUrl,
      },
    ])
  })

  it('adds an entry resource by fetching only that entry manifest', async () => {
    const fetchJson = createFetchJson({ [entryUrl]: entryManifest() })

    const resolution = await resolveProfileSourceResource(
      resource({
        id: 'entry-source',
        url: entryUrl,
        type: 'entry',
        label: 'Entry from profiles.example.com',
      }),
      { fetchJson, maxJsonBytes: 2048 },
    )

    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenCalledWith(entryUrl, {
      signal: undefined,
      maxBytes: 2048,
    })
    expect(resolution.entries).toMatchObject([
      {
        id: 'kodak-2383-rec709',
        resourceId: 'entry-source',
        sourceUrl: entryUrl,
        trustedContract: { outputTransfer: 'gamma24' },
      },
    ])
  })

  it('adds a direct CUBE resource without fetching JSON or bytes', async () => {
    const fetchJson = createFetchJson({})
    const resolution = await resolveProfileSourceResource(
      resource({
        id: 'cube-source',
        url: cubeUrl,
        type: 'cube',
        label: 'Kodak Cube',
      }),
      { fetchJson, maxJsonBytes: 2048 },
    )

    expect(fetchJson).not.toHaveBeenCalled()
    expect(resolution.entries).toEqual([
      {
        id: 'cube-source',
        resourceId: 'cube-source',
        title: 'Kodak Cube',
        sourceUrl: cubeUrl,
        sourceType: 'direct-cube',
        cube: { url: cubeUrl, sha256: '', title: 'Kodak Cube' },
        tags: [],
      },
    ])
  })

  it('preserves invalid query issues while merging valid resources', async () => {
    const existingIssue: OnlineLUTSourceIssue = {
      code: 'invalid-url',
      message: 'Source URL is invalid.',
      raw: 'not-a-url',
    }
    const fetchJson = createFetchJson({ [entryUrl]: entryManifest() })
    const resolution = await resolveProfileSourceResource(
      resource({ id: 'entry-source', url: entryUrl, type: 'entry' }),
      { fetchJson, maxJsonBytes: 2048 },
    )
    const state = mergeOnlineLUTSourceResolution(
      emptyState({ issues: [existingIssue] }),
      resolution,
    )

    expect(state.issues).toContainEqual(existingIssue)
    expect(state.entries).toHaveLength(1)
  })

  it('dedupes duplicate resources by normalized URL and keeps the older id', async () => {
    const oldResource = resource({
      id: 'old-source',
      url: entryUrl,
      type: 'entry',
    })
    const fetchJson = createFetchJson({ [entryUrl]: entryManifest() })
    const resolution = await resolveProfileSourceResource(
      resource({
        id: 'new-source',
        url: entryUrl,
        type: 'entry',
      }),
      { fetchJson, maxJsonBytes: 2048 },
    )
    const state = mergeOnlineLUTSourceResolution(
      emptyState({ resources: [oldResource] }),
      resolution,
    )

    expect(state.resources).toEqual([oldResource])
    expect(state.entries).toMatchObject([{ resourceId: 'old-source' }])
    expect(state.activeResourceId).toBe('old-source')
  })

  it('retargets synthetic resolution issues to the merged resource id so removal cleans them up', () => {
    const state = mergeOnlineLUTSourceResolution(emptyState(), {
      resource: resource({ id: 'issue-source', url: entryUrl, type: 'entry' }),
      entries: [],
      issues: [
        {
          code: 'invalid-entry',
          message: 'Release entry shape is invalid.',
          sourceUrl: entryUrl,
        },
      ],
    })

    expect(state.issues).toEqual([
      {
        code: 'invalid-entry',
        message: 'Release entry shape is invalid.',
        resourceId: 'issue-source',
        sourceUrl: entryUrl,
      },
    ])

    expect(removeOnlineLUTSourceResource(state, 'issue-source').issues).toEqual(
      [],
    )
  })

  it('removes stale entries and issues for both ids when duplicate URL merges keep the older id', () => {
    const oldResource = resource({
      id: 'old-source',
      url: entryUrl,
      type: 'entry',
    })
    const newResource = resource({
      id: 'new-source',
      url: entryUrl,
      type: 'entry',
    })
    const unrelatedResource = resource({
      id: 'unrelated-source',
      url: secondEntryUrl,
      type: 'entry',
    })
    const oldEntry: OnlineLUTSourceEntry = {
      id: 'old-entry',
      resourceId: 'old-source',
      title: 'Old Entry',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256 },
      tags: [],
    }
    const newEntry: OnlineLUTSourceEntry = {
      ...oldEntry,
      id: 'new-entry',
      resourceId: 'new-source',
    }
    const unrelatedEntry: OnlineLUTSourceEntry = {
      ...oldEntry,
      id: 'unrelated-entry',
      resourceId: 'unrelated-source',
      sourceUrl: secondEntryUrl,
    }
    const oldIssue: OnlineLUTSourceIssue = {
      code: 'network',
      message: 'Old issue.',
      resourceId: 'old-source',
    }
    const newIssue: OnlineLUTSourceIssue = {
      code: 'network',
      message: 'New issue.',
      resourceId: 'new-source',
    }
    const unrelatedIssue: OnlineLUTSourceIssue = {
      code: 'network',
      message: 'Unrelated issue.',
      resourceId: 'unrelated-source',
    }

    const state = mergeOnlineLUTSourceResolution(
      emptyState({
        resources: [oldResource, newResource, unrelatedResource],
        entries: [oldEntry, newEntry, unrelatedEntry],
        issues: [oldIssue, newIssue, unrelatedIssue],
      }),
      {
        resource: newResource,
        entries: [
          {
            ...newEntry,
            id: 'fresh-entry',
          },
        ],
        issues: [
          {
            code: 'invalid-entry',
            message: 'Fresh issue.',
            resourceId: 'new-source',
          },
        ],
      },
    )

    expect(state.resources).toEqual([oldResource, unrelatedResource])
    expect(state.entries).toEqual([
      unrelatedEntry,
      {
        ...newEntry,
        id: 'fresh-entry',
        resourceId: 'old-source',
      },
    ])
    expect(state.issues).toEqual([
      unrelatedIssue,
      {
        code: 'invalid-entry',
        message: 'Fresh issue.',
        resourceId: 'old-source',
      },
    ])
    expect(state.activeResourceId).toBe('old-source')
  })

  it('removes entries and issues owned only by a removed resource while preserving others', () => {
    const removedEntry: OnlineLUTSourceEntry = {
      id: 'removed',
      resourceId: 'removed-source',
      title: 'Removed',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256 },
      tags: [],
    }
    const keptEntry: OnlineLUTSourceEntry = {
      ...removedEntry,
      id: 'kept',
      resourceId: 'kept-source',
    }
    const removedIssue: OnlineLUTSourceIssue = {
      code: 'network',
      message: 'Failed.',
      resourceId: 'removed-source',
    }
    const keptIssue: OnlineLUTSourceIssue = {
      code: 'network',
      message: 'Failed.',
      resourceId: 'kept-source',
    }
    const state = removeOnlineLUTSourceResource(
      emptyState({
        resources: [
          resource({ id: 'removed-source' }),
          resource({ id: 'kept-source' }),
        ],
        entries: [removedEntry, keptEntry],
        issues: [removedIssue, keptIssue],
        activeResourceId: 'removed-source',
      }),
      'removed-source',
    )

    expect(state.resources).toMatchObject([{ id: 'kept-source' }])
    expect(state.entries).toEqual([keptEntry])
    expect(state.issues).toEqual([keptIssue])
    expect(state.activeResourceId).toBeNull()
  })

  it('refreshes catalog metadata by re-fetching JSON but never fetching CUBE bytes', async () => {
    const fetchJson = createFetchJson({
      [catalogUrl]: catalogDocument(),
    })

    const first = await resolveProfileSourceResource(resource({}), {
      fetchJson,
      maxJsonBytes: 2048,
    })
    const firstState = mergeOnlineLUTSourceResolution(emptyState(), first)
    const second = await resolveProfileSourceResource(resource({}), {
      fetchJson,
      maxJsonBytes: 2048,
    })
    const refreshed = mergeOnlineLUTSourceResolution(firstState, second)

    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([
      catalogUrl,
      catalogUrl,
    ])
    expect(refreshed.entries).toHaveLength(1)
  })

  it('refresh failure removes stale entries and excludes the failed resource from sharing', () => {
    const validResource = resource({
      id: 'entry-source',
      url: entryUrl,
      type: 'entry',
    })
    const entry: OnlineLUTSourceEntry = {
      id: 'kodak-2383-rec709',
      resourceId: 'entry-source',
      title: 'Kodak 2383 Rec.709',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256 },
      tags: [],
    }
    const initialState = emptyState({
      resources: [validResource],
      entries: [entry],
    })

    const failedRefresh = mergeOnlineLUTSourceResolution(initialState, {
      resource: validResource,
      entries: [],
      issues: [
        {
          code: 'network',
          message: 'Failed to refresh.',
          resourceId: 'entry-source',
          sourceUrl: entryUrl,
        },
      ],
    })

    expect(failedRefresh.entries).toEqual([])
    expect(failedRefresh.issues).toEqual([
      {
        code: 'network',
        message: 'Failed to refresh.',
        resourceId: 'entry-source',
        sourceUrl: entryUrl,
      },
    ])
    expect(getShareableOnlineLUTSourceResources(failedRefresh)).toEqual([])
  })

  it('builds share resources from valid source rows only', () => {
    const valid = resource({ id: 'valid-source', url: entryUrl, type: 'entry' })
    const invalid = resource({
      id: 'invalid-source',
      url: secondEntryUrl,
      type: 'entry',
    })
    const entry: OnlineLUTSourceEntry = {
      id: 'kodak-2383-rec709',
      resourceId: 'valid-source',
      title: 'Kodak 2383 Rec.709',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256 },
      tags: [],
    }

    expect(
      getShareableOnlineLUTSourceResources(
        emptyState({
          resources: [valid, invalid],
          entries: [entry],
          issues: [
            {
              code: 'invalid-entry',
              message: 'Release entry shape is invalid.',
              resourceId: 'invalid-source',
            },
          ],
        }),
      ),
    ).toEqual([valid])
  })
})

describe('online LUT catalog activation', () => {
  it('reports a resolution ready when it lists entries or fails nothing', () => {
    const entry: OnlineLUTSourceEntry = {
      id: 'kodak-2383-rec709',
      resourceId: 'source-1',
      title: 'Kodak 2383 Rec.709',
      sourceUrl: entryUrl,
      sourceType: 'catalog-entry',
      cube: { url: cubeUrl, sha256 },
      tags: [],
    }

    expect(
      getOnlineLUTSourceResolutionActivation({
        resource: resource({}),
        entries: [entry],
        issues: [],
      }),
    ).toBe('ready')
    // An empty catalog is a settled answer, not a failure to retry.
    expect(
      getOnlineLUTSourceResolutionActivation({
        resource: resource({}),
        entries: [],
        issues: [],
      }),
    ).toBe('ready')
  })

  it('reports a resolution that only produced issues as an error', () => {
    expect(
      getOnlineLUTSourceResolutionActivation({
        resource: resource({}),
        entries: [],
        issues: [
          {
            code: 'network',
            message: 'Failed to fetch.',
            resourceId: 'source-1',
          },
        ],
      }),
    ).toBe('error')
  })

  it('summarizes resource activation with in-flight and untouched sources first', () => {
    expect(summarizeOnlineLUTCatalogActivation([])).toBe('ready')
    expect(summarizeOnlineLUTCatalogActivation(['ready', 'inactive'])).toBe(
      'inactive',
    )
    expect(
      summarizeOnlineLUTCatalogActivation(['inactive', 'loading', 'error']),
    ).toBe('loading')
    expect(summarizeOnlineLUTCatalogActivation(['error', 'ready'])).toBe(
      'ready',
    )
    expect(summarizeOnlineLUTCatalogActivation(['error', 'error'])).toBe(
      'error',
    )
  })

  it('finds a known resource by its normalized URL', () => {
    const known = resource({ id: 'known', url: catalogUrl })

    expect(
      findOnlineLUTSourceResourceByUrl(
        [known],
        'HTTPS://profiles.example.com/releases/v2026.05.01/catalog.json',
      ),
    ).toBe(known)
    expect(findOnlineLUTSourceResourceByUrl([known], entryUrl)).toBeUndefined()
    expect(
      findOnlineLUTSourceResourceByUrl([known], 'not a url'),
    ).toBeUndefined()
  })
})

describe('online LUT source registry', () => {
  function memoryStorage(initial?: unknown): Storage {
    const items = new Map<string, string>()
    if (initial !== undefined) {
      items.set('lumaforge.raw.onlineLutSources.v1', JSON.stringify(initial))
    }
    return {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      getItem: (key) => items.get(key) ?? null,
      key: (index) => Array.from(items.keys())[index] ?? null,
      removeItem: (key) => {
        items.delete(key)
      },
      setItem: (key, value) => {
        items.set(key, value)
      },
    }
  }

  function storedResources(storage: Storage) {
    return (
      JSON.parse(
        storage.getItem('lumaforge.raw.onlineLutSources.v1') ?? '{}',
      ) as { resources?: unknown[] }
    ).resources
  }

  it('lists a saved copy of the default URL once, as the default', () => {
    const storage = memoryStorage({
      resources: [
        {
          url: 'https://LUMA-PROF.ichr.me/channels/stable/luts/catalog.json',
          type: 'catalog',
          label: 'Saved copy',
        },
        { url: catalogUrl, type: 'catalog', label: 'Saved catalog' },
      ],
      removedDefaultUrls: [],
    })

    expect(
      getInitialOnlineLUTSourceResources({ storage }).map((item) => ({
        id: item.id,
        isDefault: item.isDefault ?? false,
      })),
    ).toEqual([
      { id: 'lumaforge-default-profiles', isDefault: true },
      { id: 'stored-lut-source-2', isDefault: false },
    ])
  })

  it('keeps a saved source at the default URL while the default is removed', () => {
    const storage = memoryStorage({
      resources: [
        {
          url: DEFAULT_LUMAFORGE_PROFILE_SOURCE.url,
          type: 'catalog',
          label: 'Saved copy',
        },
      ],
      removedDefaultUrls: [DEFAULT_LUMAFORGE_PROFILE_SOURCE.url],
    })

    expect(getInitialOnlineLUTSourceResources({ storage })).toEqual([
      expect.objectContaining({
        id: 'stored-lut-source-1',
        url: DEFAULT_LUMAFORGE_PROFILE_SOURCE.url,
        label: 'Saved copy',
      }),
    ])
  })

  it('saves a source at the default URL only while the default is removed', () => {
    const copy = {
      ...DEFAULT_LUMAFORGE_PROFILE_SOURCE,
      id: 'lut-source-1',
      isDefault: undefined,
    }
    const listed = memoryStorage()
    const removed = memoryStorage({
      resources: [],
      removedDefaultUrls: [DEFAULT_LUMAFORGE_PROFILE_SOURCE.url],
    })

    persistOnlineLUTSourceResource(copy, { storage: listed })
    persistOnlineLUTSourceResource(copy, { storage: removed })

    expect(storedResources(listed) ?? []).toEqual([])
    expect(storedResources(removed)).toEqual([
      expect.objectContaining({ url: DEFAULT_LUMAFORGE_PROFILE_SOURCE.url }),
    ])
  })
})
