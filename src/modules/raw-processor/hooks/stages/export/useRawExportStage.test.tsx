import type {
  ColorGraphIntent,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import {
  getEffectiveColorIntent,
  getProcessingParams,
  setProcessingParams,
} from '../../../state/workflow.atoms'
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
      fullResCapability: { status: 'supported', width: 800, height: 600 },
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
    paramsRef: { current: params },
    getSession: () => null,
    getColorIntent: () => params,
    getLutData: () => null,
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
    previewRuntime: { cancel: vi.fn(), terminate: vi.fn() },
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
    queueExportResultResourceDisposal: vi.fn(),
    toast: { error: vi.fn(), success: vi.fn() },
    ...overrides,
  }
}

/** A ready matching source with a crash-like interruption hint. */
function createInterruptedReadyInput(
  status: ProcessingStatus,
  overrides: Partial<ExportStageInput> = {},
): ExportStageInput {
  const session = createReadySession()

  return createStageInput({
    loadedImage: { file: SOURCE_FILE, metadata: null },
    session,
    sessionRef: { current: session },
    exportInterruption: INTERRUPTION,
    exportInterruptionRef: { current: INTERRUPTION },
    status,
    hasImage: true,
    displaySource: 'quick',
    rawRenderExposure: RAW_RENDER_EXPOSURE,
    ...overrides,
  })
}

describe('useRawExportStage', () => {
  const storedIntent = getProcessingParams()

  beforeEach(() => {
    vi.mocked(orchestrateFullResExport).mockClear()
  })

  afterEach(() => {
    setCurrentSession(null)
    setProcessingParams(storedIntent)
  })

  it('composes export state and actions for an empty workflow', () => {
    const { result } = renderHook(() => useRawExportStage(createStageInput()))

    expect(result.current.canExport).toBe(false)
    expect(result.current.exportResult).toBeNull()
    expect(result.current.previewSuspended).toBe(false)
    expect(typeof result.current.exportImage).toBe('function')
    expect(typeof result.current.exportPreviewImage).toBe('function')
    expect(typeof result.current.downloadExportResult).toBe('function')
    // The explicit export is the only way in: no recovery or retry action.
    expect(
      Object.keys(result.current).filter((key) => /recover|retry/i.test(key)),
    ).toEqual([])
  })

  it('never exports from discovery, source load or readiness changes', () => {
    const view = renderHook(
      (input: ExportStageInput) => useRawExportStage(input),
      { initialProps: createInterruptedReadyInput('decoding') },
    )

    view.rerender(createInterruptedReadyInput('ready'))
    expect(view.result.current.canExport).toBe(true)
    expect(view.result.current.exportInterrupted).toBe(true)
    view.rerender(
      createInterruptedReadyInput('ready', {
        params: { ...params, userContrast: 0.4 },
      }),
    )

    expect(orchestrateFullResExport).not.toHaveBeenCalled()
    expect(view.result.current.exportInterrupted).toBe(true)
  })

  it('notes no interruption for a loaded source the hint was not read for', () => {
    const other = new File(['other'], 'other.dng', { lastModified: 9 })
    const { result } = renderHook(() =>
      useRawExportStage(
        createInterruptedReadyInput('ready', {
          loadedImage: { file: other, metadata: null },
        }),
      ),
    )

    expect(result.current.exportInterrupted).toBe(false)
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
      getColorIntent: () => currentParams,
    })
    const { result } = renderHook(() => useRawExportStage(input))

    expect(orchestrateFullResExport).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.exportImage()
    })

    expect(orchestrateFullResExport).toHaveBeenCalledTimes(1)
    const [options, ctx] = vi.mocked(orchestrateFullResExport).mock.calls[0]!
    // Only the source-scoped hint travels: no journal, so the plan sizes
    // from the current source and the graph renders the current look.
    expect(options).toEqual({ interruption: INTERRUPTION })
    expect(ctx.services.interruptionMarkers).toBe(input.interruptionMarkers)
    expect(ctx.atoms.getColorIntent()).toBe(currentParams)
    expect(ctx.atoms.loadedImage.file).toBe(SOURCE_FILE)
    expect(ctx.atoms.session?.exportState.fullResCapability).toEqual({
      status: 'supported',
      width: 800,
      height: 600,
    })
  })

  it('sends an explicit export with no quality or fidelity choice without interruption history', async () => {
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
      await result.current.exportImage()
    })

    expect(vi.mocked(orchestrateFullResExport).mock.calls[0]?.[0]).toEqual({})
  })

  it('admits an export from an older render with the session, color and LUT the store holds', async () => {
    const rendered = createReadySession()
    setCurrentSession(rendered)
    let storedLut: LUTData | null = null
    const admitted: Array<{
      session: ImageSession | null
      intent: ColorGraphIntent
      lut: LUTData | null
    }> = []
    vi.mocked(orchestrateFullResExport).mockImplementationOnce(
      async (_request, ctx) => {
        admitted.push({
          session: ctx.atoms.getSession(),
          intent: ctx.atoms.getColorIntent() as ColorGraphIntent,
          lut: ctx.atoms.getLutData(),
        })
        // The ref follows the LUT only once its effect runs; the full
        // export never reads it.
        expect(ctx.atoms).not.toHaveProperty('lutDataRef')
      },
    )
    const { result } = renderHook(() =>
      useRawExportStage(
        createStageInput({
          loadedImage: { file: SOURCE_FILE, metadata: null },
          session: rendered,
          sessionRef: { current: rendered },
          getSession: getCurrentSession,
          getColorIntent: getEffectiveColorIntent,
          getLutData: () => storedLut,
          status: 'ready',
          hasImage: true,
          displaySource: 'quick',
          rawRenderExposure: RAW_RENDER_EXPOSURE,
        }),
      ),
    )
    const exportFromRender = result.current.exportImage

    // A LUT apply writes the LUT and the look, and a color edit lands, all
    // in the same tick, before any rerender or LUT effect.
    const appliedLut: LUTData = {
      size: 2,
      data: new Float32Array(2 * 2 * 2 * 3),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      title: 'Teal',
      inputProfile: 'display-srgb',
      profileResolution: { kind: 'unknown' },
    }
    storedLut = appliedLut
    setCurrentSession((prev) =>
      prev
        ? {
            ...prev,
            activeStyle: {
              kind: 'custom',
              name: 'Teal',
              defaultIntensity: 0.7,
              currentIntensity: 0.37,
              lutAsset: { format: 'cube', dimension: 17 },
            },
          }
        : prev,
    )
    setProcessingParams({ ...getProcessingParams(), userContrast: 25 })
    const written = getCurrentSession()
    await act(async () => {
      await exportFromRender()
    })

    expect(admitted).toHaveLength(1)
    expect(admitted[0]!.session).toBe(written)
    expect(admitted[0]!.lut).toBe(appliedLut)
    // The color projects the look of the very session the export reads.
    expect(admitted[0]!.intent).toMatchObject({
      styleKind: 'custom',
      intensity: 0.37,
      userContrast: 25,
    })
  })
})
