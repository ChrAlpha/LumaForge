import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import { getCapabilityVectorSnapshot } from '~/lib/runtime/capability-vector'

import type { DisplaySource } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import { setCurrentSession } from '../../../state/session.atoms'
import { createTestDecodedImage } from '../../../test-support/builders'
import { useOriginalReference } from './useOriginalReference'

vi.mock('~/lib/runtime/capability-vector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/runtime/capability-vector')>()),
  getCapabilityVectorSnapshot: vi.fn(() => null),
}))

const rendererMock = vi.hoisted(() => ({
  renderOriginalReferenceSnapshot: vi.fn(),
}))

vi.mock('../../../services/compare/original-reference-renderer', () => ({
  renderOriginalReferenceSnapshot: rendererMock.renderOriginalReferenceSnapshot,
}))

// The GPU budget, when the device reports one, decides dual GPU compare.
const gpuBudget = vi.hoisted(() => ({
  current: null as { dualGpuAllowed: boolean } | null,
}))

vi.mock('~/lib/runtime/preview-gpu-budget', () => ({
  detectPreviewGpuCapabilitySnapshot: () => (gpuBudget.current ? {} : null),
  derivePreviewGpuBudget: () => ({
    ...gpuBudget.current,
    boundedHqMaxPixels: 4_000_000,
    originalReferenceSnapshotMaxPixels: 2_000_000,
  }),
}))

type PendingRender = {
  key: string
  signal?: AbortSignal
  promise: Promise<OriginalReferenceSnapshot>
  resolve: (snapshot: OriginalReferenceSnapshot) => void
}

type StageProps = {
  sessionId: string | null
  viewMode: PreviewViewMode
  previewSuspended?: boolean
  image: DecodedImage | null
  /**
   * Bumped with every frame the producer accepts. The harness keys its
   * frames by it, as the workflow mints one per accepted frame.
   */
  imageVersion: number
  /**
   * The workflow's accepted descriptor of `image`; the harness producer's
   * when left out.
   */
  frame?: DecodedPreviewFrame | null
  displaySource: DisplaySource
}

const revokeObjectURL = vi.fn()
const renders: PendingRender[] = []
// Object URLs stay unique across the file so each revocation names exactly
// one snapshot.
let objectUrlCount = 0

function createImage(
  source: 'quick' | 'bounded-hq',
  width = 1600,
): DecodedImage {
  return createTestDecodedImage({ width, height: 1000, source })
}

const acceptedFrames = new Map<string, DecodedPreviewFrame>()

/**
 * Plays the frame producer: one descriptor per accepted frame of a session,
 * which the harness counts with `imageVersion`.
 */
