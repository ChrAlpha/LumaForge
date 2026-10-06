import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import { PREVIEW_TRANSFORM_HQ_EXPORT_REASON } from '../../../model/derive-session'
import type { ExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import { useExportDerivedState } from './useExportDerivedState'

function createExportResult(): ExportResult {
  return {
    kind: 'full-resolution',
    output: {
      kind: 'blob',
      filename: 'frame.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      byteLength: 4,
      mimeType: 'image/jpeg',
    },
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: 4,
    createdAt: 1,
    copyCapability: {
      mode: 'full-resolution',
      label: 'Copy full-resolution image',
    },
  }
}

function createSession(): ImageSession {
  return {
    id: 'session-export',
    createdAt: 1,
    sourceFile: {
      file: new File(['raw'], 'frame.dng'),
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
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
      fullResCapability: { status: 'supported', width: 800, height: 600 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createBoundedHqImage(): DecodedImage {
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
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useExportDerivedState', () => {
  it('keeps full-resolution export and refuses only HQ preview under geometry', () => {
    const session = { ...createSession(), exportGeometry: SAMPLE_GEOMETRY }
    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: createBoundedHqImage() },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
      }),
    )

    expect(result.current.canExport).toBe(true)
    expect(result.current.exportDisabledReason).toBeUndefined()
    // The bounded HQ preview cannot reproduce the geometry, so it says so
    // instead of quietly delivering an ungeometried frame.
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toBe(
      PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
    )
  })

  it('enables HQ preview export for a ready bounded-HQ decoded preview', () => {
    const session = createSession()
    const stats = { inputSize: { width: 800, height: 600 } } as PipelineStats
    const decodedImageRef = { current: createBoundedHqImage() }

    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef,
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        stats,
      }),
    )

    expect(result.current.canExport).toBe(true)
    expect(result.current.exportDisabledReason).toBeUndefined()
    expect(result.current.previewSuspended).toBe(false)
    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.previewExportDisabledReason).toBeUndefined()
  })

  it('suspends HQ preview export while a ready full-res export owns the preview budget', () => {
    const session: ImageSession = {
      ...createSession(),
      exportState: {
        ...createSession().exportState,
        status: 'ready',
        result: createExportResult(),
        activePlan: {
          profileName: 'desktop-fast',
          preferredRows: 128,
          concurrency: 1,
          runtimeMemoryProfile: 'desktop',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
        },
      },
    }

    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: null },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
      }),
    )

    expect(result.current.exportResult).toBe(session.exportState.result)
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toBe(
      'Restore the preview before exporting an HQ preview JPEG.',
    )
  })

  it('projects the recovery state only from the hint read for the loaded source', () => {
    const session = createSession()
    const sourceFile = session.sourceFile.file ?? null
    if (!sourceFile) throw new Error('Expected a session source file.')
    const exportInterruption = {
      source: encodeExportSourceHint(sourceFile) ?? '',
      hint: {
        previousCrashLikeInterruption: true,
        previousResourceFailure: false,
        attempts: ['attempt-a'],
      },
    }
    const render = (file: File | null) =>
      renderHook(() =>
        useExportDerivedState({
          // A recovery left on the session is not a second source of hints.
          session: {
            ...session,
            exportState: {
              ...session.exportState,
              recovery: {
                status: 'ready-to-retry',
                exportId: 'session-left-over',
                message: 'Interrupted.',
              },
            },
          },
          exportInterruption,
          decodedImageRef: { current: null },
          embeddedPreviewUrl: null,
          status: 'ready',
          hasImage: true,
          displaySource: 'quick',
          sourceFile: file,
          rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
          stats: null,
        }),
      ).result.current.exportRecovery

    expect(render(sourceFile)).toEqual({
      status: 'ready-to-retry',
      exportId: 'attempt-a',
      message: expect.any(String),
    })
    expect(
      render(new File(['other'], 'other.dng', { lastModified: 1 })),
    ).toEqual({ status: 'none' })
    expect(render(null)).toEqual({ status: 'none' })
  })
})
