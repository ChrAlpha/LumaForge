import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'
import type { PendingRecoveryRetry } from './useExportRecoveryAction'
import { useRawExportStage } from './useRawExportStage'

vi.mock('../../../services/export/orchestrate-full-res-export', () => ({
  orchestrateFullResExport: vi.fn(async () => undefined),
}))

type ExportStageInput = Parameters<typeof useRawExportStage>[0]

const params: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

const SOURCE_FILE = new File(['raw'], 'frame.dng', { lastModified: 123 })
const RAW_RENDER_EXPOSURE = {
  ev: 0,
  multiplier: 1,
  source: 'identity',
} as const

/** A journal an older build left: the delivered crop, not the sensor frame. */
function createTransformedJournal(): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-interrupted',
    sourceFingerprint: {
      name: SOURCE_FILE.name,
      size: SOURCE_FILE.size,
      lastModified: SOURCE_FILE.lastModified,
      hashPrefixHex: 'hash',
    },
    fileName: SOURCE_FILE.name,
    sourceSize: SOURCE_FILE.size,
    sourceLastModified: SOURCE_FILE.lastModified,
    outputWidth: 640,
    outputHeight: 360,
    graphFingerprint: 'graph-before-interruption',
    profile: 'ios-safe',
    attempt: 1,
    preferredRows: 64,
    totalRows: 360,
    recoveryMode: 'safe-retry',
    outputSink: 'opfs-file',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 64,
    jpegState: 'restart-required',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

const INTERRUPTION: SourceInterruptionHint = {
  source: encodeExportSourceHint(SOURCE_FILE) ?? '',
  hint: {
    previousCrashLikeInterruption: true,
    previousResourceFailure: false,
    attempts: ['attempt-interrupted'],
  },
}

