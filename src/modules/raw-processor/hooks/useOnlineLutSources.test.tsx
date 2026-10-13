import type { RenderHookResult } from '@testing-library/react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchJsonWithLimit } from '~/lib/profiles/fetch'

import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import type {
  UseOnlineLutSourcesOptions,
  UseOnlineLutSourcesResult,
} from './useOnlineLutSources'
import { useOnlineLutSources } from './useOnlineLutSources'

vi.mock('~/lib/profiles/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/profiles/fetch')>()),
  fetchJsonWithLimit: vi.fn(),
}))

const mockedFetchJson = vi.mocked(fetchJsonWithLimit)

const sha256 =
  '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab'
const catalogUrl =
  'https://profiles.example.com/releases/v2026.05.01/catalog.json'
const defaultCatalogUrl =
  'https://luma-prof.ichr.me/channels/stable/luts/catalog.json'
const entryUrl =
  'https://profiles.example.com/releases/v2026.05.01/entries/kodak-2383-rec709.json'
const secondEntryUrl =
  'https://profiles.example.com/releases/v2026.05.01/entries/ektachrome-e100.json'
const cubeUrl = `https://profiles.example.com/blobs/sha256/9c/56/${sha256}.cube`
const sourcesStorageKey = 'lumaforge.raw.onlineLutSources.v1'
const DEFAULT_ID = 'lumaforge-default-profiles'
const ENTRY_ID = 'kodak-2383-rec709'

const primaryAsset = {
  role: 'cube-lut',
  mediaType: 'application/x-cube-lut',
  size: 12,
  sha256,
  url: cubeUrl,
}

function entryManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: ENTRY_ID,
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

function catalogDocument() {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: ENTRY_ID,
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

const luts = (...urls: string[]) =>
  `?${urls.map((url) => `luts=${encodeURIComponent(url)}`).join('&')}`

function createLoadOnlineLUT() {
  return vi.fn(
    async (
      _entry: OnlineLUTEntry,
      _options?: { signal?: AbortSignal },
    ): Promise<LutLoadOutcome> => 'loaded',
  )
}

/**
 * A LUT load that reports some progress, then waits for `settle` or for its
 * signal to abort it.
 */
function createPendingLoad() {
  let settle!: (outcome: LutLoadOutcome) => void
  const loadOnlineLUT = vi.fn(
    (
      _entry: OnlineLUTEntry,
      options?: {
        signal?: AbortSignal
        onProgress?: (received: number, total?: number) => void
      },
    ) =>
      new Promise<LutLoadOutcome>((resolve) => {
        settle = resolve
        options?.signal?.addEventListener('abort', () => resolve('aborted'))
        options?.onProgress?.(1024, 4096)
      }),
  )
  return { loadOnlineLUT, settle: (outcome: LutLoadOutcome) => settle(outcome) }
}

function setupFetchJson(fixtures: Record<string, unknown> = {}) {
  const documents: Record<string, unknown> = {
    [catalogUrl]: catalogDocument(),
    [entryUrl]: entryManifest(),
    ...fixtures,
  }
  mockedFetchJson.mockImplementation(async (url) => {
    if (!(url in documents)) throw new Error(`Missing fixture for ${url}`)
    return documents[url]
  })
}

function setupDeferredFetchJson() {
  const requests: Array<{
    url: string
    signal?: AbortSignal
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }> = []
  mockedFetchJson.mockImplementation(
    (url, options) =>
      new Promise<unknown>((resolve, reject) => {
        requests.push({ url, signal: options.signal, resolve, reject })
      }),
  )
  return { requests }
}

function storeSource(url: string) {
  localStorage.setItem(
    sourcesStorageKey,
    JSON.stringify({
      resources: [{ url, type: 'catalog', label: 'Saved catalog' }],
      removedDefaultUrls: [],
    }),
  )
}

function renderSources({
  wrapper,
  loadOnlineLUT = createLoadOnlineLUT(),
  ...options
}: Partial<UseOnlineLutSourcesOptions> & {
  wrapper?: typeof StrictMode
} = {}) {
  return renderHook(
    (props: Partial<UseOnlineLutSourcesOptions>) =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT,
        ...options,
        ...props,
      }),
    { wrapper, initialProps: {} },
  )
}

