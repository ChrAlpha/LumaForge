import type {
  ExportColorGraphStep,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  getLUTColorProfile,
  LUT_CONSTANTS_VERSION,
  makeNeutralBand,
  SKIN_HUE_CENTER_DEG,
  SKIN_HUE_SIGMA_DEG,
  SKIN_PROTECT_STRENGTH,
  USER_SATURATION_MAX_FACTOR,
  USER_VIBRANCE_MAX_FACTOR,
  VIBRANCE_CHROMA_REF,
} from '@lumaforge/luma-color-runtime'
import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { Provider, useAtomValue } from 'jotai'
import type { ReactNode } from 'react'
import { StrictMode } from 'react'
import type { NavigateFunction } from 'react-router'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
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
import { DEFAULT_PREVIEW_VIEWPORT } from '../services/preview/preview-viewport'
import { deriveTransformStatus } from '../services/transform/transform-state'
import { previewHistogramStateAtom } from '../state/histogram.atoms'
import { getDetachedPreviewView } from '../state/preview-view.atoms'
import { currentSessionAtom } from '../state/session.atoms'
import { getProcessingParams, resetToDefaults } from '../state/workflow.atoms'
import { acceptTransformGeometry } from './transform-session.fixture'
import { usePublishedPreviewHistogram } from './usePublishedPreviewHistogram'
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

const originalReferenceSnapshotMock = vi.hoisted(() => ({
  renderOriginalReferenceSnapshot: vi.fn(),
  releaseOriginalReferenceSnapshot: vi.fn(),
}))

// Workflow tests provide a usable GPU explicitly; jsdom's missing canvas API
// must not turn the decoded-size and dual-preview assertions into CPU tests.
// A test that drops to the CPU preview mid-session swaps `state` and puts
// the GPU back afterwards.
const previewBackendMock = vi.hoisted(() => {
  const gpu = {
    status: 'ready' as const,
    facts: {
      backend: 'webgpu' as 'webgpu' | 'cpu',
      maxTextureSize: 16384,
      reason: null as 'gpu-preview-failed' | null,
    },
  }
  return { gpu, state: gpu }
})
vi.mock('~/lib/preview/gpu-backend', () => {
  const { facts } = previewBackendMock.gpu
  return {
    resolvePreviewBackend: vi.fn(async () => facts),
    getPreviewBackendSnapshot: () => facts,
    getPreviewBackendState: () => previewBackendMock.state,
    reportGpuPreviewFailure: vi.fn(),
  }
})

// Each workflow builds its own RAW host. The stand-in records every host it
// builds and forwards its calls to the runtime mock the tests configure; a
// test that sets `realRawRuntimeHostOptions` gets a real host instead.
const rawRuntimeHosts = vi.hoisted(() => [] as RawRuntimeHost[])
const realRawRuntimeHostOptions = vi.hoisted(() => ({
  current: null as RawRuntimeHostOptions | null,
}))
vi.mock('~/lib/raw/raw-runtime-host', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/lib/raw/raw-runtime-host')>()
  const createRawRuntimeHostStandIn = (): RawRuntimeHost => {
    if (realRawRuntimeHostOptions.current) {
      const realHost = actual.createRawRuntimeHost(
        realRawRuntimeHostOptions.current,
      )
      rawRuntimeHosts.push(realHost)
      return realHost
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
    // Session leases keep the host's ownership rules, warming and opening
    // through the runtime mock instead of a native bridge.
    const sessions = actual.createRawRuntimeSessionLeases(
      (file, signal) => rawRuntimeMock.openSession(file, signal),
      { prewarm: () => host.prewarm() },
    )
    const host: RawRuntimeHost = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      prewarm: vi.fn(() => rawRuntimeMock.prewarm()),
      getPrewarmState: vi.fn(() => rawRuntimeMock.getPrewarmState()),
      openSession: vi.fn((file: File, signal?: AbortSignal) =>
        rawRuntimeMock.openSession(file, signal),
      ),
      extractEmbeddedPreview: vi.fn((file: File) =>
        rawRuntimeMock.extractEmbeddedPreview(file),
      ),
      decodeQuickRaw: vi.fn((file: File) =>
        rawRuntimeMock.decodeQuickRaw(file),
      ),
      decodeBoundedHqRaw: vi.fn(
        (file: File, options: { maxOutputPixels: number }) =>
          rawRuntimeMock.decodeBoundedHqRaw(file, options),
      ),
      terminateDecodeBridge: vi.fn(async () => {}),
      beginSession: vi.fn(sessions.begin),
      cancelSession: vi.fn(sessions.cancel),
      dispose: vi.fn(sessions.cancel),
    }
    rawRuntimeHosts.push(host)
    return host
  }
  return { createRawRuntimeHost: createRawRuntimeHostStandIn }
})

vi.mock('sonner', () => ({
  toast: toastMock,
}))

vi.mock('../services/export/export-system', async () => {
  const actual = await vi.importActual('../services/export/export-system')
  return {
    ...actual,
    runFullResolutionExportJob: exportSystemMock.runFullResolutionExportJob,
    runPreviewExportJob: exportSystemMock.runPreviewExportJob,
  }
})

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

vi.mock('../services/compare/original-reference-renderer', async () => {
  const actual = await vi.importActual(
    '../services/compare/original-reference-renderer',
  )
  return {
    ...actual,
    renderOriginalReferenceSnapshot:
      originalReferenceSnapshotMock.renderOriginalReferenceSnapshot,
  }
})

vi.mock('../services/compare/original-reference-snapshot', async () => {
  const actual = await vi.importActual(
    '../services/compare/original-reference-snapshot',
  )
  return {
    ...actual,
    releaseOriginalReferenceSnapshot:
      originalReferenceSnapshotMock.releaseOriginalReferenceSnapshot,
  }
})

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

function createDecodedImage(
  source: 'quick' | 'bounded-hq',
  overrides: Partial<DecodedImage> = {},
): DecodedImage {
  const isQuick = source === 'quick'

  return {
    width: isQuick ? 800 : 4000,
    height: isQuick ? 600 : 3000,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array([0, 1024, 65535]),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    timings: { total: isQuick ? 20 : 120 },
    metadata: {
      make: 'Sony',
      model: 'A7',
      width: isQuick ? 800 : 4000,
      height: isQuick ? 600 : 3000,
    },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    ...overrides,
  }
}

function createCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, '']
  const step = 1 / (size - 1)

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r * step} ${g * step} ${b * step}`)
      }
    }
  }

  return lines.join('\n')
}

function createCubeFile(title: string, name: string) {
  const content = createCube(title)
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
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
    createCube(title, size),
  ].join('\n')
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

/** A .cube whose bytes arrive only when the test finishes the read. */
function createDeferredCubeFile(title: string, name: string) {
  const bytes = new TextEncoder().encode(createCube(title))
  const read = deferred<ArrayBuffer>()
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', { value: () => read.promise })
  return { file, finishRead: () => read.resolve(bytes.buffer) }
}

const MARKER_PREFIX = 'lumaforge.export-interruption.v1.'
const OWNER_LOCK_PREFIX = 'lumaforge-export-attempt-owner:'

/** Exclusive `ifAvailable` Web Locks shared by the pages of one test. */
function createFakeLocks() {
  const held = new Set<string>()
  const locks = {
    async request(
      name: string,
      _options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ) {
      if (held.has(name)) return callback(null)
      held.add(name)
      try {
        return await callback({ name, mode: 'exclusive' } as Lock)
      } finally {
        held.delete(name)
      }
    },
  } as unknown as Pick<LockManager, 'request'>
  return {
    locks,
    closePage(page: string) {
      held.delete(`${OWNER_LOCK_PREFIX}${page}`)
    },
  }
}

let fakeLocks = createFakeLocks()

function createMarkerPage(page: string) {
  let attempts = 0
  return createExportInterruptionMarkers({
    getStorage: () => localStorage,
    getLocks: () => fakeLocks.locks,
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
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(MARKER_PREFIX))
    .map((key) => JSON.parse(localStorage.getItem(key)!) as { attempt: string })
}

function pageMarkers() {
  const markers = interruptionMarkersMock.current
  if (!markers) throw new Error('Expected test markers.')
  return markers
}

/** A supported capability carrying every fact the native runtime declares. */
function createSupportedCapability(): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 6048,
    height: 4024,
    rawWidth: 6048,
    rawHeight: 4024,
    visibleCrop: { x: 0, y: 0, width: 6048, height: 4024 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
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
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: { black: 0, white: 65535 },
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
    windows: { librawProcessed: true, rawMosaic: false },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

function createFileWithSize(name: string, size: number) {
  const file = new File(['raw'], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

// Workflow atom hooks are bound to the shared jotaiStore, so a fresh Provider
// would not isolate them: each test resets that store in beforeEach/afterEach.
function wrapper({ children }: { children: ReactNode }) {
  return <Provider store={jotaiStore}>{children}</Provider>
}

// The workflow as the view hosts it: the histogram runs beside it and
// publishes to its atom.
function useWorkflowWithHistogram() {
  const workflow = useRawWorkflow()
  usePublishedPreviewHistogram(workflow)
  const histogram = useAtomValue(previewHistogramStateAtom, {
    store: jotaiStore,
  })
  return { workflow, histogram }
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

async function flushScheduledToasts() {
  await flushPostCommitTasks()
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useRawWorkflow embedded preview state', () => {
  beforeEach(() => {
    resetToDefaults()
    jotaiStore.set(currentSessionAtom, null)
    rawRuntimeMock.openSession.mockReset()
    rawRuntimeMock.extractEmbeddedPreview.mockReset()
    rawRuntimeMock.decodeQuickRaw.mockReset()
    rawRuntimeMock.decodeBoundedHqRaw.mockReset()
    rawRuntimeMock.probeExportCapability.mockReset()
    rawRuntimeMock.getPrewarmState.mockReset().mockReturnValue('ready')
    rawRuntimeMock.prewarm.mockReset().mockResolvedValue({ status: 'ready' })
    exportSystemMock.runFullResolutionExportJob.mockReset()
    exportSystemMock.runPreviewExportJob.mockReset()
    originalReferenceSnapshotMock.renderOriginalReferenceSnapshot
      .mockReset()
      .mockRejectedValue(
        new Error('Original reference snapshot disabled in hook tests'),
      )
    originalReferenceSnapshotMock.releaseOriginalReferenceSnapshot.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    toastMock.info.mockReset()
    toastMock.dismiss.mockReset()
    localStorage.clear()
    resetCapabilityVectorForTest()
    fakeLocks = createFakeLocks()
    interruptionMarkersMock.current = createMarkerPage('this-page')
    vi.spyOn(interruptionMarkersMock.current, 'inspect')

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:embedded-preview'),
      revokeObjectURL: vi.fn(),
    })
    rawRuntimeMock.openSession.mockImplementation(() =>
      Promise.resolve({
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: rawRuntimeMock.extractEmbeddedPreview,
        decodeQuickRaw: rawRuntimeMock.decodeQuickRaw,
        decodeBoundedHqRaw: rawRuntimeMock.decodeBoundedHqRaw,
        probeExportCapability: rawRuntimeMock.probeExportCapability,
        dispose: vi.fn(),
      }),
    )
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createSupportedCapability(),
    )
  })

  afterEach(() => {
    act(() => {
      resetToDefaults()
      jotaiStore.set(currentSessionAtom, null)
    })
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    resetCapabilityVectorForTest()
    interruptionMarkersMock.current = null
  })

  describe('export evacuation on the workflow host', () => {
    const exportedJpeg = () => ({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    function openSignalOf(call: number) {
      return rawRuntimeMock.openSession.mock.calls[call]?.[1] as
        | AbortSignal
        | undefined
    }

    async function renderLoaded() {
      vi.stubGlobal('crossOriginIsolated', true)
      rawRuntimeHosts.length = 0
      const rendered = renderHook(() => useRawWorkflow(), { wrapper })
      const [host] = rawRuntimeHosts
      await act(async () => {
        await rendered.result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      return { ...rendered, host: host! }
    }

    it('ends the preview session and terminates its worker on the host before the export worker runs', async () => {
      // The bounded HQ decode is still in flight on the load's lease.
      const boundedHq = deferred<DecodedImage>()
      const sessionDispose = vi.fn()
      rawRuntimeMock.openSession.mockResolvedValueOnce({
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
        decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
        probeExportCapability: rawRuntimeMock.probeExportCapability,
        dispose: sessionDispose,
      })
      const workerRuns = vi.fn()
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async (input: {
          beforeStart?: () => void | Promise<void>
          signal: AbortSignal
        }) => {
          await input.beforeStart?.()
          workerRuns(input.signal.aborted)
          return exportedJpeg()
        },
      )
      const { result, host } = await renderLoaded()
      expect(openSignalOf(0)?.aborted).toBe(false)
      const cancelsBefore = vi.mocked(host.cancelSession).mock.calls.length

      await act(async () => {
        await result.current.exportImage()
      })

      expect(workerRuns).toHaveBeenCalledExactlyOnceWith(false)
      expect(openSignalOf(0)?.aborted).toBe(true)
      expect(sessionDispose).toHaveBeenCalledTimes(1)
      const cancelOrder = vi
        .mocked(host.cancelSession)
        .mock.invocationCallOrder.slice(cancelsBefore)
      const terminateOrder = vi.mocked(host.terminateDecodeBridge).mock
        .invocationCallOrder
      expect(cancelOrder.length).toBeGreaterThan(0)
      expect(terminateOrder).toHaveLength(1)
      expect(cancelOrder[0]).toBeLessThan(terminateOrder[0]!)
      expect(terminateOrder[0]).toBeLessThan(
        workerRuns.mock.invocationCallOrder[0]!,
      )
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )

      // The evacuated source's HQ frame lands late and publishes nothing.
      await act(async () => {
        boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(sessionDispose).toHaveBeenCalledTimes(1)
      expect(result.current.decodedImageRef.current).toBeNull()
      expect(result.current.previewSuspended).toBe(true)
    })

    it('keeps the export running when the preview runtime is cancelled on the host', async () => {
      const pendingJpeg = deferred<ReturnType<typeof exportedJpeg>>()
      let jobSignal: AbortSignal | undefined
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async (input: {
          beforeStart?: () => void | Promise<void>
          signal: AbortSignal
        }) => {
          await input.beforeStart?.()
          jobSignal = input.signal
          return pendingJpeg.promise
        },
      )
      const { result, host } = await renderLoaded()

      let exporting!: Promise<void>
      act(() => {
        exporting = result.current.exportImage()
      })
      await waitFor(() => expect(jobSignal).toBeDefined())

      act(() => {
        host.cancelSession()
      })
      expect(jobSignal?.aborted).toBe(false)
      expect(result.current.status).toBe('exporting')

      await act(async () => {
        pendingJpeg.resolve(exportedJpeg())
        await exporting
      })

      expect(jobSignal?.aborted).toBe(false)
      expect(result.current.status).toBe('ready')
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )
    })

    it('restores the preview on the same host after a failed export', async () => {
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async (input: { beforeStart?: () => void | Promise<void> }) => {
          await input.beforeStart?.()
          throw new Error('decoder exploded')
        },
      )
      const { result, host } = await renderLoaded()

      await act(async () => {
        await result.current.exportImage()
      })
      await flushScheduledToasts()

      expect(toastMock.error).toHaveBeenCalledWith(
        'Export failed',
        expect.anything(),
      )
      expect(result.current.status).toBe('ready')
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'failed',
      )
      expect(host.terminateDecodeBridge).toHaveBeenCalledTimes(1)
      expect(result.current.decodedImageRef.current).toBeNull()

      await act(async () => {
        await result.current.restorePreviewAfterExport()
      })

      expect(host.beginSession).toHaveBeenCalledTimes(2)
      expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(2)
      expect(openSignalOf(1)?.aborted).toBe(false)
      expect(result.current.status).toBe('ready')
      expect(result.current.decodedImageRef.current?.source).toBe('quick')
      expect(rawRuntimeHosts).toHaveLength(1)
      await flushScheduledToasts()
      expect(toastMock.error).not.toHaveBeenCalledWith(
        'Preview restore failed',
        expect.anything(),
      )
    })
  })

  describe('on a real RAW host', () => {
    function makeRuntime() {
      const info: LumaRawRuntimeInfo = {
        runtime: 'luma',
        version: '0.1.0',
        simd: true,
        pthreads: true,
        crossOriginIsolated: true,
        memoryTier: 'normal',
        memoryProfile: 'desktop',
        workerPoolSize: 2,
      }
      return {
        info,
        init: vi.fn<LumaRawRuntime['init']>().mockResolvedValue(info),
        probe: vi.fn<LumaRawRuntime['probe']>(),
        extractEmbeddedPreview:
          vi.fn<LumaRawRuntime['extractEmbeddedPreview']>(),
        decodeQuick: vi.fn<LumaRawRuntime['decodeQuick']>(),
        decodeBoundedHq: vi.fn<LumaRawRuntime['decodeBoundedHq']>(),
        openSession: vi.fn<LumaRawRuntime['openSession']>(),
        dispose: vi.fn<LumaRawRuntime['dispose']>(),
      }
    }

    afterEach(() => {
      realRawRuntimeHostOptions.current = null
    })

    function renderOnRealHost(runtime: ReturnType<typeof makeRuntime>) {
      rawRuntimeHosts.length = 0
      realRawRuntimeHostOptions.current = { runtimeFactory: () => runtime }
      const rendered = renderHook(() => useRawWorkflow(), { wrapper })
      const [host] = rawRuntimeHosts
      expect(rendered.result.current.rawRuntimeHost).toBe(host)
      return { ...rendered, host: host! }
    }

    it('terminates a warmed runtime when the workflow unmounts', async () => {
      const runtime = makeRuntime()
      const { host, unmount } = renderOnRealHost(runtime)
      await act(async () => {
        await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
      })
      expect(host.getSnapshot().runtime.initialized).toBe(true)

      unmount()
      await act(async () => {})

      expect(runtime.dispose).toHaveBeenCalledTimes(1)
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'idle',
        runtime: {
          workerAlive: false,
          initialized: false,
          lastTermination: { reason: 'explicit' },
        },
      })
    })

    it('keeps its host usable across a StrictMode effect replay', async () => {
      const runtime = makeRuntime()
      realRawRuntimeHostOptions.current = { runtimeFactory: () => runtime }
      const { result } = renderHook(() => useRawWorkflow(), {
        wrapper,
        reactStrictMode: true,
      })
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

    it('leaves no initialized runtime when a warm-up settles after unmount', async () => {
      const runtime = makeRuntime()
      let resolveInit!: (info: LumaRawRuntimeInfo) => void
      runtime.init.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve
          }),
      )
      const { host, unmount } = renderOnRealHost(runtime)
      let warmup!: ReturnType<RawRuntimeHost['prewarm']>
      act(() => {
        warmup = host.prewarm()
      })
      await waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))

      unmount()
      await act(async () => {})
      expect(runtime.dispose).toHaveBeenCalledTimes(1)
      expect(host.getSnapshot().runtime.lastTermination).toMatchObject({
        reason: 'explicit',
      })

      await act(async () => {
        resolveInit(runtime.info)
        await expect(warmup).resolves.toMatchObject({ status: 'failed' })
      })
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'idle',
        outcome: null,
        runtime: { workerAlive: false, initialized: false },
      })
    })

    describe('superseded native work', () => {
      type WorkerOperation =
        | 'init'
        | 'openSession'
        | 'extractEmbeddedPreview'
        | 'probeExportCapability'
        | 'decodeQuick'
        | 'decodeBoundedHq'

      function makeFrame(
        source: LumaRawFrame['source'],
        make: string,
      ): LumaRawFrame {
        return {
          jobId: `${source}-${make}`,
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
      function makeWorkerLikeRuntime() {
        const info = makeRuntime().info
        let tail: Promise<unknown> = Promise.resolve()
        const gates = new Map<
          WorkerOperation,
          ReturnType<typeof deferred<void>>
        >()
        const run = <T,>(operation: WorkerOperation, value: () => T) => {
          const job = tail.then(async () => {
            await gates.get(operation)?.promise
            return value()
          })
          tail = job.catch(() => undefined)
          return job
        }
        const sessions: LumaRawDecodeSession[] = []
        const runtime = {
          init: vi.fn<LumaRawRuntime['init']>(() => run('init', () => info)),
          probe: vi.fn<LumaRawRuntime['probe']>(),
          extractEmbeddedPreview:
            vi.fn<LumaRawRuntime['extractEmbeddedPreview']>(),
          decodeQuick: vi.fn<LumaRawRuntime['decodeQuick']>(),
          decodeBoundedHq: vi.fn<LumaRawRuntime['decodeBoundedHq']>(),
          openSession: vi.fn<LumaRawRuntime['openSession']>((file) =>
            run('openSession', () => {
              const session: LumaRawDecodeSession = {
                sessionId: file.name,
                probe: {
                  jobId: 'probe',
                  width: defaultSourceDimensions.width,
                  height: defaultSourceDimensions.height,
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
                readRawWindow: vi.fn(),
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
              }
              sessions.push(session)
              return session
            }),
          ),
          dispose: vi.fn<LumaRawRuntime['dispose']>(),
        }
        return {
          runtime,
          sessions,
          /** Holds `operation` until the returned gate opens. */
          hold(operation: WorkerOperation) {
            const gate = deferred<void>()
            gates.set(operation, gate)
            return gate
          },
        }
      }

      /** One worker-like runtime per runtime generation the host starts. */
      function renderOnWorkerLikeHost(
        configure: (
          worker: ReturnType<typeof makeWorkerLikeRuntime>,
          index: number,
        ) => void,
      ) {
        const workers: Array<ReturnType<typeof makeWorkerLikeRuntime>> = []
        rawRuntimeHosts.length = 0
        realRawRuntimeHostOptions.current = {
          runtimeFactory: () => {
            const worker = makeWorkerLikeRuntime()
            configure(worker, workers.length)
            workers.push(worker)
            return worker.runtime
          },
          jpegRuntimeAvailabilityProbe: () => true,
        }
        const rendered = renderHook(() => useRawWorkflow(), { wrapper })
        return { ...rendered, workers }
      }

      function shownSource(result: { current: UseRawWorkflowReturn }) {
        return result.current.decodedImageRef.current?.metadata.make
      }

      /** Starts a load without waiting for it to finish. */
      function startLoad(
        result: { current: UseRawWorkflowReturn },
        name: string,
      ) {
        let loading!: Promise<void>
        act(() => {
          loading = result.current.loadFile(new File(['raw'], name))
        })
        return loading
      }

      it.each(['replaced', 'reset'] as const)(
        'loads the next file on a fresh runtime when the warming load is %s while its init never answers',
        async (ending) => {
          let gate!: ReturnType<typeof deferred<void>>
          const { result, workers } = renderOnWorkerLikeHost(
            (worker, index) => {
              if (index === 0) gate = worker.hold('init')
            },
          )

          const firstLoad = startLoad(result, 'first.ARW')
          await waitFor(() =>
            expect(workers[0]?.runtime.init).toHaveBeenCalled(),
          )
          expect(result.current.status).toBe('warming')

          if (ending === 'reset') {
            act(() => {
              result.current.reset()
            })
            expect(jotaiStore.get(currentSessionAtom)).toBeNull()
          }
          const loading = startLoad(result, 'second.ARW')
          await waitFor(() => expect(shownSource(result)).toBe('second.ARW'))
          await act(async () => {
            await loading
            await firstLoad
          })
          await waitFor(() =>
            expect(result.current.displaySource).toBe('bounded-hq'),
          )

          // The replacement is ready on the second runtime before the
          // obsolete init has answered.
          expect(result.current.status).toBe('ready')
          expect(workers).toHaveLength(2)
          expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
          expect(workers[0]!.runtime.openSession).not.toHaveBeenCalled()
          const replacement = jotaiStore.get(currentSessionAtom)
          expect(replacement?.sourceFile.name).toBe('second.ARW')
          const replacementDisposals = vi.mocked(
            workers[1]!.sessions[0]!.dispose,
          ).mock.calls.length

          await act(async () => {
            gate.resolve()
            await flushPromises()
          })
          await flushScheduledToasts()

          expect(jotaiStore.get(currentSessionAtom)).toBe(replacement)
          expect(replacement?.renderState.lastErrorCode).toBeUndefined()
          expect(shownSource(result)).toBe('second.ARW')
          expect(result.current.status).toBe('ready')
          expect(result.current.error).toBeNull()
          expect(result.current.rawRuntimeHost.getSnapshot()).toMatchObject({
            initialization: 'ready',
            runtime: { generation: 2, workerAlive: true, initialized: true },
          })
          expect(workers[0]!.runtime.openSession).not.toHaveBeenCalled()
          expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
          expect(workers[1]!.sessions[0]!.dispose).toHaveBeenCalledTimes(
            replacementDisposals,
          )
          expect(toastMock.error).not.toHaveBeenCalled()
        },
      )

      it('loads a replacement while the replaced bounded HQ never answers, and its late frame changes nothing', async () => {
        let gate!: ReturnType<typeof deferred<void>>
        const { result, workers } = renderOnWorkerLikeHost((worker, index) => {
          if (index === 0) gate = worker.hold('decodeBoundedHq')
        })

        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'first.ARW'))
        })
        expect(shownSource(result)).toBe('first.ARW')
        await waitFor(() =>
          expect(workers[0]!.sessions[0]!.decodeBoundedHq).toHaveBeenCalled(),
        )

        const loading = startLoad(result, 'second.ARW')
        await waitFor(() => expect(shownSource(result)).toBe('second.ARW'))
        await act(async () => {
          await loading
        })
        await waitFor(() =>
          expect(result.current.displaySource).toBe('bounded-hq'),
        )
        expect(workers).toHaveLength(2)
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
        expect(workers[0]!.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
        const replacement = jotaiStore.get(currentSessionAtom)
        expect(replacement?.sourceFile.name).toBe('second.ARW')

        await act(async () => {
          gate.resolve()
          await flushPromises()
        })
        await flushScheduledToasts()

        expect(jotaiStore.get(currentSessionAtom)).toBe(replacement)
        expect(shownSource(result)).toBe('second.ARW')
        expect(result.current.status).toBe('ready')
        expect(result.current.error).toBeNull()
        expect(replacement?.previewBundle.boundedHqPreview.status).toBe('ready')
        expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
        expect(toastMock.error).not.toHaveBeenCalled()
      })

      it('loads after a reset while the reset quick decode never answers, and reports no cancellation', async () => {
        let gate!: ReturnType<typeof deferred<void>>
        const { result, workers } = renderOnWorkerLikeHost((worker, index) => {
          if (index === 0) gate = worker.hold('decodeQuick')
        })

        const firstLoad = startLoad(result, 'first.ARW')
        await waitFor(() =>
          expect(workers[0]?.sessions[0]?.decodeQuick).toHaveBeenCalled(),
        )
        act(() => {
          result.current.reset()
        })
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()

        const loading = startLoad(result, 'second.ARW')
        await waitFor(() => expect(shownSource(result)).toBe('second.ARW'))
        await act(async () => {
          await loading
        })

        // The reset load settles only once its quick decode answers late.
        await act(async () => {
          gate.resolve()
          await firstLoad
        })
        await flushScheduledToasts()

        const session = jotaiStore.get(currentSessionAtom)
        expect(session?.sourceFile.name).toBe('second.ARW')
        expect(session?.renderState.lastErrorCode).toBeUndefined()
        expect(shownSource(result)).toBe('second.ARW')
        expect(result.current.error).toBeNull()
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
        expect(workers.at(-1)!.runtime.dispose).not.toHaveBeenCalled()
        expect(toastMock.error).not.toHaveBeenCalled()
      })

      it('loads a replacement while a restore after export never answers', async () => {
        vi.stubGlobal('crossOriginIsolated', true)
        exportSystemMock.runFullResolutionExportJob.mockImplementation(
          async (input: { beforeStart?: () => void | Promise<void> }) => {
            await input.beforeStart?.()
            return {
              filename: 'first_neutral_fullres.jpg',
              blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
            }
          },
        )
        let gate!: ReturnType<typeof deferred<void>>
        // The export ends the first generation; the restore runs on the
        // second, whose quick decode never answers.
        const { result, workers } = renderOnWorkerLikeHost((worker, index) => {
          if (index === 1) gate = worker.hold('decodeQuick')
        })

        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'first.ARW'))
        })
        await waitFor(() =>
          expect(result.current.displaySource).toBe('bounded-hq'),
        )
        await act(async () => {
          await result.current.exportImage()
        })
        expect(result.current.previewSuspended).toBe(true)
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)

        let restoring!: Promise<void>
        act(() => {
          restoring = result.current.restorePreviewAfterExport()
        })
        await waitFor(() =>
          expect(workers[1]?.sessions[0]?.decodeQuick).toHaveBeenCalled(),
        )

        const loading = startLoad(result, 'second.ARW')
        await waitFor(() => expect(shownSource(result)).toBe('second.ARW'))
        await act(async () => {
          await loading
        })
        expect(workers[1]!.runtime.dispose).toHaveBeenCalledTimes(1)
        const replacement = jotaiStore.get(currentSessionAtom)
        expect(replacement?.sourceFile.name).toBe('second.ARW')

        // The replaced restore settles only once its decode answers late.
        await act(async () => {
          gate.resolve()
          await restoring
        })
        await flushScheduledToasts()

        expect(jotaiStore.get(currentSessionAtom)?.id).toBe(replacement?.id)
        expect(shownSource(result)).toBe('second.ARW')
        expect(result.current.status).toBe('ready')
        expect(workers.at(-1)!.runtime.dispose).not.toHaveBeenCalled()
        expect(toastMock.error).not.toHaveBeenCalled()
      })
    })
  })

  it('reads an interruption hint only once its source is loaded', async () => {
    const source = new File(['raw'], 'frame.ARW', { lastModified: 123 })
    await seedCrashedExport(source)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await flushPostCommitTasks()

    // No source, no hint: a stored marker never surfaces on its own.
    expect(result.current.exportInterrupted).toBe(false)
    expect(pageMarkers().inspect).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.loadFile(source)
    })

    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(true)
    })
  })

  it('requests the safer plan from the current source on the next explicit export', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(
        new File(['raw'], 'frame.ARW', { lastModified: 123 }),
      )
    })
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(true)
    })
    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        quality: 0.92,
        executionPlan: expect.objectContaining({
          productCopy: 'interrupted-retry',
          runtimeMemoryProfile: 'low-memory',
          request: expect.objectContaining({
            source: { width: 6048, height: 4024 },
          }),
        }),
      }),
    )
    // The delivered export used the hint up; nothing is left to read again.
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(false)
    })
    expect(storedMarkers()).toEqual([])
  })

  describe('local LUT loads against the current session', () => {
    it('lands a LUT picked in a replacing loadFile tick on the replacement', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      const first = jotaiStore.get(currentSessionAtom)
      const pick = createDeferredCubeFile('Second Look', 'second-look.cube')

      // Both commands come from the first source's render and run before
      // React renders the replacement, so the pick belongs to the source
      // that exists after the load.
      const { loadFile, loadLUT } = result.current
      let lutLoad!: Promise<LutLoadOutcome>
      await act(async () => {
        const loading = loadFile(new File(['raw'], 'second.ARW'))
        lutLoad = loadLUT(pick.file)
        await loading
      })
      let outcome: LutLoadOutcome | undefined
      await act(async () => {
        pick.finishRead()
        outcome = await lutLoad
      })

      expect(outcome).toBe('loaded')
      expect(result.current.currentLutName).toBe('Second Look')
      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        sourceFile: { name: 'second.ARW' },
        activeStyle: { kind: 'custom', name: 'Second Look' },
      })
      expect(first?.activeStyle ?? null).toBeNull()
    })

    it('carries a look strength set in a replacing loadFile tick into the replacement', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      const lookStrength = renderLookStrength()
      await act(async () => {
        await result.current.loadLUT(
          createCubeFile('Strength Look', 'strength.cube'),
        )
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      const first = jotaiStore.get(currentSessionAtom)
      expect(first?.activeStyle).toMatchObject({ kind: 'custom' })
      expect(first?.activeStyle?.currentIntensity).not.toBe(0.41)

      // Both commands come from the first source's render: the strength lands
      // in the store before the load reads the look it carries over, and no
      // render runs between them.
      const { setIntensity, loadFile } = result.current
      await act(async () => {
        setIntensity(0.41)
        await loadFile(new File(['raw'], 'second.ARW'))
      })

      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        sourceFile: { name: 'second.ARW' },
        activeStyle: {
          kind: 'custom',
          name: 'Strength Look',
          currentIntensity: 0.41,
        },
      })
      expect(lookStrength()).toBe(0.41)
    })

    it('seeds the next source with a LUT picked in the reset tick', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      const pick = createDeferredCubeFile('Reset Look', 'reset-look.cube')

      const { reset, loadLUT } = result.current
      let lutLoad!: Promise<LutLoadOutcome>
      act(() => {
        reset()
        lutLoad = loadLUT(pick.file)
      })
      let outcome: LutLoadOutcome | undefined
      await act(async () => {
        pick.finishRead()
        outcome = await lutLoad
      })

      expect(outcome).toBe('loaded')
      expect(jotaiStore.get(currentSessionAtom)).toBeNull()
      expect(result.current.currentLutName).toBe('Reset Look')
      expect(getProcessingParams()).toMatchObject({
        styleKind: 'custom',
        builtinPreset: null,
      })

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })
      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        sourceFile: { name: 'second.ARW' },
        activeStyle: { kind: 'custom', name: 'Reset Look' },
      })
    })
  })

  it('publishes the active decoded preview histogram after load', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    )
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
      createDecodedImage('quick', {
        width: 2,
        height: 1,
        data: new Uint16Array([0, 0, 0, 65535, 65535, 65535]),
      }),
    )
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq', {
        width: 2,
        height: 1,
        data: new Uint16Array([65535, 0, 0, 0, 0, 65535]),
      }),
    )

    const { result } = renderHook(() => useWorkflowWithHistogram(), {
      wrapper,
    })

    await act(async () => {
      const loadPromise = result.current.workflow.loadFile(
        new File(['raw'], 'frame.ARW'),
      )
      await Promise.resolve()
      await vi.runAllTimersAsync()
      await loadPromise
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await vi.runOnlyPendingTimersAsync()
    })

    expect(result.current.histogram.state).toBe('ready')
    if (result.current.histogram.state !== 'ready') {
      throw new Error('Expected histogram')
    }
    expect(result.current.histogram.source).toBe('bounded-hq')
  })

  it('routes view writes made in the reset tick to the detached view', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    act(() => {
      result.current.setViewMode('processed')
    })

    // Every callback comes from the session render; the view writes land
    // after reset has already dropped the session.
    const { reset, setViewMode, setCompareSplit } = result.current
    act(() => {
      reset()
      setViewMode('original')
      setCompareSplit(0.37)

      expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    })

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(result.current.viewMode).toBe('original')
    expect(result.current.compareSplit).toBe(0.37)

    // The next RAW keeps the detached split but always opens in compare.
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'second.ARW'))
    })

    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.37)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.37,
    })
  })

  it('starts an original reference fallback snapshot after dual GPU fails', async () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => true),
    })
    setCapabilityVectorForTest({
      coi: true,
      pthread: true,
      deviceMemoryGB: 8,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: true,
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('compare')
    })
    await flushPromises()

    expect(result.current.dualGpuAllowed).toBe(true)
    expect(
      originalReferenceSnapshotMock.renderOriginalReferenceSnapshot,
    ).not.toHaveBeenCalled()

    act(() => {
      result.current.requestOriginalReferenceFallback()
    })

    await waitFor(() => {
      expect(
        originalReferenceSnapshotMock.renderOriginalReferenceSnapshot,
      ).toHaveBeenCalledTimes(1)
    })
  })

  it('does not prepare original reference snapshots when CSS clipping is unavailable', async () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => false),
    })
    setCapabilityVectorForTest({
      coi: false,
      pthread: false,
      deviceMemoryGB: 4,
      hwConcurrency: 4,
      webKitClass: 'webkit-mobile',
      deviceFormFactor: 'mobile',
      maybeOpfsSupported: false,
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('compare')
    })
    await flushPromises()

    expect(result.current.dualGpuAllowed).toBe(false)
    expect(
      originalReferenceSnapshotMock.renderOriginalReferenceSnapshot,
    ).not.toHaveBeenCalled()
  })

  it('keeps full-resolution export disabled until decoded render exposure is available', async () => {
    const file = createFileWithSize('large.ARW', 33 * 1024 * 1024)
    const quickDecode = deferred<DecodedImage>()
    const boundedHqDecode = deferred<DecodedImage>()
    const runtimeCallOrder: string[] = []

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockImplementation(() => {
      runtimeCallOrder.push('quick')
      return quickDecode.promise
    })
    rawRuntimeMock.decodeBoundedHqRaw.mockImplementation(() => {
      runtimeCallOrder.push('bounded-hq')
      return boundedHqDecode.promise
    })
    rawRuntimeMock.probeExportCapability.mockImplementation(() => {
      runtimeCallOrder.push('probe-export')
      return Promise.resolve(createSupportedCapability())
    })
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'large_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = result.current.loadFile(file)
      await flushPromises()
    })

    await waitFor(() => {
      expect(rawRuntimeMock.decodeQuickRaw).toHaveBeenCalled()
    })
    expect(rawRuntimeMock.probeExportCapability).not.toHaveBeenCalled()
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.fullResCapability,
    ).toEqual({ status: 'probing' })
    expect(result.current.canExport).toBe(false)
    expect(result.current.exportRefusal).toEqual({
      code: 'quick-preview-pending',
    })

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      { description: 'Quick preview is still being prepared.' },
    )

    await act(async () => {
      quickDecode.resolve(createDecodedImage('quick'))
      await flushPromises()
    })
    await waitFor(() => {
      expect(rawRuntimeMock.probeExportCapability).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(rawRuntimeMock.decodeBoundedHqRaw).toHaveBeenCalled()
    })
    expect(runtimeCallOrder.indexOf('probe-export')).toBeGreaterThan(
      runtimeCallOrder.indexOf('quick'),
    )
    expect(runtimeCallOrder.indexOf('probe-export')).toBeLessThan(
      runtimeCallOrder.indexOf('bounded-hq'),
    )
    await waitFor(() => {
      expect(
        jotaiStore.get(currentSessionAtom)?.exportState.fullResCapability,
      ).toMatchObject({
        status: 'supported',
      })
    })

    await act(async () => {
      boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await loadPromise
    })
  })

  describe('export attempts and the session Transform', () => {
    /** A second geometry, rotated the other way. */
    const OTHER_GEOMETRY = {
      matrix: [0.999, 0.035, -0.018, -0.035, 0.999, 0.017, 0, 0, 1],
      constrainCrop: true,
    }
    const FRAME = { width: 800, height: 600 }

    function transformPort(result: {
      current: UseRawWorkflowReturn
    }): NonNullable<UseRawWorkflowReturn['transform']> {
      const port = result.current.transform
      if (!port?.state) throw new Error('expected a Transform source')
      return port
    }

    function liveTransform() {
      const transform = jotaiStore.get(currentSessionAtom)?.transform
      if (!transform) throw new Error('expected a session Transform')
      return transform
    }

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
          return {
            filename,
            blob: new Blob(['preview-jpeg'], { type: 'image/jpeg' }),
          }
        },
      )
      const renderToHiddenCanvas = vi
        .fn()
        .mockResolvedValue(document.createElement('canvas'))
      const hook = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await hook.result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await waitFor(() => {
        expect(hook.result.current.displaySource).toBe('bounded-hq')
      })
      act(() => {
        hook.result.current.pipelineRef.current = {
          renderToHiddenCanvas,
          // The preview has drawn the look the workflow holds.
          getParams: () => hook.result.current.params,
          getLutData: () => null,
        } as never
        hook.result.current.updateStats({
          uploadTime: 1,
          lutUploadTime: 0,
          processTime: 2,
          totalTime: 3,
          inputSize: { width: 6000, height: 4000 },
          previewSize: { width: 1200, height: 800 },
          inputFormat: 'uint16-rgb',
          transformPath: 'no-lut',
          lutRole: null,
          lutInputTransfer: null,
          lutOutputTransfer: null,
          lutSize: null,
        })
      })
      return { ...hook, renderToHiddenCanvas }
    }

    it('refuses full and HQ export from actions captured before the first edit while the Transform is pending, invalid or unavailable', async () => {
      exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      const { result, renderToHiddenCanvas } = await loadForHqExport()
      expect(result.current.canExport).toBe(true)
      expect(result.current.canPreviewExport).toBe(true)
      // The surface captured both actions while the Transform was neutral.
      const { exportImage, exportPreviewImage } = result.current
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId

      async function expectBothRefused(fullResDescription: string) {
        toastMock.error.mockClear()
        await act(async () => {
          await exportImage()
          await exportPreviewImage()
        })
        await flushScheduledToasts()
        expect(
          exportSystemMock.runFullResolutionExportJob,
        ).not.toHaveBeenCalled()
        expect(exportSystemMock.runPreviewExportJob).not.toHaveBeenCalled()
        expect(renderToHiddenCanvas).not.toHaveBeenCalled()
        expect(result.current.status).toBe('ready')
        expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
          'idle',
        )
        expect(toastMock.error).toHaveBeenCalledWith(
          'Full-resolution export is not ready',
          { description: fullResDescription },
        )
        expect(toastMock.error).toHaveBeenCalledWith(
          'HQ preview export is not ready',
          { description: enMessages['raw.transform.hqExportReason'] },
        )
      }

      // The edit, its request and the worker's answer arrive separately.
      act(() =>
        dispatch({
          type: 'edit',
          sourceId,
          intent: { manual: { ...NEUTRAL_TRANSFORM, rotate: 3 } },
        }),
      )
      expect(deriveTransformStatus(liveTransform())).toBe('pending')
      await expectBothRefused(
        'Transform is still preparing the current photo. Export once the preview shows it.',
      )

      act(() => {
        dispatch({
          type: 'capture',
          sourceId,
          captureKey: 'frame-a',
          clientEpoch: 1,
        })
      })
      act(() => {
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-a',
          clientEpoch: 1,
          requestId: 1,
          geometry: SAMPLE_GEOMETRY,
        })
      })
      expect(deriveTransformStatus(liveTransform())).toBe('pending')
      await expectBothRefused(
        'Transform is still preparing the current photo. Export once the preview shows it.',
      )

      act(() => {
        dispatch({
          type: 'render-failed',
          sourceId,
          captureKey: 'frame-a',
          clientEpoch: 1,
          requestId: 1,
          failure: 'transform',
        })
      })
      expect(deriveTransformStatus(liveTransform())).toBe('invalid')
      await expectBothRefused(
        'This Transform leaves too little usable image. Reduce the adjustment or reset Transform to export.',
      )

      act(() => {
        dispatch({
          type: 'capture',
          sourceId,
          captureKey: 'frame-b',
          clientEpoch: 1,
        })
      })
      act(() => {
        dispatch({
          type: 'capture-failed',
          sourceId,
          captureKey: 'frame-b',
          clientEpoch: 1,
        })
      })
      expect(deriveTransformStatus(liveTransform())).toBe('unavailable')
      await expectBothRefused(
        'The processed preview is unavailable. Wait for it or reset Transform to export.',
      )
      // No answer was ever accepted, so the session holds no geometry.
      expect(
        jotaiStore.get(currentSessionAtom)?.exportGeometry ?? null,
      ).toBeNull()
    })

    it('ends an in-flight export of an accepted geometry on the next edit, while the held geometry stays', async () => {
      const pending = deferred<{ filename: string; blob: Blob }>()
      exportSystemMock.runFullResolutionExportJob.mockReturnValue(
        pending.promise,
      )
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      act(() =>
        acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
      )
      let exportPromise!: Promise<void>
      await act(async () => {
        exportPromise = result.current.exportImage()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          exportSystemMock.runFullResolutionExportJob,
        ).toHaveBeenCalledTimes(1),
      )
      const job = exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]
      expect(job.geometry).toEqual(SAMPLE_GEOMETRY)
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      const captureKey = state!.capture!.key

      act(() =>
        dispatch({
          type: 'edit',
          sourceId,
          intent: { manual: { ...state!.intent.manual, rotate: 40 } },
        }),
      )
      const edited = jotaiStore.get(currentSessionAtom)
      expect(job.signal.aborted).toBe(true)
      expect(edited?.exportGeometry).toEqual(SAMPLE_GEOMETRY)
      expect(deriveTransformStatus(edited!.transform!)).toBe('pending')
      expect(edited?.exportState.status).toBe('idle')
      expect(result.current.status).toBe('ready')

      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey,
          clientEpoch: 1,
          requestId: 900,
          geometry: OTHER_GEOMETRY,
        }),
      )
      expect(jotaiStore.get(currentSessionAtom)?.exportGeometry).toEqual(
        SAMPLE_GEOMETRY,
      )
      act(() =>
        dispatch({
          type: 'rendered',
          sourceId,
          captureKey,
          clientEpoch: 1,
          requestId: 900,
          geometry: OTHER_GEOMETRY,
          frame: FRAME,
        }),
      )
      const answered = jotaiStore.get(currentSessionAtom)
      expect(answered?.exportGeometry).toEqual(OTHER_GEOMETRY)
      await act(async () => {
        pending.resolve({
          filename: 'stale.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        })
        await exportPromise
      })

      expect(result.current.exportResult).toBeNull()
      expect(jotaiStore.get(currentSessionAtom)).toBe(answered)
      expect(result.current.status).toBe('ready')
    })

    function deliverFileBackedExports() {
      const cleanup = vi.fn(async () => undefined)
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({ filename }: { filename: string }) => ({
          filename,
          output: {
            kind: 'file-backed',
            exportId: `export-${filename}`,
            filename,
            byteLength: 4,
            mimeType: 'image/jpeg',
            openBlob: vi.fn(
              async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
            ),
            cleanup,
          } satisfies FileBackedOutputResult,
        }),
      )
      return cleanup
    }

    it('keeps a delivered export through neutral Transform events', async () => {
      const cleanup = deliverFileBackedExports()
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      await act(async () => {
        await result.current.exportImage()
      })
      const neutralResult = result.current.exportResult
      expect(neutralResult).not.toBeNull()

      // A neutral Transform asks for nothing: a reset, a new frame and a
      // request on it leave the delivered export where it is.
      act(() => dispatch({ type: 'reset', sourceId }))
      act(() =>
        dispatch({
          type: 'capture',
          sourceId,
          captureKey: 'frame-n',
          clientEpoch: 1,
        }),
      )
      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-n',
          clientEpoch: 1,
          requestId: 950,
          geometry: SAMPLE_GEOMETRY,
        }),
      )
      await flushPostCommitTasks()
      expect(deriveTransformStatus(liveTransform())).toBe('neutral')
      expect(result.current.exportResult).toBe(neutralResult)
      expect(cleanup).not.toHaveBeenCalled()
    })

    const UNAVAILABLE_REFUSAL =
      'The processed preview is unavailable. Wait for it or reset Transform to export.'

    /**
     * Delivers file-backed exports, each once `finishJob` is called, from a
     * source whose manifest stays sealing until `seal` is called: hashing the
     * source RAW waits for its bytes.
     */
    function deliverSealGatedExports() {
      const gate = deferred<void>()
      const job = deferred<void>()
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({ filename }: { filename: string }) => {
          await job.promise
          return {
            filename,
            output: {
              kind: 'file-backed',
              exportId: `export-${filename}`,
              filename,
              byteLength: 4,
              mimeType: 'image/jpeg',
              sha256: 'c'.repeat(64),
              openBlob: vi.fn(
                async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
              ),
              cleanup: vi.fn(async () => undefined),
            } satisfies FileBackedOutputResult,
          }
        },
      )
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
      return {
        source,
        finishJob: () => job.resolve(),
        seal: () => gate.resolve(),
      }
    }

    it('does not deliver a JPEG that completes after its frame fails with no edit', async () => {
      const job = deliverSealGatedExports()
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(job.source)
      })
      act(() =>
        acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
      )
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      const intent = state!.intent
      let exportPromise!: Promise<void>
      await act(async () => {
        exportPromise = result.current.exportImage()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          exportSystemMock.runFullResolutionExportJob,
        ).toHaveBeenCalledTimes(1),
      )
      toastMock.error.mockClear()

      act(() =>
        dispatch({
          type: 'capture-failed',
          sourceId,
          captureKey: liveTransform().capture!.key,
          clientEpoch: 1,
        }),
      )
      expect(liveTransform().intent).toBe(intent)
      expect(deriveTransformStatus(liveTransform())).toBe('unavailable')
      await act(async () => {
        job.finishJob()
        await exportPromise
      })
      await flushScheduledToasts()

      expect(result.current.exportResult).toBeNull()
      expect(result.current.status).toBe('ready')
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'idle',
      )
      expect(toastMock.error).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        { description: UNAVAILABLE_REFUSAL },
      )
      // No result took the finished file, so the refused attempt removed it.
      const { output } =
        await exportSystemMock.runFullResolutionExportJob.mock.results[0]!.value
      expect(output.kind).toBe('file-backed')
      expect(output.cleanup).toHaveBeenCalledTimes(1)
    })
  })

  it('refuses the split once the GPU preview falls back to the CPU, and keeps the original', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const { setCompareSplit, setViewMode, resetCompareView } = result.current
    act(() => {
      setCompareSplit(0.7)
      result.current.setPreviewViewport({
        zoom: 2,
        panX: 30,
        panY: 10,
        fitMode: 'custom',
      })
    })
    const storedParamsBefore = getProcessingParams()

    previewBackendMock.state = {
      status: 'ready',
      facts: {
        backend: 'cpu',
        maxTextureSize: 0,
        reason: 'gpu-preview-failed',
      },
    }
    try {
      const sessionBefore = jotaiStore.get(currentSessionAtom)
      act(() => {
        setCompareSplit(0.2)
        setViewMode('compare')
        resetCompareView()
      })
      expect(jotaiStore.get(currentSessionAtom)).toBe(sessionBefore)

      act(() => setViewMode('original'))
      expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
        mode: 'original',
        compareSplit: 0.7,
        zoom: 2,
        fitMode: 'custom',
      })
      expect(getProcessingParams()).toBe(storedParamsBefore)
    } finally {
      previewBackendMock.state = previewBackendMock.gpu
    }
  })

  it('runs the full-resolution export job with the pinned source exposure and records strip progress', async () => {
    const renderExposure: RawRenderExposure = {
      ev: 1.25,
      multiplier: Math.pow(2, 1.25),
      source: 'image-statistics',
    }

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
      createDecodedImage('quick', { renderExposure }),
    )
    // A bounded HQ frame that estimated on its own does not move the export.
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq', {
        renderExposure: {
          ev: 1.3,
          multiplier: Math.pow(2, 1.3),
          source: 'image-statistics',
        },
      }),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createSupportedCapability(),
    )
    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      async ({
        onProgress,
        filename,
      }: {
        onProgress?: (progress: {
          completedStrips: number
          totalStrips: number
          progress: number
        }) => void
        filename: string
      }) => {
        onProgress?.({ completedStrips: 1, totalStrips: 4, progress: 25 })
        onProgress?.({ completedStrips: 4, totalStrips: 4, progress: 100 })
        return {
          filename,
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        }
      },
    )

    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const revokeObjectURL = vi.fn()
    const originalCreateElement = document.createElement.bind(document)

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:fullres-export'),
      revokeObjectURL,
    })
    vi.spyOn(document.body, 'append').mockImplementation(append)
    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
    ) => {
      if (tagName === 'a') {
        return {
          href: '',
          download: '',
          click,
          remove,
        }
      }
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    const exportRequest =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]
    const expectedExportGraphSteps = [
      { kind: 'input-linear-prophoto' },
      {
        kind: 'raw-render-exposure',
        ev: renderExposure.ev,
        multiplier: renderExposure.multiplier,
      },
      {
        kind: 'user-color-balance',
        temperature: 0,
        tint: 0,
        gain: [1, 1, 1],
        operator: 'linear-prophoto-relative-rgb-gain',
        luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      },
      { kind: 'user-exposure', ev: 0, multiplier: 1 },
      {
        kind: 'user-contrast',
        amount: 0,
        factor: 1,
        pivot: 0.18,
        operator: 'linear-prophoto-luminance-scale',
        luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
        zeroLuminanceMode: 'return-black',
      },
      {
        kind: 'user-regional-tone',
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        operator: 'linear-prophoto-log-luminance-regions',
        pivot: 0.18,
        luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
        zeroLuminanceMode: 'return-black',
      },
      {
        kind: 'user-saturation',
        operator: 'oklab-chroma-with-skin-protection',
        saturation: 0,
        vibrance: 0,
        satMaxFactor: USER_SATURATION_MAX_FACTOR,
        vibMaxFactor: USER_VIBRANCE_MAX_FACTOR,
        chromaRef: VIBRANCE_CHROMA_REF,
        skinHueCenterDeg: SKIN_HUE_CENTER_DEG,
        skinHueSigmaDeg: SKIN_HUE_SIGMA_DEG,
        skinProtectStrength: SKIN_PROTECT_STRENGTH,
      },
      {
        kind: 'user-selective-color',
        bands: {
          red: makeNeutralBand(),
          orange: makeNeutralBand(),
          yellow: makeNeutralBand(),
          green: makeNeutralBand(),
          aqua: makeNeutralBand(),
          blue: makeNeutralBand(),
          purple: makeNeutralBand(),
          magenta: makeNeutralBand(),
        },
        chromaClampLow: CHROMA_CLAMP_LOW,
        chromaClampHigh: CHROMA_CLAMP_HIGH,
        workingSpace: 'oklab-via-prophoto-d65',
        operator: 'oklch-per-band-shift',
        constantsVersion: LUT_CONSTANTS_VERSION,
      },
      { kind: 'output-srgb' },
    ]

    expect(exportRequest.graph.steps).toEqual(expectedExportGraphSteps)
    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.any(File),
        filename: 'frame_neutral_fullres.jpg',
        executionPlan: expect.objectContaining({
          preferredRows: expect.any(Number),
          concurrency: expect.any(Number),
        }),
        quality: 0.92,
        graph: expect.objectContaining({
          steps: expectedExportGraphSteps,
        }),
      }),
    )
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      status: 'ready',
      lastProgress: {
        completedStrips: 4,
        totalStrips: 4,
      },
      lastSuccessfulSize: {
        width: 6048,
        height: 4024,
      },
      result: {
        filename: 'frame_neutral_fullres.jpg',
        width: 6048,
        height: 4024,
        size: 4,
      },
    })
    expect(click).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('exports an HQ preview JPEG from the bounded preview without using the full-resolution worker', async () => {
    class FakeClipboardItem {
      static supports(type: string) {
        return type === 'image/jpeg'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn() },
    })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq', {
        width: 6000,
        height: 4000,
        metadata: {
          make: 'Sony',
          model: 'A7',
          width: 6000,
          height: 4000,
        },
      }),
    )
    exportSystemMock.runPreviewExportJob.mockImplementation(
      async ({
        renderToCanvas,
        filename,
      }: {
        renderToCanvas: () => Promise<HTMLCanvasElement>
        filename: string
      }) => {
        await renderToCanvas()
        return {
          filename,
          blob: new Blob(['preview-jpeg'], { type: 'image/jpeg' }),
        }
      },
    )
    const renderToHiddenCanvas = vi
      .fn()
      .mockResolvedValue(document.createElement('canvas'))

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('bounded-hq')
    })

    act(() => {
      result.current.pipelineRef.current = {
        renderToHiddenCanvas,
        // The preview has drawn the look the workflow holds.
        getParams: () => result.current.params,
        getLutData: () => null,
      } as never
      result.current.updateStats({
        uploadTime: 1,
        lutUploadTime: 0,
        processTime: 2,
        totalTime: 3,
        inputSize: { width: 6000, height: 4000 },
        previewSize: { width: 1200, height: 800 },
        inputFormat: 'uint16-rgb',
        transformPath: 'no-lut',
        lutRole: null,
        lutInputTransfer: null,
        lutOutputTransfer: null,
        lutSize: null,
      })
    })

    const previewExport = result.current as typeof result.current & {
      canPreviewExport: boolean
      exportPreviewImage: () => Promise<void>
    }
    expect(previewExport.canPreviewExport).toBe(true)

    await act(async () => {
      await previewExport.exportPreviewImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(exportSystemMock.runPreviewExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'frame_neutral_hq-preview.jpg',
        // The HQ preview encodes at the same fixed quality as full resolution.
        quality: 0.92,
      }),
    )
    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    const previewRenderRequest = renderToHiddenCanvas.mock.calls[0]![0]
    expect(
      previewRenderRequest.width * previewRenderRequest.height,
    ).toBeLessThanOrEqual(12_000_000)
    expect(
      previewRenderRequest.width * previewRenderRequest.height,
    ).toBeGreaterThanOrEqual(11_900_000)
    expect(
      previewRenderRequest.width / previewRenderRequest.height,
    ).toBeCloseTo(1.5, 2)
    expect(result.current.exportResult).toMatchObject({
      kind: 'hq-preview',
      filename: 'frame_neutral_hq-preview.jpg',
      width: previewRenderRequest.width,
      height: previewRenderRequest.height,
      size: 12,
      copyCapability: {
        mode: 'hq-preview',
      },
    })
    expect(toastMock.success).toHaveBeenCalledWith('HQ preview JPEG ready')
  })

  it('does not offer preview-size clipboard fallback for HQ preview JPEG results', async () => {
    class PngOnlyClipboardItem {
      static supports(type: string) {
        return type === 'image/png'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn() },
    })
    vi.stubGlobal('ClipboardItem', PngOnlyClipboardItem)
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq', {
        width: 4000,
        height: 3000,
      }),
    )
    exportSystemMock.runPreviewExportJob.mockImplementation(
      async ({ filename }: { filename: string }) => ({
        filename,
        blob: new Blob(['preview-jpeg'], { type: 'image/jpeg' }),
      }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('bounded-hq')
    })

    act(() => {
      result.current.pipelineRef.current = {
        renderToHiddenCanvas: vi
          .fn()
          .mockResolvedValue(document.createElement('canvas')),
        // The preview has drawn the look the workflow holds.
        getParams: () => result.current.params,
        getLutData: () => null,
      } as never
      result.current.updateStats({
        uploadTime: 1,
        lutUploadTime: 0,
        processTime: 2,
        totalTime: 3,
        inputSize: { width: 4000, height: 3000 },
        previewSize: { width: 1200, height: 900 },
        inputFormat: 'uint16-rgb',
        transformPath: 'no-lut',
        lutRole: null,
        lutInputTransfer: null,
        lutOutputTransfer: null,
        lutSize: null,
      })
    })

    await act(async () => {
      await result.current.exportPreviewImage()
    })

    expect(result.current.exportResult?.copyCapability).toEqual({
      mode: 'unavailable',
      reasonCode: 'hq-preview-copy-unsupported',
    })
  })

  it('restores an evacuated preview after export without discarding the result', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      maxTouchPoints: 0,
      storage: {},
      hardwareConcurrency: 8,
    })
    vi.stubGlobal('crossOriginIsolated', true)

    const quickExposure: RawRenderExposure = {
      ev: 0.6,
      multiplier: Math.pow(2, 0.6),
      source: 'image-statistics',
    }
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
      createDecodedImage('quick', { renderExposure: quickExposure }),
    )
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq', {
        renderExposure: {
          ev: 0.7,
          multiplier: Math.pow(2, 0.7),
          source: 'image-statistics',
        },
      }),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const file = new File(['raw'], 'frame.ARW')

    await act(async () => {
      await result.current.loadFile(file)
    })
    expect(result.current.displaySource).toBe('bounded-hq')

    await act(async () => {
      await result.current.exportImage()
    })

    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.decodedImageRef.current).toBeNull()
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )

    await act(async () => {
      await (
        result.current as unknown as {
          restorePreviewAfterExport: () => Promise<void>
        }
      ).restorePreviewAfterExport()
    })

    expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(2)
    expect(result.current.previewSuspended).toBe(false)
    expect(result.current.decodedImageRef.current?.source).toBe('quick')
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )

    // Quick, HQ, the export and the restored frame all render with the one
    // exposure the first quick decode pinned for this source.
    const exportGraph =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0].graph
    expect(
      exportGraph.steps.find(
        (step: ExportColorGraphStep) => step.kind === 'raw-render-exposure',
      ),
    ).toEqual({
      kind: 'raw-render-exposure',
      ev: quickExposure.ev,
      multiplier: quickExposure.multiplier,
    })
    expect(rawRuntimeMock.decodeQuickRaw).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { pinnedExposure: quickExposure },
    )
    expect(result.current.decodedImageRef.current?.renderExposure).toEqual(
      quickExposure,
    )
  })

  it('clears a ready export when render graph inputs change but not when compare split changes', async () => {
    const cleanup = vi.fn(async () => undefined)
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-graph-invalidation',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
      cleanup,
    }

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      output,
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.exportImage()
    })

    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()

    act(() => {
      result.current.setCompareSplit(0.25)
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()
    expect(cleanup).not.toHaveBeenCalled()

    act(() => {
      result.current.setIntensity(1)
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
    await waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores an in-flight export after render graph inputs change', async () => {
    const pendingExport = deferred<{
      filename: string
      blob: Blob
    }>()
    let exportSignal: AbortSignal | undefined

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) => {
        exportSignal = signal
        return pendingExport.promise
      },
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let exportPromise!: Promise<void>

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(exportSignal).toBeInstanceOf(AbortSignal)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
      'exporting',
    )

    act(() => {
      result.current.setIntensity(1)
    })

    expect(exportSignal?.aborted).toBe(true)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
    expect(toastMock.success).not.toHaveBeenCalledWith(
      'JPEG ready',
      expect.anything(),
    )
  })

  it('keeps a ready export and its output through view-only changes', async () => {
    const cleanup = vi.fn(async () => undefined)
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      output: {
        kind: 'file-backed',
        exportId: 'export-view-only',
        filename: 'frame_neutral_fullres.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
        openBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
        cleanup,
      } satisfies FileBackedOutputResult,
    })
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.exportImage()
    })
    await waitFor(() => {
      expect(
        jotaiStore.get(currentSessionAtom)?.exportState.result?.manifestState
          ?.status,
      ).not.toBe('sealing')
    })
    const readyResult = jotaiStore.get(currentSessionAtom)?.exportState.result
    expect(readyResult).toBeDefined()
    // This plan released the preview for the export, so the original and the
    // split are refused until it is restored; the processed photo and the
    // viewport stay open.
    expect(result.current.previewSuspended).toBe(true)

    act(() => result.current.setViewMode('original'))
    act(() => result.current.setViewMode('processed'))
    act(() => result.current.setCompareSplit(0.37))
    act(() => result.current.setViewMode('compare'))
    act(() => result.current.resetCompareView())
    act(() =>
      result.current.setPreviewViewport({
        zoom: 2,
        panX: 40,
        panY: -20,
        fitMode: 'custom',
      }),
    )
    act(() => result.current.setPreviewViewport(DEFAULT_PREVIEW_VIEWPORT))
    await flushPostCommitTasks()

    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBe(
      readyResult,
    )
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
    })
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    expect(result.current.canExport).toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('exports and seals a non-detent look strength exactly', async () => {
    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      async ({ filename }: { filename: string }) => ({
        filename,
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }),
    )
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const lookStrength = renderLookStrength()
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'client-look.cube'),
      )
    })
    act(() => {
      result.current.selectLUTProfile({
        ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      })
    })
    await waitFor(() => {
      expect(result.current.lutData?.profileResolution.kind).toBe('confirmed')
    })

    // 0.37 sits between the Light (0.4) and Standard (0.7) detents.
    act(() => {
      result.current.setIntensity(0.37)
    })
    expect(lookStrength()).toBe(0.37)
    expect(result.current.params.intensity).toBe(0.37)

    await act(async () => {
      await result.current.exportImage()
    })

    const [{ graph }] =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    expect(
      graph.steps.find(
        (step: ExportColorGraphStep) => step.kind === 'lut-output-to-srgb',
      ),
    ).toMatchObject({ intensity: 0.37 })
    await waitFor(() => {
      expect(
        jotaiStore.get(currentSessionAtom)?.exportState.result?.manifestState
          ?.status,
      ).toBe('ready')
    })
    const readyResult = jotaiStore.get(currentSessionAtom)?.exportState.result
    expect(readyResult?.manifest).toMatchObject({
      calibration: null,
      lut: { kind: 'local-file', filename: 'client-look.cube' },
      render_params: { intensity: 0.37 },
    })

    // Repeating the exported amount keeps the result; any other amount is a
    // different render, whether or not it sits on a detent.
    act(() => {
      result.current.setIntensity(0.37)
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBe(
      readyResult,
    )

    act(() => {
      result.current.setIntensity(0.62)
    })
    expect(lookStrength()).toBe(0.62)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
  })

  describe('a LUT change and an older export action in the same tick', () => {
    beforeEach(() => {
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({ filename }: { filename: string }) => ({
          filename,
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        }),
      )
    })

    async function readSealedResult() {
      await waitFor(() => {
        expect(
          jotaiStore.get(currentSessionAtom)?.exportState.result?.manifestState
            ?.status,
        ).toBe('ready')
      })
      return jotaiStore.get(currentSessionAtom)!.exportState.result!
    }

    function executedGraphSteps(): ExportColorGraphStep[] {
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      )
      const [{ graph }] =
        exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
      return graph.steps
    }

    it('exports the LUT a load landed in that tick through graph, identity and manifest', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await result.current.loadLUT(
          createContractCubeFile('Look A', 'look-a.cube', [
            'LUMAFORGE_INPUT_PROFILE=display-srgb',
            'LUMAFORGE_ROLE=display-look',
          ]),
        )
      })
      await waitFor(() => {
        expect(result.current.lutData?.title).toBe('Look A')
      })
      const lutA = result.current.lutDataRef.current!

      const { loadLUT, exportImage, lutDataRef } = result.current
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
        expect(lutDataRef.current).toBe(lutA)
        await exportImage()
      })

      const lutB = result.current.lutDataRef.current!
      expect(lutB.title).toBe('Look B')
      const steps = executedGraphSteps()
      expect(
        steps.find((step) => step.kind === 'gamut-to-lut-input'),
      ).toMatchObject({ gamut: 'v-gamut' })
      const lut3d = steps.find((step) => step.kind === 'lut3d')
      expect(lut3d).toMatchObject({ size: 33 })
      expect(lut3d && lut3d.kind === 'lut3d' ? lut3d.data : null).toBe(
        lutB.data,
      )
      const sealed = await readSealedResult()
      expect(sealed.identity?.lut).toMatchObject({
        size: 33,
        contract: { status: 'confirmed', inputGamut: 'v-gamut' },
      })
      const lutBSha256 =
        jotaiStore.get(currentSessionAtom)?.activeStyle?.lutAsset?.sha256
      expect(lutBSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(sealed.manifest?.lut).toMatchObject({
        kind: 'local-file',
        filename: 'look-b.cube',
        sha256: lutBSha256,
        input_contract: { gamut: 'v-gamut', transfer: 'v-log' },
      })
    })
  })

  it('aborts in-flight export when a replacement file starts and ignores stale completion', async () => {
    const staleExport = deferred<{
      filename: string
      blob: Blob
    }>()
    let staleExportSignal: AbortSignal | undefined
    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const originalCreateElement = document.createElement.bind(document)

    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) => {
        staleExportSignal = signal
        return staleExport.promise
      },
    )
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:stale-export'),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(document.body, 'append').mockImplementation(append)
    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
    ) => {
      if (tagName === 'a') {
        return {
          href: '',
          download: '',
          click,
          remove,
        }
      }
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let staleExportPromise!: Promise<void>

    await act(async () => {
      await result.current.loadFile(new File(['stale'], 'stale.ARW'))
    })

    await act(async () => {
      staleExportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(staleExportSignal).toBeInstanceOf(AbortSignal)

    await act(async () => {
      await result.current.loadFile(new File(['current'], 'current.ARW'))
    })

    expect(staleExportSignal?.aborted).toBe(true)
    const replacementSession = jotaiStore.get(currentSessionAtom)

    await act(async () => {
      staleExport.resolve({
        filename: 'stale_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await staleExportPromise
    })

    expect(click).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(result.current.sourceFileName).toBe('current.ARW')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(jotaiStore.get(currentSessionAtom)).toBe(replacementSession)
    expect(result.current.exportResult).toBeNull()
  })

  it.each([false, true])(
    'ends the session when the router leaves /raw and starts the route empty on return (StrictMode: %s)',
    async (strictMode) => {
      const mounted = { current: null as UseRawWorkflowReturn | null }
      const navigation = { navigate: null as NavigateFunction | null }
      function RawRouteProbe() {
        mounted.current = useRawWorkflow()
        return null
      }
      function NavigationProbe() {
        navigation.navigate = useNavigate()
        return null
      }
      const tree = (
        <Provider store={jotaiStore}>
          <MemoryRouter initialEntries={['/raw']}>
            <NavigationProbe />
            <Routes>
              <Route path="/raw" element={<RawRouteProbe />} />
              <Route path="/" element={null} />
            </Routes>
          </MemoryRouter>
        </Provider>
      )
      const view = render(strictMode ? <StrictMode>{tree}</StrictMode> : tree)
      await flushPostCommitTasks()

      await act(async () => {
        await mounted.current!.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await flushPostCommitTasks()
      // Mounted, the session stays usable, StrictMode replay or not.
      expect(mounted.current).toMatchObject({
        status: 'ready',
        sourceFileName: 'frame.ARW',
        canExport: true,
      })

      // A new search on the route keeps the mount, and with it the session.
      const loaded = jotaiStore.get(currentSessionAtom)
      act(() => {
        void navigation.navigate!('/raw?luts=https%3A%2F%2Fexample.com')
      })
      await flushPostCommitTasks()
      expect(jotaiStore.get(currentSessionAtom)).toBe(loaded)
      expect(mounted.current?.status).toBe('ready')

      act(() => {
        void navigation.navigate!('/')
      })
      await flushPostCommitTasks()
      expect(jotaiStore.get(currentSessionAtom)).toBeNull()

      mounted.current = null
      act(() => {
        void navigation.navigate!('/raw')
      })
      await flushPostCommitTasks()
      expect(mounted.current).toMatchObject({
        status: 'idle',
        hasImage: false,
        displaySource: 'none',
        canExport: false,
        exportResult: null,
      })

      view.unmount()
    },
  )

  it('loads, routes compare writes and exports under StrictMode effect replay', async () => {
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const { result, unmount } = renderHook(() => useRawWorkflow(), {
      wrapper,
      reactStrictMode: true,
    })

    // Without a source there is no hint to read, even on effect replay.
    expect(pageMarkers().inspect).not.toHaveBeenCalled()

    act(() => {
      result.current.setCompareSplit(0.7)
    })
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(getDetachedPreviewView().compareSplit).toBe(0.7)

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('ready')
    expect(result.current.displaySource).toBe('bounded-hq')
    expect(result.current.canExport).toBe(true)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.7,
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    const exportedSession = jotaiStore.get(currentSessionAtom)
    expect(exportedSession?.exportState.status).toBe('ready')

    // The replay at mount left the exported session in place.
    await flushPostCommitTasks()
    expect(jotaiStore.get(currentSessionAtom)?.id).toBe(exportedSession?.id)

    act(() => unmount())
    await flushPostCommitTasks()

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
  })

  it('ends an exporting session with its mount and lets the late export land on nothing', async () => {
    const pendingExport = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
    )
    const mounted = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await mounted.result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = mounted.result.current.exportImage()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      )
    })
    const request =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]

    await flushScheduledToasts()
    toastMock.success.mockClear()
    act(() => {
      mounted.unmount()
    })
    expect(request.signal.aborted).toBe(true)
    await flushPostCommitTasks()
    // The exporting session ended with the mount that ran its export.
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    const remounted = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      pendingExport.resolve({
        filename: 'late_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(remounted.result.current).toMatchObject({
      status: 'idle',
      hasImage: false,
      exportResult: null,
    })
    expect(toastMock.success).not.toHaveBeenCalled()
    remounted.unmount()
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
      rawRuntimeMock.openSession.mockImplementation(() => {
        const session = {
          sourceDimensions: defaultSourceDimensions,
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
          probeExportCapability: rawRuntimeMock.probeExportCapability,
          dispose: vi.fn(),
        }
        counted.runtimeSessions.push(session)
        return Promise.resolve(session)
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
          (session) => session.dispose.mock.calls.length,
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
      rawRuntimeHosts.length = 0
      const rendered = renderHook(() => useRawWorkflow(), {
        wrapper,
        ...options,
      })
      return {
        ...rendered,
        counted,
        host: rendered.result.current.rawRuntimeHost,
      }
    }

    it('routes a split and a look strength written in a replacing loadFile tick into the replacement only', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      const lookStrength = renderLookStrength()
      await act(async () => {
        await result.current.loadLUT(createCubeFile('Client Look', 'look.cube'))
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      act(() => {
        result.current.setCompareSplit(0.8)
        result.current.setIntensity(0.62)
      })
      const first = jotaiStore.get(currentSessionAtom)
      const detachedIntent = getProcessingParams()
      const detachedView = getDetachedPreviewView()

      // Every command comes from the first source's render, and all of them
      // run before React renders the replacement.
      const { loadFile, setCompareSplit, setIntensity } = result.current
      await act(async () => {
        const loading = loadFile(new File(['raw'], 'second.ARW'))
        setCompareSplit(0.3)
        setIntensity(0.4)

        const replacement = jotaiStore.get(currentSessionAtom)
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

    it('routes look and tone writes made in the reset tick to the detached intent the next source keeps', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      const lookStrength = renderLookStrength()
      await act(async () => {
        await result.current.loadLUT(createCubeFile('Client Look', 'look.cube'))
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })

      const { reset, setIntensity, setToneParams } = result.current
      act(() => {
        reset()
        setIntensity(0.33)
        setToneParams({ userContrast: 12 })

        expect(jotaiStore.get(currentSessionAtom)).toBeNull()
        expect(getProcessingParams()).toMatchObject({
          intensity: 0.33,
          userContrast: 12,
        })
      })

      expect(lookStrength()).toBe(0.33)
      expect(result.current.params.userContrast).toBe(12)

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })

      expect(result.current.currentLutName).toBe('Client Look')
      expect(result.current.params.userContrast).toBe(12)
      expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toMatchObject({
        name: 'Client Look',
        currentIntensity: 0.33,
      })
    })

    it('resets the replacement from a reset held over the replaced source and releases each source once', async () => {
      const { result, counted } = renderCounted()
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      const { reset } = result.current
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })
      expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
        'second.ARW',
      )

      act(() => {
        reset()
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()
      })

      expect(result.current.hasImage).toBe(false)
      expect(result.current.status).toBe('idle')
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [],
        revokedUrls: ['blob:embedded-1', 'blob:embedded-2'],
      })
    })

    it.each(['reset', 'replacement'] as const)(
      'releases the outgoing source once on %s, writes nothing from its late HQ frame, and releases nothing again on a repeat',
      async (owner) => {
        const { result, counted } = renderCounted()
        const outgoingHq = deferred<DecodedImage>()
        const openCounted = rawRuntimeMock.openSession.getMockImplementation()!
        rawRuntimeMock.openSession.mockImplementationOnce(
          async (...args: unknown[]) => {
            const session = await openCounted(...args)
            session.decodeBoundedHqRaw = vi
              .fn()
              .mockReturnValue(outgoingHq.promise)
            return session
          },
        )
        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'first.ARW'))
        })
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
        const successor = jotaiStore.get(currentSessionAtom)
        const afterTeardown = releases(counted)
        // The outgoing lease and its captured preview URL go exactly once.
        expect(afterTeardown.runtimeSessions[0]).toBe(1)
        expect(afterTeardown.revokedUrls).toEqual(['blob:embedded-1'])

        // The outgoing source's HQ frame settles after its teardown.
        await act(async () => {
          outgoingHq.resolve(createDecodedImage('bounded-hq'))
          await flushPromises()
        })
        expect(jotaiStore.get(currentSessionAtom)).toBe(successor)
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
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()
      },
    )

    it.each(['reset', 'replacement'] as const)(
      'releases a sealing export once on %s and lets its late manifest land on nothing',
      async (owner) => {
        const gate = deferred<void>()
        const { result, counted } = renderCounted()
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
        await act(async () => {
          await result.current.loadFile(source)
        })
        await act(async () => {
          await result.current.exportImage()
        })
        const delivered = result.current.exportResult
        expect(delivered?.manifestState?.status).toBe('sealing')

        await act(async () => {
          if (owner === 'reset') result.current.reset()
          else await result.current.loadFile(new File(['raw'], 'second.ARW'))
        })
        const successor = jotaiStore.get(currentSessionAtom)
        await waitFor(() => expect(counted.outputs[0]).toHaveBeenCalled())

        await act(async () => {
          gate.resolve()
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        await flushPostCommitTasks()

        // Disposal: the delivered output is released exactly once.
        expect(releases(counted).outputs).toEqual([1])
        // Stale completion: the seal finds no current attempt and writes
        // nothing over whatever owns the slot now.
        expect(jotaiStore.get(currentSessionAtom)).toBe(successor)
        expect(result.current.exportResult).toBeNull()
        // Identity: sealing never rewrote the delivered result in place.
        expect(delivered?.manifestState?.status).toBe('sealing')
        if (owner === 'reset') expect(successor).toBeNull()
        else expect(successor?.sourceFile.name).toBe('second.ARW')
      },
    )

    it('keeps a released preview a valid mounted session whose refused view commands write nothing anywhere', async () => {
      const { result, counted } = renderCounted()
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await result.current.exportImage()
      })
      await waitFor(() =>
        expect(result.current.exportResult?.manifestState?.status).toBe(
          'ready',
        ),
      )
      expect(result.current.previewSuspended).toBe(true)
      const released = jotaiStore.get(currentSessionAtom)
      const delivered = released?.exportState.result
      const detachedView = getDetachedPreviewView()

      // Commands held from the released render run before any rerender.
      const { setCompareSplit, setViewMode, resetCompareView } = result.current
      act(() => {
        setCompareSplit(0.2)
        setViewMode('original')
        resetCompareView()
      })

      // Refusal: neither the session nor the detached sample view moved.
      expect(jotaiStore.get(currentSessionAtom)).toBe(released)
      expect(getDetachedPreviewView()).toBe(detachedView)
      // Validity: the session stays loaded, exportable and delivered.
      expect(result.current).toMatchObject({
        hasImage: true,
        sourceFileName: 'frame.ARW',
        status: 'ready',
        canExport: true,
        previewSuspended: true,
      })
      expect(result.current.exportResult).toBe(delivered)
      // Disposal: holding the release frees nothing the result still owns.
      expect(releases(counted)).toEqual({
        runtimeSessions: [1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })

      await act(async () => {
        await result.current.restorePreviewAfterExport()
      })
      act(() => {
        result.current.setCompareSplit(0.2)
      })

      expect(result.current.previewSuspended).toBe(false)
      expect(result.current.exportResult).toBe(delivered)
      expect(jotaiStore.get(currentSessionAtom)?.viewState.compareSplit).toBe(
        0.2,
      )
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })
    })

    it('releases every session, output and preview URL exactly once across load, export, replacement and reset', async () => {
      const { result, counted, host } = renderCounted()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      await act(async () => {
        await result.current.exportImage()
      })
      await flushPostCommitTasks()
      // Export evacuates the embedded preview; the result keeps its output.
      expect(releases(counted)).toEqual({
        runtimeSessions: [1],
        outputs: [0],
        revokedUrls: ['blob:embedded-1'],
      })

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })
      await flushPostCommitTasks()
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [1],
        revokedUrls: ['blob:embedded-1'],
      })

      await act(async () => {
        await result.current.exportImage()
      })
      act(() => result.current.reset())
      act(() => result.current.reset())
      await flushPostCommitTasks()
      expect(releases(counted)).toEqual({
        runtimeSessions: [1, 1],
        outputs: [1, 1],
        revokedUrls: ['blob:embedded-1', 'blob:embedded-2'],
      })
      expect(host.dispose).not.toHaveBeenCalled()
    })

    describe('under StrictMode replay', () => {
      it('replays its mount effects without cancelling or releasing what a later load opens', async () => {
        const { result, counted, host } = renderCounted({
          reactStrictMode: true,
        })
        // The replayed cleanup already ended the host once; it stays usable.
        const replayDisposals = vi.mocked(host.dispose).mock.calls.length

        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'frame.ARW'))
        })
        await act(async () => {
          await result.current.exportImage()
        })
        await flushPostCommitTasks()

        // Cancellation: nothing cancels the load's lease after the replay.
        const openSignal = rawRuntimeMock.openSession.mock.calls[0]?.[1] as
          | AbortSignal
          | undefined
        expect(openSignal?.aborted).toBe(false)
        expect(result.current.status).toBe('ready')
        expect(result.current.exportResult?.filename).toBe(
          'frame_neutral_fullres.jpg',
        )
        // Disposal: the session is released once, by its own completion and
        // export, and the delivered output is still held.
        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [0],
          revokedUrls: ['blob:embedded-1'],
        })
        expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1)
        expect(host.dispose).toHaveBeenCalledTimes(replayDisposals)
      })
    })

    describe('real departure', () => {
      // A departure releases what the mount held, once each, and ends the
      // session it published, so a later mount starts without it.
      it('releases a loaded source preview once and a remounted workflow releases nothing again', async () => {
        const { result, counted, host, unmount } = renderCounted()
        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'frame.ARW'))
        })
        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [],
          revokedUrls: [],
        })

        act(() => unmount())
        await flushPostCommitTasks()

        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [],
          revokedUrls: ['blob:embedded-1'],
        })
        expect(host.dispose).toHaveBeenCalledTimes(1)
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()

        const remounted = renderHook(() => useRawWorkflow(), { wrapper })
        expect(remounted.result.current.hasImage).toBe(false)
        act(() => remounted.unmount())
        await flushPostCommitTasks()

        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [],
          revokedUrls: ['blob:embedded-1'],
        })
        expect(host.dispose).toHaveBeenCalledTimes(1)
      })

      it('releases a delivered export output once on unmount and never again from a later mount', async () => {
        const { result, counted, host, unmount } = renderCounted()
        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'frame.ARW'))
        })
        await act(async () => {
          await result.current.exportImage()
        })
        expect(releases(counted).outputs).toEqual([0])

        act(() => unmount())
        await waitFor(() => expect(counted.outputs[0]).toHaveBeenCalled())
        expect(host.dispose).toHaveBeenCalledTimes(1)
        // The result's output is gone, so neither its session nor the result
        // reaches the next mount.
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()

        const remounted = renderHook(() => useRawWorkflow(), { wrapper })
        expect(remounted.result.current.exportResult).toBeNull()
        expect(remounted.result.current.hasImage).toBe(false)
        act(() => remounted.unmount())
        await flushPostCommitTasks()

        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [1],
          revokedUrls: ['blob:embedded-1'],
        })
      })

      it("leaves another live mount's session, preview URL and status whole when it departs", async () => {
        const { counted, unmount } = renderCounted()
        // A second workflow is mounted while the first is still alive, and
        // loads a source with an embedded preview of its own.
        const other = renderHook(() => useRawWorkflow(), { wrapper })
        await act(async () => {
          await other.result.current.loadFile(new File(['raw'], 'other.ARW'))
        })
        const acquired = jotaiStore.get(currentSessionAtom)
        expect(acquired?.previewBundle.embeddedPreview).toMatchObject({
          objectUrl: 'blob:embedded-1',
        })

        act(() => unmount())
        await flushPostCommitTasks()

        expect(releases(counted).revokedUrls).toEqual([])
        expect(jotaiStore.get(currentSessionAtom)).toBe(acquired)
        expect(other.result.current).toMatchObject({
          status: 'ready',
          sourceFileName: 'other.ARW',
          embeddedPreviewUrl: 'blob:embedded-1',
          hasImage: true,
        })

        act(() => other.unmount())
        await flushPostCommitTasks()
        expect(releases(counted).revokedUrls).toEqual(['blob:embedded-1'])
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()
      })

      it('ends a released-preview session once on departure, leaving a StrictMode mount after it alone', async () => {
        const { result, counted, unmount } = renderCounted()
        await act(async () => {
          await result.current.loadFile(new File(['raw'], 'frame.ARW'))
        })
        await act(async () => {
          await result.current.exportImage()
        })
        expect(result.current.previewSuspended).toBe(true)
        expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
          'frame.ARW',
        )

        act(() => unmount())
        await flushPostCommitTasks()
        expect(jotaiStore.get(currentSessionAtom)).toBeNull()

        // A later mount under StrictMode replays its own cleanup and loads;
        // nothing of the departed mount touches what it opens.
        const remounted = renderHook(() => useRawWorkflow(), {
          wrapper,
          reactStrictMode: true,
        })
        await flushPostCommitTasks()
        await act(async () => {
          await remounted.result.current.loadFile(new File(['raw'], 'next.ARW'))
        })
        await flushPostCommitTasks()

        expect(remounted.result.current).toMatchObject({
          status: 'ready',
          sourceFileName: 'next.ARW',
          hasImage: true,
        })
        expect(releases(counted)).toEqual({
          runtimeSessions: [1, 1],
          outputs: [1],
          revokedUrls: ['blob:embedded-1'],
        })
        remounted.unmount()
      })
    })
  })
})