function frameOf(
  props: Pick<StageProps, 'sessionId' | 'image' | 'imageVersion'>,
): DecodedPreviewFrame | null {
  const { sessionId, image, imageVersion } = props
  if (!sessionId || !image) return null
  const id = `${sessionId}/decoded-frame-${imageVersion}`
  const frame = acceptedFrames.get(id) ?? {
    sessionId,
    frameId: `decoded-frame-${imageVersion}`,
    stage: image.source ?? 'unknown',
    width: image.width,
    height: image.height,
    exposure: { kind: 'unpinned', value: image.renderExposure },
    quickPredecessorFrameId: null,
  }
  acceptedFrames.set(id, frame)
  return frame
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
  const decodedImageRef: { current: DecodedImage | null } = { current: null }
  const resourceRegistryRef = { current: registry }
  return renderHook(
    (props: StageProps) => {
      decodedImageRef.current = props.image
      return useOriginalReference({
        sessionId: props.sessionId,
        viewMode: props.viewMode,
        previewSuspended: props.previewSuspended ?? false,
        decodedImageRef,
        decodedFrame: props.frame === undefined ? frameOf(props) : props.frame,
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

const QUICK_PROPS: StageProps = {
  sessionId: 'session-original-reference',
  viewMode: 'compare',
  image: createImage('quick'),
  imageVersion: 1,
  displaySource: 'quick',
}

function liveResources(registry: ResourceRegistry, kind: string) {
  return registry.snapshot().live.filter((entry) => entry.kind === kind)
}

function simulateDualGpuDevice() {
  vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
    coi: true,
    pthread: true,
    deviceMemoryGB: 8,
    hwConcurrency: 8,
    webKitClass: 'chromium',
    deviceFormFactor: 'desktop',
    maybeOpfsSupported: true,
  })
}

describe('useOriginalReference', () => {
  beforeEach(() => {
    renders.length = 0
    acceptedFrames.clear()
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
    vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
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
    vi.mocked(getCapabilityVectorSnapshot).mockReturnValue(null)
    gpuBudget.current = null
    setCurrentSession(null)
  })

  it('revokes the previous snapshot exactly once when a bounded HQ upgrade replaces it', async () => {
    const next = {
      image: createImage('bounded-hq', 2400),
      imageVersion: 2,
      displaySource: 'bounded-hq' as DisplaySource,
    }
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

  it('prepares a snapshot without dual GPU compare, and on a fallback request with it', async () => {
    const { result, unmount } = renderStage()
    expect(result.current.dualGpuAllowed).toBe(false)
    await waitFor(() => expect(renders).toHaveLength(1))
    unmount()

    simulateDualGpuDevice()
    const session = createImageSession(new File(['raw'], 'frame.dng'))
    setCurrentSession(session)
    const dual = renderStage()
    dual.rerender({ ...QUICK_PROPS, sessionId: session.id })
    expect(dual.result.current.dualGpuAllowed).toBe(true)
    await act(async () => {})
    expect(renders).toHaveLength(1)

    act(() => dual.result.current.requestOriginalReferenceFallback())
    await waitFor(() => expect(renders).toHaveLength(2))

    // Leaving compare ends the request; returning does not revive it.
    dual.rerender({
      ...QUICK_PROPS,
      sessionId: session.id,
      viewMode: 'processed',
    })
    dual.rerender({ ...QUICK_PROPS, sessionId: session.id })
    await act(async () => {})
    expect(renders).toHaveLength(2)
    dual.unmount()
  })

  it('lets the GPU budget allow dual GPU compare without pthreads', () => {
    gpuBudget.current = { dualGpuAllowed: true }
    const { result, unmount } = renderStage()
    expect(result.current.dualGpuAllowed).toBe(true)
    expect(renders).toHaveLength(0)
    unmount()
  })

  it('never carries a fallback request over to a replacement source', async () => {
    simulateDualGpuDevice()
    const first = createImageSession(new File(['raw'], 'first.dng'))
    setCurrentSession(first)
    const { result, rerender, unmount } = renderStage()
    rerender({ ...QUICK_PROPS, sessionId: first.id })
    // The store already holds the replacement when the request runs.
    const second = createImageSession(new File(['raw'], 'second.dng'))
    setCurrentSession(second)
    act(() => result.current.requestOriginalReferenceFallback())
    await act(async () => {})
    expect(renders).toHaveLength(0)

    rerender({ ...QUICK_PROPS, sessionId: second.id })
    await waitFor(() => expect(renders).toHaveLength(1))
    unmount()
  })

  it('draws only frames the workflow accepted for this session', async () => {
    const { rerender, unmount } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    rerender({ ...QUICK_PROPS, imageVersion: 2, frame: null })
    rerender({
      ...QUICK_PROPS,
      imageVersion: 3,
      frame: frameOf({ ...QUICK_PROPS, sessionId: 'another-session' }),
    })
    await act(async () => {})
    expect(renders).toHaveLength(1)
    expect(renders[0]?.signal?.aborted).toBe(true)
    unmount()
  })

  it('drops the previous session snapshot while the replacement renders', async () => {
    const { result, rerender, unmount } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const first = await resolveRender(0)

    rerender({ ...QUICK_PROPS, sessionId: 'session-replacement' })
    await waitFor(() => expect(renders).toHaveLength(2))
    expect(result.current.originalReferenceSnapshot).toBeNull()
    expect(revokedUrls()).toEqual([first.objectUrl])
    unmount()
  })

  it('releases a render that settles after unmount and reports render failures', async () => {
    const { unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    // The pending render is a preview resource until it settles.
    expect(liveResources(registry, 'gpu-pipeline')).toHaveLength(1)
    unmount()
    const late = await resolveRender(0)
    expect(revokedUrls()).toEqual([late.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })

    rendererMock.renderOriginalReferenceSnapshot.mockRejectedValueOnce({
      message: 'ORIGINAL_REFERENCE_SNAPSHOT_TIMEOUT',
    })
    const failing = renderStage()
    await waitFor(() =>
      expect(failing.result.current.originalReferenceFallbackReason).toBe(
        'ORIGINAL_REFERENCE_SNAPSHOT_TIMEOUT',
      ),
    )
    failing.unmount()
  })

  it('keeps a snapshot live when its release throws, so evacuation fails closed', async () => {
    const { unmount, registry } = renderStage()
    await waitFor(() => expect(renders).toHaveLength(1))
    const snapshot = await resolveRender(0)
    revokeObjectURL.mockImplementationOnce(() => {
      throw new Error('snapshot release failed')
    })

    await expect(registry.disposeOwners(['preview'])).rejects.toThrow(
      'snapshot release failed',
    )
    expect(liveSnapshotUrls(registry)).toHaveLength(1)

    await registry.disposeOwners(['preview'])
    unmount()
    await act(async () => {})
    expect(revokedUrls()).toEqual([snapshot.objectUrl, snapshot.objectUrl])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('owns snapshots without a resource registry', async () => {
    const { rerender, unmount } = renderStageHook({ registry: null })
    await waitFor(() => expect(renders).toHaveLength(1))
    const first = await resolveRender(0)
    rerender({
      ...QUICK_PROPS,
      image: createImage('bounded-hq', 2400),
      imageVersion: 2,
      displaySource: 'bounded-hq',
    })
    await waitFor(() => expect(renders).toHaveLength(2))
    const second = await resolveRender(1)
    unmount()
    expect(revokedUrls()).toEqual([first.objectUrl, second.objectUrl])
  })
})
