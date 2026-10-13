import type {
  ExportColorGraphStep,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { jotaiStore } from '~/lib/jotai'
import type { DecodedImage } from '~/lib/raw/decoder'
import type {
  RawRuntimeHost,
  RawRuntimeHostOptions,
  RawRuntimeHostSnapshot,
} from '~/lib/raw/raw-runtime-host'
import {
  resetCapabilityVectorForTest,
  setCapabilityVectorForTest,
} from '~/lib/runtime/capability-vector'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import enMessages from '~/locales/en.json'

import { createExportInterruptionMarkers } from '../services/export/export-interruption'
import type { ExportInterruptionMarkers } from '../services/export/export-recovery'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import { getDetachedPreviewView } from '../state/preview-view.atoms'
import { currentSessionAtom } from '../state/session.atoms'
import { getProcessingParams } from '../state/workflow.atoms'
import {
  createDeferredTestCubeFile,
  createTestCube,
  createTestCubeFile,
  createTestDecodedImage,
} from '../test-support/builders'
import { createFakeLocks } from '../test-support/web-locks'
import { resetToDefaults } from '../test-support/workflow-store'
import { acceptTransformGeometry } from './transform-session.fixture'
import { useRawToolAdjustments } from './useRawToolState'
import type { UseRawWorkflowReturn } from './useRawWorkflow'
import { useRawWorkflow } from './useRawWorkflow'

const rawRuntimeMock = vi.hoisted(() => ({
  openSession: vi.fn(),
  extractEmbeddedPreview: vi.fn(),
  decodeQuickRaw: vi.fn(),
  decodeBoundedHqRaw: vi.fn(),
  probeExportCapability: vi.fn(),
  prewarm: vi.fn(),
  getPrewarmState: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}))

const exportSystemMock = vi.hoisted(() => ({
  runFullResolutionExportJob: vi.fn(),
  runPreviewExportJob: vi.fn(),
}))

const interruptionMarkersMock = vi.hoisted(() => ({
  current: null as ExportInterruptionMarkers | null,
}))

const renderOriginalReferenceSnapshot = vi.hoisted(() => vi.fn())

// jsdom has no canvas, so the workflow gets a usable WebGPU explicitly.
vi.mock('~/lib/preview/gpu-backend', () => {
  const facts = {
    backend: 'webgpu' as const,
    maxTextureSize: 16384,
    reason: null,
  }
  const state = { status: 'ready' as const, facts }
  return {
    resolvePreviewBackend: vi.fn(async () => facts),
    getPreviewBackendSnapshot: () => facts,
    getPreviewBackendState: () => state,
    reportGpuPreviewFailure: vi.fn(),
  }
})

// Each workflow builds its own RAW host. The stand-in forwards to the runtime
// mock and keeps the real session lease rules; a test that sets
// `realRawRuntimeHostOptions` gets a real host instead.
const realRawRuntimeHostOptions = vi.hoisted(() => ({
  current: null as RawRuntimeHostOptions | null,
}))
vi.mock('~/lib/raw/raw-runtime-host', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/lib/raw/raw-runtime-host')>()
  const createRawRuntimeHostStandIn = (): RawRuntimeHost => {
    if (realRawRuntimeHostOptions.current) {
      return actual.createRawRuntimeHost(realRawRuntimeHostOptions.current)
    }
    const snapshot: RawRuntimeHostSnapshot = Object.freeze({
      initialization: 'idle',
      outcome: null,
      runtime: Object.freeze({
        generation: 0,
        workerAlive: false,
        initialized: false,
        lastTermination: null,
      }),
    })
    const sessions = actual.createRawRuntimeSessionLeases(
      (file, signal) => rawRuntimeMock.openSession(file, signal),
      { prewarm: () => host.prewarm() },
    )
    const host: RawRuntimeHost = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      prewarm: vi.fn(() => rawRuntimeMock.prewarm()),
      getPrewarmState: vi.fn(() => rawRuntimeMock.getPrewarmState()),
      terminateDecodeBridge: vi.fn(async () => {}),
      beginSession: vi.fn(sessions.begin),
      cancelSession: vi.fn(sessions.cancel),
      dispose: vi.fn(sessions.cancel),
    }
    return host
  }
  return { createRawRuntimeHost: createRawRuntimeHostStandIn }
})

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('../services/export/export-system', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/export/export-system')
  >()),
  ...exportSystemMock,
}))

// Each test gets its own page of markers over jsdom's localStorage and a
// shared fake Web Locks, so a closed page's attempt reads as crash-like.
vi.mock('../services/export/export-recovery', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/export/export-recovery')>()
  return {
    ...actual,
    getExportInterruptionMarkers: () =>
      interruptionMarkersMock.current ?? actual.getExportInterruptionMarkers(),
  }
})

vi.mock(
  '../services/compare/original-reference-renderer',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../services/compare/original-reference-renderer')
    >()),
    renderOriginalReferenceSnapshot,
  }),
)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

const defaultSourceDimensions = { width: 6048, height: 4024 }

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

function createDecodedImage(
  source: 'quick' | 'bounded-hq',
  overrides: Partial<DecodedImage> = {},
): DecodedImage {
  const [width, height] = source === 'quick' ? [800, 600] : [4000, 3000]
  return createTestDecodedImage({
    width,
    height,
    data: new Uint16Array([0, 1024, 65535]),
    source,
    metadata: { make: 'Sony', model: 'A7', width, height },
    ...overrides,
  })
}

function exposure(ev: number): RawRenderExposure {
  return { ev, multiplier: 2 ** ev, source: 'image-statistics' }
}

function jpeg(filename: string) {
  return { filename, blob: new Blob(['jpeg'], { type: 'image/jpeg' }) }
}