/** The hook with the `?luts=` catalog listed and its one row loaded. */
async function renderListedCatalog(
  options: Partial<UseOnlineLutSourcesOptions> = {},
  fixtures?: Record<string, unknown>,
) {
  setupFetchJson(fixtures)
  const hook = renderSources({ search: luts(catalogUrl), ...options })
  await waitFor(() => expect(hook.result.current.state.entries).toHaveLength(1))
  return hook
}

type SourcesHook = RenderHookResult<
  UseOnlineLutSourcesResult,
  Partial<UseOnlineLutSourcesOptions>
>

async function addSource({ result }: SourcesHook, url: string) {
  act(() => result.current.setSourceUrlInput(url))
  await act(async () => {
    await result.current.addSourceFromInput()
  })
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useOnlineLutSources', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset()
    localStorage.clear()
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => {}) },
    })
  })

  describe('sources', () => {
    it('requests a source the user adds at once and keeps it, and a removed default, for the next mount', () => {
      const { requests } = setupDeferredFetchJson()
      const first = renderSources()
      act(() => first.result.current.setSourceUrlInput(catalogUrl))
      act(() => {
        void first.result.current.addSourceFromInput()
      })

      expect(requests.map((request) => request.url)).toEqual([catalogUrl])
      expect(first.result.current.resourceActivation).toEqual({
        'lut-source-1': 'loading',
      })
      act(() => first.result.current.removeSource(DEFAULT_ID))
      first.unmount()

      const second = renderSources()
      expect(second.result.current.state.resources).toEqual([
        expect.objectContaining({ id: 'stored-lut-source-1', url: catalogUrl }),
      ])
      act(() => second.result.current.removeSource('stored-lut-source-1'))
      second.unmount()

      expect(renderSources().result.current.state.resources).toEqual([])
      expect(requests).toHaveLength(1)
    })

    it('requests a ?luts= source that arrives while mounted once, listing what the link could not use as issues', async () => {
      setupFetchJson()
      const hook = renderSources()
      expect(mockedFetchJson).not.toHaveBeenCalled()

      const search = luts('ftp://example.com/look.cube', catalogUrl)
      hook.rerender({ search })
      await waitFor(() =>
        expect(hook.result.current.state.entries).toHaveLength(1),
      )
      hook.rerender({ search: `${search}&utm=1` })

      expect(mockedFetchJson).toHaveBeenCalledTimes(1)
      expect(hook.result.current.state.entries).toHaveLength(1)
      expect(hook.result.current.state.issues).toEqual([
        expect.objectContaining({
          code: 'unsupported-scheme',
          raw: 'ftp://example.com/look.cube',
        }),
      ])
    })

    it('replaces input issues on each attempt and clears them once a source is added', async () => {
      setupFetchJson()
      const hook = renderSources()
      const looseIssues = () =>
        hook.result.current.state.issues.filter((issue) => !issue.resourceId)

      await addSource(hook, 'first invalid')
      await addSource(hook, 'second invalid')
      expect(looseIssues()).toHaveLength(1)

      await addSource(hook, catalogUrl)
      await waitFor(() =>
        expect(hook.result.current.state.entries).toHaveLength(1),
      )
      expect(looseIssues()).toEqual([])
    })

    it('stays loading until every concurrent source request settles', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources({
        search: luts(entryUrl, secondEntryUrl),
      })
      expect(requests).toHaveLength(2)
      expect(result.current.state.isLoading).toBe(true)

      await act(async () => {
        requests[0].resolve(entryManifest())
      })
      expect(result.current.state.entries).toHaveLength(1)
      expect(result.current.state.isLoading).toBe(true)

      await act(async () => {
        requests[1].reject(new Error('offline'))
      })
      expect(result.current.state.isLoading).toBe(false)
    })

    it('requests only the source a ?luts= link names and shares it', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources({ search: luts(catalogUrl) })
      expect(requests.map((request) => request.url)).toEqual([catalogUrl])

      await act(async () => {
        requests[0].resolve(catalogDocument())
      })
      expect(result.current.resourceActivation).toEqual({
        'lut-source-1': 'ready',
      })
      const shareUrl = `/raw${luts(catalogUrl)}`
      expect(result.current.share).toMatchObject({
        enabled: true,
        url: shareUrl,
      })

      await act(() => result.current.share.copy())
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(shareUrl)
    })

    it.each([
      ['no source lists entries', '', 0, true],
      ['the browser can neither copy nor share', luts(catalogUrl), 1, false],
    ])('keeps Share disabled when %s', async (_, search, entries, canCopy) => {
      if (!canCopy) vi.stubGlobal('navigator', {})
      setupFetchJson()
      const { result } = renderSources({ search })

      await waitFor(() =>
        expect(result.current.state.entries).toHaveLength(entries),
      )
      expect(result.current.share.enabled).toBe(false)
    })
  })

  describe('entry loads', () => {
    it('shares the loading entry and its progress, then marks it failed', async () => {
      const { loadOnlineLUT, settle } = createPendingLoad()
      const { result } = await renderListedCatalog({ loadOnlineLUT })
      let loading!: Promise<LutLoadOutcome>
      act(() => {
        loading = result.current.loadEntry(ENTRY_ID)
      })

      await waitFor(() =>
        expect(result.current.entryLoadProgress).toMatchObject({
          entryId: ENTRY_ID,
          receivedBytes: 1024,
        }),
      )
      expect(result.current.loadingEntryId).toBe(ENTRY_ID)

      await act(async () => {
        settle('failed')
        await loading
      })
      expect(result.current).toMatchObject({
        loadingEntryId: null,
        entryLoadProgress: null,
        failedEntryId: ENTRY_ID,
      })
    })

    it('ignores a second load while one is in flight', async () => {
      const { loadOnlineLUT, settle } = createPendingLoad()
      const { result } = await renderListedCatalog({ loadOnlineLUT })
      let first!: Promise<LutLoadOutcome>
      act(() => {
        first = result.current.loadEntry(ENTRY_ID)
      })
      await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(1))

      // A second surface racing in does not take the active load's slot.
      await expect(result.current.loadEntry(ENTRY_ID)).resolves.toBe('aborted')
      expect(loadOnlineLUT).toHaveBeenCalledTimes(1)

      await act(async () => {
        settle('loaded')
        await expect(first).resolves.toBe('loaded')
      })
      expect(result.current.loadingEntryId).toBeNull()
    })

    it('releases the lock on cancel so another entry can load in the same tap', async () => {
      const { loadOnlineLUT } = createPendingLoad()
      const { result } = await renderListedCatalog({ loadOnlineLUT })
      let first!: Promise<LutLoadOutcome>
      let second!: Promise<LutLoadOutcome>
      act(() => {
        first = result.current.loadEntry(ENTRY_ID)
      })
      await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(1))

      await act(async () => {
        result.current.cancelEntryLoad()
        second = result.current.loadEntry(ENTRY_ID)
        await expect(first).resolves.toBe('aborted')
        await vi.waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(2))
      })
      // The aborted load's cleanup leaves the new load's state alone.
      expect(result.current.loadingEntryId).toBe(ENTRY_ID)

      await act(async () => {
        result.current.cancelEntryLoad()
        await expect(second).resolves.toBe('aborted')
      })
      expect(result.current).toMatchObject({
        loadingEntryId: null,
        failedEntryId: null,
        entryLoadProgress: null,
      })
    })

    it('does not mark an entry failed when it is cancelled while its manifest resolves', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources({ search: luts(catalogUrl) })
      await act(async () => {
        requests[0].resolve(catalogDocument())
      })
      let loading!: Promise<LutLoadOutcome>
      act(() => {
        loading = result.current.loadEntry(ENTRY_ID)
      })
      await waitFor(() => expect(requests).toHaveLength(2))

      await act(async () => {
        result.current.cancelEntryLoad()
        requests[1].reject(new DOMException('Aborted', 'AbortError'))
        await expect(loading).resolves.toBe('aborted')
      })
      expect(result.current).toMatchObject({
        failedEntryId: null,
        loadingEntryId: null,
      })
    })

    it('loads the resolved entry manifest but keeps the title the catalog listed', async () => {
      const loadOnlineLUT = createLoadOnlineLUT()
      const { result } = await renderListedCatalog(
        { loadOnlineLUT },
        // The entry manifest names the look without its brand.
        { [entryUrl]: entryManifest({ title: '2383 Rec.709' }) },
      )

      await act(async () => {
        await result.current.loadEntry(ENTRY_ID)
      })

      expect(mockedFetchJson.mock.calls.map(([url]) => url)).toEqual([
        catalogUrl,
        entryUrl,
      ])
      expect(loadOnlineLUT).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '2383 Rec.709',
          trustedContract: expect.objectContaining({ inputTransfer: 'logc3' }),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(result.current.state.entries[0]).toMatchObject({
        title: 'Kodak 2383 Rec.709',
        trustedContract: { outputTransfer: 'gamma24' },
      })
    })

    it('pairs a loaded hashless entry with the hash the session applies for it', async () => {
      const { result, rerender } = renderSources({ search: luts(cubeUrl) })
      await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
      const entryId = result.current.state.entries[0].id

      await act(async () => {
        await result.current.loadEntry(entryId)
      })
      // Not paired until the session reports the hash it applied.
      expect(result.current.loadedEntry).toBeNull()
      rerender({ appliedLutSha256: sha256 })
      expect(result.current.loadedEntry).toEqual({ entryId, sha256 })

      // A later LUT from elsewhere does not re-pair the entry.
      rerender({ appliedLutSha256: 'e'.repeat(64) })
      expect(result.current.loadedEntry).toEqual({ entryId, sha256 })
    })
  })

  describe('catalog activation', () => {
    const requestsFor = (
      requests: ReturnType<typeof setupDeferredFetchJson>['requests'],
      url: string,
    ) => requests.filter((request) => request.url === url)

    it.each([
      ['', undefined],
      [' under StrictMode', StrictMode],
    ])(
      'requests no catalog on mount%s, then each listed source once when a surface asks',
      async (_, wrapper) => {
        storeSource(catalogUrl)
        const { requests } = setupDeferredFetchJson()
        const loadOnlineLUT = createLoadOnlineLUT()
        const { result, rerender } = renderSources({ loadOnlineLUT, wrapper })
        await flushEffects()
        rerender({})
        await flushEffects()

        expect(requests).toHaveLength(0)
        expect(result.current.state.resources).toEqual([
          expect.objectContaining({
            id: DEFAULT_ID,
            label: 'LumaForge Profiles',
            isDefault: true,
          }),
          expect.objectContaining({
            id: 'stored-lut-source-1',
            url: catalogUrl,
            label: 'Saved catalog',
          }),
        ])
        expect(result.current.resourceActivation).toEqual({})
        expect(result.current.catalogActivation).toBe('inactive')
        expect(result.current.state.isLoading).toBe(false)

        act(() => {
          result.current.activateCatalogs()
          result.current.activateCatalogs()
        })
        act(() => result.current.activateCatalogs())
        expect(requests.map((request) => request.url)).toEqual([
          defaultCatalogUrl,
          catalogUrl,
        ])
        expect(requests.some((request) => request.signal?.aborted)).toBe(false)
        expect(result.current.resourceActivation).toEqual({
          [DEFAULT_ID]: 'loading',
          'stored-lut-source-1': 'loading',
        })
        expect(result.current.catalogActivation).toBe('loading')

        await act(async () => {
          for (const request of requests) request.resolve(catalogDocument())
        })
        act(() => result.current.activateCatalogs())

        expect(requests).toHaveLength(2)
        expect(result.current.catalogActivation).toBe('ready')
        expect(result.current.state.entries).toHaveLength(2)
        // Listing a catalog never applies a look.
        expect(loadOnlineLUT).not.toHaveBeenCalled()
        expect(result.current.loadedEntry).toBeNull()
      },
    )

    it('requests an inactive source when the user refreshes it', async () => {
      storeSource(catalogUrl)
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      await flushEffects()

      act(() => {
        void result.current.refreshSource('stored-lut-source-1')
      })

      expect(requests.map((request) => request.url)).toEqual([catalogUrl])
      expect(result.current.resourceActivation).toEqual({
        'stored-lut-source-1': 'loading',
      })
    })

    it('refreshes the listed default when its URL is added, without saving a copy', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      act(() => result.current.setSourceUrlInput(defaultCatalogUrl))

      await act(async () => {
        const added = result.current.addSourceFromInput()
        requests[0]?.resolve(catalogDocument())
        await added
      })

      expect(requests).toHaveLength(1)
      expect(result.current.state.resources).toEqual([
        expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
      ])
      expect(
        JSON.parse(localStorage.getItem(sourcesStorageKey) ?? '{}').resources ??
          [],
      ).toEqual([])
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'ready',
      })
    })

    it('requests one catalog for a default URL that is also saved and named by ?luts=', async () => {
      // Storage written before the default URL was kept out of saved
      // sources still lists a copy of it.
      storeSource(defaultCatalogUrl)
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources({ search: luts(defaultCatalogUrl) })
      act(() => result.current.activateCatalogs())
      expect(requestsFor(requests, defaultCatalogUrl)).toHaveLength(1)

      // Every response lands in the same act, before any effect runs.
      await act(async () => {
        for (const request of requests) request.resolve(catalogDocument())
      })
      act(() => result.current.activateCatalogs())

      expect(requests).toHaveLength(1)
      expect(result.current.state.resources).toEqual([
        expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
      ])
      expect(result.current.state.entries).toEqual([
        expect.objectContaining({ resourceId: DEFAULT_ID }),
      ])
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'ready',
      })
    })

    it('restarts a ?luts= request StrictMode cleanup aborted and ignores its late completion', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources({
        search: luts(defaultCatalogUrl),
        wrapper: StrictMode,
      })

      await waitFor(() => expect(requests).toHaveLength(2))
      const [aborted, live] = requests
      expect(aborted.signal?.aborted).toBe(true)
      expect(live.signal?.aborted).toBe(false)
      act(() => result.current.activateCatalogs())
      expect(requests).toHaveLength(2)

      await act(async () => {
        live.resolve(catalogDocument())
      })
      await act(async () => {
        aborted.resolve({ schemaVersion: 1, entries: [] })
      })
      expect(result.current.state.entries).toHaveLength(1)
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'ready',
      })
    })

    it('aborts a catalog request a refresh supersedes and ignores its late response', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      act(() => result.current.activateCatalogs())
      act(() => {
        void result.current.refreshSource(DEFAULT_ID)
      })

      expect(requests).toHaveLength(2)
      expect(requests[0].signal?.aborted).toBe(true)
      expect(requests[1].signal?.aborted).toBe(false)
      await act(async () => {
        requests[1].resolve(catalogDocument())
      })
      await act(async () => {
        requests[0].resolve({ schemaVersion: 1, entries: [] })
      })

      expect(result.current.state.entries).toHaveLength(1)
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'ready',
      })
    })

    it('keeps a failed source failed until an explicit retry', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      act(() => result.current.activateCatalogs())

      await act(async () => {
        requests[0].reject(new Error('offline'))
      })
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'error',
      })
      expect(result.current.catalogActivation).toBe('error')
      act(() => result.current.activateCatalogs())
      expect(requests).toHaveLength(1)

      act(() => result.current.activateCatalogs({ retryFailed: true }))
      expect(requests).toHaveLength(2)
      await act(async () => {
        requests[1].resolve(catalogDocument())
      })
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'ready',
      })
      expect(
        result.current.state.issues.filter((issue) => issue.resourceId),
      ).toEqual([])
    })

    it('activates only the named sources', async () => {
      storeSource(catalogUrl)
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      act(() => result.current.activateCatalogs())
      await act(async () => {
        for (const request of requests) request.reject(new Error('offline'))
      })

      act(() =>
        result.current.activateCatalogs({
          resourceIds: ['stored-lut-source-1'],
          retryFailed: true,
        }),
      )

      expect(requestsFor(requests, catalogUrl)).toHaveLength(2)
      expect(requestsFor(requests, defaultCatalogUrl)).toHaveLength(1)
      expect(result.current.resourceActivation).toEqual({
        [DEFAULT_ID]: 'error',
        'stored-lut-source-1': 'loading',
      })
    })

    it('drops a removed source from activation and ignores its late response', async () => {
      const { requests } = setupDeferredFetchJson()
      const { result } = renderSources()
      act(() => result.current.activateCatalogs())

      act(() => result.current.removeSource(DEFAULT_ID))
      expect(requests[0].signal?.aborted).toBe(true)
      expect(result.current.resourceActivation).toEqual({})

      await act(async () => {
        requests[0].resolve(catalogDocument())
      })
      act(() => result.current.activateCatalogs())
      expect(requests).toHaveLength(1)
      expect(result.current.state.resources).toEqual([])
      expect(result.current.state.entries).toEqual([])
    })

    it('starts a remounted hook inactive and activates it afresh', async () => {
      const { requests } = setupDeferredFetchJson()
      const first = renderSources()
      act(() => first.result.current.activateCatalogs())
      first.unmount()
      expect(requests[0].signal?.aborted).toBe(true)

      const { result } = renderSources()
      expect(result.current.catalogActivation).toBe('inactive')
      act(() => result.current.activateCatalogs())
      await act(async () => {
        requests[1].resolve(catalogDocument())
      })
      expect(result.current.catalogActivation).toBe('ready')
      expect(result.current.state.entries).toHaveLength(1)
    })
  })
})
