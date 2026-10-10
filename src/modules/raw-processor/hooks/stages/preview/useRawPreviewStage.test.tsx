import type {
  ColorGraphIntent,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import { createRawRuntimeSessionLeases } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import { usePreviewHistogram } from '../../usePreviewHistogram'
import { useRawPreviewStage } from './useRawPreviewStage'

// The real histogram hook runs; the wrapper only records what it receives.
vi.mock('../../usePreviewHistogram', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../usePreviewHistogram')>()
  return { ...actual, usePreviewHistogram: vi.fn(actual.usePreviewHistogram) }
})

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

function createSession(
  id: string,
  options: { file?: File; embeddedObjectUrl?: string } = {},
): ImageSession {
  const file = options.file ?? new File(['raw'], `${id}.dng`)
  return {
    id,
    createdAt: 1,
    sourceFile: {
      file,
      name: file.name,
      extension: 'dng',
      sizeBytes: 3,
      metadata: { width: 400, height: 300 },
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: options.embeddedObjectUrl
        ? {
            status: 'ready',
            objectUrl: options.embeddedObjectUrl,
            width: 400,
            height: 300,
            mimeType: 'image/jpeg',
          }
        : { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: options.embeddedObjectUrl ? 'embedded' : 'none',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'idle' },
    exportState: {
      status: 'ready',
      fullResCapability: { status: 'supported', width: 400, height: 300 },
      retryRecommended: false,
    },
    transform: createTransformState(id),
  }
}

function createDecodedImage(renderExposure: RawRenderExposure): DecodedImage {
  return {
    width: 64,
    height: 48,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(64 * 48 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 64, height: 48 },
    renderExposure,
    timings: { decodeMs: 3 },
  }
}

function renderStage(
  overrides: Partial<Parameters<typeof useRawPreviewStage>[0]> = {},
) {
  const input: Parameters<typeof useRawPreviewStage>[0] = {
    decodedImageRef: { current: null },
    rawRenderExposureRef: { current: null },
    resourceRegistryRef: { current: createResourceRegistry() },
    setDecodedImageVersion: vi.fn(),
    invalidateExportGraph: vi.fn(),
    embeddedPreviewUrlRef: { current: null },
    setSession: setCurrentSession,
    pipelineRef: { current: null as RawProcessingPipeline | null },
    params,
    lutDataRef: { current: null },
    lutDataVersion: 0,
    displaySource: 'none',
    isMountedRef: { current: true },
    runtimeWorkSessionIdRef: { current: null },
    beginRuntimeSession: vi.fn(),
    setStatus: vi.fn(),
    setProgress: vi.fn(),
    setError: vi.fn(),
    scheduleToast: vi.fn(),
    toast: { error: vi.fn() },
    ...overrides,
  }
  return { ...renderHook(() => useRawPreviewStage(input)), input }
}

describe('useRawPreviewStage', () => {
  afterEach(() => {
    setCurrentSession(null)
    vi.unstubAllGlobals()
  })

  it('composes preview lifecycle actions for an empty preview state', async () => {
    const beginRuntimeSession = vi.fn()
    const { result } = renderStage({ beginRuntimeSession })

    expect(result.current.histogram).toEqual({
      state: 'unavailable',
      reason: 'no-image',
    })
    expect(typeof result.current.setDecodedImageRef).toBe('function')
    expect(typeof result.current.restorePreviewAfterExport).toBe('function')
    expect(
      typeof result.current.registerCurrentPreviewPipelineForEvacuation,
    ).toBe('function')
    expect(typeof result.current.setOriginalPreviewPipeline).toBe('function')

    // Without a source there is nothing to restore and no host lease to take.
    await result.current.restorePreviewAfterExport()
    expect(beginRuntimeSession).not.toHaveBeenCalled()
  })

  it('publishes the accepted descriptor to the workflow and the histogram as one object', () => {
    setCurrentSession(createSession('session-accepted'))
    const decodedImageRef = { current: null as DecodedImage | null }
    const { result, rerender } = renderStage({ decodedImageRef })
    expect(result.current.decodedFrame).toBeNull()

    act(() => {
      result.current.setDecodedImageRef(
        createDecodedImage({
          ev: 0.5,
          multiplier: 2 ** 0.5,
          source: 'identity',
        }),
      )
    })
    rerender()

    const frame = result.current.decodedFrame
    expect(frame).toMatchObject({
      sessionId: 'session-accepted',
      stage: 'quick',
      width: 64,
      height: 48,
    })
    expect(vi.mocked(usePreviewHistogram).mock.lastCall?.[0].frame).toBe(frame)

    act(() => {
      result.current.setDecodedImageRef(null)
    })
    rerender()
    expect(result.current.decodedFrame).toBeNull()
    expect(vi.mocked(usePreviewHistogram).mock.lastCall?.[0].frame).toBeNull()
  })

  it('restores the source in the store, with its 0 EV pin, and keeps the delivered result', async () => {
    const rendered = createSession('session-rendered')
    const replacementFile = new File(['raw'], 'replacement.dng')
    const replacement = createSession('session-replacement', {
      file: replacementFile,
    })
    setCurrentSession(rendered)
    const pinnedExposure: RawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    }
    const decoded = createDecodedImage(pinnedExposure)
    const runtimeSession: RawRuntimeSession = {
      sourceDimensions: { width: 64, height: 48 },
      extractEmbeddedPreview: vi.fn(),
      decodeQuickRaw: vi.fn(async () => decoded),
      decodeBoundedHqRaw: vi.fn(),
      applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
      dispose: vi.fn(),
    }
    const open = vi.fn(
      async (_file: File, _signal: AbortSignal) => runtimeSession,
    )
    const slot = createRawRuntimeSessionLeases(open)
    const invalidateExportGraph = vi.fn()
    const { result, rerender } = renderStage({
      rawRenderExposureRef: { current: pinnedExposure },
      beginRuntimeSession: slot.begin,
      invalidateExportGraph,
    })

    // The store moves on before the stage rerenders: the restore names the
    // source the store holds when it runs.
    setCurrentSession(replacement)
    await act(async () => {
      await result.current.restorePreviewAfterExport()
    })

    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0]).toBe(replacementFile)
    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { pinnedExposure },
    )
    expect(getCurrentSession()?.id).toBe('session-replacement')
    expect(getCurrentSession()?.previewBundle.displaySource).toBe('quick')
    expect(getCurrentSession()?.exportState.status).toBe('ready')
    expect(invalidateExportGraph).not.toHaveBeenCalled()
    // The restored frame is a fresh acceptance of the source in the store.
    rerender()
    expect(result.current.decodedFrame).toMatchObject({
      sessionId: 'session-replacement',
      stage: 'quick',
      exposure: { kind: 'source-pin', value: pinnedExposure },
      quickPredecessorFrameId: null,
    })
  })

  it('revokes and clears the embedded URL of the source in the store only', () => {
    const rendered = createSession('session-rendered', {
      embeddedObjectUrl: 'blob:rendered-embedded',
    })
    const replacement = createSession('session-replacement', {
      embeddedObjectUrl: 'blob:replacement-embedded',
    })
    setCurrentSession(rendered)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, { revokeObjectURL }),
    )
    const embeddedPreviewUrlRef = {
      current: 'blob:replacement-embedded' as string | null,
    }
    const { result } = renderStage({
      embeddedPreviewUrlRef,
    })

    setCurrentSession(replacement)
    act(() => {
      result.current.revokeCurrentEmbeddedPreviewUrl()
    })

    expect(revokeObjectURL.mock.calls).toEqual([['blob:replacement-embedded']])
    expect(embeddedPreviewUrlRef.current).toBeNull()
    expect(getCurrentSession()?.id).toBe('session-replacement')
    expect(getCurrentSession()?.previewBundle.embeddedPreview).toEqual({
      status: 'idle',
    })
  })
})