/** A .cube whose contract its own metadata comments declare. */
function createContractCubeFile(
  title: string,
  name: string,
  metadata: string[],
  size = 17,
) {
  const content = [
    ...metadata.map((entry) => `# ${entry}`),
    createTestCube(title, size),
  ].join('\n')
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

/** A supported capability carrying every fact the native runtime declares. */
function createSupportedCapability(): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    ...defaultSourceDimensions,
    rawWidth: 6048,
    rawHeight: 4024,
    visibleCrop: { x: 0, y: 0, ...defaultSourceDimensions },
    blackLevel: 0,
    whiteLevel: 65535,
    orientation: {
      code: 1,
      supported: true,
      outputWidth: 6048,
      outputHeight: 4024,
    },
    sensor: {
      layout: 'bayer',
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    },
    color: {
      whiteBalance: [2.0546875, 1, 1.5234375, 1],
      cameraToWorkingRgb: [
        1.6205, -0.4859, -0.1346, -0.1238, 1.3117, -0.1879, 0.0215, -0.2521,
        1.2306,
      ],
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    windows: { librawProcessed: true },
    reasons: [],
  }
}

/** A runtime session over the runtime mock, as the stand-in host opens it. */
function runtimeSession(overrides: Record<string, unknown> = {}) {
  return {
    sourceDimensions: defaultSourceDimensions,
    extractEmbeddedPreview: rawRuntimeMock.extractEmbeddedPreview,
    decodeQuickRaw: rawRuntimeMock.decodeQuickRaw,
    decodeBoundedHqRaw: rawRuntimeMock.decodeBoundedHqRaw,
    probeExportCapability: rawRuntimeMock.probeExportCapability,
    dispose: vi.fn(),
    ...overrides,
  }
}

function openSignal(call: number) {
  return rawRuntimeMock.openSession.mock.calls[call]?.[1] as
    | AbortSignal
    | undefined
}

const MARKER_PREFIX = 'lumaforge.export-interruption.v1.'
let fakeLocks = createFakeLocks()

function createMarkerPage(page: string) {
  let attempts = 0
  return createExportInterruptionMarkers({
    getStorage: () => localStorage,
    getLocks: () => fakeLocks.forPage(page),
    createId: (kind) =>
      kind === 'owner' ? page : `${page}-attempt-${++attempts}`,
  })
}

/** Another page began exporting `file` and closed before the export ended. */
async function seedCrashedExport(file: File) {
  const closedPage = createMarkerPage('closed-page')
  await closedPage.begin({
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  })
  fakeLocks.closePage('closed-page')
}

function storedMarkers() {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith(MARKER_PREFIX),
  )
}

// Workflow atom hooks are bound to the shared jotaiStore, so a fresh Provider
// would not isolate them: each test resets that store in beforeEach/afterEach.
function wrapper({ children }: { children: ReactNode }) {
  return <Provider store={jotaiStore}>{children}</Provider>
}

type WorkflowResult = { current: UseRawWorkflowReturn }

function renderWorkflow(options: { reactStrictMode?: boolean } = {}) {
  return renderHook(() => useRawWorkflow(), { wrapper, ...options })
}

type RenderedWorkflow = ReturnType<typeof renderWorkflow>

const session = () => jotaiStore.get(currentSessionAtom)

async function load(result: WorkflowResult, file: File | string) {
  await act(async () => {
    await result.current.loadFile(
      typeof file === 'string' ? new File(['raw'], file) : file,
    )
  })
}

/** Starts a load without waiting for it to finish. */
function startLoad(result: WorkflowResult, name: string) {
  let loading!: Promise<void>
  act(() => {
    loading = result.current.loadFile(new File(['raw'], name))
  })
  return loading
}

async function exportImage(result: WorkflowResult) {
  await act(async () => {
    await result.current.exportImage()
  })
}

/** Starts an export without waiting for it to finish. */
function startExport(result: WorkflowResult) {
  let exporting!: Promise<void>
  act(() => {
    exporting = result.current.exportImage()
  })
  return exporting
}

async function restore(result: WorkflowResult) {
  await act(async () => {
    await result.current.restorePreviewAfterExport()
  })
}

/**
 * The look strength as the tool surfaces read it: from the store the
 * workflow writes, not from the workflow's return.
 */