function createReadySession(): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      file: SOURCE_FILE,
      name: SOURCE_FILE.name,
      extension: 'dng',
      sizeBytes: SOURCE_FILE.size,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'quick',
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
    renderState: { status: 'ready', lastRenderSource: 'quick' },
    exportState: {
      status: 'idle',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 800, height: 600 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createStageInput(
  overrides: Partial<ExportStageInput> = {},
): ExportStageInput {
  return {
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    setSession: vi.fn(),
    loadedImage: { file: null, metadata: null },
    session: null,
    params,
    lutDataRef: { current: null },
    decodedImageRef: { current: null },
    stats: null,
    refreshExportInterruption: vi.fn(),
    interruptionMarkers: {
      begin: vi.fn(),
      finish: vi.fn(),
      inspect: vi.fn(),
      retire: vi.fn(),
    },
    exportAbortControllerRef: { current: null },
    exportGraphVersionRef: { current: 0 },
    isMountedRef: { current: true },
    sessionRef: { current: null as ImageSession | null },
    pipelineRef: { current: null as RawProcessingPipeline | null },
    resourceRegistryRef: { current: createResourceRegistry() },
    previewCopyCanvasRef: { current: null },
    scheduleToast: vi.fn(),
    abortExportWork: vi.fn(),
    abortRuntimeWork: vi.fn(),
    terminateRawDecodeBridge: vi.fn(),
    registerCurrentPreviewPipelineForEvacuation: vi.fn(),
    registerExportResultResource: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    exportInterruption: null,
    exportInterruptionRef: { current: null },
    embeddedPreviewUrl: null,
    status: 'idle',
    hasImage: false,
    displaySource: 'none',
    rawRenderExposure: null,
    pendingRecoveryRetry: null,
    setPendingRecoveryRetry: vi.fn(),
    loadFile: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    toast: { error: vi.fn(), success: vi.fn() },
    ...overrides,
  }
}

/**
 * A matching source with an interruption hint and a legacy armed retry: the
 * strongest state the retired recovery flow would have exported from.
 */
function createInterruptedReadyInput(
  status: ProcessingStatus,
  overrides: Partial<ExportStageInput> = {},
): ExportStageInput {
  const session = createReadySession()
  const journal = createTransformedJournal()
  const pendingRecoveryRetry: PendingRecoveryRetry = {
    sourceExportId: journal.exportId,
    manifest: journal,
    sessionId: session.id,
    fileName: SOURCE_FILE.name,
    size: SOURCE_FILE.size,
    lastModified: SOURCE_FILE.lastModified,
  }

  return createStageInput({
    loadedImage: { file: SOURCE_FILE, metadata: null },
    session,
    sessionRef: { current: session },
    exportInterruption: INTERRUPTION,
    exportInterruptionRef: { current: INTERRUPTION },
    pendingRecoveryRetry,
    status,
    hasImage: true,
    displaySource: 'quick',
    rawRenderExposure: RAW_RENDER_EXPOSURE,
    ...overrides,
  })
}

describe('useRawExportStage', () => {
  beforeEach(() => {
    vi.mocked(orchestrateFullResExport).mockClear()
  })

  it('composes export state and actions for an empty workflow', () => {
    const { result } = renderHook(() => useRawExportStage(createStageInput()))

    expect(result.current.canExport).toBe(false)
    expect(result.current.exportResult).toBeNull()
    expect(result.current.previewSuspended).toBe(false)
    expect(typeof result.current.exportImage).toBe('function')
    expect(typeof result.current.exportPreviewImage).toBe('function')
    expect(typeof result.current.recoverInterruptedExport).toBe('function')
    expect(typeof result.current.downloadExportResult).toBe('function')
  })

  it('never exports from discovery, source load or readiness changes', () => {
    const view = renderHook(
      (input: ExportStageInput) => useRawExportStage(input),
      { initialProps: createInterruptedReadyInput('decoding') },
    )

    view.rerender(createInterruptedReadyInput('ready'))
    expect(view.result.current.canExport).toBe(true)
    expect(view.result.current.exportRecovery.status).toBe('ready-to-retry')
    view.rerender(
      createInterruptedReadyInput('ready', {
        params: { ...params, userContrast: 0.4 },
      }),
    )

    expect(orchestrateFullResExport).not.toHaveBeenCalled()
    expect(view.result.current.exportRecovery).toEqual({
      status: 'ready-to-retry',
      exportId: 'attempt-interrupted',
      message: expect.any(String),
    })
  })

  it('projects no recovery for a loaded source the hint was not read for', () => {
    const other = new File(['other'], 'other.dng', { lastModified: 9 })
    const { result } = renderHook(() =>
      useRawExportStage(
        createInterruptedReadyInput('ready', {
          loadedImage: { file: other, metadata: null },
        }),
      ),
    )

    expect(result.current.exportRecovery).toEqual({ status: 'none' })
    expect(orchestrateFullResExport).not.toHaveBeenCalled()
  })

  it('sends interruption history with one explicit export of the current look', async () => {
    const currentParams: ProcessingParams = {
      ...params,
      userExposureEv: 0.5,
      userSaturation: 0.2,
    }
    const input = createInterruptedReadyInput('ready', {
      params: currentParams,
    })
    const { result } = renderHook(() => useRawExportStage(input))

    expect(orchestrateFullResExport).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.exportImage({
        quality: 'high',
        fidelity: 'balanced',
      })
    })

    expect(orchestrateFullResExport).toHaveBeenCalledTimes(1)
    const [options, ctx] = vi.mocked(orchestrateFullResExport).mock.calls[0]!
    // Only the source-scoped hint travels: no journal, so the plan sizes
    // from the current source and the graph renders the current look.
    expect(options).toEqual({
      quality: 'high',
      fidelity: 'balanced',
      interruption: INTERRUPTION,
    })
    expect(ctx.services.interruptionMarkers).toBe(input.interruptionMarkers)
    expect(ctx.atoms.params).toBe(currentParams)
    expect(ctx.atoms.loadedImage.file).toBe(SOURCE_FILE)
    expect(ctx.atoms.session?.exportState.fullResCapability).toEqual({
      status: 'supported',
      width: 800,
      height: 600,
    })
  })

  it('sends only the chosen quality and fidelity without interruption history', async () => {
    const session = createReadySession()
    const { result } = renderHook(() =>
      useRawExportStage(
        createStageInput({
          loadedImage: { file: SOURCE_FILE, metadata: null },
          session,
          sessionRef: { current: session },
          status: 'ready',
          hasImage: true,
          displaySource: 'quick',
          rawRenderExposure: RAW_RENDER_EXPOSURE,
        }),
      ),
    )

    await act(async () => {
      await result.current.exportImage({ quality: 'standard', fidelity: 'max' })
    })

    expect(vi.mocked(orchestrateFullResExport).mock.calls[0]?.[0]).toEqual({
      quality: 'standard',
      fidelity: 'max',
    })
  })
})
