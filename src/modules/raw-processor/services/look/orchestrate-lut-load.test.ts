import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getStoredLUTContractSelection } from '~/lib/lut/profile-resolution'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import {
  fetchCachedBytesWithLimit,
  fetchVerifiedCubeAsset,
} from '~/lib/profiles/fetch'

import type { ImageSession } from '../../model/session'
import type { LutLoadContext, LutNotification } from './orchestrate-lut-load'
import {
  orchestrateLutLoadFromFile,
  orchestrateOnlineLutLoad,
  orchestrateProfileSelection,
} from './orchestrate-lut-load'

vi.mock('~/lib/profiles/fetch', () => ({
  createBrowserOnlineProfileCache: vi.fn(() => ({})),
  fetchVerifiedCubeAsset: vi.fn(),
  fetchCachedBytesWithLimit: vi.fn(),
}))

// Wrapped, not replaced: the spy shows which loads hash bytes themselves.
vi.mock('@lumaforge/render-engine/manifest', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/render-engine/manifest')>()
  return {
    ...actual,
    sourceContentIdFromBytes: vi.fn(actual.sourceContentIdFromBytes),
  }
})

function cubeText(size: number): string {
  const lines = [`TITLE "Outcome Fixture"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

function buildCtx() {
  const notifications: LutNotification[] = []
  // Stands in for the session and LUT stores: the orchestrator reads them
  // through the getters each time, never through a copy taken when the load
  // or the caller began.
  const store: { session: ImageSession | null; lut: ParsedLUT | null } = {
    session: null,
    lut: null,
  }
  const ctx: LutLoadContext = {
    atoms: {
      getSession: vi.fn(() => store.session),
      getLut: vi.fn(() => store.lut),
      setLut: vi.fn((lut: ParsedLUT | null) => {
        store.lut = lut
      }),
      setSession: vi.fn(),
      setColorIntent: vi.fn(),
    },
    services: {
      notify: (notification) => {
        notifications.push(notification)
      },
      invalidateExportGraph: vi.fn(),
      canApplyLoadedLut: vi.fn(() => true),
    },
  }
  return { ctx, notifications, store }
}

/** A .cube whose bytes arrive only when the test finishes the read. */
function deferredCubeFile(name: string) {
  const bytes = new TextEncoder().encode(cubeText(17))
  let finishRead!: () => void
  const read = new Promise<ArrayBuffer>((resolve) => {
    finishRead = () => resolve(bytes.buffer)
  })
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', { value: () => read })
  return { file, finishRead }
}

function expectUntouched(ctx: LutLoadContext, notifications: unknown[]) {
  expect(ctx.atoms.setLut).not.toHaveBeenCalled()
  expect(ctx.atoms.setSession).not.toHaveBeenCalled()
  expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
  expect(ctx.services.invalidateExportGraph).not.toHaveBeenCalled()
  expect(notifications).toHaveLength(0)
}

function sessionWithId(id: string): ImageSession {
  return { id } as ImageSession
}

/** jsdom's File lacks Blob.text(); patch the instance to match browsers. */
function asTextFile(text: string, name: string): File {
  const file = new File([text], name, { type: 'text/plain' })
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve(text),
    })
  }
  return file
}

function verifiedCube(text: string, sha256 = 'a'.repeat(64)) {
  return { bytes: new TextEncoder().encode(text), sha256 }
}

function lastAppliedSha256(ctx: LutLoadContext): string | undefined {
  return vi.mocked(ctx.atoms.setLut).mock.calls.at(-1)?.[0]?.sha256
}

async function realSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

const entry: OnlineLUTEntry = {
  id: 'entry-1',
  title: 'Entry One',
  sourceUrl: 'https://example.com/entry-1.json',
  sourceType: 'catalog-entry',
  cube: {
    url: 'https://example.com/entry-1.cube',
    sha256: 'a'.repeat(64),
    bytes: 64,
  },
  tags: [],
}

describe('orchestrateOnlineLutLoad outcome', () => {
  beforeEach(() => {
    vi.mocked(fetchVerifiedCubeAsset).mockReset()
    vi.mocked(fetchCachedBytesWithLimit).mockReset()
    vi.mocked(sourceContentIdFromBytes).mockClear()
  })

  it('records the verified catalog hash without hashing the bytes again', async () => {
    const verifiedSha256 = 'b'.repeat(64)
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17), verifiedSha256),
    )
    const { ctx } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('loaded')
    expect(lastAppliedSha256(ctx)).toBe(verifiedSha256)
    expect(sourceContentIdFromBytes).not.toHaveBeenCalled()
  })

  it('hashes the bytes of a direct .cube URL, which declares no hash', async () => {
    const text = cubeText(17)
    vi.mocked(fetchCachedBytesWithLimit).mockResolvedValue(
      new TextEncoder().encode(text),
    )
    const { ctx } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      {
        ...entry,
        id: 'direct',
        sourceType: 'direct-cube',
        cube: { url: 'https://example.com/direct.cube', sha256: '' },
      },
      undefined,
      ctx,
    )

    expect(outcome).toBe('loaded')
    expect(fetchVerifiedCubeAsset).not.toHaveBeenCalled()
    expect(sourceContentIdFromBytes).toHaveBeenCalledTimes(1)
    expect(lastAppliedSha256(ctx)).toBe(await realSha256(text))
  })

  it("returns 'aborted' without applying when the signal aborts after the verified fetch", async () => {
    const controller = new AbortController()
    vi.mocked(fetchVerifiedCubeAsset).mockImplementation(async () => {
      controller.abort()
      return verifiedCube(cubeText(17))
    })
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      entry,
      { signal: controller.signal },
      ctx,
    )

    expect(outcome).toBe('aborted')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(0)
  })

  it("returns 'loaded' and applies the LUT when download and parse succeed", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('loaded')
    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
    expect(notifications).toEqual([
      { kind: 'loaded', title: 'Outcome Fixture', gridSize: 17 },
    ])
  })

  it('lands on the photo in the store when the online LUT arrives', async () => {
    const download = Promise.withResolvers<ReturnType<typeof verifiedCube>>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const { ctx, store } = buildCtx()

    // The request began before any photo; a photo loaded while it ran.
    const load = orchestrateOnlineLutLoad(entry, undefined, ctx)
    store.session = sessionWithId('photo-a')
    download.resolve(verifiedCube(cubeText(17)))

    await expect(load).resolves.toBe('loaded')
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(1)
    expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
  })

  it("returns 'failed' and reports the failure detail when the download fails", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue(
      new Error('HTTP 404 Not Found'),
    )
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('failed')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(notifications).toEqual([
      { kind: 'load-failed', message: 'HTTP 404 Not Found' },
    ])
  })

  it('forwards download progress events from the verified fetch', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockImplementation(
      async (_asset, options) => {
        options.onProgress?.(8, 64)
        options.onProgress?.(64, 64)
        return verifiedCube(cubeText(17))
      },
    )
    const { ctx } = buildCtx()
    const events: Array<[number, number | undefined]> = []

    const outcome = await orchestrateOnlineLutLoad(
      entry,
      { onProgress: (received, total) => events.push([received, total]) },
      ctx,
    )

    expect(outcome).toBe('loaded')
    expect(events).toEqual([
      [8, 64],
      [64, 64],
    ])
  })

  it("returns 'aborted' without fetching when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      entry,
      { signal: controller.signal },
      ctx,
    )

    expect(outcome).toBe('aborted')
    expect(fetchVerifiedCubeAsset).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(0)
  })

  it("returns 'aborted' without applying when the workflow refuses the parsed LUT", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const { ctx, notifications } = buildCtx()
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it("returns 'aborted' without toasting when the fetch aborts mid-flight", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    )
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('aborted')
    expect(notifications).toHaveLength(0)
  })
})

describe('lUT contract provenance', () => {
  const SELECTIONS_KEY = 'lumaforge.lutProfileSelections.v1'
  const catalogEntry: OnlineLUTEntry = {
    ...entry,
    id: 'catalog-vlog',
    title: 'Catalog V-Log',
    trustedContract: {
      role: 'combined-look-output',
      inputProfile: 'panasonic-vgamut-vlog',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    },
  }

  function selectionWrites(setItem: { mock: { calls: unknown[][] } }) {
    return setItem.mock.calls.filter(([key]) => key === SELECTIONS_KEY)
  }

  function lastLoadedLut(ctx: LutLoadContext): ParsedLUT {
    const calls = vi.mocked(ctx.atoms.setLut).mock.calls
    const lut = calls.at(-1)?.[0]
    if (!lut) throw new Error('Expected a loaded LUT')
    return lut
  }

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(fetchVerifiedCubeAsset).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('applies catalog contracts as metadata without creating a user selection', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { ctx } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(catalogEntry, undefined, ctx)

    expect(outcome).toBe('loaded')
    const loaded = lastLoadedLut(ctx)
    expect(loaded.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: { id: 'panasonic-vgamut-vlog', outputTransfer: 'bt709' },
    })
    expect(selectionWrites(setItem)).toHaveLength(0)
    expect(getStoredLUTContractSelection(loaded.fingerprint)).toBeUndefined()

    const { ctx: reloadCtx } = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'catalog-vlog.cube'),
      reloadCtx,
    )
    expect(lastLoadedLut(reloadCtx).fingerprint).toBe(loaded.fingerprint)
    expect(lastLoadedLut(reloadCtx).profileResolution.kind).not.toBe(
      'confirmed',
    )
  })

  it('fails closed on incomplete catalog contracts without writing storage', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      {
        ...catalogEntry,
        trustedContract: {
          role: 'combined-look-output',
          inputProfile: 'panasonic-vgamut-vlog',
        },
      },
      undefined,
      ctx,
    )

    expect(outcome).toBe('failed')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(selectionWrites(setItem)).toHaveLength(0)
    expect(notifications).toEqual([{ kind: 'unsupported-contract' }])
  })

  it('writes a contract choice to the photo in the store, or else to the detached intent', async () => {
    const { ctx, store } = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'user-look.cube'),
      ctx,
    )
    vi.mocked(ctx.atoms.setSession).mockClear()
    vi.mocked(ctx.atoms.setColorIntent).mockClear()

    store.session = sessionWithId('photo-a')
    orchestrateProfileSelection('display-srgb', ctx)
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(1)
    expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()

    store.session = null
    orchestrateProfileSelection('display-srgb', ctx)
    expect(ctx.atoms.setColorIntent).toHaveBeenCalledTimes(1)
  })

  it('persists explicit user selections and restores them on reload', async () => {
    const { ctx } = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'user-look.cube'),
      ctx,
    )
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    orchestrateProfileSelection(
      {
        ...getLUTColorProfile('panasonic-vgamut-vlog')!,
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
      ctx,
    )

    const selected = lastLoadedLut(ctx)
    expect(selected.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'user',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
    expect(selectionWrites(setItem)).toHaveLength(1)
    expect(getStoredLUTContractSelection(selected.fingerprint)).toMatchObject({
      inputProfile: 'panasonic-vgamut-vlog',
      outputTransfer: 'bt709',
    })

    const { ctx: reloadCtx } = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'renamed-look.cube'),
      reloadCtx,
    )
    expect(lastLoadedLut(reloadCtx).profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
  })
})

describe('orchestrateLutLoadFromFile outcome', () => {
  it('records the hash of the file bytes', async () => {
    const text = cubeText(17)
    const { ctx } = buildCtx()

    await orchestrateLutLoadFromFile(asTextFile(text, 'local.cube'), ctx)

    expect(lastAppliedSha256(ctx)).toBe(await realSha256(text))
  })

  it("returns 'loaded' for a valid .cube file", async () => {
    const file = asTextFile(cubeText(17), 'fixture.cube')
    const { ctx } = buildCtx()

    const outcome = await orchestrateLutLoadFromFile(file, ctx)

    expect(outcome).toBe('loaded')
    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
  })

  it("returns 'aborted' untouched when the workflow refuses a load before it starts", async () => {
    const { ctx, notifications } = buildCtx()
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)

    const outcome = await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'fixture.cube'),
      ctx,
    )

    expect(outcome).toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it("returns 'aborted' untouched when the workflow refuses edits while the file reads", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, notifications } = buildCtx()

    const load = orchestrateLutLoadFromFile(file, ctx)
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it("returns 'aborted' untouched when its signal aborts while the file reads", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, notifications } = buildCtx()
    const controller = new AbortController()

    const load = orchestrateLutLoadFromFile(file, ctx, {
      signal: controller.signal,
    })
    controller.abort()
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it("returns 'aborted' untouched when the photo it was started on is replaced", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, notifications, store } = buildCtx()
    store.session = sessionWithId('photo-a')

    const load = orchestrateLutLoadFromFile(file, ctx)
    store.session = sessionWithId('photo-b')
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it("returns 'aborted' untouched when the photo it was started on is reset", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, notifications, store } = buildCtx()
    store.session = sessionWithId('photo-a')

    const load = orchestrateLutLoadFromFile(file, ctx)
    store.session = null
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, notifications)
  })

  it('belongs to the photo in the store when it starts, not one read earlier', async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, store } = buildCtx()
    // A load replaced the photo in the same tick, before any rerender.
    store.session = sessionWithId('photo-b')

    const load = orchestrateLutLoadFromFile(file, ctx)
    finishRead()

    await expect(load).resolves.toBe('loaded')
    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(1)
    expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
  })

  it('seeds the photo that arrives when the load began before any photo', async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, store } = buildCtx()

    const load = orchestrateLutLoadFromFile(file, ctx)
    store.session = sessionWithId('photo-a')
    finishRead()

    await expect(load).resolves.toBe('loaded')
    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
    // The photo now owns the look, so the detached intent is left alone.
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(1)
    expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
  })

  it('writes the detached intent when no photo exists as the LUT lands', async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, store } = buildCtx()
    store.session = null

    const load = orchestrateLutLoadFromFile(file, ctx)
    finishRead()

    await expect(load).resolves.toBe('loaded')
    expect(ctx.atoms.setColorIntent).toHaveBeenCalledTimes(1)
    const update = vi.mocked(ctx.atoms.setColorIntent).mock.calls[0]![0]
    expect(typeof update).toBe('function')
  })

  it("returns 'failed' for an unsupported format", async () => {
    const file = asTextFile('not a lut', 'fixture.txt')
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateLutLoadFromFile(file, ctx)

    expect(outcome).toBe('failed')
    expect(notifications).toEqual([{ kind: 'unsupported-format' }])
  })

  it("returns 'failed' and reports the parser detail for a malformed .cube", async () => {
    const file = asTextFile('LUT_3D_SIZE 2\n0 0 0\n', 'broken.cube')
    const { ctx, notifications } = buildCtx()

    const outcome = await orchestrateLutLoadFromFile(file, ctx)

    expect(outcome).toBe('failed')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(notifications).toEqual([
      {
        kind: 'load-failed',
        message: 'Invalid .cube file: expected 8 entries, got 1',
      },
    ])
  })

  it('reports a failure only after recording its code on the session', async () => {
    const file = asTextFile('not a lut', 'fixture.txt')
    const { ctx } = buildCtx()
    const order: string[] = []
    vi.mocked(ctx.atoms.setSession).mockImplementation(() => {
      order.push('session')
    })
    ctx.services.notify = (notification) => {
      order.push(notification.kind)
    }

    await orchestrateLutLoadFromFile(file, ctx)

    expect(order).toEqual(['session', 'unsupported-format'])
  })
})

describe('orchestrateProfileSelection against the stored LUT', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  async function loadTwoLuts() {
    const built = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'a.cube'),
      built.ctx,
    )
    const lutA = built.store.lut!
    await orchestrateLutLoadFromFile(
      asTextFile(
        cubeText(17).replace('Outcome Fixture', 'Second Fixture'),
        'b.cube',
      ),
      built.ctx,
    )
    const lutB = built.store.lut!
    expect(lutB.fingerprint).not.toBe(lutA.fingerprint)
    vi.mocked(built.ctx.atoms.setLut).mockClear()
    vi.mocked(built.ctx.atoms.setSession).mockClear()
    vi.mocked(built.ctx.atoms.setColorIntent).mockClear()
    vi.mocked(built.ctx.services.invalidateExportGraph).mockClear()
    built.notifications.length = 0
    return { ...built, lutA, lutB }
  }

  it('applies a choice to the LUT the store holds when it runs', async () => {
    const { ctx, store, lutA, lutB } = await loadTwoLuts()
    store.session = sessionWithId('photo-a')

    orchestrateProfileSelection('display-srgb', ctx)

    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
    const selected = vi.mocked(ctx.atoms.setLut).mock.calls[0]![0]!
    expect(selected.fingerprint).toBe(lutB.fingerprint)
    expect(selected.data).toBe(lutB.data)
    expect(selected.title).toBe('Second Fixture')
    expect(selected.sha256).toBe(lutB.sha256)
    expect(getStoredLUTContractSelection(lutB.fingerprint)).toBeDefined()
    expect(getStoredLUTContractSelection(lutA.fingerprint)).toBeUndefined()
  })

  it('refuses a choice once the store holds no LUT, writing nothing', async () => {
    const { ctx, store, notifications, lutB } = await loadTwoLuts()
    store.session = sessionWithId('photo-a')
    store.lut = null
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    orchestrateProfileSelection('display-srgb', ctx)

    expect(notifications).toEqual([{ kind: 'no-lut' }])
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(ctx.atoms.setSession).not.toHaveBeenCalled()
    expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
    expect(ctx.services.invalidateExportGraph).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getStoredLUTContractSelection(lutB.fingerprint)).toBeUndefined()
  })
})

describe('orchestrateProfileSelection notifications', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('reports a choice made with no LUT loaded and writes nothing', () => {
    const { ctx, notifications } = buildCtx()

    orchestrateProfileSelection('display-srgb', ctx)

    expect(notifications).toEqual([{ kind: 'no-lut' }])
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(ctx.atoms.setSession).not.toHaveBeenCalled()
  })

  it('reports an incomplete contract choice by the profile it named', async () => {
    const { ctx, notifications } = buildCtx()
    await orchestrateLutLoadFromFile(asTextFile(cubeText(17), 'a.cube'), ctx)
    vi.mocked(ctx.atoms.setLut).mockClear()
    notifications.length = 0

    orchestrateProfileSelection('not-a-profile', ctx)
    orchestrateProfileSelection(
      { ...getLUTColorProfile('panasonic-vgamut-vlog')!, id: 'partial-vlog' },
      ctx,
    )

    expect(notifications).toEqual([
      { kind: 'incomplete-contract', profileId: 'not-a-profile' },
      { kind: 'incomplete-contract', profileId: 'partial-vlog' },
    ])
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
  })

  it('reports nothing for a choice that applies', async () => {
    const { ctx, notifications } = buildCtx()
    await orchestrateLutLoadFromFile(asTextFile(cubeText(17), 'a.cube'), ctx)
    notifications.length = 0

    orchestrateProfileSelection('display-srgb', ctx)

    expect(notifications).toEqual([])
  })
})
