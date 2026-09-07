import { renderHook } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import { PREVIEW_TRANSFORM_HQ_EXPORT_REASON } from '../../../model/derive-session'
import type { ImageSession } from '../../../model/session'
import { useHqPreviewExportAction } from './useHqPreviewExportAction'

function createSession(): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      file: new File(['raw'], 'frame.dng'),
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      metadata: { width: 800, height: 600 },
      supportLevel: 'official',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: {
      kind: 'builtin',
      name: 'cinema',
      defaultIntensityLevel: 'standard',
      currentIntensityLevel: 'standard',
    },
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready', lastRenderSource: 'bounded-hq' },
    exportState: {
      status: 'idle',
      qualityPreset: 'standard',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'unknown' },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 800,
    height: 600,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(800 * 600 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'bounded-hq',
    metadata: { width: 800, height: 600 },
    renderExposure: {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    },
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useHqPreviewExportAction', () => {
  it('discards an HQ render completed after preview geometry invalidates its export', async () => {
    const sessionRef: { current: ImageSession | null } = {
      current: createSession(),
    }
    const exportGraphVersionRef = { current: 1 }
    const exportAbortControllerRef: { current: AbortController | null } = {
      current: null,
    }
    let completeRender!: (canvas: HTMLCanvasElement) => void
    const renderToHiddenCanvas = vi.fn(
      () =>
        new Promise<HTMLCanvasElement>((resolve) => {
          completeRender = resolve
        }),
    )
    const registerExportResultResource = vi.fn()
    const success = vi.fn()
    const error = vi.fn()
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef,
        exportAbortControllerRef,
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource,
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession: (updater) => {
          sessionRef.current =
            typeof updater === 'function'
              ? updater(sessionRef.current)
              : updater
        },
        setStatus: vi.fn(),
        toast: { success, error },
      }),
    )
    const pending = result.current.exportPreviewImage()
    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    exportAbortControllerRef.current!.abort()
    exportGraphVersionRef.current += 1
    sessionRef.current = {
      ...sessionRef.current!,
      exportGeometry: SAMPLE_GEOMETRY,
      exportState: { ...sessionRef.current!.exportState, status: 'idle' },
    }
    completeRender({
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    } as HTMLCanvasElement)
    await pending

    expect(sessionRef.current.exportState.result).toBeUndefined()
    expect(sessionRef.current.exportState.status).toBe('idle')
    expect(registerExportResultResource).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('rejects a previously captured HQ action after geometry becomes active', async () => {
    const sessionRef = { current: createSession() }
    const renderToHiddenCanvas = vi.fn()
    const setStatus = vi.fn()
    const error = vi.fn()
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource: vi.fn(),
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession: vi.fn(),
        setStatus,
        toast: { success: vi.fn(), error },
      }),
    )
    const exportPreviewImage = result.current.exportPreviewImage
    sessionRef.current = {
      ...sessionRef.current,
      exportGeometry: SAMPLE_GEOMETRY,
    }
    await exportPreviewImage()

    expect(renderToHiddenCanvas).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
    })
  })

  it('exports the bounded HQ preview and stores the completed result on the active session', async () => {
    class FakeClipboardItem {
      static supports(type: string) {
        return type === 'image/jpeg'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)

    let session: ImageSession | null = createSession()
    const sessionRef: { current: ImageSession | null } = { current: session }
    const setSession: Dispatch<SetStateAction<ImageSession | null>> = vi.fn(
      (updater: SetStateAction<ImageSession | null>) => {
        session = typeof updater === 'function' ? updater(session) : updater
        sessionRef.current = session
      },
    )
    const fakeCanvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob(['jpeg'], { type: type ?? 'image/jpeg' }))
      }),
    } as unknown as HTMLCanvasElement
    const renderToHiddenCanvas = vi.fn().mockResolvedValue(fakeCanvas)
    const registerExportResultResource = vi.fn()
    const statusUpdates: string[] = []
    const progressUpdates: number[] = []
    const toastMessages: string[] = []
    const previewCopyCanvasRef = {
      current: {} as HTMLCanvasElement,
    }

    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef,
        previewSuspended: false,
        previewExportDisabledReason: undefined,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource,
        scheduleToast: (notify) => notify(),
        setProgress: (progress) => progressUpdates.push(progress),
        setSession,
        setStatus: (status) => statusUpdates.push(status),
        toast: {
          success: (message) => {
            toastMessages.push(message)
          },
          error: vi.fn(),
        },
      }),
    )

    await result.current.exportPreviewImage()

    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 800,
      height: 600,
    })
    expect(fakeCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/jpeg',
      0.9,
    )
    expect(registerExportResultResource).toHaveBeenCalledTimes(1)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(session?.exportState.status).toBe('ready')
    expect(session?.exportState.result?.kind).toBe('hq-preview')
    expect(session?.exportState.result?.filename).toBe(
      'frame_cinema_hq-preview.jpg',
    )
    expect(statusUpdates).toEqual(['exporting', 'ready'])
    expect(progressUpdates).toEqual([0, 100])
    expect(toastMessages).toEqual(['HQ preview JPEG ready'])
  })
})
