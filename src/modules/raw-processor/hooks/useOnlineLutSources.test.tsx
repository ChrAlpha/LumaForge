import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchJsonWithLimit } from '~/lib/profiles/fetch'

import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
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

function catalogDocument() {
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

function createLoadOnlineLUT() {
  return vi.fn(
    async (
      _entry: OnlineLUTEntry,
      _options?: { signal?: AbortSignal },
    ): Promise<LutLoadOutcome> => 'loaded',
  )
}

function setupFetchJson(fixtures: Record<string, unknown>) {
  mockedFetchJson.mockImplementation(async (url) => {
    if (url.endsWith('.cube')) {
      throw new Error(`CUBE bytes must not be fetched: ${url}`)
    }

    if (!(url in fixtures)) {
      throw new Error(`Missing fixture for ${url}`)
    }

    return fixtures[url]
  })
}

function setupPendingFetchJson() {
  const signals: AbortSignal[] = []

  mockedFetchJson.mockImplementation((_url, options) => {
    if (options.signal) {
      signals.push(options.signal)
    }

    return new Promise<unknown>(() => {})
  })

  return { signals }
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
        requests.push({
          url,
          signal: options.signal,
          resolve,
          reject,
        })
      }),
  )

  return { requests }
}

function hideDefaultSource() {
  localStorage.setItem(
    sourcesStorageKey,
    JSON.stringify({
      resources: [],
      removedDefaultUrls: [defaultCatalogUrl],
    }),
  )
}

