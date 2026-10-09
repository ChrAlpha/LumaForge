import type {
  ColorGraphIntent,
  LUTData,
  ParsedLUT,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  parseCubeLUT,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { act, renderHook } from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import type { ProcessingStatus } from '../../../model/workflow'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import { claimExportSlot } from '../../../services/export/export-state'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'
import { reduceTransformState } from '../../../services/transform/transform-state'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import {
  getEffectiveColorIntent,
  getLut,
  getProcessingParams,
  setLut,
  setProcessingParams,
} from '../../../state/workflow.atoms'
import { useRawExportStage } from './useRawExportStage'

vi.mock('../../../services/export/orchestrate-full-res-export', () => ({
  orchestrateFullResExport: vi.fn(async () => undefined),
}))

type ExportStageInput = Parameters<typeof useRawExportStage>[0]

const params: ColorGraphIntent = {
  intensity: 0.7,
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
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
}

const SOURCE_FILE = new File(['raw'], 'frame.dng', { lastModified: 123 })
const RAW_RENDER_EXPOSURE = {
  ev: 0,
  multiplier: 1,
  source: 'identity',
} as const

/** A two-point "Teal" cube; each test chooses its own contract. */
const tealCube = `TITLE "Teal"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`

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
    exportInterruption: INTERRUPTION,
    exportInterruptionRef: { current: INTERRUPTION },
    status,
    hasImage: true,
    displaySource: 'quick',
    rawRenderExposure: RAW_RENDER_EXPOSURE,
    ...overrides,
  })
}

/** A session whose bounded HQ frame is on screen, for the HQ export. */
function createBoundedHqSession(): ImageSession {
  const session = createReadySession()
  return {
    ...session,
    sourceFile: {
      ...session.sourceFile,
      metadata: { width: 800, height: 600 },
    },
    previewBundle: {
      ...session.previewBundle,
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
    },
    renderState: { status: 'ready', lastRenderSource: 'bounded-hq' },
    transform: createTransformState(session.id),
  }
}

function createBoundedHqImage(): DecodedImage {
  return {
    width: 800,
    height: 600,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'bounded-hq',
    metadata: { width: 800, height: 600 },
    renderExposure: RAW_RENDER_EXPOSURE,
  }
}

/**
 * The HQ export over the workflow's stores: the stage reads the session,
 * the color and the LUT from them. The pipeline renders with the color
 * and the LUT it holds, which follow the stores only on `drawStoredLook`, as
 * the preview's effects would after a rerender.
 */
function renderHqStage(getLutData: () => LUTData | null) {
  const rendered = createBoundedHqSession()
  setCurrentSession(rendered)
  const held = { params: getEffectiveColorIntent(), lut: getLutData() }
  const drawn: Array<{ params: ColorGraphIntent; lut: LUTData | null }> = []
  const renderToHiddenCanvas = vi.fn(async () => {
    drawn.push({ ...held })
    return {
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    } as unknown as HTMLCanvasElement
  })
  const pipeline = {
    renderToHiddenCanvas,
    getParams: () => ({ ...held.params, viewMode: 'processed' as const }),
    getLutData: () => held.lut,
  }
  const toast = { error: vi.fn(), success: vi.fn() }
  const view = renderHook(() =>
    useRawExportStage(
      createStageInput({
        loadedImage: { file: SOURCE_FILE, metadata: null },
        session: rendered,
        getSession: getCurrentSession,
        getColorIntent: getEffectiveColorIntent,
        getLutData,
        setSession: setCurrentSession,
        decodedImageRef: { current: createBoundedHqImage() },
        pipelineRef: {
          current: pipeline as unknown as RawProcessingPipeline,
        },
        scheduleToast: (notify) => notify(),
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        rawRenderExposure: RAW_RENDER_EXPOSURE,
        toast,
      }),
    ),
  )
  return {
    ...view,
    renderToHiddenCanvas,
    toast,
    drawn,
    drawStoredLook() {
      held.params = getEffectiveColorIntent()
      held.lut = getLutData()
    },
  }
}