function renderLookStrength() {
  const { result } = renderHook(() => useRawToolAdjustments(), { wrapper })
  return () => result.current.activeIntensity
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushPostCommitTasks() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Loads to the bounded HQ frame with a preview pipeline that has drawn it. */
async function loadForHqExport() {
  exportSystemMock.runPreviewExportJob.mockImplementation(
    async ({
      renderToCanvas,
      filename,
    }: {
      renderToCanvas: () => Promise<HTMLCanvasElement>
      filename: string
    }) => {
      await renderToCanvas()
      return { filename, blob: new Blob(['hq-jpeg'], { type: 'image/jpeg' }) }
    },
  )
  const renderToHiddenCanvas = vi
    .fn()
    .mockResolvedValue(document.createElement('canvas'))
  const rendered = renderWorkflow()
  const { result } = rendered
  await load(result, 'frame.ARW')
  await waitFor(() => expect(result.current.displaySource).toBe('bounded-hq'))
  act(() => {
    result.current.pipelineRef.current = {
      renderToHiddenCanvas,
      // The preview has drawn the look the workflow holds.
      getParams: () => result.current.params,
      getLutData: () => null,
    } as never
    result.current.updateStats({
      processTime: 2,
      inputSize: { width: 6000, height: 4000 },
      previewSize: { width: 1200, height: 800 },
    })
  })
  return { ...rendered, renderToHiddenCanvas }
}

describe('useRawWorkflow', () => {
  beforeEach(() => {
    resetToDefaults()
    jotaiStore.set(currentSessionAtom, null)
    for (const mock of [
      ...Object.values(rawRuntimeMock),
      ...Object.values(toastMock),
      ...Object.values(exportSystemMock),
    ]) {
      mock.mockReset()
    }
    rawRuntimeMock.getPrewarmState.mockReturnValue('ready')
    rawRuntimeMock.prewarm.mockResolvedValue({ status: 'ready' })
    rawRuntimeMock.openSession.mockImplementation(async () => runtimeSession())
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createSupportedCapability(),
    )
    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      async ({ filename }: { filename: string }) => jpeg(filename),
    )
    renderOriginalReferenceSnapshot
      .mockReset()
      .mockRejectedValue(new Error('No original reference in hook tests'))
    localStorage.clear()
    resetCapabilityVectorForTest()
    fakeLocks = createFakeLocks()
    interruptionMarkersMock.current = createMarkerPage('this-page')
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:embedded-preview'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => {
      resetToDefaults()
      jotaiStore.set(currentSessionAtom, null)
    })
    vi.unstubAllGlobals()
    localStorage.clear()
    resetCapabilityVectorForTest()
    interruptionMarkersMock.current = null
    realRawRuntimeHostOptions.current = null
  })

  describe('load, export and restore', () => {
    it('ends the preview lease and terminates its decode worker before the export worker runs, and drops the late HQ frame', async () => {
      vi.stubGlobal('crossOriginIsolated', true)
      const boundedHq = deferred<DecodedImage>()
      const dispose = vi.fn()
      rawRuntimeMock.openSession.mockResolvedValueOnce(
        runtimeSession({
          decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
          dispose,
        }),
      )
      const { result } = renderWorkflow()
      const host = result.current.rawRuntimeHost
      let atWorkerStart: unknown
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async (input: {
          beforeStart?: () => void | Promise<void>
          signal: AbortSignal
          filename: string
        }) => {
          await input.beforeStart?.()
          atWorkerStart = {
            leaseAborted: openSignal(0)?.aborted,
            bridgeTerminated: vi.mocked(host.terminateDecodeBridge).mock.calls
              .length,
            exportAborted: input.signal.aborted,
          }
          return jpeg(input.filename)
        },
      )
      await load(result, 'frame.ARW')
      expect(openSignal(0)?.aborted).toBe(false)

      await exportImage(result)

      expect(atWorkerStart).toEqual({
        leaseAborted: true,
        bridgeTerminated: 1,
        exportAborted: false,
      })
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )

      await act(async () => {
        boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(result.current.decodedImageRef.current).toBeNull()
      expect(result.current.previewSuspended).toBe(true)
    })

    it('pins the quick frame exposure through bounded HQ, the export and the restored preview, keeping the result', async () => {
      vi.stubGlobal('crossOriginIsolated', true)
      const quickExposure = exposure(0.6)
      rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
        createDecodedImage('quick', { renderExposure: quickExposure }),
      )
      // A bounded HQ frame that estimated on its own moves nothing.
      rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
        createDecodedImage('bounded-hq', { renderExposure: exposure(0.7) }),
      )
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({
          onProgress,
          filename,
        }: {
          onProgress: (progress: object) => void
          filename: string
        }) => {
          onProgress({ completedStrips: 4, totalStrips: 4, progress: 100 })
          return jpeg(filename)
        },
      )
      const { result } = renderWorkflow()
      await load(result, 'frame.ARW')
      expect(result.current.displaySource).toBe('bounded-hq')

      await exportImage(result)

      const [{ graph }] =
        exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
      expect(
        graph.steps.find(
          (step: ExportColorGraphStep) => step.kind === 'raw-render-exposure',
        ),
      ).toEqual({
        kind: 'raw-render-exposure',
        ev: quickExposure.ev,
        multiplier: quickExposure.multiplier,
      })
      expect(session()?.exportState).toMatchObject({
        status: 'ready',
        lastProgress: { completedStrips: 4, totalStrips: 4 },
        result: {
          filename: 'frame_neutral_fullres.jpg',
          ...defaultSourceDimensions,
        },
      })
      expect(result.current.previewSuspended).toBe(true)
      expect(result.current.decodedImageRef.current).toBeNull()

      await restore(result)

      expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(2)
      expect(rawRuntimeMock.decodeQuickRaw).toHaveBeenLastCalledWith(
        expect.any(Function),
        expect.any(AbortSignal),
        { pinnedExposure: quickExposure },
      )
      expect(result.current.previewSuspended).toBe(false)
      expect(result.current.decodedImageRef.current?.source).toBe('quick')
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )
    })

    it('restores the preview on the same host after a failed export', async () => {
      vi.stubGlobal('crossOriginIsolated', true)
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async (input: { beforeStart?: () => void | Promise<void> }) => {
          await input.beforeStart?.()
          throw new Error('decoder exploded')
        },
      )
      const { result } = renderWorkflow()
      const host = result.current.rawRuntimeHost
      await load(result, 'frame.ARW')

      await exportImage(result)
      await flushPostCommitTasks()

      expect(toastMock.error).toHaveBeenCalledWith(
        'Export failed',
        expect.anything(),
      )
      expect(result.current.status).toBe('ready')
      expect(session()?.exportState.status).toBe('failed')
      expect(result.current.decodedImageRef.current).toBeNull()

      await restore(result)

      expect(host.beginSession).toHaveBeenCalledTimes(2)
      expect(openSignal(1)?.aborted).toBe(false)
      expect(result.current.rawRuntimeHost).toBe(host)
      expect(result.current.decodedImageRef.current?.source).toBe('quick')
    })

    it('probes full-resolution export only once the quick frame pins the exposure, refusing export until then', async () => {
      const quick = deferred<DecodedImage>()
      const boundedHq = deferred<DecodedImage>()
      const calls: string[] = []
      rawRuntimeMock.decodeQuickRaw.mockImplementation(() => {
        calls.push('quick')
        return quick.promise
      })
      rawRuntimeMock.decodeBoundedHqRaw.mockImplementation(() => {
        calls.push('bounded-hq')
        return boundedHq.promise
      })
      rawRuntimeMock.probeExportCapability.mockImplementation(async () => {
        calls.push('probe')
        return createSupportedCapability()
      })
      const { result } = renderWorkflow()
      let loading!: Promise<void>
      await act(async () => {
        loading = result.current.loadFile(new File(['raw'], 'frame.ARW'))
        await flushPromises()
      })
      await waitFor(() => expect(calls).toEqual(['quick']))
      expect(session()?.exportState.fullResCapability).toEqual({
        status: 'probing',
      })
      expect(result.current.exportRefusal).toEqual({
        code: 'quick-preview-pending',
      })

      await exportImage(result)
      expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()

      await act(async () => {
        quick.resolve(createDecodedImage('quick'))
        await flushPromises()
      })
      await waitFor(() =>
        expect(calls).toEqual(['quick', 'probe', 'bounded-hq']),
      )
      await waitFor(() =>
        expect(session()?.exportState.fullResCapability).toMatchObject({
          status: 'supported',
        }),
      )
      await act(async () => {
        boundedHq.resolve(createDecodedImage('bounded-hq'))
        await loading
      })
    })

    it('surfaces an interruption hint only for the loaded source and spends it on the next explicit export', async () => {
      vi.stubGlobal('crossOriginIsolated', true)
      const source = () => new File(['raw'], 'frame.ARW', { lastModified: 123 })
      await seedCrashedExport(source())
      const { result } = renderWorkflow()
      await flushPostCommitTasks()
      // No source, no hint: a stored marker never surfaces on its own.
      expect(result.current.exportInterrupted).toBe(false)

      await load(result, source())
      await waitFor(() => expect(result.current.exportInterrupted).toBe(true))
      act(() => result.current.setToneParams({ userExposureEv: 0.5 }))
      expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()

      await exportImage(result)

      // Only the source-scoped hint travels: the plan sizes from the current
      // source and the graph renders the current look.
      const [retry] = exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
      expect(retry).toMatchObject({
        quality: 0.92,
        executionPlan: {
          productCopy: 'interrupted-retry',
          runtimeMemoryProfile: 'low-memory',
          request: { source: defaultSourceDimensions },
        },
      })
      expect(
        retry.graph.steps.find(
          (step: ExportColorGraphStep) => step.kind === 'user-exposure',
        ),
      ).toMatchObject({ ev: 0.5 })
      await waitFor(() => expect(result.current.exportInterrupted).toBe(false))
      expect(storedMarkers()).toEqual([])

      await restore(result)
      await exportImage(result)
      expect(
        exportSystemMock.runFullResolutionExportJob.mock.calls[1]![0]
          .executionPlan,
      ).toMatchObject({ productCopy: 'safe-export' })
    })
  })

  describe('on a real RAW host', () => {
    const RUNTIME_INFO: LumaRawRuntimeInfo = {
      runtime: 'luma',
      version: '0.1.0',
      crossOriginIsolated: true,
      memoryProfile: 'desktop',
    }

    it('keeps its host usable across a StrictMode effect replay', async () => {
      const runtime = {
        init: vi.fn<LumaRawRuntime['init']>().mockResolvedValue(RUNTIME_INFO),
        openSession: vi.fn<LumaRawRuntime['openSession']>(),
        dispose: vi.fn<LumaRawRuntime['dispose']>(),
      }
      realRawRuntimeHostOptions.current = { runtimeFactory: () => runtime }
      const { result } = renderWorkflow({ reactStrictMode: true })
      const host = result.current.rawRuntimeHost

      await act(async () => {
        await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
      })
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        runtime: { workerAlive: true, initialized: true },
      })
      expect(runtime.dispose).not.toHaveBeenCalled()
    })

    describe('superseded native work', () => {
      type Operation =
        | 'init'
        | 'openSession'
        | 'extractEmbeddedPreview'
        | 'probeExportCapability'
        | 'decodeQuick'
        | 'decodeBoundedHq'
      type Gate = ReturnType<typeof deferred<void>> & { reached: boolean }

      function makeFrame(
        source: LumaRawFrame['source'],
        make: string,
      ): LumaRawFrame {
        return {
          jobId: `${source}-${make}`,
          sessionId: make,
          source,
          width: 1,
          height: 1,
          data: new Uint16Array([0, 32768, 65535]),
          layout: 'rgb',
          bitDepth: 16,
          colorSpace: 'linear-prophoto-rgb',
          orientation: 1,
          metadata: {
            width: 1,
            height: 1,
            make,
            model: 'A7',
            supportLevel: 'experimental',
          },
          timings: { total: 1 },
        }
      }

      /**
       * A runtime that behaves like the real decode worker: one request at
       * a time, and native work in flight cannot be interrupted. `dispose`
       * settles nothing, so a held request never answers and every later
       * request on the same runtime waits behind it. Frames carry the
       * source's file name as their camera make.
       */
      function makeWorkerLikeRuntime(held: Operation | null) {
        const gate: Gate = Object.assign(deferred<void>(), { reached: false })
        let tail: Promise<unknown> = Promise.resolve()
        const run = <T,>(operation: Operation, value: () => T) => {
          const job = tail.then(async () => {
            if (operation === held) {
              gate.reached = true
              await gate.promise
            }
            return value()
          })
          tail = job.catch(() => undefined)
          return job
        }
        const runtime = {
          init: vi.fn<LumaRawRuntime['init']>(() =>
            run('init', () => RUNTIME_INFO),
          ),
          openSession: vi.fn<LumaRawRuntime['openSession']>((file) =>
            run(
              'openSession',
              (): LumaRawDecodeSession => ({
                sessionId: file.name,
                probe: {
                  jobId: 'probe',
                  ...defaultSourceDimensions,
                  supportLevel: 'experimental',
                  timings: { total: 1 },
                },
                timings: { total: 1 },
                extractEmbeddedPreview: vi.fn(() =>
                  run('extractEmbeddedPreview', () => null),
                ),
                probeExportCapability: vi.fn(() =>
                  run('probeExportCapability', createSupportedCapability),
                ),
                readProcessedWindow: vi.fn(),
                decodeQuick: vi.fn(() =>
                  run('decodeQuick', () => makeFrame('quick', file.name)),
                ),
                decodeBoundedHq: vi.fn(() =>
                  run('decodeBoundedHq', () =>
                    makeFrame('bounded-hq', file.name),
                  ),
                ),
                applyCalibration: vi.fn(),
                dispose: vi.fn(),
              }),
            ),
          ),
          dispose: vi.fn<LumaRawRuntime['dispose']>(),
        }
        return { runtime, gate }
      }

      /** One worker-like runtime per generation; the first holds `held`. */
      function renderOnWorkerLikeHost(held: Operation) {
        const workers: Array<ReturnType<typeof makeWorkerLikeRuntime>> = []
        realRawRuntimeHostOptions.current = {
          runtimeFactory: () => {
            const worker = makeWorkerLikeRuntime(
              workers.length === 0 ? held : null,
            )
            workers.push(worker)
            return worker.runtime
          },
          jpegRuntimeAvailabilityProbe: () => true,
        }
        return { ...renderWorkflow(), workers }
      }

      it.each([
        { held: 'init', ending: 'replaced' },
        { held: 'init', ending: 'reset' },
        { held: 'decodeQuick', ending: 'reset' },
        { held: 'decodeBoundedHq', ending: 'replaced' },
      ] as const)(
        "shows the next file from a fresh runtime when the $ending load's $held never answers, and its late answer changes nothing",
        async ({ held, ending }) => {
          const { result, workers } = renderOnWorkerLikeHost(held)
          const firstLoad = startLoad(result, 'first.ARW')
          await waitFor(() => expect(workers[0]?.gate.reached).toBe(true))
          if (ending === 'reset') act(() => result.current.reset())

          const loading = startLoad(result, 'second.ARW')
          await act(async () => {
            await loading
          })
          await waitFor(() =>
            expect(result.current.displaySource).toBe('bounded-hq'),
          )
          const replacement = session()
          expect(replacement?.sourceFile.name).toBe('second.ARW')

          await act(async () => {
            workers[0]!.gate.resolve()
            await firstLoad
          })
          await flushPostCommitTasks()

          expect(session()).toBe(replacement)
          expect(result.current.decodedImageRef.current?.metadata.make).toBe(
            'second.ARW',
          )
          expect(result.current).toMatchObject({ status: 'ready', error: null })
          expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
          expect(workers.at(-1)!.runtime.dispose).not.toHaveBeenCalled()
          expect(toastMock.error).not.toHaveBeenCalled()
        },
      )
    })
  })

  describe('commands against the store when they run', () => {
    it('lands a LUT picked in a replacing loadFile tick on the replacement', async () => {
      const { result } = renderWorkflow()
      await load(result, 'first.ARW')
      const first = session()
      const pick = createDeferredTestCubeFile('Second Look', 'second-look.cube')

      // Both commands come from the first source's render and run before
      // React renders the replacement.
      const { loadFile, loadLUT } = result.current
      let lutLoad!: Promise<LutLoadOutcome>
      await act(async () => {
        const loading = loadFile(new File(['raw'], 'second.ARW'))
        lutLoad = loadLUT(pick.file)
        await loading
      })
      await act(async () => {
        pick.finishRead()
        await expect(lutLoad).resolves.toBe('loaded')
      })

      expect(result.current.currentLutName).toBe('Second Look')
      expect(session()).toMatchObject({
        sourceFile: { name: 'second.ARW' },
        activeStyle: { kind: 'custom', name: 'Second Look' },
      })
      expect(first?.activeStyle ?? null).toBeNull()
    })

    it('routes a split and a look strength written in a replacing loadFile tick into the replacement only', async () => {
      const { result } = renderWorkflow()
      const lookStrength = renderLookStrength()
      await act(async () => {
        await result.current.loadLUT(
          createTestCubeFile('Client Look', 'look.cube'),
        )
      })
      await load(result, 'first.ARW')
      act(() => {
        result.current.setCompareSplit(0.8)
        result.current.setIntensity(0.62)
      })
      const first = session()
      const detachedIntent = getProcessingParams()
      const detachedView = getDetachedPreviewView()

      const { loadFile, setCompareSplit, setIntensity } = result.current
      await act(async () => {
        const loading = loadFile(new File(['raw'], 'second.ARW'))
        setCompareSplit(0.3)
        setIntensity(0.4)

        const replacement = session()
        expect(replacement?.id).not.toBe(first?.id)
        expect(replacement).toMatchObject({
          sourceFile: { name: 'second.ARW' },
          viewState: { mode: 'compare', compareSplit: 0.3 },
          activeStyle: { name: 'Client Look', currentIntensity: 0.4 },
        })
        await loading
      })

      expect(result.current.status).toBe('ready')
      expect(result.current.compareSplit).toBe(0.3)
      expect(lookStrength()).toBe(0.4)
      expect(result.current.params.intensity).toBe(0.4)
      // The replaced session and the detached state took none of the writes.
      expect(first).toMatchObject({
        viewState: { compareSplit: 0.8 },
        activeStyle: { currentIntensity: 0.62 },
      })
      expect(getProcessingParams()).toEqual(detachedIntent)
      expect(getDetachedPreviewView()).toBe(detachedView)
    })

    it('seeds the next source with a LUT picked in the reset tick', async () => {
      const { result } = renderWorkflow()
      await load(result, 'first.ARW')
      const pick = createDeferredTestCubeFile('Reset Look', 'reset-look.cube')

      const { reset, loadLUT } = result.current
      let lutLoad!: Promise<LutLoadOutcome>
      act(() => {
        reset()
        lutLoad = loadLUT(pick.file)
      })
      await act(async () => {
        pick.finishRead()
        await expect(lutLoad).resolves.toBe('loaded')
      })

      expect(session()).toBeNull()
      expect(result.current.currentLutName).toBe('Reset Look')
      expect(getProcessingParams()).toMatchObject({ styleKind: 'custom' })

      await load(result, 'second.ARW')
      expect(session()).toMatchObject({
        sourceFile: { name: 'second.ARW' },
        activeStyle: { kind: 'custom', name: 'Reset Look' },
      })
    })

    it('routes look, tone and view writes made in the reset tick to the detached state the next source keeps', async () => {
      const { result } = renderWorkflow()
      const lookStrength = renderLookStrength()
      await act(async () => {
        await result.current.loadLUT(
          createTestCubeFile('Client Look', 'look.cube'),
        )
      })
      await load(result, 'first.ARW')

      // Every command comes from the session render and lands after reset
      // has already dropped the session.
      const {
        reset,
        setIntensity,
        setToneParams,
        setViewMode,
        setCompareSplit,
      } = result.current
      act(() => {
        reset()
        setIntensity(0.33)
        setToneParams({ userContrast: 12 })
        setViewMode('original')
        setCompareSplit(0.37)

        expect(session()).toBeNull()
        expect(getProcessingParams()).toMatchObject({
          intensity: 0.33,
          userContrast: 12,
        })
      })
      expect(lookStrength()).toBe(0.33)
      expect(result.current).toMatchObject({
        viewMode: 'original',
        compareSplit: 0.37,
      })

      await load(result, 'second.ARW')

      expect(result.current.currentLutName).toBe('Client Look')
      expect(result.current.params.userContrast).toBe(12)
      expect(session()).toMatchObject({
        activeStyle: { name: 'Client Look', currentIntensity: 0.33 },
        // The next RAW keeps the detached split but always opens in compare.
        viewState: { mode: 'compare', compareSplit: 0.37 },
      })
    })

    it('exports the LUT a load landed in the same tick as an older export action, through graph, identity and manifest', async () => {
      const { result } = renderWorkflow()
      await load(result, 'frame.ARW')
      await act(async () => {
        await result.current.loadLUT(
          createContractCubeFile('Look A', 'look-a.cube', [
            'LUMAFORGE_INPUT_PROFILE=display-srgb',
            'LUMAFORGE_ROLE=display-look',
          ]),
        )
      })
      await waitFor(() => expect(result.current.lutData?.title).toBe('Look A'))

      const { loadLUT, exportImage: exportFromOlderRender } = result.current
      await act(async () => {
        await expect(
          loadLUT(
            createContractCubeFile(
              'Look B',
              'look-b.cube',
              [
                'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
                'LUMAFORGE_ROLE=combined-look-output',
                'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
                'LUMAFORGE_OUTPUT_TRANSFER=bt709',
                'LUMAFORGE_OUTPUT_RANGE=full',
              ],
              33,
            ),
          ),
        ).resolves.toBe('loaded')
        await exportFromOlderRender()
      })

      const lutB = result.current.lutData!
      expect(lutB.title).toBe('Look B')
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      )
      const [{ graph }] =
        exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
      const steps: ExportColorGraphStep[] = graph.steps
      expect(
        steps.find((step) => step.kind === 'gamut-to-lut-input'),
      ).toMatchObject({ gamut: 'v-gamut' })
      const lut3d = steps.find((step) => step.kind === 'lut3d')
      expect(lut3d).toMatchObject({ size: 33 })
      expect(lut3d?.kind === 'lut3d' ? lut3d.data : null).toBe(lutB.data)

      await waitFor(() =>
        expect(session()?.exportState.result?.manifestState?.status).toBe(
          'ready',
        ),
      )
      const sealed = session()!.exportState.result!
      expect(sealed.identity?.lut).toMatchObject({
        size: 33,
        contract: { status: 'confirmed', inputGamut: 'v-gamut' },
      })
      const lutBSha256 = session()?.activeStyle?.lutAsset?.sha256
      expect(lutBSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(sealed.manifest?.lut).toMatchObject({
        kind: 'local-file',
        filename: 'look-b.cube',
        sha256: lutBSha256,
        input_contract: { gamut: 'v-gamut', transfer: 'v-log' },
      })
    })
  })

  describe('the HQ preview export and the session Transform', () => {
    it.each([
      { clipboard: 'image/jpeg', copy: { mode: 'hq-preview' } },
      {
        clipboard: 'image/png',
        copy: {
          mode: 'unavailable',
          reasonCode: 'hq-preview-copy-unsupported',
        },
      },
    ])(
      'exports an HQ preview JPEG from the bounded preview without the full-resolution worker, copyable with a $clipboard clipboard as $copy.mode',
      async ({ clipboard, copy }) => {
        vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } })
        vi.stubGlobal(
          'ClipboardItem',
          class {
            static supports(type: string) {
              return type === clipboard
            }
          },
        )
        const { result, renderToHiddenCanvas } = await loadForHqExport()
        expect(result.current.canPreviewExport).toBe(true)

        await act(async () => {
          await result.current.exportPreviewImage()
        })

        expect(
          exportSystemMock.runFullResolutionExportJob,
        ).not.toHaveBeenCalled()
        expect(exportSystemMock.runPreviewExportJob).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: 'frame_neutral_hq-preview.jpg',
            quality: 0.92,
          }),
        )
        const [{ width, height }] = renderToHiddenCanvas.mock.calls[0]!
        expect(result.current.exportResult).toMatchObject({
          kind: 'hq-preview',
          filename: 'frame_neutral_hq-preview.jpg',
          width,
          height,
          copyCapability: copy,
        })
      },
    )

    it('refuses full and HQ export from actions captured before a Transform edit that is still pending', async () => {
      const { result, renderToHiddenCanvas } = await loadForHqExport()
      expect(result.current).toMatchObject({
        canExport: true,
        canPreviewExport: true,
      })
      const {
        exportImage: exportFull,
        exportPreviewImage,
        transform,
      } = result.current

      act(() =>
        transform!.dispatch({
          type: 'edit',
          sourceId: transform!.state!.sourceId,
          intent: { manual: { ...NEUTRAL_TRANSFORM, rotate: 3 } },
        }),
      )
      await act(async () => {
        await exportFull()
        await exportPreviewImage()
      })
      await flushPostCommitTasks()

      expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(exportSystemMock.runPreviewExportJob).not.toHaveBeenCalled()
      expect(renderToHiddenCanvas).not.toHaveBeenCalled()
      expect(session()?.exportState.status).toBe('idle')
      expect(toastMock.error).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        { description: enMessages['raw.export.reason.transformPending'] },
      )
      expect(toastMock.error).toHaveBeenCalledWith(
        'HQ preview export is not ready',
        { description: enMessages['raw.transform.hqExportReason'] },
      )
    })
  })

  it.each<{
    name: string
    acceptGeometry?: boolean
    supersede: (rendered: RenderedWorkflow) => unknown
  }>([
    {
      name: 'a replacement file loads',
      supersede: ({ result }) =>
        result.current.loadFile(new File(['current'], 'current.ARW')),
    },
    {
      name: 'a render graph input changes',
      supersede: ({ result }) => result.current.setIntensity(1),
    },
    {
      name: 'its accepted Transform is edited',
      acceptGeometry: true,
      supersede: ({ result }) => {
        const { dispatch, state } = result.current.transform!
        dispatch({
          type: 'edit',
          sourceId: state!.sourceId,
          intent: { manual: { ...state!.intent.manual, rotate: 40 } },
        })
      },
    },
    { name: 'its mount departs', supersede: ({ unmount }) => unmount() },
  ])(
    'ends an in-flight export when $name and lets its late JPEG land on nothing',
    async ({ acceptGeometry, supersede }) => {
      const pending = deferred<ReturnType<typeof jpeg>>()
      exportSystemMock.runFullResolutionExportJob.mockReturnValue(
        pending.promise,
      )
      const rendered = renderWorkflow()
      await load(rendered.result, 'stale.ARW')
      if (acceptGeometry) {
        act(() =>
          acceptTransformGeometry(
            rendered.result.current.transform,
            SAMPLE_GEOMETRY,
          ),
        )
      }
      const exporting = startExport(rendered.result)
      await waitFor(() =>
        expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalled(),
      )
      const [job] = exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
      if (acceptGeometry) expect(job.geometry).toEqual(SAMPLE_GEOMETRY)
      expect(session()?.exportState.status).toBe('exporting')

      await act(async () => {
        await supersede(rendered)
      })
      await flushPostCommitTasks()
      expect(job.signal.aborted).toBe(true)
      const superseding = session()
      expect(superseding?.exportState.status ?? 'idle').toBe('idle')

      await act(async () => {
        pending.resolve(jpeg('stale_neutral_fullres.jpg'))
        await exporting
      })
      await flushPostCommitTasks()

      expect(session()).toBe(superseding)
      expect(superseding?.exportState.result).toBeUndefined()
    },
  )

  it('prepares no original reference snapshot in compare when CSS clipping is unavailable', async () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) })
    // Without dual GPU compare, compare would otherwise prepare a snapshot.
    setCapabilityVectorForTest({
      coi: false,
      pthread: false,
      deviceMemoryGB: 4,
      hwConcurrency: 4,
      webKitClass: 'webkit-mobile',
      deviceFormFactor: 'mobile',
      maybeOpfsSupported: false,
    })
    const { result } = renderWorkflow()
    await load(result, 'frame.ARW')
    act(() => result.current.setViewMode('compare'))
    await flushPromises()

    expect(result.current.dualGpuAllowed).toBe(false)
    expect(renderOriginalReferenceSnapshot).not.toHaveBeenCalled()
  })

  describe('integrated ownership boundaries', () => {
    type Counted = {
      runtimeSessions: Array<{ dispose: ReturnType<typeof vi.fn> }>
      outputs: Array<ReturnType<typeof vi.fn>>
    }

    /**
     * Every load opens its own RAW session with an embedded preview, and
     * every export delivers its own file-backed output, so each resource's
     * release can be counted on its own.
     */
    function countResources(): Counted {
      const counted: Counted = { runtimeSessions: [], outputs: [] }
      let urls = 0
      vi.mocked(URL.createObjectURL).mockImplementation(
        () => `blob:embedded-${++urls}`,
      )
      rawRuntimeMock.openSession.mockImplementation(async () => {
        const opened = runtimeSession({
          extractEmbeddedPreview: vi.fn().mockResolvedValue({
            width: 1600,
            height: 1067,
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/jpeg',
            timings: { total: 8 },
          }),
          decodeQuickRaw: vi
            .fn()
            .mockResolvedValue(createDecodedImage('quick')),
          decodeBoundedHqRaw: vi
            .fn()
            .mockResolvedValue(createDecodedImage('bounded-hq')),
        })
        counted.runtimeSessions.push(opened)
        return opened
      })
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({ filename }: { filename: string }) => {
          const cleanup = vi.fn(async () => undefined)
          counted.outputs.push(cleanup)
          return {
            filename,
            output: {
              kind: 'file-backed',
              exportId: `export-${counted.outputs.length}`,
              filename,
              byteLength: 4,
              mimeType: 'image/jpeg',
              sha256: 'c'.repeat(64),
              openBlob: vi.fn(
                async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
              ),
              cleanup,
            } satisfies FileBackedOutputResult,
          }
        },
      )
      return counted
    }

    function releases(counted: Counted) {
      return {
        runtimeSessions: counted.runtimeSessions.map(
          (opened) => opened.dispose.mock.calls.length,
        ),
        outputs: counted.outputs.map((cleanup) => cleanup.mock.calls.length),
        revokedUrls: vi
          .mocked(URL.revokeObjectURL)
          .mock.calls.map(([url]) => url),
      }
    }

    function renderCounted(options: { reactStrictMode?: boolean } = {}) {
      vi.stubGlobal('crossOriginIsolated', true)
      const counted = countResources()
      const rendered = renderWorkflow(options)
      return {
        ...rendered,
        counted,
        host: rendered.result.current.rawRuntimeHost,
      }
    }

    it('releases every session, output and preview URL once across load, export, replacement and a reset held from the first source', async () => {
      const { result, counted, host } = renderCounted()
      await load(result, 'first.ARW')
      const { reset } = result.current
      await exportImage(result)
      await flushPostCommitTasks()
      // Export evacuates the embedded preview; the result keeps its output.
      expect(releases(counted)).toEqual({
        runtimeSessions: [1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })

      await load(result, 'second.ARW')
      await flushPostCommitTasks()
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [1],
        revokedUrls: ['blob:embedded-1'],
      })

      await exportImage(result)
      act(() => reset())
      act(() => reset())
      await flushPostCommitTasks()

      expect(session()).toBeNull()
      expect(result.current).toMatchObject({ hasImage: false, status: 'idle' })
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [1, 1],
        revokedUrls: ['blob:embedded-1', 'blob:embedded-2'],
      })
      expect(host.dispose).not.toHaveBeenCalled()
    })

    it.each(['reset', 'replacement'] as const)(
      'releases the outgoing source once on %s, writes nothing from its late HQ frame, and releases nothing again on a repeat',
      async (owner) => {
        const { result, counted } = renderCounted()
        const outgoingHq = deferred<DecodedImage>()
        const openCounted = rawRuntimeMock.openSession.getMockImplementation()!
        rawRuntimeMock.openSession.mockImplementationOnce(
          async (...args: unknown[]) => {
            const opened = await openCounted(...args)
            opened.decodeBoundedHqRaw = vi
              .fn()
              .mockReturnValue(outgoingHq.promise)
            return opened
          },
        )
        await load(result, 'first.ARW')
        expect(result.current.displaySource).toBe('quick')
        expect(releases(counted)).toEqual({
          runtimeSessions: [0],
          outputs: [],
          revokedUrls: [],
        })

        await act(async () => {
          if (owner === 'reset') result.current.reset()
          else await result.current.loadFile(new File(['raw'], 'second.ARW'))
        })
        const successor = session()
        const afterTeardown = releases(counted)
        expect(afterTeardown.runtimeSessions[0]).toBe(1)
        expect(afterTeardown.revokedUrls).toEqual(['blob:embedded-1'])

        await act(async () => {
          outgoingHq.resolve(createDecodedImage('bounded-hq'))
          await flushPromises()
        })
        expect(session()).toBe(successor)
        expect(releases(counted)).toEqual(afterTeardown)

        act(() => result.current.reset())
        act(() => result.current.reset())
        await flushPostCommitTasks()
        expect(releases(counted)).toEqual(
          owner === 'reset'
            ? afterTeardown
            : {
                runtimeSessions: [1, 1],
                outputs: [],
                revokedUrls: ['blob:embedded-1', 'blob:embedded-2'],
              },
        )
        expect(result.current.status).toBe('idle')
        expect(session()).toBeNull()
      },
    )

    it.each(['reset', 'replacement'] as const)(
      'releases a sealing export once on %s and lets its late manifest land on nothing',
      async (owner) => {
        const gate = deferred<void>()
        const { result, counted } = renderCounted()
        // Sealing hashes the source RAW, whose bytes wait for the gate.
        const source = new File(['raw'], 'frame.ARW')
        Object.defineProperty(source, 'stream', {
          value: () =>
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await gate.promise
                controller.enqueue(new TextEncoder().encode('raw'))
                controller.close()
              },
            }),
        })
        await load(result, source)
        await exportImage(result)
        const delivered = result.current.exportResult
        expect(delivered?.manifestState?.status).toBe('sealing')

        await act(async () => {
          if (owner === 'reset') result.current.reset()
          else await result.current.loadFile(new File(['raw'], 'second.ARW'))
        })
        const successor = session()
        await waitFor(() => expect(counted.outputs[0]).toHaveBeenCalled())

        await act(async () => {
          gate.resolve()
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        await flushPostCommitTasks()

        expect(releases(counted).outputs).toEqual([1])
        // The seal finds no current attempt and writes nothing over whatever
        // owns the slot now, nor rewrites the delivered result in place.
        expect(session()).toBe(successor)
        expect(result.current.exportResult).toBeNull()
        expect(delivered?.manifestState?.status).toBe('sealing')
        if (owner === 'reset') expect(successor).toBeNull()
        else expect(successor?.sourceFile.name).toBe('second.ARW')
      },
    )

    it('keeps a delivered export through refused and restored view commands, and releases its output once on a graph change', async () => {
      const { result, counted } = renderCounted()
      await load(result, 'frame.ARW')
      await exportImage(result)
      await waitFor(() =>
        expect(result.current.exportResult?.manifestState?.status).toBe(
          'ready',
        ),
      )
      expect(result.current.previewSuspended).toBe(true)
      const released = session()
      const delivered = released?.exportState.result
      const detachedView = getDetachedPreviewView()

      // Commands held from the released render run before any rerender; the
      // original and the split stay refused until the preview is restored.
      const { setCompareSplit, setViewMode, resetCompareView } = result.current
      act(() => {
        setCompareSplit(0.2)
        setViewMode('original')
        resetCompareView()
      })

      expect(session()).toBe(released)
      expect(getDetachedPreviewView()).toBe(detachedView)
      expect(result.current).toMatchObject({
        hasImage: true,
        status: 'ready',
        canExport: true,
        previewSuspended: true,
      })
      expect(result.current.exportResult).toBe(delivered)
      expect(releases(counted)).toEqual({
        runtimeSessions: [1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })

      await restore(result)
      act(() => {
        result.current.setCompareSplit(0.2)
        result.current.setPreviewViewport({
          zoom: 2,
          panX: 40,
          panY: -20,
          fitMode: 'custom',
        })
      })

      expect(session()?.viewState).toMatchObject({ compareSplit: 0.2, zoom: 2 })
      expect(result.current.exportResult).toBe(delivered)
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })

      act(() => result.current.setIntensity(1))

      expect(session()?.exportState.status).toBe('idle')
      expect(session()?.exportState.result).toBeUndefined()
      await waitFor(() => expect(releases(counted).outputs).toEqual([1]))
    })

    it('loads, routes compare writes and exports under StrictMode replay without cancelling or releasing what the load opens', async () => {
      const { result, counted, host, unmount } = renderCounted({
        reactStrictMode: true,
      })
      // The replayed cleanup already ended the host once; it stays usable.
      const replayDisposals = vi.mocked(host.dispose).mock.calls.length
      act(() => result.current.setCompareSplit(0.7))
      expect(session()).toBeNull()
      expect(getDetachedPreviewView().compareSplit).toBe(0.7)

      await load(result, 'frame.ARW')
      expect(result.current).toMatchObject({
        status: 'ready',
        displaySource: 'bounded-hq',
        canExport: true,
      })
      expect(session()?.viewState).toMatchObject({
        mode: 'compare',
        compareSplit: 0.7,
      })
      await exportImage(result)
      await flushPostCommitTasks()

      expect(openSignal(0)?.aborted).toBe(false)
      expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1)
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )
      expect(releases(counted)).toEqual({
        runtimeSessions: [1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })
      expect(host.dispose).toHaveBeenCalledTimes(replayDisposals)

      act(() => unmount())
      await flushPostCommitTasks()
      expect(session()).toBeNull()
    })

    it.each([
      { name: 'a loaded source', exported: false },
      { name: 'a delivered export', exported: true },
    ])(
      'releases $name once on departure, and a later mount releases nothing again',
      async ({ exported }) => {
        const { result, counted, host, unmount } = renderCounted()
        await load(result, 'frame.ARW')
        if (exported) await exportImage(result)
        const departed = {
          runtimeSessions: [1],
          outputs: exported ? [1] : [],
          revokedUrls: ['blob:embedded-1'],
        }

        act(() => unmount())
        await flushPostCommitTasks()

        await waitFor(() => expect(releases(counted)).toEqual(departed))
        expect(host.dispose).toHaveBeenCalledTimes(1)
        expect(session()).toBeNull()

        const remounted = renderWorkflow()
        expect(remounted.result.current).toMatchObject({
          hasImage: false,
          exportResult: null,
        })
        act(() => remounted.unmount())
        await flushPostCommitTasks()

        expect(releases(counted)).toEqual(departed)
        expect(host.dispose).toHaveBeenCalledTimes(1)
      },
    )
  })
})
