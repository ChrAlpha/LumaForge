import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import {
  resetCapabilityVectorForTest,
  setCapabilityVectorForTest,
} from '~/lib/runtime/capability-vector'

import type { DisplaySource, ImageSession } from '../../../model/session'
import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import { useOriginalReferenceStage } from './useOriginalReferenceStage'

const rendererMock = vi.hoisted(() => ({
  renderOriginalReferenceSnapshot: vi.fn(),
}))

vi.mock('../../../services/compare/original-reference-renderer', () => ({
  renderOriginalReferenceSnapshot: rendererMock.renderOriginalReferenceSnapshot,
}))

type PendingRender = {
  key: string
  signal?: AbortSignal
  promise: Promise<OriginalReferenceSnapshot>
  resolve: (snapshot: OriginalReferenceSnapshot) => void
}

type StageProps = {
  sessionId: string | null
  viewMode: ProcessingParams['viewMode']
  image: DecodedImage | null
  imageVersion: number
  displaySource: DisplaySource
}

const revokeObjectURL = vi.fn()
const renders: PendingRender[] = []
// Object URLs stay unique across the file so each revocation names exactly
// one snapshot.
let objectUrlCount = 0

function createSession(viewMode: ProcessingParams['viewMode']): ImageSession {
  return {
    id: 'session-original-reference',
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 1,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: viewMode,
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 800, height: 600 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createImage(
  source: 'quick' | 'bounded-hq',
  width = 1600,
): DecodedImage {
  return {
    width,
    height: 1000,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array(width * 1000 * 3),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    metadata: { width, height: 1000 },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function createSnapshot(key: string): OriginalReferenceSnapshot {
  objectUrlCount += 1
  return {
    key,
    objectUrl: `blob:original-reference-${objectUrlCount}`,
    width: 400,
    height: 250,
    source: key.includes('bounded-hq') ? 'bounded-hq' : 'quick',
    mimeType: 'image/jpeg',
    estimatedBytes: 1024 * objectUrlCount,
  }
}

async function resolveRender(index: number) {
  const render = renders[index]
  if (!render) throw new Error(`render ${index} was not started`)
  const snapshot = createSnapshot(render.key)
  await act(async () => {
    render.resolve(snapshot)
    await render.promise
  })
  return snapshot
}

function revokedUrls() {
  return revokeObjectURL.mock.calls.map(([url]) => url)
}

function liveSnapshotUrls(registry: ResourceRegistry) {
  return registry.snapshot().live.filter((entry) => entry.kind === 'object-url')
}

function renderStageHook({
  registry,
  strict = false,
}: {
  registry: ResourceRegistry | null
  strict?: boolean
}) {
  const sessionRef = { current: createSession('compare') }
  const decodedImageRef: { current: DecodedImage | null } = { current: null }
  const resourceRegistryRef = { current: registry }
  return renderHook(
    (props: StageProps) => {
      decodedImageRef.current = props.image
      return useOriginalReferenceStage({
        sessionId: props.sessionId,
        sessionRef,
        viewMode: props.viewMode,
        previewSuspended: false,
        decodedImageRef,
        decodedImageVersion: props.imageVersion,
        displaySource: props.displaySource,
        resourceRegistryRef,
      })
    },
    {
      initialProps: {
        sessionId: 'session-original-reference',
        viewMode: 'compare',
        image: createImage('quick'),
        imageVersion: 1,
        displaySource: 'quick',
      },
      wrapper: strict ? StrictMode : undefined,
    },
  )
}

function renderStage({ strict = false }: { strict?: boolean } = {}) {
  const registry = createResourceRegistry()
  return { ...renderStageHook({ registry, strict }), registry }
}

describe('useOriginalReferenceStage', () => {
  beforeEach(() => {
    renders.length = 0
    revokeObjectURL.mockReset()
    rendererMock.renderOriginalReferenceSnapshot.mockReset()
    rendererMock.renderOriginalReferenceSnapshot.mockImplementation(
      ({ key, signal }: { key: string; signal?: AbortSignal }) => {
        let resolve!: (snapshot: OriginalReferenceSnapshot) => void
        const promise = new Promise<OriginalReferenceSnapshot>(
          (innerResolve) => {
            resolve = innerResolve
          },
        )
        renders.push({ key, signal, promise, resolve })
        return promise
      },
    )
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, { revokeObjectURL }),
    )
    // Without dual-GPU compare the stage prepares a snapshot in compare mode.
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
    setCapabilityVectorForTest({
      coi: false,
      pthread: false,
      deviceMemoryGB: 4,
      hwConcurrency: 4,
      webKitClass: 'webkit-mobile',
      deviceFormFactor: 'mobile',
      maybeOpfsSupported: false,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetCapabilityVectorForTest()
  })

  it('exposes compare fallback controls and no snapshot before an image is available', () => {
    const session = createSession('compare')

    const { result } = renderHook(() =>
      useOriginalReferenceStage({
        sessionId: session.id,
        sessionRef: { current: session },
        viewMode: 'compare',
        previewSuspended: false,
        decodedImageRef: { current: null },
        decodedImageVersion: 0,
        displaySource: 'bounded-hq',
        resourceRegistryRef: { current: createResourceRegistry() },
      }),
    )

    expect(typeof result.current.dualGpuAllowed).toBe('boolean')
    expect(result.current.originalReferenceSnapshot).toBeNull()
    expect(result.current.originalReferenceFallbackReason).toBeNull()
    expect(typeof result.current.requestOriginalReferenceFallback).toBe(
      'function',
    )
  })

  it.each([
    {
      replacement: 'a bounded HQ upgrade',
      next: {
        image: createImage('bounded-hq', 2400),
        imageVersion: 2,
        displaySource: 'bounded-hq' as DisplaySource,
      },
    },
    {
      replacement: 'a new quick source',
      next: {
        image: createImage('quick', 1800),
        imageVersion: 2,
        displaySource: 'quick' as DisplaySource,
      },
    },
  ])(
    'revokes the previous snapshot exactly once when $replacement replaces it',
    async ({ next }) => {
      const { result, rerender, unmount, registry } = renderStage()
      await waitFor(() => expect(renders).toHaveLength(1))
      const first = await resolveRender(0)
      expect(result.current.originalReferenceSnapshot).toBe(first)

      rerender({
        sessionId: 'session-original-reference',
        viewMode: 'compare',
        ...next,
      })
      await waitFor(() => expect(renders).toHaveLength(2))

      expect(result.current.originalReferenceSnapshot).toBe(first)
      expect(revokedUrls()).toEqual([])

      const second = await resolveRender(1)

      expect(result.current.originalReferenceSnapshot).toBe(second)
      expect(revokedUrls()).toEqual([first.objectUrl])
      expect(liveSnapshotUrls(registry)).toEqual([
        expect.objectContaining({ estimatedBytes: second.estimatedBytes }),
      ])

      unmount()
      await act(async () => {})

      expect(revokedUrls()).toEqual([first.objectUrl, second.objectUrl])
      expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
    },
  )

  it('revokes the previous session snapshot once when a new session replaces it', async () => {
    const { result, rerender, unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const first = await resolveRender(0)

    rerender({
      sessionId: 'session-replacement',
      viewMode: 'compare',
      image: createImage('quick'),
      imageVersion: 1,
      displaySource: 'quick',
    })
    await waitFor(() => expect(renders).toHaveLength(2))

    expect(result.current.originalReferenceSnapshot).toBeNull()
    await act(async () => {})
    expect(revokedUrls()).toEqual([first.objectUrl])
    expect(liveSnapshotUrls(registry)).toEqual([])

    const second = await resolveRender(1)
    expect(result.current.originalReferenceSnapshot).toBe(second)

    unmount()
    await act(async () => {})

    expect(revokedUrls()).toEqual([first.objectUrl, second.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('keeps one owned snapshot when rerenders reuse the same key', async () => {
    const { result, rerender, unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const snapshot = await resolveRender(0)

    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'compare',
      image: createImage('quick'),
      imageVersion: 1,
      displaySource: 'quick',
    })
    await act(async () => {})

    expect(renders).toHaveLength(1)
    expect(result.current.originalReferenceSnapshot).toBe(snapshot)
    expect(revokedUrls()).toEqual([])
    expect(liveSnapshotUrls(registry)).toHaveLength(1)

    unmount()
    await act(async () => {})

    expect(revokedUrls()).toEqual([snapshot.objectUrl])
  })

  it('revokes a render cancelled before completion exactly once without publishing it', async () => {
    const { result, rerender, unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))

    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'processed',
      image: createImage('quick'),
      imageVersion: 1,
      displaySource: 'quick',
    })
    expect(renders[0]?.signal?.aborted).toBe(true)

    const late = await resolveRender(0)

    expect(result.current.originalReferenceSnapshot).toBeNull()
    expect(revokedUrls()).toEqual([late.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })

    unmount()
    await act(async () => {})

    expect(revokedUrls()).toEqual([late.objectUrl])
  })

  it('revokes a render that completes after unmount exactly once', async () => {
    const { unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))

    unmount()
    const late = await resolveRender(0)

    expect(revokedUrls()).toEqual([late.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('lets an export evacuation release a snapshot that resolved in the same tick', async () => {
    const { registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const render = renders[0]!
    const snapshot = createSnapshot(render.key)
    let evacuation: Promise<void> | undefined
    // Registered after the stage's own handler, so it runs once the snapshot
    // has resolved but before React commits the published state.
    void render.promise.then(() => {
      evacuation = registry.disposeOwners(['preview'])
    })

    await act(async () => {
      render.resolve(snapshot)
      await render.promise
      await evacuation
    })

    expect(revokedUrls()).toEqual([snapshot.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('revokes an evacuated snapshot only once across later cleanup', async () => {
    const { rerender, unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const snapshot = await resolveRender(0)

    await act(async () => {
      await registry.disposeOwners(['preview'])
    })
    expect(revokedUrls()).toEqual([snapshot.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })

    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'processed',
      image: createImage('quick'),
      imageVersion: 1,
      displaySource: 'quick',
    })
    await act(async () => {
      await registry.disposeOwners(['preview'])
    })
    unmount()
    await act(async () => {})

    expect(revokedUrls()).toEqual([snapshot.objectUrl])
  })

  it('owns every snapshot URL without a resource registry', async () => {
    const { result, rerender, unmount } = renderStageHook({ registry: null })
    await waitFor(() => expect(renders).toHaveLength(1))
    const first = await resolveRender(0)

    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'compare',
      image: createImage('bounded-hq', 2400),
      imageVersion: 2,
      displaySource: 'bounded-hq',
    })
    await waitFor(() => expect(renders).toHaveLength(2))
    const second = await resolveRender(1)
    expect(result.current.originalReferenceSnapshot).toBe(second)
    expect(revokedUrls()).toEqual([first.objectUrl])

    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'compare',
      image: createImage('quick', 1800),
      imageVersion: 3,
      displaySource: 'quick',
    })
    await waitFor(() => expect(renders).toHaveLength(3))
    unmount()
    const late = await resolveRender(2)

    expect(revokedUrls()).toEqual([
      first.objectUrl,
      second.objectUrl,
      late.objectUrl,
    ])
  })

  it('revokes each snapshot URL exactly once under StrictMode effect replay', async () => {
    const { result, unmount, registry } = renderStage({ strict: true })
    await waitFor(() => expect(renders).toHaveLength(2))
    expect(renders[0]?.signal?.aborted).toBe(true)

    // The replayed render settles first; the aborted mount-time render then
    // resolves late into a URL nobody publishes.
    const live = await resolveRender(1)
    const replayed = await resolveRender(0)
    expect(result.current.originalReferenceSnapshot).toBe(live)
    expect(revokedUrls()).toEqual([replayed.objectUrl])

    unmount()
    await act(async () => {})

    expect(revokedUrls()).toEqual([replayed.objectUrl, live.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })
})
