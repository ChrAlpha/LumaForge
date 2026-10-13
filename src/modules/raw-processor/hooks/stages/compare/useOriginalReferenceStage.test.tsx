import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import {
  resetCapabilityVectorForTest,
  setCapabilityVectorForTest,
} from '~/lib/runtime/capability-vector'

import type { DisplaySource } from '../../../model/session'
import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import { useOriginalReferenceSnapshot } from '../../useOriginalReferenceSnapshot'
import { useOriginalReferenceStage } from './useOriginalReferenceStage'

const rendererMock = vi.hoisted(() => ({
  renderOriginalReferenceSnapshot: vi.fn(),
}))

vi.mock('../../../services/compare/original-reference-renderer', () => ({
  renderOriginalReferenceSnapshot: rendererMock.renderOriginalReferenceSnapshot,
}))

// The snapshot port runs as it is; the spy only records what the stage hands
// it.
vi.mock('../../useOriginalReferenceSnapshot', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../useOriginalReferenceSnapshot')>()
  return {
    ...actual,
    useOriginalReferenceSnapshot: vi.fn(actual.useOriginalReferenceSnapshot),
  }
})

type PendingRender = {
  key: string
  signal?: AbortSignal
  promise: Promise<OriginalReferenceSnapshot>
  resolve: (snapshot: OriginalReferenceSnapshot) => void
}

type StageProps = {
  sessionId: string | null
  viewMode: PreviewViewMode
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
      return useOriginalReferenceStage({
        sessionId: props.sessionId,
        viewMode: props.viewMode,
        previewSuspended: false,
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

describe('useOriginalReferenceStage', () => {
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
    vi.mocked(useOriginalReferenceSnapshot).mockClear()
  })

  it('hands the snapshot port the accepted descriptor of the frame it prepares', async () => {
    const quick = createImage('quick')
    const descriptor: DecodedPreviewFrame = {
      sessionId: 'session-original-reference',
      frameId: 'decoded-frame-1',
      stage: 'quick',
      width: quick.width,
      height: quick.height,
      exposure: { kind: 'unpinned', value: quick.renderExposure },
      quickPredecessorFrameId: null,
    }
    const lastPortInput = () =>
      vi.mocked(useOriginalReferenceSnapshot).mock.lastCall?.[0]
    const { rerender, unmount } = renderStage()
    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'compare',
      image: quick,
      imageVersion: 1,
      frame: descriptor,
      displaySource: 'quick',
    })
    // The same object the workflow published, beside the pixels it names.
    expect(lastPortInput()?.image).toBe(quick)
    expect(lastPortInput()?.frame).toBe(descriptor)

    // A frame the stage does not prepare a snapshot for names none.
    rerender({
      sessionId: 'session-original-reference',
      viewMode: 'processed',
      image: quick,
      imageVersion: 1,
      frame: descriptor,
      displaySource: 'quick',
    })
    expect(lastPortInput()?.image).toBeNull()
    expect(lastPortInput()?.frame).toBeNull()
    unmount()
    await act(async () => {})
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
})
