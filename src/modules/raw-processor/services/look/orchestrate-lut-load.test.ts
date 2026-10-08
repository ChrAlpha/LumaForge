import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { getStoredLUTContractSelection } from '~/lib/lut/profile-resolution'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import {
  fetchCachedBytesWithLimit,
  fetchVerifiedCubeAsset,
} from '~/lib/profiles/fetch'

import type { ImageSession } from '../../model/session'
import type { LutLoadContext } from './orchestrate-lut-load'
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

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

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
  const scheduledToasts: Array<() => void> = []
  // Stands in for the session store: the orchestrator reads it through the
  // getter each time, never through a copy taken when the load began.
  const store: { session: ImageSession | null } = { session: null }
  const ctx: LutLoadContext = {
    atoms: {
      getSession: vi.fn(() => store.session),
      setLut: vi.fn(),
      setSession: vi.fn(),
      setColorIntent: vi.fn(),
      lut: null,
    },
    refs: {
      lutDataRef: { current: null },
    },
    services: {
      scheduleToast: (notify) => {
        scheduledToasts.push(notify)
      },
      invalidateExportGraph: vi.fn(),
      setLutDataRef: vi.fn(),
      canApplyLoadedLut: vi.fn(() => true),
    },
  }
  return { ctx, scheduledToasts, store }
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

function expectUntouched(ctx: LutLoadContext, scheduledToasts: unknown[]) {
  expect(ctx.atoms.setLut).not.toHaveBeenCalled()
  expect(ctx.atoms.setSession).not.toHaveBeenCalled()
  expect(ctx.atoms.setColorIntent).not.toHaveBeenCalled()
  expect(ctx.services.invalidateExportGraph).not.toHaveBeenCalled()
  expect(scheduledToasts).toHaveLength(0)
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
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      entry,
      { signal: controller.signal },
      ctx,
    )

    expect(outcome).toBe('aborted')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(scheduledToasts).toHaveLength(0)
  })

  it("returns 'loaded' and applies the LUT when download and parse succeed", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('loaded')
    expect(ctx.atoms.setLut).toHaveBeenCalledTimes(1)
    expect(scheduledToasts).toHaveLength(1)
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

  it("returns 'failed' and schedules a failure toast when the download fails", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue(
      new Error('HTTP 404 Not Found'),
    )
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('failed')
    expect(ctx.atoms.setLut).not.toHaveBeenCalled()
    expect(scheduledToasts).toHaveLength(1)
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
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(
      entry,
      { signal: controller.signal },
      ctx,
    )

    expect(outcome).toBe('aborted')
    expect(fetchVerifiedCubeAsset).not.toHaveBeenCalled()
    expect(scheduledToasts).toHaveLength(0)
  })

  it("returns 'aborted' without applying when the workflow refuses the parsed LUT", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(
      verifiedCube(cubeText(17)),
    )
    const { ctx, scheduledToasts } = buildCtx()
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
  })

  it("returns 'aborted' without toasting when the fetch aborts mid-flight", async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    )
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateOnlineLutLoad(entry, undefined, ctx)

    expect(outcome).toBe('aborted')
    expect(scheduledToasts).toHaveLength(0)
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
    const { ctx } = buildCtx()

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
  })

  it('writes a contract choice to the photo in the store, or else to the detached intent', async () => {
    const { ctx, store } = buildCtx()
    await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'user-look.cube'),
      ctx,
    )
    ctx.atoms.lut = lastLoadedLut(ctx)
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
    ctx.atoms.lut = lastLoadedLut(ctx)
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
    const { ctx, scheduledToasts } = buildCtx()
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)

    const outcome = await orchestrateLutLoadFromFile(
      asTextFile(cubeText(17), 'fixture.cube'),
      ctx,
    )

    expect(outcome).toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
  })

  it("returns 'aborted' untouched when the workflow refuses edits while the file reads", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, scheduledToasts } = buildCtx()

    const load = orchestrateLutLoadFromFile(file, ctx)
    vi.mocked(ctx.services.canApplyLoadedLut).mockReturnValue(false)
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
  })

  it("returns 'aborted' untouched when its signal aborts while the file reads", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, scheduledToasts } = buildCtx()
    const controller = new AbortController()

    const load = orchestrateLutLoadFromFile(file, ctx, {
      signal: controller.signal,
    })
    controller.abort()
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
  })

  it("returns 'aborted' untouched when the photo it was started on is replaced", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, scheduledToasts, store } = buildCtx()
    store.session = sessionWithId('photo-a')

    const load = orchestrateLutLoadFromFile(file, ctx)
    store.session = sessionWithId('photo-b')
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
  })

  it("returns 'aborted' untouched when the photo it was started on is reset", async () => {
    const { file, finishRead } = deferredCubeFile('fixture.cube')
    const { ctx, scheduledToasts, store } = buildCtx()
    store.session = sessionWithId('photo-a')

    const load = orchestrateLutLoadFromFile(file, ctx)
    store.session = null
    finishRead()

    await expect(load).resolves.toBe('aborted')
    expectUntouched(ctx, scheduledToasts)
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
    const { ctx, scheduledToasts } = buildCtx()

    const outcome = await orchestrateLutLoadFromFile(file, ctx)

    expect(outcome).toBe('failed')
    expect(scheduledToasts).toHaveLength(1)
  })
})
