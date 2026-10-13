import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  ONLINE_LUT_MAX_JSON_BYTES,
  ONLINE_LUT_SOURCE_STORAGE_KEY,
  persistOnlineLUTSourceRemoval,
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
  overrides: Partial<ProfileSourceResource> = {},
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

function entryManifest(): Record<string, unknown> {
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
  }
}

function catalogDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entries: [
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
  }
}

function sourceEntry(
  overrides: Partial<OnlineLUTSourceEntry> = {},
): OnlineLUTSourceEntry {
  return {
    id: 'kodak-2383-rec709',
    resourceId: 'source-1',
    title: 'Kodak 2383 Rec.709',
    sourceUrl: entryUrl,
    sourceType: 'catalog-entry',
    cube: { url: cubeUrl, sha256 },
    tags: [],
    ...overrides,
  }
}

function issue(
  message: string,
  overrides: Partial<OnlineLUTSourceIssue> = {},
): OnlineLUTSourceIssue {
  return { code: 'network', message, ...overrides }
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

/** Serves JSON fixtures by URL; a CUBE byte request fails the test. */
function createFetchJson(fixtures: Record<string, unknown>) {
  const mock = vi.fn(
    async (
      url: string,
      _options: { signal?: AbortSignal; maxBytes: number },
    ): Promise<unknown> => {
      if (url.endsWith('.cube')) {
        throw new Error(`CUBE bytes must not be fetched: ${url}`)
      }
      if (!(url in fixtures)) throw new Error(`Missing fixture for ${url}`)
      return fixtures[url]
    },
  )

  return mock as typeof fetchJsonWithLimit & typeof mock
}

const jsonRequest = (url: string) =>
  [url, { signal: undefined, maxBytes: ONLINE_LUT_MAX_JSON_BYTES }] as const

describe('online LUT source metadata service', () => {
  it("lists catalog rows from the catalog JSON alone and fetches a row's entry manifest only when it is resolved", async () => {
    const fetchJson = createFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const resolution = await resolveProfileSourceResource(resource(), {
      fetchJson,
    })

    expect(fetchJson.mock.calls).toEqual([jsonRequest(catalogUrl)])
    expect(resolution.issues).toEqual([])
    expect(resolution.entries).toMatchObject([
      {
        id: 'kodak-2383-rec709',
        resourceId: 'source-1',
        sourceUrl: entryUrl,
        cube: { url: cubeUrl, sha256 },
        trustedContract: undefined,
      },
    ])

    fetchJson.mockClear()
    const entryResolution = await resolveOnlineLUTSourceEntry(
      resolution.entries[0],
      { fetchJson },
    )

    expect(fetchJson.mock.calls).toEqual([jsonRequest(entryUrl)])
    expect(entryResolution).toMatchObject({
      entry: {
        id: 'kodak-2383-rec709',
        resourceId: 'source-1',
        trustedContract: { inputTransfer: 'logc3' },
        tags: ['film-print'],
      },
      issues: [],
    })
  })

  it('keeps the catalog row when its entry manifest cannot be fetched', async () => {
    const row = sourceEntry()

    const resolution = await resolveOnlineLUTSourceEntry(row, {
      fetchJson: createFetchJson({}),
    })

    expect(resolution.entry).toBe(row)
    expect(resolution.issues).toMatchObject([
      {
        code: 'network',
        resourceId: 'source-1',
        entryId: 'kodak-2383-rec709',
        sourceUrl: entryUrl,
      },
    ])
  })

  it('adds an entry resource by fetching only its manifest', async () => {
    const fetchJson = createFetchJson({ [entryUrl]: entryManifest() })

    const resolution = await resolveProfileSourceResource(
      resource({ id: 'entry-source', url: entryUrl, type: 'entry' }),
      { fetchJson },
    )

    expect(fetchJson.mock.calls).toEqual([jsonRequest(entryUrl)])
    expect(resolution.entries).toMatchObject([
      {
        id: 'kodak-2383-rec709',
        resourceId: 'entry-source',
        trustedContract: { outputTransfer: 'gamma24' },
      },
    ])
  })

  it.each([
    ['its label', 'Kodak Cube', 'Kodak Cube'],
    ['its file name without a label', '', `${sha256}.cube`],
  ])(
    'adds a direct CUBE resource titled by %s without fetching anything',
    async (_, label, title) => {
      const fetchJson = createFetchJson({})

      const resolution = await resolveProfileSourceResource(
        resource({ id: 'cube-source', url: cubeUrl, type: 'cube', label }),
        { fetchJson },
      )

      expect(fetchJson).not.toHaveBeenCalled()
      expect(resolution.entries).toEqual([
        {
          id: 'cube-source',
          resourceId: 'cube-source',
          title,
          sourceUrl: cubeUrl,
          sourceType: 'direct-cube',
          cube: { url: cubeUrl, sha256: '', title },
          tags: [],
        },
      ])
    },
  )

  it('keeps loose input issues when a resolution merges', () => {
    const inputIssue = issue('Source URL is invalid.', {
      code: 'invalid-url',
      raw: 'not-a-url',
    })

    const state = mergeOnlineLUTSourceResolution(
      emptyState({ issues: [inputIssue] }),
      { resource: resource(), entries: [sourceEntry()], issues: [] },
    )

    expect(state.issues).toEqual([inputIssue])
    expect(state.entries).toHaveLength(1)
  })

  it('merges a duplicate URL into the older source, replacing what either id held', () => {
    const older = resource({ id: 'old-source', url: entryUrl, type: 'entry' })
    const newer = resource({ id: 'new-source', url: entryUrl, type: 'entry' })
    const unrelated = resource({
      id: 'unrelated-source',
      url: secondEntryUrl,
      type: 'entry',
    })
    const unrelatedEntry = sourceEntry({
      id: 'unrelated-entry',
      resourceId: 'unrelated-source',
    })
    const unrelatedIssue = issue('Unrelated.', {
      resourceId: 'unrelated-source',
    })

    const state = mergeOnlineLUTSourceResolution(
      emptyState({
        resources: [older, newer, unrelated],
        entries: [
          sourceEntry({ id: 'old-entry', resourceId: 'old-source' }),
          sourceEntry({ id: 'new-entry', resourceId: 'new-source' }),
          unrelatedEntry,
        ],
        issues: [
          issue('Old.', { resourceId: 'old-source' }),
          issue('New.', { resourceId: 'new-source' }),
          unrelatedIssue,
        ],
      }),
      {
        resource: newer,
        entries: [sourceEntry({ id: 'fresh', resourceId: 'new-source' })],
        issues: [issue('Fresh.', { resourceId: 'new-source' })],
      },
    )

    expect(state).toEqual({
      resources: [older, unrelated],
      entries: [
        unrelatedEntry,
        sourceEntry({ id: 'fresh', resourceId: 'old-source' }),
      ],
      issues: [unrelatedIssue, issue('Fresh.', { resourceId: 'old-source' })],
      activeResourceId: 'old-source',
      isLoading: false,
    })
  })

  it('retargets resolution issues to the merged source so its removal clears them', () => {
    const state = mergeOnlineLUTSourceResolution(emptyState(), {
      resource: resource({ id: 'issue-source' }),
      entries: [],
      issues: [issue('Release entry shape is invalid.')],
    })

    expect(state.issues).toEqual([
      issue('Release entry shape is invalid.', { resourceId: 'issue-source' }),
    ])
    expect(removeOnlineLUTSourceResource(state, 'issue-source').issues).toEqual(
      [],
    )
  })

  it('removes only what a removed source owns and drops it as the active source', () => {
    const kept = sourceEntry({ id: 'kept', resourceId: 'kept-source' })
    const keptIssue = issue('Failed.', { resourceId: 'kept-source' })

    const state = removeOnlineLUTSourceResource(
      emptyState({
        resources: [
          resource({ id: 'removed-source' }),
          resource({ id: 'kept-source' }),
        ],
        entries: [sourceEntry({ resourceId: 'removed-source' }), kept],
        issues: [issue('Failed.', { resourceId: 'removed-source' }), keptIssue],
        activeResourceId: 'removed-source',
      }),
      'removed-source',
    )

    expect(state.resources).toMatchObject([{ id: 'kept-source' }])
    expect(state.entries).toEqual([kept])
    expect(state.issues).toEqual([keptIssue])
    expect(state.activeResourceId).toBeNull()
  })

  it('replaces the entries of a refreshed source, and a failed refresh leaves it nothing to share', () => {
    const listed = resource({ fromQuery: false })
    const state = emptyState({
      resources: [listed],
      entries: [sourceEntry()],
    })

    const refreshed = mergeOnlineLUTSourceResolution(state, {
      resource: listed,
      entries: [sourceEntry()],
      issues: [],
    })
    expect(refreshed.entries).toEqual([sourceEntry()])
    expect(getShareableOnlineLUTSourceResources(refreshed)).toEqual([listed])

    const failedIssue = issue('Failed to refresh.', { resourceId: 'source-1' })
    const failed = mergeOnlineLUTSourceResolution(state, {
      resource: listed,
      entries: [],
      issues: [failedIssue],
    })
    expect(failed.entries).toEqual([])
    expect(failed.issues).toEqual([failedIssue])
    expect(getShareableOnlineLUTSourceResources(failed)).toEqual([])
  })

  it('shares only non-default sources that list entries', () => {
    const listing = resource({ id: 'listing' })
    const empty = resource({ id: 'empty', url: secondEntryUrl })
    const defaultSource = { ...DEFAULT_LUMAFORGE_PROFILE_SOURCE }

    expect(
      getShareableOnlineLUTSourceResources(
        emptyState({
          resources: [listing, empty, defaultSource],
          entries: [
            sourceEntry({ resourceId: 'listing' }),
            sourceEntry({ resourceId: defaultSource.id }),
          ],
          issues: [issue('Invalid.', { resourceId: 'empty' })],
        }),
      ),
    ).toEqual([listing])
  })
})

describe('online LUT catalog activation', () => {
  it.each([
    ['ready when it lists entries', [sourceEntry()], [], 'ready'],
    // An empty catalog is a settled answer, not a failure to retry.
    ['ready when it lists nothing and fails nothing', [], [], 'ready'],
    ['an error when it only reports issues', [], [issue('Failed.')], 'error'],
  ])('reports a resolution %s', (_, entries, issues, activation) => {
    expect(
      getOnlineLUTSourceResolutionActivation({
        resource: resource(),
        entries,
        issues,
      }),
    ).toBe(activation)
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
    const known = resource({ id: 'known' })

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
  const defaultUrl = DEFAULT_LUMAFORGE_PROFILE_SOURCE.url

  beforeEach(() => {
    localStorage.clear()
  })

  const seed = (registry: unknown) =>
    localStorage.setItem(
      ONLINE_LUT_SOURCE_STORAGE_KEY,
      JSON.stringify(registry),
    )
  const storedResources = () =>
    (
      JSON.parse(
        localStorage.getItem(ONLINE_LUT_SOURCE_STORAGE_KEY) ?? '{}',
      ) as { resources?: unknown[] }
    ).resources ?? []
  const listedIds = () =>
    getInitialOnlineLUTSourceResources().map((item) => item.id)

  it('lists a saved source on the next load and forgets it once removed', () => {
    const added = resource({ id: 'lut-source-1', fromQuery: false })

    persistOnlineLUTSourceResource(added)
    expect(getInitialOnlineLUTSourceResources()).toEqual([
      expect.objectContaining({ id: 'lumaforge-default-profiles' }),
      {
        id: 'stored-lut-source-1',
        url: catalogUrl,
        type: 'catalog',
        label: added.label,
        fromQuery: false,
      },
    ])

    persistOnlineLUTSourceRemoval(added)
    expect(listedIds()).toEqual(['lumaforge-default-profiles'])
  })

  it('keeps a removed default hidden until its tombstone is gone', () => {
    persistOnlineLUTSourceRemoval({ ...DEFAULT_LUMAFORGE_PROFILE_SOURCE })
    expect(listedIds()).toEqual([])

    localStorage.clear()
    expect(listedIds()).toEqual(['lumaforge-default-profiles'])
  })

  it('keeps the default hidden for users who removed it at its legacy flat-catalog URL', () => {
    seed({
      resources: [],
      removedDefaultUrls: [
        'https://luma-prof.ichr.me/channels/stable/catalog.json',
      ],
    })

    expect(listedIds()).toEqual([])
  })

  it('lists a saved copy of the default URL once, as the default', () => {
    seed({
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

    expect(listedIds()).toEqual([
      'lumaforge-default-profiles',
      'stored-lut-source-2',
    ])
  })

  it('keeps a saved source at the default URL while the default is removed', () => {
    seed({
      resources: [{ url: defaultUrl, type: 'catalog', label: 'Saved copy' }],
      removedDefaultUrls: [defaultUrl],
    })

    expect(getInitialOnlineLUTSourceResources()).toEqual([
      expect.objectContaining({
        id: 'stored-lut-source-1',
        url: defaultUrl,
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

    persistOnlineLUTSourceResource(copy)
    expect(storedResources()).toEqual([])

    seed({ resources: [], removedDefaultUrls: [defaultUrl] })
    persistOnlineLUTSourceResource(copy)
    expect(storedResources()).toEqual([
      expect.objectContaining({ url: defaultUrl }),
    ])
  })
})