describe('useRawExportStage', () => {
  const storedIntent = getProcessingParams()

  beforeEach(() => {
    vi.mocked(orchestrateFullResExport).mockClear()
  })

  afterEach(() => {
    setCurrentSession(null)
    setProcessingParams(storedIntent)
    setLut(null)
  })

  it('composes export state and actions for an empty workflow', () => {
    const { result } = renderHook(() => useRawExportStage(createStageInput()))

    expect(result.current.canExport).toBe(false)
    expect(result.current.exportResult).toBeNull()
    expect(result.current.previewSuspended).toBe(false)
    expect(typeof result.current.exportImage).toBe('function')
    expect(typeof result.current.exportPreviewImage).toBe('function')
    expect(typeof result.current.downloadExportResult).toBe('function')
    // Every export action reads the session and the color from the store,
    // so the stage takes no render-written copy of either.
    expectTypeOf<ExportStageInput>().not.toHaveProperty('sessionRef')
    expectTypeOf<ExportStageInput>().not.toHaveProperty('paramsRef')
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
    const currentParams: ColorGraphIntent = {
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
      ...toLUTData(parseCubeLUT(tealCube)),
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
  it('refuses an HQ export from an older render once the store holds a pending Transform', async () => {
    const { result, renderToHiddenCanvas, toast } = renderHqStage(() => null)
    const exportPreviewFromRender = result.current.exportPreviewImage

    // The first Transform edit lands in the store; nothing rerenders before
    // the captured action runs.
    setCurrentSession((prev) =>
      prev?.transform
        ? {
            ...prev,
            transform: reduceTransformState(prev.transform, {
              type: 'edit',
              sourceId: prev.id,
              intent: {
                manual: { ...prev.transform.intent.manual, rotate: 2 },
              },
            }),
          }
        : prev,
    )
    await act(async () => {
      await exportPreviewFromRender()
    })

    expect(renderToHiddenCanvas).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: expect.any(String),
    })
    expect(getCurrentSession()?.exportState.status).toBe('idle')
  })

  it('admits an HQ export from an older render with the session, color and LUT the store holds', async () => {
    let storedLut: LUTData | null = null
    const { result, renderToHiddenCanvas, drawn, drawStoredLook } =
      renderHqStage(() => storedLut)
    const exportPreviewFromRender = result.current.exportPreviewImage

    // A LUT apply writes the LUT and the look, and a color edit lands, all
    // in the same tick, before any rerender or LUT effect.
    const appliedLut: LUTData = {
      ...toLUTData(parseCubeLUT(tealCube)),
      // A confirmed scene contract the WebGPU preview draws.
      profileResolution: {
        kind: 'confirmed',
        confidence: 'user',
        profile: {
          id: 'teal-profile',
          label: 'Teal profile',
          role: 'scene-creative',
          inputGamut: 'v-gamut',
          inputTransfer: 'v-log',
          inputRange: 'full',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          outputRange: 'full',
          aliases: [],
        },
      },
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
    const written = getCurrentSession()!
    const admittedIntent = getEffectiveColorIntent()
    // The color projects the look of the very session the export reads.
    expect(admittedIntent).toMatchObject({
      styleKind: 'custom',
      intensity: 0.37,
      userContrast: 25,
    })
    const expected = captureExportResultIdentity({
      resultKind: 'hq-preview',
      attemptId: 'not-compared',
      sessionId: written.id,
      sourceFile: SOURCE_FILE,
      intent: admittedIntent,
      lut: appliedLut,
      rawRenderExposure: RAW_RENDER_EXPOSURE,
      geometry: null,
    })
    // The preview's effects draw the written look; the surface still holds
    // the action from the older render.
    drawStoredLook()
    await act(async () => {
      await exportPreviewFromRender()
    })

    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    // The pipeline drew the very look the result names.
    expect(drawn).toEqual([{ params: admittedIntent, lut: appliedLut }])
    const delivered = getCurrentSession()?.exportState.result
    expect(delivered?.kind).toBe('hq-preview')
    expect(delivered?.filename).toBe('frame_Teal_hq-preview.jpg')
    expect(delivered?.identity).toEqual({
      ...expected,
      attemptId: expect.any(String),
    })
  })
  /** A parsed LUT whose confirmed scene contract the WebGPU preview draws. */
  function parsedLut(title: string): ParsedLUT {
    const cube = `TITLE "${title}"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`
    return {
      ...parseCubeLUT(cube),
      data: new Float32Array(2 * 2 * 2 * 3).fill(title.length / 10),
      fingerprint: title,
      profileResolution: {
        kind: 'confirmed',
        confidence: 'user',
        profile: {
          id: `${title}-profile`,
          label: `${title} profile`,
          role: 'scene-creative',
          inputGamut: 'v-gamut',
          inputTransfer: 'v-log',
          inputRange: 'full',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          outputRange: 'full',
          aliases: [],
        },
      },
    }
  }

  /** The stored LUT in the shape the pipeline reads, as the workflow reads it. */
  const getStoredLutData = () => {
    const lut = getLut()
    return lut ? toLUTData(lut) : null
  }

  const customLook = (session: ImageSession | null): ImageSession | null =>
    session
      ? {
          ...session,
          activeStyle: {
            kind: 'custom',
            name: 'Teal',
            defaultIntensity: 0.7,
            currentIntensity: 0.7,
            lutAsset: { format: 'cube', dimension: 17 },
          },
        }
      : session

  it.each([
    {
      name: 'a color edit',
      setup() {},
      write() {
        setProcessingParams({ ...getProcessingParams(), userContrast: 25 })
      },
    },
    {
      name: 'a LUT replacement',
      setup() {
        setLut(parsedLut('Teal'))
        setCurrentSession(customLook)
      },
      write() {
        setLut(parsedLut('Amber'))
      },
    },
  ])(
    'refuses an HQ export from an older render after $name the pipeline has not drawn',
    async ({ setup, write }) => {
      const { result, renderToHiddenCanvas, toast, drawStoredLook } =
        renderHqStage(getStoredLutData)
      setup()
      drawStoredLook()
      const exportPreviewFromRender = result.current.exportPreviewImage

      // The store takes the write; nothing rerenders and no preview effect
      // runs before the captured action, so the pipeline still holds the
      // look it drew before.
      write()
      await act(async () => {
        await exportPreviewFromRender()
      })

      expect(renderToHiddenCanvas).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        'HQ preview export is not ready',
        { description: 'HQ preview export is not ready.' },
      )
      expect(getCurrentSession()?.exportState.status).toBe('idle')
      expect(getCurrentSession()?.exportState.result).toBeUndefined()
    },
  )

  describe('delivery', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    function stubDelivery() {
      const createObjectURL = vi.fn(() => 'blob:delivery')
      vi.stubGlobal(
        'URL',
        Object.assign(class extends URL {}, {
          createObjectURL,
          revokeObjectURL: vi.fn(),
        }),
      )
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {})
      const share = vi.fn().mockResolvedValue(undefined)
      const clipboardWrite = vi.fn().mockResolvedValue(undefined)
      class FakeClipboardItem {
        static supports(type: string) {
          return type === 'image/jpeg' || type === 'image/png'
        }

        constructor(public readonly items: Record<string, Blob>) {}
      }
      vi.stubGlobal('navigator', {
        canShare: () => true,
        share,
        clipboard: { write: clipboardWrite },
      })
      vi.stubGlobal('ClipboardItem', FakeClipboardItem)
      return {
        delivered: () =>
          createObjectURL.mock.calls.length +
          click.mock.calls.length +
          share.mock.calls.length +
          clipboardWrite.mock.calls.length,
      }
    }

    /**
     * A completed full-resolution result over the workflow's stores, under
     * a custom look, with an output whose blob waits until the test releases
     * it. The stage renders once, with the preview released as export left
     * it; every later write lands in the stores and nothing rerenders.
     */
    function renderDeliveryStage() {
      setLut(parsedLut('Teal'))
      const base = createReadySession()
      setCurrentSession(
        customLook({ ...base, transform: createTransformState(base.id) }),
      )
      const exportAbortControllerRef = {
        current: null as AbortController | null,
      }
      // The attempt that produced the result claimed the slot and released
      // it when it ended, as every completed export does.
      claimExportSlot(
        exportAbortControllerRef,
        new AbortController(),
        'attempt-1',
      )
      exportAbortControllerRef.current = null
      let releaseBlob!: () => void
      const opened = new Promise<Blob>((resolve) => {
        releaseBlob = () => resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      })
      const openBlob = vi.fn(() => opened)
      const output: FileBackedOutputResult = {
        kind: 'file-backed',
        exportId: 'export-1',
        filename: 'frame.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
        openBlob,
      }
      const result: ExportResult = {
        kind: 'full-resolution',
        output,
        filename: 'frame.jpg',
        width: 800,
        height: 600,
        size: 4,
        createdAt: 1,
        copyCapability: { mode: 'full-resolution' },
        manifest: { manifest_version: 1 } as unknown as RenderManifest,
        manifestState: { status: 'ready' },
        identity: captureExportResultIdentity({
          resultKind: 'full-resolution',
          attemptId: 'attempt-1',
          sessionId: base.id,
          sourceFile: SOURCE_FILE,
          intent: getEffectiveColorIntent(),
          lut: getStoredLutData(),
          rawRenderExposure: RAW_RENDER_EXPOSURE,
          geometry: null,
        }),
      }
      setCurrentSession((prev) =>
        prev
          ? {
              ...prev,
              exportState: { ...prev.exportState, status: 'ready', result },
            }
          : prev,
      )
      const rendered = getCurrentSession()
      const toast = { error: vi.fn(), success: vi.fn() }
      const view = renderHook(() =>
        useRawExportStage(
          createStageInput({
            loadedImage: { file: SOURCE_FILE, metadata: null },
            session: rendered,
            params: getEffectiveColorIntent(),
            getSession: getCurrentSession,
            getColorIntent: getEffectiveColorIntent,
            getLutData: getStoredLutData,
            lutDataRef: { current: getStoredLutData() },
            setSession: setCurrentSession,
            exportAbortControllerRef,
            scheduleToast: (notify) => notify(),
            status: 'ready',
            hasImage: true,
            displaySource: 'quick',
            rawRenderExposure: RAW_RENDER_EXPOSURE,
            toast,
          }),
        ),
      )
      return {
        ...view,
        heldResult: result,
        openBlob,
        releaseBlob,
        toast,
        exportAbortControllerRef,
      }
    }

    type DeliveryStage = ReturnType<typeof renderDeliveryStage>

    const withSession = (update: (session: ImageSession) => ImageSession) =>
      setCurrentSession((prev) => (prev ? update(prev) : prev))

    /** Store writes after which the held result no longer answers. */
    const STALE_WRITES: Array<[string, (stage: DeliveryStage) => void]> = [
      [
        'a color edit lands',
        () =>
          setProcessingParams({ ...getProcessingParams(), userContrast: 25 }),
      ],
      [
        'the look strength changes',
        () =>
          withSession((session) => ({
            ...session,
            activeStyle: session.activeStyle
              ? { ...session.activeStyle, currentIntensity: 0.4 }
              : null,
          })),
      ],
      [
        'the LUT contract changes',
        () => setLut({ ...getLut()!, profileResolution: { kind: 'unknown' } }),
      ],
      ['the LUT is replaced', () => setLut(parsedLut('Amber'))],
      [
        'a Transform edit is pending',
        () =>
          withSession((session) => ({
            ...session,
            transform: reduceTransformState(session.transform!, {
              type: 'edit',
              sourceId: session.id,
              intent: {
                manual: { ...session.transform!.intent.manual, rotate: 2 },
              },
            }),
          })),
      ],
      [
        'a later result replaces it',
        (stage) =>
          withSession((session) => ({
            ...session,
            exportState: {
              ...session.exportState,
              result: {
                ...stage.heldResult,
                identity: {
                  ...stage.heldResult.identity!,
                  attemptId: 'attempt-2',
                },
              },
            },
          })),
      ],
      ['the session is reset', () => setCurrentSession(null)],
      [
        'a later attempt claims the export slot',
        (stage) =>
          claimExportSlot(
            stage.exportAbortControllerRef,
            new AbortController(),
            'attempt-2',
          ),
      ],
    ]

    const MATERIALIZING = [
      ['download', 'downloadExportResult'],
      ['share', 'shareExportResult'],
      ['copy', 'copyExportResult'],
    ] as const

    describe.each(MATERIALIZING)('%s', (_name, action) => {
      it.each(STALE_WRITES)(
        'delivers nothing when %s in the store while the output materializes',
        async (_write, write) => {
          const delivery = stubDelivery()
          const stage = renderDeliveryStage()
          const deliver = stage.result.current[action]

          let pending!: Promise<void>
          await act(async () => {
            pending = deliver()
            await Promise.resolve()
          })
          expect(stage.openBlob).toHaveBeenCalledTimes(1)
          write(stage)
          stage.releaseBlob()
          await act(async () => {
            await pending
          })

          expect(delivery.delivered()).toBe(0)
          expect(stage.toast.success).not.toHaveBeenCalled()
        },
      )
    })

    it.each(STALE_WRITES)(
      'downloads no manifest when %s in the store as it materializes',
      async (_write, write) => {
        const delivery = stubDelivery()
        const stage = renderDeliveryStage()
        const onDebug = (event: Event) => {
          const detail = (event as CustomEvent<{ type: string }>).detail
          if (detail.type === 'output-materialized') write(stage)
        }
        window.addEventListener('lumaforge-export-debug', onDebug)
        try {
          await act(async () => {
            await stage.result.current.downloadExportManifest()
          })
        } finally {
          window.removeEventListener('lumaforge-export-debug', onDebug)
        }

        expect(delivery.delivered()).toBe(0)
      },
    )

    it('refuses a delivery an older render captured once the store moved on', async () => {
      const delivery = stubDelivery()
      const stage = renderDeliveryStage()
      stage.releaseBlob()
      const { downloadExportResult, downloadExportManifest } =
        stage.result.current

      setLut({ ...getLut()!, profileResolution: { kind: 'unknown' } })
      await act(async () => {
        await downloadExportResult()
        await downloadExportManifest()
      })

      expect(stage.openBlob).not.toHaveBeenCalled()
      expect(delivery.delivered()).toBe(0)
      expect(stage.toast.error).toHaveBeenCalledTimes(2)
    })

    it('delivers a current result while the preview stays released and the view moves', async () => {
      const delivery = stubDelivery()
      const stage = renderDeliveryStage()
      stage.releaseBlob()
      // The preview stays released and the view moves; neither is part of
      // the request the result answers.
      withSession((session) => ({
        ...session,
        previewBundle: {
          ...session.previewBundle,
          quickDecodePreview: { status: 'idle' },
          displaySource: 'none',
        },
        viewState: { ...session.viewState, compareSplit: 0.2, zoom: 3 },
      }))

      await act(async () => {
        await stage.result.current.downloadExportResult()
        await stage.result.current.downloadExportManifest()
        await stage.result.current.shareExportResult()
        await stage.result.current.copyExportResult()
      })

      // Two downloads each create a URL and click; then a share and a copy.
      expect(delivery.delivered()).toBe(6)
      expect(stage.toast.error).not.toHaveBeenCalled()
      expect(stage.toast.success).toHaveBeenCalledWith(
        'Full-resolution image copied',
      )
    })
  })
})