describe('useOnlineLutSources', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset()
    localStorage.clear()
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    })
  })

  it('loads the default LumaForge profile source when source storage is empty', async () => {
    setupFetchJson({
      [defaultCatalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(result.current.state.resources).toEqual([
      expect.objectContaining({
        id: 'lumaforge-default-profiles',
        url: defaultCatalogUrl,
        type: 'catalog',
        label: 'LumaForge Profiles',
        isDefault: true,
      }),
    ])
    expect(result.current.state.entries[0]).toMatchObject({
      title: 'Kodak 2383 Rec.709',
      resourceId: 'lumaforge-default-profiles',
    })
    expect(result.current.share.url).toBe('/raw')
  })

  it('keeps a removed default LumaForge source hidden until source storage is cleared', async () => {
    setupFetchJson({
      [defaultCatalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const firstLoad = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() =>
      expect(firstLoad.result.current.state.resources).toHaveLength(1),
    )

    act(() => {
      firstLoad.result.current.removeSource('lumaforge-default-profiles')
    })
    expect(firstLoad.result.current.state.resources).toHaveLength(0)
    firstLoad.unmount()

    mockedFetchJson.mockClear()
    const secondLoad = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    expect(secondLoad.result.current.state.resources).toHaveLength(0)
    expect(mockedFetchJson).not.toHaveBeenCalled()
    secondLoad.unmount()

    localStorage.clear()
    const restored = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() =>
      expect(restored.result.current.state.resources).toEqual([
        expect.objectContaining({ id: 'lumaforge-default-profiles' }),
      ]),
    )
  })

  it('keeps the default hidden for users who removed it at its legacy flat-catalog URL', () => {
    // The default source moved from channels/stable/catalog.json to the
    // scoped channels/stable/luts/catalog.json. A user who removed the old
    // default must not see the source resurrected by the URL change.
    localStorage.setItem(
      sourcesStorageKey,
      JSON.stringify({
        resources: [],
        removedDefaultUrls: [
          'https://luma-prof.ichr.me/channels/stable/catalog.json',
        ],
      }),
    )

    const { result, unmount } = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    expect(result.current.state.resources).toHaveLength(0)
    expect(mockedFetchJson).not.toHaveBeenCalled()
    unmount()
  })

  it('restores manually added sources from storage and forgets them after removal', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const firstLoad = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    act(() => {
      firstLoad.result.current.setSourceUrlInput(catalogUrl)
    })
    await act(async () => {
      await firstLoad.result.current.addSourceFromInput()
    })
    await waitFor(() =>
      expect(firstLoad.result.current.state.entries).toHaveLength(1),
    )
    expect(JSON.parse(localStorage.getItem(sourcesStorageKey) ?? '{}')).toEqual(
      expect.objectContaining({
        resources: [
          expect.objectContaining({
            url: catalogUrl,
            type: 'catalog',
            label: 'Catalog from profiles.example.com',
          }),
        ],
      }),
    )
    firstLoad.unmount()

    mockedFetchJson.mockClear()
    const restored = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() =>
      expect(restored.result.current.state.resources).toEqual([
        expect.objectContaining({
          id: 'stored-lut-source-1',
          url: catalogUrl,
        }),
      ]),
    )
    expect(mockedFetchJson).toHaveBeenCalledWith(catalogUrl, {
      signal: expect.any(AbortSignal),
      maxBytes: expect.any(Number),
    })

    act(() => {
      restored.result.current.removeSource('stored-lut-source-1')
    })
    expect(JSON.parse(localStorage.getItem(sourcesStorageKey) ?? '{}')).toEqual(
      expect.objectContaining({ resources: [] }),
    )
    restored.unmount()

    mockedFetchJson.mockClear()
    const removed = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    expect(removed.result.current.state.resources).toHaveLength(0)
    expect(mockedFetchJson).not.toHaveBeenCalled()
  })

  it('parses and resolves query resources once on first RAW Lab load', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = createLoadOnlineLUT()
    const { result } = renderHook(
      ({ search }) =>
        useOnlineLutSources({
          search,
          pathname: '/raw',
          loadOnlineLUT,
        }),
      {
        initialProps: {
          search: `?luts=${encodeURIComponent(catalogUrl)}`,
        },
      },
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(result.current.state.resources).toHaveLength(1)
    expect(result.current.state.resources[0]).toMatchObject({
      url: catalogUrl,
      type: 'catalog',
    })
    expect(result.current.state.entries[0]).toMatchObject({
      title: 'Kodak 2383 Rec.709',
      resourceId: 'lut-source-1',
    })
    expect(mockedFetchJson).toHaveBeenCalledTimes(1)
  })

  it('exposes download progress for the in-flight entry and clears it after', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loadOnlineLUT = vi.fn(
      async (
        _entry: OnlineLUTEntry,
        options?: {
          signal?: AbortSignal
          onProgress?: (received: number, total?: number) => void
        },
      ): Promise<LutLoadOutcome> => {
        options?.onProgress?.(1024, 4096)
        await gate
        return 'loaded'
      },
    )
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
    expect(result.current.entryLoadProgress).toBeNull()

    let loading!: Promise<unknown>
    act(() => {
      loading = result.current.loadEntry('kodak-2383-rec709')
    })

    await waitFor(() =>
      expect(result.current.entryLoadProgress).toMatchObject({
        entryId: 'kodak-2383-rec709',
        receivedBytes: 1024,
      }),
    )

    await act(async () => {
      release()
      await loading
    })

    expect(result.current.entryLoadProgress).toBeNull()
  })

  it('exposes the shared loading and failed entry state across consumers', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    let release!: (outcome: 'failed') => void
    const gate = new Promise<'failed'>((resolve) => {
      release = resolve
    })
    const loadOnlineLUT = vi.fn((): Promise<LutLoadOutcome> => gate)
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
    expect(result.current.loadingEntryId).toBeNull()
    expect(result.current.failedEntryId).toBeNull()

    let loading!: Promise<unknown>
    act(() => {
      loading = result.current.loadEntry('kodak-2383-rec709')
    })

    await waitFor(() =>
      expect(result.current.loadingEntryId).toBe('kodak-2383-rec709'),
    )

    await act(async () => {
      release('failed')
      await loading
    })

    expect(result.current.loadingEntryId).toBeNull()
    expect(result.current.failedEntryId).toBe('kodak-2383-rec709')
  })

  it('ignores a second loadEntry while one is in flight', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    let release!: (outcome: 'loaded') => void
    const gate = new Promise<'loaded'>((resolve) => {
      release = resolve
    })
    const loadOnlineLUT = vi.fn((): Promise<LutLoadOutcome> => gate)
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    let first!: Promise<unknown>
    act(() => {
      first = result.current.loadEntry('kodak-2383-rec709')
    })
    await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(1))

    // A second surface racing in while the first load is active is ignored.
    let second!: Promise<unknown>
    act(() => {
      second = result.current.loadEntry('kodak-2383-rec709')
    })
    await expect(second).resolves.toBe('aborted')
    expect(loadOnlineLUT).toHaveBeenCalledTimes(1)

    // The original load keeps its cancel handle: cancelling aborts IT.
    await act(async () => {
      release('loaded')
      await first
    })
    expect(result.current.loadingEntryId).toBeNull()
  })

  it('does not mark the entry failed when cancelled during manifest resolution', async () => {
    hideDefaultSource()
    const { requests } = setupDeferredFetchJson()
    const loadOnlineLUT = createLoadOnlineLUT()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => {
      requests[0].resolve(catalogDocument())
    })
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    let loading!: Promise<unknown>
    act(() => {
      loading = result.current.loadEntry('kodak-2383-rec709')
    })
    await waitFor(() => expect(requests).toHaveLength(2))

    await act(async () => {
      result.current.cancelEntryLoad()
      requests[1].reject(new DOMException('Aborted', 'AbortError'))
      await expect(loading).resolves.toBe('aborted')
    })

    expect(result.current.failedEntryId).toBeNull()
    expect(result.current.loadingEntryId).toBeNull()
  })

  it('cancelEntryLoad aborts the in-flight entry load', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = vi.fn(
      (
        _entry: OnlineLUTEntry,
        options?: { signal?: AbortSignal },
      ): Promise<LutLoadOutcome> =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve('aborted'))
        }),
    )
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    let loading!: Promise<unknown>
    act(() => {
      loading = result.current.loadEntry('kodak-2383-rec709')
    })
    await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(1))

    await act(async () => {
      result.current.cancelEntryLoad()
      await expect(loading).resolves.toBe('aborted')
    })

    expect(result.current.entryLoadProgress).toBeNull()
  })

  it('releases the lock on cancel so another entry can load in the same tap', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = vi.fn(
      (
        _entry: OnlineLUTEntry,
        options?: { signal?: AbortSignal },
      ): Promise<LutLoadOutcome> =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve('aborted'))
        }),
    )
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    let first!: Promise<unknown>
    act(() => {
      first = result.current.loadEntry('kodak-2383-rec709')
    })
    await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(1))
    const firstSignal = loadOnlineLUT.mock.calls[0][1]!.signal!

    let second!: Promise<unknown>
    act(() => {
      result.current.cancelEntryLoad()
      second = result.current.loadEntry('kodak-2383-rec709')
    })
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() => expect(loadOnlineLUT).toHaveBeenCalledTimes(2))
    await expect(first).resolves.toBe('aborted')
    // The aborted load's cleanup leaves the new load's state alone.
    expect(result.current.loadingEntryId).toBe('kodak-2383-rec709')

    await act(async () => {
      result.current.cancelEntryLoad()
      await expect(second).resolves.toBe('aborted')
    })
    expect(result.current.loadingEntryId).toBeNull()
    expect(result.current.failedEntryId).toBeNull()
  })

  it('fetches the entry manifest only when loading a selected catalog LUT', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = createLoadOnlineLUT()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT,
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
    expect(mockedFetchJson).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.loadEntry('kodak-2383-rec709')
    })

    expect(mockedFetchJson).toHaveBeenCalledTimes(2)
    expect(mockedFetchJson).toHaveBeenNthCalledWith(2, entryUrl, {
      signal: expect.any(AbortSignal),
      maxBytes: expect.any(Number),
    })
    expect(loadOnlineLUT).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'kodak-2383-rec709',
        sourceUrl: entryUrl,
        trustedContract: expect.objectContaining({
          inputTransfer: 'logc3',
        }),
        tags: ['film-print'],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.current.state.entries[0]).toMatchObject({
      trustedContract: { outputTransfer: 'gamma24' },
    })
  })

  it('does not duplicate resources when re-rendering with the same search string', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = createLoadOnlineLUT()
    const { result, rerender } = renderHook(
      ({ search }) =>
        useOnlineLutSources({
          search,
          pathname: '/raw',
          loadOnlineLUT,
        }),
      {
        initialProps: {
          search: `?luts=${encodeURIComponent(catalogUrl)}`,
        },
      },
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
    rerender({ search: `?luts=${encodeURIComponent(catalogUrl)}` })

    expect(result.current.state.resources).toHaveLength(1)
    expect(result.current.state.entries).toHaveLength(1)
    expect(mockedFetchJson).toHaveBeenCalledTimes(1)
  })

  it('processes newly introduced query resources while mounted without duplicating the same query', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const loadOnlineLUT = createLoadOnlineLUT()
    const { result, rerender } = renderHook(
      ({ search }) =>
        useOnlineLutSources({
          search,
          pathname: '/raw',
          loadOnlineLUT,
        }),
      {
        initialProps: {
          search: '',
        },
      },
    )

    expect(result.current.state.resources).toHaveLength(0)

    rerender({ search: `?luts=${encodeURIComponent(catalogUrl)}` })
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    rerender({ search: `?luts=${encodeURIComponent(catalogUrl)}` })

    expect(result.current.state.resources).toHaveLength(1)
    expect(result.current.state.entries).toHaveLength(1)
    expect(mockedFetchJson).toHaveBeenCalledTimes(1)
  })

  it('keeps share disabled when no valid source has entries', () => {
    hideDefaultSource()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    expect(result.current.share.enabled).toBe(false)
    expect(result.current.share.url).toBe('/raw')
  })

  it('keeps share disabled when no clipboard or Web Share API is available', async () => {
    hideDefaultSource()
    vi.stubGlobal('navigator', {})
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(result.current.share.enabled).toBe(false)
  })

  it('enables share when a valid source has entries and clipboard is available', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.share.enabled).toBe(true))
    expect(result.current.share.url).toBe(
      `/raw?luts=${encodeURIComponent(catalogUrl)}`,
    )
  })

  it('copies the canonical source share URL', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.share.enabled).toBe(true))
    await act(async () => {
      await result.current.share.copy()
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `/raw?luts=${encodeURIComponent(catalogUrl)}`,
    )
  })

  it('keeps isLoading true until all concurrent resource requests settle', async () => {
    hideDefaultSource()
    const deferred = setupDeferredFetchJson()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(entryUrl)}&luts=${encodeURIComponent(secondEntryUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(deferred.requests).toHaveLength(2))
    expect(result.current.state.isLoading).toBe(true)

    await act(async () => {
      deferred.requests[0].resolve(entryManifest())
    })

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
    expect(result.current.state.isLoading).toBe(true)

    await act(async () => {
      deferred.requests[1].resolve(
        entryManifest({
          id: 'ektachrome-e100',
          title: 'Ektachrome E100',
          entryUrl: secondEntryUrl,
        }),
      )
    })

    await waitFor(() => expect(result.current.state.entries).toHaveLength(2))
    expect(result.current.state.isLoading).toBe(false)
  })

  it('preserves invalid query issues while resolving valid query resources', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent('ftp://example.com/look.cube')}&luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(result.current.state.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported-scheme',
          raw: 'ftp://example.com/look.cube',
        }),
      ]),
    )
  })

  it('refreshes invalid input issues instead of accumulating them', async () => {
    hideDefaultSource()

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    act(() => result.current.setSourceUrlInput('first invalid'))
    await act(async () => {
      await result.current.addSourceFromInput()
    })
    act(() => result.current.setSourceUrlInput('second invalid'))
    await act(async () => {
      await result.current.addSourceFromInput()
    })

    const looseIssues = result.current.state.issues.filter(
      (issue) => !issue.resourceId,
    )
    expect(looseIssues).toHaveLength(1)
  })

  it('clears stale input issues once a valid source resolves', async () => {
    hideDefaultSource()
    setupFetchJson({
      [catalogUrl]: catalogDocument(),
      [entryUrl]: entryManifest(),
    })

    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: '',
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    act(() => result.current.setSourceUrlInput('not a url'))
    await act(async () => {
      await result.current.addSourceFromInput()
    })
    expect(
      result.current.state.issues.filter((issue) => !issue.resourceId),
    ).toHaveLength(1)

    act(() => result.current.setSourceUrlInput(catalogUrl))
    await act(async () => {
      await result.current.addSourceFromInput()
    })
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(
      result.current.state.issues.filter((issue) => !issue.resourceId),
    ).toHaveLength(0)
  })

  it('creates a direct CUBE entry without fetching CUBE bytes', async () => {
    hideDefaultSource()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(cubeUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1))

    expect(mockedFetchJson).not.toHaveBeenCalled()
    expect(result.current.state.entries[0]).toMatchObject({
      id: 'lut-source-1',
      title: `${sha256}.cube`,
      sourceType: 'direct-cube',
      cube: { url: cubeUrl },
    })
  })

  it('aborts an in-flight metadata request when refreshing the same resource', async () => {
    hideDefaultSource()
    const pending = setupPendingFetchJson()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(pending.signals).toHaveLength(1))
    await waitFor(() => expect(result.current.state.resources).toHaveLength(1))

    act(() => {
      void result.current.refreshSource('lut-source-1')
    })

    expect(pending.signals[0].aborted).toBe(true)
    await waitFor(() => expect(pending.signals).toHaveLength(2))
    expect(pending.signals[1].aborted).toBe(false)
  })

  it('aborts an in-flight metadata request when removing that resource', async () => {
    hideDefaultSource()
    const pending = setupPendingFetchJson()
    const { result } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(pending.signals).toHaveLength(1))
    await waitFor(() => expect(result.current.state.resources).toHaveLength(1))

    act(() => {
      result.current.removeSource('lut-source-1')
    })

    expect(pending.signals[0].aborted).toBe(true)
  })

  it('retries query metadata after StrictMode cleanup aborts the first effect pass', async () => {
    hideDefaultSource()
    const pending = setupPendingFetchJson()
    const { result } = renderHook(
      () =>
        useOnlineLutSources({
          search: `?luts=${encodeURIComponent(catalogUrl)}`,
          pathname: '/raw',
          loadOnlineLUT: createLoadOnlineLUT(),
        }),
      { wrapper: StrictMode },
    )

    await waitFor(() =>
      expect(pending.signals.length).toBeGreaterThanOrEqual(2),
    )
    await waitFor(() => expect(result.current.state.resources).toHaveLength(1))

    expect(pending.signals[0].aborted).toBe(true)
    expect(pending.signals.at(-1)?.aborted).toBe(false)
  })

  it('aborts in-flight metadata requests on unmount', async () => {
    hideDefaultSource()
    const pending = setupPendingFetchJson()
    const { unmount } = renderHook(() =>
      useOnlineLutSources({
        search: `?luts=${encodeURIComponent(catalogUrl)}`,
        pathname: '/raw',
        loadOnlineLUT: createLoadOnlineLUT(),
      }),
    )

    await waitFor(() => expect(pending.signals).toHaveLength(1))

    unmount()

    expect(pending.signals[0].aborted).toBe(true)
  })
})
