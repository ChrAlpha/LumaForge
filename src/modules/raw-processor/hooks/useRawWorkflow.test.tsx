import type {
  ExportColorGraphStep,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  COLOR_GRAPH_INTENT_KEYS,
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
import {
  createBlobOutputResult,
  materializeOutputBlob,
} from '@lumaforge/render-engine/export'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryFileBackedOutputResult } from '~/lib/export/output-sink'
import { jotaiStore } from '~/lib/jotai'
import {
  getStoredLUTContractSelection,
  getStoredLUTProfileSelection,
} from '~/lib/lut/profile-resolution'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import {
  fetchCachedBytesWithLimit,
  fetchVerifiedCubeAsset,
} from '~/lib/profiles/fetch'
import type { DecodedImage } from '~/lib/raw/decoder'
import { BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS } from '~/lib/raw/decoder'
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
import { readSourceInterruption } from '../services/export/export-recovery'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import { deriveTransformStatus } from '../services/transform/transform-state'
import { getDetachedPreviewView } from '../state/preview-view.atoms'
import { currentSessionAtom } from '../state/session.atoms'
import { getProcessingParams, resetToDefaults } from '../state/workflow.atoms'
import { acceptTransformGeometry } from './transform-session.fixture'
import type { UseRawWorkflowReturn } from './useRawWorkflow'
import { useRawWorkflow } from './useRawWorkflow'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'

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

const onlineProfileFetchMock = vi.hoisted(() => ({
  fetchCachedBytesWithLimit: vi.fn(),
  fetchVerifiedCubeAsset: vi.fn(),
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

vi.mock('~/lib/profiles/fetch', async () => {
  const actual = await vi.importActual('~/lib/profiles/fetch')
  return {
    ...actual,
    fetchCachedBytesWithLimit: onlineProfileFetchMock.fetchCachedBytesWithLimit,
    fetchVerifiedCubeAsset: onlineProfileFetchMock.fetchVerifiedCubeAsset,
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

function makeJfifOnlyJpegBytes() {
  return new Uint8Array([
    255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    255, 217,
  ])
}

async function readBlobBytes(blob: Blob) {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })

  return new Uint8Array(buffer)
}

function bytesIncludeAscii(bytes: Uint8Array, value: string) {
  const needle = Array.from(value, (character) => character.charCodeAt(0))

  return bytes.some((_byte, index) =>
    needle.every((byte, offset) => bytes[index + offset] === byte),
  )
}

function encodeCube(title: string) {
  return new TextEncoder().encode(createCube(title))
}

/** What the verified catalog fetch resolves: bytes plus their manifest hash. */
function verifiedCube(title: string, sha256 = 'a'.repeat(64)) {
  return { bytes: encodeCube(title), sha256 }
}

function createOnlineLUTEntry(
  overrides: Partial<OnlineLUTEntry> = {},
): OnlineLUTEntry {
  return {
    id: 'online-lut',
    title: 'Online Client LUT',
    sourceUrl: 'https://example.com/catalog.json',
    sourceType: 'catalog-entry',
    cube: {
      url: 'https://example.com/luts/client.cube',
      sha256: 'a'.repeat(64),
      bytes: 1024,
      title: 'client.cube',
    },
    tags: [],
    ...overrides,
  }
}

function createTestSession() {
  return {
    id: 'session-lut-test',
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental' as const,
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' as const },
      quickDecodePreview: { status: 'ready' as const, width: 800, height: 600 },
      boundedHqPreview: { status: 'ready' as const, width: 800, height: 600 },
      displaySource: 'bounded-hq' as const,
      boundedHqRequiredForExport: false as const,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed' as const,
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen' as const,
    },
    renderState: { status: 'ready' as const },
    exportState: {
      status: 'idle' as const,
      fullResCapability: {
        status: 'supported' as const,
        width: 4000,
        height: 3000,
      },
      retryRecommended: false,
    },
  }
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

/**
 * Workflow keys naming an export recovery, retry or reselection. The load
 * progress hint is about decoding, not export.
 */
function exportRecoveryKeys(workflow: object) {
  return Object.keys(workflow).filter(
    (key) =>
      key !== 'progressRecoveryHint' &&
      /recover|retry|discovered|reselect/i.test(key),
  )
}

function pageMarkers() {
  const markers = interruptionMarkersMock.current
  if (!markers) throw new Error('Expected test markers.')
  return markers
}

function createSupportedCapability() {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 6048,
    height: 4024,
    rawWidth: 6048,
    rawHeight: 4024,
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 65535,
    orientation: 1,
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: { black: 0, white: 65535 },
    color: {
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

function createRawMosaicCapability() {
  return {
    ...createSupportedCapability(),
    strategy: 'raw-mosaic-window',
    windows: { librawProcessed: false, rawMosaic: true },
  }
}

function createUnsupportedCapability(reason: string) {
  return {
    ...createSupportedCapability(),
    supported: false,
    reasons: [reason],
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

function stubDownloadLink() {
  const click = vi.fn()
  const remove = vi.fn()
  const originalCreateElement = document.createElement.bind(document)

  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
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

  return { click, remove }
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
    onlineProfileFetchMock.fetchCachedBytesWithLimit.mockReset()
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockReset()
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

  it('warms, loads, and restores on the one RAW host it exposes', async () => {
    rawRuntimeHosts.length = 0
    rawRuntimeMock.getPrewarmState.mockReturnValue('idle')
    const { result, rerender } = renderHook(() => useRawWorkflow(), {
      wrapper,
    })
    rerender()

    expect(rawRuntimeHosts).toHaveLength(1)
    const [host] = rawRuntimeHosts
    expect(result.current.rawRuntimeHost).toBe(host)

    const file = new File(['raw'], 'frame.ARW')
    await act(async () => {
      await result.current.loadFile(file)
    })

    expect(result.current.status).toBe('ready')
    expect(host.getPrewarmState).toHaveBeenCalled()
    expect(host.prewarm).toHaveBeenCalledTimes(1)
    expect(host.beginSession).toHaveBeenCalledTimes(1)
    expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1)
    expect(rawRuntimeMock.openSession).toHaveBeenCalledWith(
      file,
      expect.any(AbortSignal),
    )
    expect(host.openSession).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.restorePreviewAfterExport()
    })
    // Restore takes its session from the same host slot as the load.
    expect(host.beginSession).toHaveBeenCalledTimes(2)
    expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(2)
    expect(host.openSession).not.toHaveBeenCalled()
    expect(rawRuntimeHosts).toHaveLength(1)
  })

  it('releases its RAW host after the RAW session when it unmounts', async () => {
    rawRuntimeHosts.length = 0
    const sessionDispose = vi.fn()
    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: rawRuntimeMock.extractEmbeddedPreview,
      decodeQuickRaw: rawRuntimeMock.decodeQuickRaw,
      decodeBoundedHqRaw: rawRuntimeMock.decodeBoundedHqRaw,
      probeExportCapability: rawRuntimeMock.probeExportCapability,
      dispose: sessionDispose,
    })
    const { result, unmount } = renderHook(() => useRawWorkflow(), {
      wrapper,
    })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const [host] = rawRuntimeHosts
    expect(host.dispose).not.toHaveBeenCalled()

    unmount()

    expect(sessionDispose).toHaveBeenCalledTimes(1)
    expect(host.dispose).toHaveBeenCalledTimes(1)
    expect(sessionDispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(host.dispose).mock.invocationCallOrder[0]!,
    )
  })

  describe('ingest sessions on the workflow host', () => {
    /** A RAW session whose bounded HQ decode settles only when told to. */
    function createHeldSession() {
      const boundedHq = deferred<DecodedImage>()
      const session = {
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
        decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
        probeExportCapability: rawRuntimeMock.probeExportCapability,
        dispose: vi.fn(),
      }
      return { session, boundedHq }
    }

    function openSignalOf(call: number) {
      return rawRuntimeMock.openSession.mock.calls[call]?.[1] as
        | AbortSignal
        | undefined
    }

    function renderWorkflowHost() {
      rawRuntimeHosts.length = 0
      const rendered = renderHook(() => useRawWorkflow(), { wrapper })
      const [host] = rawRuntimeHosts
      return { ...rendered, host: host! }
    }

    it('cancels a replaced load through its host and disposes that session once', async () => {
      const first = createHeldSession()
      const second = createHeldSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session)
      const { result, host } = renderWorkflowHost()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      expect(result.current.status).toBe('ready')
      const cancelsBefore = vi.mocked(host.cancelSession).mock.calls.length

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })

      // The replacing load cancels the first session on the host before it
      // takes the next lease.
      const cancelOrder = vi.mocked(host.cancelSession).mock.invocationCallOrder
      expect(cancelOrder.length).toBeGreaterThan(cancelsBefore)
      expect(cancelOrder[cancelsBefore]).toBeLessThan(
        vi.mocked(host.beginSession).mock.invocationCallOrder[1]!,
      )
      expect(openSignalOf(0)?.aborted).toBe(true)
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
      expect(second.session.dispose).not.toHaveBeenCalled()

      // The first load's bounded HQ settling late releases nothing twice and
      // publishes nothing over the replacement.
      await act(async () => {
        first.boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
      expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
        'second.ARW',
      )
      expect(result.current.displaySource).toBe('quick')

      await act(async () => {
        second.boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(second.session.dispose).toHaveBeenCalledTimes(1)
      expect(result.current.displaySource).toBe('bounded-hq')
    })

    it('disposes a session that opens after its load was replaced and never decodes it', async () => {
      const lateOpen =
        deferred<ReturnType<typeof createHeldSession>['session']>()
      const late = createHeldSession()
      const current = createHeldSession()
      rawRuntimeMock.openSession
        .mockReturnValueOnce(lateOpen.promise)
        .mockResolvedValueOnce(current.session)
      const { result } = renderWorkflowHost()

      let firstLoad!: Promise<void>
      await act(async () => {
        firstLoad = result.current.loadFile(new File(['raw'], 'first.ARW'))
        await waitFor(() =>
          expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1),
        )
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })
      expect(openSignalOf(0)?.aborted).toBe(true)

      await act(async () => {
        lateOpen.resolve(late.session)
        await firstLoad
      })

      expect(late.session.dispose).toHaveBeenCalledTimes(1)
      expect(late.session.decodeQuickRaw).not.toHaveBeenCalled()
      expect(current.session.dispose).not.toHaveBeenCalled()
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeNull()
      expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
        'second.ARW',
      )
    })

    it('fails an open without a session to dispose and loads the next file on the same host', async () => {
      const next = createHeldSession()
      rawRuntimeMock.openSession
        .mockRejectedValueOnce(new Error('open failed'))
        .mockResolvedValueOnce(next.session)
      const { result, host } = renderWorkflowHost()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'broken.ARW'))
      })
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('open failed')
      expect(openSignalOf(0)?.aborted).toBe(true)

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'next.ARW'))
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeNull()
      expect(host.beginSession).toHaveBeenCalledTimes(2)
      expect(openSignalOf(1)?.aborted).toBe(false)
      expect(rawRuntimeHosts).toHaveLength(1)
    })

    it('cancels an in-flight load on its host once when the workflow unmounts', async () => {
      const held = createHeldSession()
      rawRuntimeMock.openSession.mockResolvedValueOnce(held.session)
      const { result, host, unmount } = renderWorkflowHost()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      expect(held.session.dispose).not.toHaveBeenCalled()

      unmount()

      expect(host.cancelSession).toHaveBeenCalled()
      expect(
        vi.mocked(host.cancelSession).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(host.dispose).mock.invocationCallOrder[0]!)
      expect(openSignalOf(0)?.aborted).toBe(true)
      expect(held.session.dispose).toHaveBeenCalledTimes(1)

      await act(async () => {
        held.boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(held.session.dispose).toHaveBeenCalledTimes(1)
    })

    it('cancels an in-flight load on its host once when the session resets', async () => {
      const held = createHeldSession()
      rawRuntimeMock.openSession.mockResolvedValueOnce(held.session)
      const { result, host } = renderWorkflowHost()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      act(() => {
        result.current.reset()
      })

      expect(host.cancelSession).toHaveBeenCalled()
      expect(openSignalOf(0)?.aborted).toBe(true)
      expect(held.session.dispose).toHaveBeenCalledTimes(1)
      expect(jotaiStore.get(currentSessionAtom)).toBeNull()

      await act(async () => {
        held.boundedHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(held.session.dispose).toHaveBeenCalledTimes(1)
      expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    })

    it('routes a compare split written in a replacing loadFile tick into the replacement only', async () => {
      const first = createHeldSession()
      const second = createHeldSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session)
      const { result } = renderWorkflowHost()

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      act(() => {
        result.current.setCompareSplit(0.8)
      })
      const firstSessionId = jotaiStore.get(currentSessionAtom)?.id

      // Both callbacks come from the first source's render.
      const { loadFile, setCompareSplit } = result.current
      await act(async () => {
        const loadPromise = loadFile(new File(['raw'], 'second.ARW'))
        setCompareSplit(0.3)

        const replacement = jotaiStore.get(currentSessionAtom)
        expect(replacement?.id).not.toBe(firstSessionId)
        expect(replacement?.sourceFile.name).toBe('second.ARW')
        expect(replacement?.viewState.compareSplit).toBe(0.3)

        await loadPromise
      })

      expect(result.current.status).toBe('ready')
      expect(result.current.compareSplit).toBe(0.3)
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
      expect(second.session.dispose).not.toHaveBeenCalled()
    })
  })

  describe('preview restore on the workflow host', () => {
    const quickPin: RawRenderExposure = {
      ev: 0.6,
      multiplier: Math.pow(2, 0.6),
      source: 'image-statistics',
    }

    function createLoadSession(name: string) {
      return {
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue(
          createDecodedImage('quick', {
            renderExposure: quickPin,
            metadata: { make: name, model: 'A7', width: 800, height: 600 },
          }),
        ),
        decodeBoundedHqRaw: vi.fn().mockResolvedValue(
          createDecodedImage('bounded-hq', {
            renderExposure: {
              ev: 0.7,
              multiplier: Math.pow(2, 0.7),
              source: 'image-statistics',
            },
          }),
        ),
        probeExportCapability: rawRuntimeMock.probeExportCapability,
        dispose: vi.fn(),
      }
    }

    /** A restore session whose quick decode settles only when told to. */
    function createRestoreSession() {
      const quick = deferred<DecodedImage>()
      const session = {
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn(() => quick.promise),
        decodeBoundedHqRaw: vi.fn(),
        probeExportCapability: rawRuntimeMock.probeExportCapability,
        dispose: vi.fn(),
      }
      return { session, quick }
    }

    function openSignalOf(call: number) {
      return rawRuntimeMock.openSession.mock.calls[call]?.[1] as
        | AbortSignal
        | undefined
    }

    /** Loads `frame.ARW`, exports it, and leaves the preview released. */
    async function renderExported() {
      vi.stubGlobal('crossOriginIsolated', true)
      exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      rawRuntimeHosts.length = 0
      const rendered = renderHook(() => useRawWorkflow(), { wrapper })
      const [host] = rawRuntimeHosts
      await act(async () => {
        await rendered.result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await rendered.result.current.exportImage()
      })
      expect(rendered.result.current.previewSuspended).toBe(true)
      expect(rendered.result.current.decodedImageRef.current).toBeNull()
      return { ...rendered, host: host! }
    }

    /** Starts a restore and waits until its quick decode is in flight. */
    async function startRestore(
      result: { current: UseRawWorkflowReturn },
      restore: ReturnType<typeof createRestoreSession>,
    ) {
      let restoring!: Promise<void>
      act(() => {
        restoring = result.current.restorePreviewAfterExport()
      })
      await waitFor(() =>
        expect(restore.session.decodeQuickRaw).toHaveBeenCalled(),
      )
      // Wrapped so awaiting the start does not wait for the restore itself.
      return { restoring }
    }

    it('restores on a host lease that ends with the restore', async () => {
      const restore = createRestoreSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(createLoadSession('first'))
        .mockResolvedValueOnce(restore.session)
      const { result, host } = await renderExported()

      const { restoring } = await startRestore(result, restore)
      expect(host.beginSession).toHaveBeenCalledTimes(2)
      expect(host.openSession).not.toHaveBeenCalled()
      expect(restore.session.decodeQuickRaw).toHaveBeenCalledWith(
        expect.any(Function),
        openSignalOf(1),
        { pinnedExposure: quickPin },
      )

      await act(async () => {
        restore.quick.resolve(
          createDecodedImage('quick', { renderExposure: quickPin }),
        )
        await restoring
      })

      expect(result.current.previewSuspended).toBe(false)
      expect(result.current.decodedImageRef.current?.renderExposure).toEqual(
        quickPin,
      )
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )
      expect(openSignalOf(1)?.aborted).toBe(false)
      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
      expect(rawRuntimeHosts).toHaveLength(1)
    })

    it('cancels a restore on its host when a replacing load starts and publishes nothing over the replacement', async () => {
      const restore = createRestoreSession()
      // The replacement's bounded HQ stays in flight, so its lease is still
      // live when the old source's frame lands.
      const secondHq = deferred<DecodedImage>()
      const second = createLoadSession('second')
      second.decodeBoundedHqRaw.mockReturnValue(secondHq.promise)
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(createLoadSession('first'))
        .mockResolvedValueOnce(restore.session)
        .mockResolvedValueOnce(second)
      const { result, host } = await renderExported()

      const { restoring } = await startRestore(result, restore)
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })

      expect(openSignalOf(1)?.aborted).toBe(true)
      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
      expect(host.beginSession).toHaveBeenCalledTimes(3)
      const replacement = jotaiStore.get(currentSessionAtom)
      expect(replacement?.sourceFile.name).toBe('second.ARW')

      // The old source's frame lands after the replacement took the slot.
      await act(async () => {
        restore.quick.resolve(
          createDecodedImage('quick', {
            metadata: { make: 'stale', model: 'A7', width: 800, height: 600 },
          }),
        )
        await restoring
      })

      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
      expect(second.dispose).not.toHaveBeenCalled()
      expect(openSignalOf(2)?.aborted).toBe(false)
      expect(jotaiStore.get(currentSessionAtom)?.id).toBe(replacement?.id)
      expect(
        jotaiStore.get(currentSessionAtom)?.sourceFile.metadata?.make,
      ).toBe('second')
      expect(result.current.decodedImageRef.current?.metadata?.make).toBe(
        'second',
      )
      expect(result.current.status).toBe('ready')
      await flushScheduledToasts()
      expect(toastMock.error).not.toHaveBeenCalled()

      await act(async () => {
        secondHq.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
      expect(second.dispose).toHaveBeenCalledTimes(1)
      expect(result.current.displaySource).toBe('bounded-hq')
    })

    it('cancels a restore on its host when the session resets', async () => {
      const restore = createRestoreSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(createLoadSession('first'))
        .mockResolvedValueOnce(restore.session)
      const { result, host } = await renderExported()

      const { restoring } = await startRestore(result, restore)
      act(() => {
        result.current.reset()
      })

      expect(host.cancelSession).toHaveBeenCalled()
      expect(openSignalOf(1)?.aborted).toBe(true)
      expect(restore.session.dispose).toHaveBeenCalledTimes(1)

      await act(async () => {
        restore.quick.resolve(createDecodedImage('quick'))
        await restoring
      })

      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
      expect(jotaiStore.get(currentSessionAtom)).toBeNull()
      expect(result.current.decodedImageRef.current).toBeNull()
      await flushScheduledToasts()
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('cancels a restore on its host when the workflow unmounts', async () => {
      const restore = createRestoreSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(createLoadSession('first'))
        .mockResolvedValueOnce(restore.session)
      const { result, host, unmount } = await renderExported()

      const { restoring } = await startRestore(result, restore)
      unmount()

      expect(openSignalOf(1)?.aborted).toBe(true)
      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
      expect(host.dispose).toHaveBeenCalledTimes(1)

      restore.quick.resolve(createDecodedImage('quick'))
      await restoring
      expect(restore.session.dispose).toHaveBeenCalledTimes(1)
    })

    it('keeps the export after a failed restore and restores with the quick pin on the next try', async () => {
      const failed = createRestoreSession()
      const retried = createRestoreSession()
      rawRuntimeMock.openSession
        .mockResolvedValueOnce(createLoadSession('first'))
        .mockResolvedValueOnce(failed.session)
        .mockResolvedValueOnce(retried.session)
      const { result, host } = await renderExported()

      const { restoring: failing } = await startRestore(result, failed)
      await act(async () => {
        failed.quick.reject(new Error('restore decode failed'))
        await failing
      })
      await flushScheduledToasts()

      expect(toastMock.error).toHaveBeenCalledWith('Preview restore failed', {
        description: 'restore decode failed',
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.previewSuspended).toBe(true)
      expect(result.current.exportResult?.filename).toBe(
        'frame_neutral_fullres.jpg',
      )
      expect(failed.session.dispose).toHaveBeenCalledTimes(1)

      const { restoring: retrying } = await startRestore(result, retried)
      expect(retried.session.decodeQuickRaw).toHaveBeenCalledWith(
        expect.any(Function),
        openSignalOf(2),
        { pinnedExposure: quickPin },
      )
      await act(async () => {
        retried.quick.resolve(
          createDecodedImage('quick', { renderExposure: quickPin }),
        )
        await retrying
      })

      expect(host.beginSession).toHaveBeenCalledTimes(3)
      expect(result.current.previewSuspended).toBe(false)
      expect(result.current.decodedImageRef.current?.renderExposure).toEqual(
        quickPin,
      )
      expect(retried.session.dispose).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps no RAW session, abort controller or disposal set beside its host', () => {
    const { result } = renderHook(() =>
      useRawWorkflowRefs({ initialView: getDetachedPreviewView() }),
    )

    expect(result.current.rawRuntimeHost).toBeDefined()
    expect(
      Object.keys(result.current).filter((key) =>
        /runtimeSession|runtimeAbort|disposedRuntime/i.test(key),
      ),
    ).toEqual([])
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
                  run(
                    'probeExportCapability',
                    () =>
                      createSupportedCapability() as unknown as LumaRawExportCapability,
                  ),
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

  it('rejects unsupported files without replacing the active session or opening the runtime', async () => {
    const existingSession = createTestSession()
    jotaiStore.set(currentSessionAtom, existingSession)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.8)
      result.current.setParams({
        userExposureEv: 1,
        userContrast: 50,
      })
    })
    const previousParams = result.current.params
    const previousSession = jotaiStore.get(currentSessionAtom)

    await act(async () => {
      await result.current.loadFile(new File(['not raw'], 'notes.txt'))
    })

    expect(result.current.error).toBe('Unsupported file format: notes.txt')
    expect(result.current.status).toBe('idle')
    expect(result.current.loadedImage.file).toBeNull()
    expect(result.current.params).toEqual(previousParams)
    expect(result.current.viewMode).toBe('processed')
    expect(result.current.compareSplit).toBe(0.8)
    expect(jotaiStore.get(currentSessionAtom)).toBe(previousSession)
    expect(rawRuntimeMock.openSession).not.toHaveBeenCalled()
  })

  it('publishes no camera-calibration stage and never applies calibration on load', async () => {
    const applyCalibration = vi.fn()
    const dispose = vi.fn()
    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: rawRuntimeMock.extractEmbeddedPreview,
      decodeQuickRaw: rawRuntimeMock.decodeQuickRaw,
      decodeBoundedHqRaw: rawRuntimeMock.decodeBoundedHqRaw,
      probeExportCapability: rawRuntimeMock.probeExportCapability,
      applyCalibration,
      dispose,
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    expect(result.current).not.toHaveProperty('calibrationStage')

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(result.current.status).toBe('ready')
    expect(result.current).not.toHaveProperty('calibrationStage')
    expect(applyCalibration).not.toHaveBeenCalled()
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
    // The workflow publishes only that the loaded source was interrupted:
    // no attempt id, sentence or legacy recovery state.
    expect(exportRecoveryKeys(result.current)).toEqual([])
    // The session keeps no second copy of the hint.
    expect(jotaiStore.get(currentSessionAtom)?.exportState).not.toHaveProperty(
      'recovery',
    )
  })

  it('shows no hint for a loaded source other than the interrupted one', async () => {
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(
        new File(['raw'], 'other.ARW', { lastModified: 123 }),
      )
    })
    await waitFor(() => {
      expect(pageMarkers().inspect).toHaveBeenCalled()
    })
    await flushPostCommitTasks()

    expect(result.current.exportInterrupted).toBe(false)
    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('offers no recovery command or continuation for an interrupted source', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await flushPostCommitTasks()

    // Export starts only through exportImage; nothing reselects, reloads or
    // arms a retry for the interrupted file.
    expect(exportRecoveryKeys(result.current)).toEqual([])
    expect(rawRuntimeMock.openSession).not.toHaveBeenCalled()
    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('never exports on its own after a look change or a cancelled explicit export', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )
    exportSystemMock.runFullResolutionExportJob.mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError'),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(
        new File(['raw'], 'frame.ARW', { lastModified: 123 }),
      )
    })
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(true)
    })

    act(() => {
      result.current.setParams({ userExposureEv: 0.5 })
    })
    await flushPostCommitTasks()
    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.exportImage()
    })
    await flushPostCommitTasks()
    act(() => {
      result.current.setParams({ userContrast: 10 })
    })
    await flushPostCommitTasks()

    // The cancelled attempt is the only one: its end, the readiness that
    // follows and the next look change start nothing.
    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
  })

  it('never exports when an interrupted source loads and becomes ready', async () => {
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(
        new File(['raw'], 'frame.ARW', { lastModified: 123 }),
      )
    })
    await waitFor(() => {
      expect(result.current.canExport).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(true)
    })
    await flushPostCommitTasks()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    // The hint survives the load so the next explicit export can use it.
    expect(result.current.exportInterrupted).toBe(true)
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

  it("does not hand an interrupted source's safer plan to another file", async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    await seedCrashedExport(
      new File(['raw'], 'frame.ARW', { lastModified: 123 }),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'other_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(
        new File(['raw'], 'other.ARW', { lastModified: 123 }),
      )
    })
    await waitFor(() => {
      expect(pageMarkers().inspect).toHaveBeenCalled()
    })
    await flushPostCommitTasks()
    await act(async () => {
      await result.current.exportImage()
    })

    const [request] = exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    expect(request.executionPlan).toMatchObject({
      productCopy: 'safe-export',
      request: { source: { width: 6048, height: 4024 } },
    })
    // The interrupted file's hint waits for that file.
    expect(storedMarkers()).toEqual([
      expect.objectContaining({ attempt: 'closed-page-attempt-1' }),
    ])
  })

  it('exposes pending LUT profile selection and applies a user-selected profile', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    await waitFor(() => {
      expect(result.current.lut?.profileResolution).toEqual({
        kind: 'unknown',
      })
    })
    const unknownSelection = {
      status: 'unknown',
      fingerprint: result.current.lut?.fingerprint,
      title: 'Client Secret Sauce',
      sourceName: 'unknown-look.cube',
    }
    expect(result.current.lutProfileSelection).toEqual(unknownSelection)
    expect(jotaiStore.get(currentSessionAtom)?.lutProfileSelection).toEqual(
      unknownSelection,
    )

    const selectedContract = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }

    act(() => {
      result.current.selectLUTProfile(selectedContract)
    })

    await waitFor(() => {
      expect(result.current.lut?.profileResolution).toMatchObject({
        kind: 'confirmed',
        confidence: 'user',
        profile: {
          id: 'sony-sgamut3cine-slog3',
          role: 'combined-look-output',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'bt709',
          outputRange: 'full',
        },
      })
    })
    await waitFor(() => {
      expect(result.current.lutData?.profileResolution).toMatchObject({
        kind: 'confirmed',
        profile: { id: 'sony-sgamut3cine-slog3' },
      })
    })
    expect(
      getStoredLUTContractSelection(result.current.lut!.fingerprint),
    ).toEqual(
      expect.objectContaining({
        inputProfile: 'sony-sgamut3cine-slog3',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      }),
    )
    expect(
      getStoredLUTProfileSelection(result.current.lut!.fingerprint),
    ).toMatchObject({
      id: 'sony-sgamut3cine-slog3',
      role: 'combined-look-output',
      outputTransfer: 'bt709',
    })
    expect(result.current.lutProfileSelection).toMatchObject({
      status: 'confirmed',
      fingerprint: result.current.lut?.fingerprint,
      profileId: 'sony-sgamut3cine-slog3',
      confidence: 'user',
    })
    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      activeStyle: {
        kind: 'custom',
        lutAsset: {
          profileResolution: {
            kind: 'confirmed',
            profile: { id: 'sony-sgamut3cine-slog3' },
          },
        },
      },
      lutProfileSelection: {
        status: 'confirmed',
        fingerprint: result.current.lut?.fingerprint,
        profileId: 'sony-sgamut3cine-slog3',
        confidence: 'user',
      },
    })
  })

  it('keeps a detached LUT loaded before RAW upload and preserves it across RAW replacement', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    const detachedFingerprint = result.current.lut?.fingerprint

    expect(result.current.currentLutName).toBe('Client Secret Sauce')
    expect(result.current.lutProfileSelection).toMatchObject({
      status: 'unknown',
      fingerprint: detachedFingerprint,
      title: 'Client Secret Sauce',
    })
    expect(result.current.params.styleKind).toBe('custom')
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()

    await act(async () => {
      await result.current.loadFile(new File(['raw-one'], 'frame-1.ARW'))
    })

    await waitFor(() => {
      expect(result.current.currentLutName).toBe('Client Secret Sauce')
    })
    expect(result.current.lut?.fingerprint).toBe(detachedFingerprint)
    // LUT-before-RAW must still reach a previewable state: the retained look
    // can never block the preview from becoming visible.
    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })
    expect(result.current.hasImage).toBe(true)
    expect(result.current.displaySource).not.toBe('none')
    expect(result.current.params.styleKind).toBe('custom')
    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      activeStyle: {
        kind: 'custom',
        name: 'Client Secret Sauce',
      },
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: detachedFingerprint,
        title: 'Client Secret Sauce',
      },
    })

    await act(async () => {
      await result.current.loadFile(new File(['raw-two'], 'frame-2.ARW'))
    })

    await waitFor(() => {
      expect(result.current.currentLutName).toBe('Client Secret Sauce')
    })
    expect(result.current.lut?.fingerprint).toBe(detachedFingerprint)
    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      sourceFile: {
        name: 'frame-2.ARW',
      },
      activeStyle: {
        kind: 'custom',
        name: 'Client Secret Sauce',
      },
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: detachedFingerprint,
        title: 'Client Secret Sauce',
      },
    })
  })

  it('applies only the newest of two overlapping local LUT loads', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const slowLook = createDeferredCubeFile('Slow Look', 'slow-look.cube')
    let slowLoad!: Promise<LutLoadOutcome>
    act(() => {
      slowLoad = result.current.loadLUT(slowLook.file)
    })

    await act(async () => {
      await expect(
        result.current.loadLUT(createCubeFile('Quick Look', 'quick-look.cube')),
      ).resolves.toBe('loaded')
    })
    expect(result.current.currentLutName).toBe('Quick Look')

    let outcome: LutLoadOutcome | undefined
    await act(async () => {
      slowLook.finishRead()
      outcome = await slowLoad
    })

    expect(outcome).toBe('aborted')
    expect(result.current.currentLutName).toBe('Quick Look')
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
      expect(result.current.activeIntensity).toBe(0.41)
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

    it('drops a LUT that finishes after its source was replaced and leaves the replacement look alone', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadLUT(createCubeFile('Kept Look', 'kept.cube'))
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })
      const late = createDeferredCubeFile('Late Look', 'late-look.cube')
      let lutLoad!: Promise<LutLoadOutcome>
      act(() => {
        lutLoad = result.current.loadLUT(late.file)
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'second.ARW'))
      })
      const replacement = jotaiStore.get(currentSessionAtom)

      let outcome: LutLoadOutcome | undefined
      await act(async () => {
        late.finishRead()
        outcome = await lutLoad
      })

      expect(outcome).toBe('aborted')
      expect(result.current.currentLutName).toBe('Kept Look')
      expect(jotaiStore.get(currentSessionAtom)?.id).toBe(replacement?.id)
      expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toMatchObject({
        name: 'Kept Look',
      })
    })

    it('seeds the source that arrives with a LUT picked before any RAW', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      const early = createDeferredCubeFile('Early Look', 'early-look.cube')
      let lutLoad!: Promise<LutLoadOutcome>
      act(() => {
        lutLoad = result.current.loadLUT(early.file)
      })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'first.ARW'))
      })

      let outcome: LutLoadOutcome | undefined
      await act(async () => {
        early.finishRead()
        outcome = await lutLoad
      })

      expect(outcome).toBe('loaded')
      expect(result.current.currentLutName).toBe('Early Look')
      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        sourceFile: { name: 'first.ARW' },
        activeStyle: { kind: 'custom', name: 'Early Look' },
      })
    })
  })

  it('preserves a detached intensity choice across the first RAW load', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    act(() => {
      result.current.setIntensity(0.62)
    })

    expect(result.current.activeIntensity).toBe(0.62)
    expect(result.current.params.intensity).toBe(0.62)

    await act(async () => {
      await result.current.loadFile(new File(['raw-one'], 'frame-1.ARW'))
    })

    await waitFor(() => {
      expect(result.current.currentLutName).toBe('Client Secret Sauce')
    })
    expect(result.current.activeIntensity).toBe(0.62)
    expect(result.current.params.intensity).toBe(0.62)
    expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toMatchObject({
      kind: 'custom',
      currentIntensity: 0.62,
    })
  })

  it('carries a detached strength set in the first loadFile tick into the session', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(result.current.params.intensity).not.toBe(0.37)

    // Both commands come from the render before any RAW: the strength lands
    // in the stored intent and the load reads it before any rerender.
    const { setIntensity, loadFile } = result.current
    await act(async () => {
      setIntensity(0.37)
      await loadFile(new File(['raw-one'], 'frame-1.ARW'))
    })

    expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toMatchObject({
      kind: 'custom',
      name: 'Client Secret Sauce',
      currentIntensity: 0.37,
    })
    expect(result.current.activeIntensity).toBe(0.37)
    expect(result.current.params.intensity).toBe(0.37)
  })

  it('rejects raw registry scene-creative LUT profile selections without output metadata', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    await waitFor(() => {
      expect(result.current.lutProfileSelection?.status).toBe('unknown')
    })

    const fingerprint = result.current.lut!.fingerprint

    act(() => {
      result.current.selectLUTProfile(
        getLUTColorProfile('sony-sgamut3cine-slog3')!,
      )
    })

    expect(result.current.lut?.profileResolution).toEqual({
      kind: 'unknown',
    })
    expect(result.current.lutProfileSelection?.status).toBe('unknown')
    expect(getStoredLUTContractSelection(fingerprint)).toBeUndefined()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(toastMock.error).toHaveBeenCalledWith('Incomplete LUT contract', {
      description: 'sony-sgamut3cine-slog3',
    })
  })

  it('accepts explicit same-space output contract selections', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    await waitFor(() => {
      expect(result.current.lutProfileSelection?.status).toBe('unknown')
    })

    const selectedContract = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output' as const,
      outputGamut: 'v-gamut' as const,
      outputTransfer: 'v-log' as const,
      outputRange: 'full' as const,
    }

    act(() => {
      result.current.selectLUTProfile(selectedContract)
    })

    await waitFor(() => {
      expect(result.current.lut?.profileResolution).toMatchObject({
        kind: 'confirmed',
        confidence: 'user',
        profile: {
          id: 'panasonic-vgamut-vlog',
          role: 'combined-look-output',
          outputGamut: 'v-gamut',
          outputTransfer: 'v-log',
          outputRange: 'full',
        },
      })
    })
    expect(
      getStoredLUTContractSelection(result.current.lut!.fingerprint),
    ).toEqual(
      expect.objectContaining({
        inputProfile: 'panasonic-vgamut-vlog',
        role: 'combined-look-output',
        outputGamut: 'v-gamut',
        outputTransfer: 'v-log',
        outputRange: 'full',
      }),
    )
  })

  it('persists a searchable V-Log to Rec.709 display contract', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    await waitFor(() => {
      expect(result.current.lutProfileSelection?.status).toBe('unknown')
    })

    const selectedContract = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      label: 'Panasonic V-Gamut / V-Log -> Rec.709 display',
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }

    act(() => {
      result.current.selectLUTProfile(selectedContract)
    })

    await waitFor(() => {
      expect(result.current.lut?.profileResolution).toMatchObject({
        kind: 'confirmed',
        profile: {
          id: 'panasonic-vgamut-vlog',
          role: 'combined-look-output',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'bt709',
          outputRange: 'full',
        },
      })
    })
    expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toMatchObject({
      kind: 'custom',
      warning: 'This LUT uses Panasonic V-Gamut / V-Log -> Rec.709 display.',
    })
    expect(
      getStoredLUTContractSelection(result.current.lut!.fingerprint),
    ).toEqual(
      expect.objectContaining({
        inputProfile: 'panasonic-vgamut-vlog',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      }),
    )
  })

  it('defers LUT success toasts until after the state commit finishes', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Client Secret Sauce', 'unknown-look.cube'),
      )
    })

    expect(toastMock.success).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(toastMock.success).toHaveBeenCalledWith(
      'Loaded LUT: Client Secret Sauce',
      {
        description: '17³ grid',
      },
    )
  })

  it('loads direct online CUBE entries through the manual-style unresolved profile path', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    onlineProfileFetchMock.fetchCachedBytesWithLimit.mockResolvedValue(
      encodeCube('Direct Online LUT'),
    )
    const signal = new AbortController().signal
    const entry = createOnlineLUTEntry({
      title: 'Direct Online LUT',
      sourceType: 'direct-cube',
      cube: {
        url: 'https://example.com/direct/online-look.cube',
        sha256: '',
      },
      trustedContract: {
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
      },
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadOnlineLUT(entry, { signal })
    })

    expect(fetchCachedBytesWithLimit).toHaveBeenCalledWith(
      'https://example.com/direct/online-look.cube',
      expect.objectContaining({
        signal,
        maxBytes: 64 * 1024 * 1024,
      }),
    )
    expect(fetchVerifiedCubeAsset).not.toHaveBeenCalled()
    expect(result.current.lut).toMatchObject({
      title: 'Direct Online LUT',
      sourceName: 'Direct Online LUT',
      profileResolution: {
        kind: 'unknown',
      },
    })
    expect(result.current.lutProfileSelection).toMatchObject({
      status: 'unknown',
      title: 'Direct Online LUT',
      sourceName: 'Direct Online LUT',
    })
  })

  it('loads verified registry CUBE entries and applies trusted contracts', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockResolvedValue(
      verifiedCube('Registry Online LUT'),
    )
    const entry = createOnlineLUTEntry({
      title: 'Registry Online LUT',
      trustedContract: {
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
      },
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadOnlineLUT(entry)
    })

    expect(fetchVerifiedCubeAsset).toHaveBeenCalledWith(
      entry.cube,
      expect.objectContaining({
        maxBytes: 64 * 1024 * 1024,
      }),
    )
    expect(fetchCachedBytesWithLimit).not.toHaveBeenCalled()
    // The applied style carries the hash the catalog bytes were verified
    // against, which is what every surface matches tiles by.
    expect(
      jotaiStore.get(currentSessionAtom)?.activeStyle?.lutAsset?.sha256,
    ).toBe(entry.cube.sha256)
    expect(result.current.lut?.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: 'display-srgb',
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
      },
    })
    expect(result.current.lutData?.profileResolution).toMatchObject({
      kind: 'confirmed',
      profile: { id: 'display-srgb' },
    })
    expect(result.current.lutProfileSelection).toMatchObject({
      status: 'confirmed',
      profileId: 'display-srgb',
      confidence: 'metadata',
    })
    expect(
      getStoredLUTContractSelection(result.current.lut!.fingerprint),
    ).toBeUndefined()
  })

  it('rejects unsupported trusted contracts and leaves the active LUT unchanged', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Previous LUT', 'previous.cube'),
      )
    })

    const previousLut = result.current.lut
    const previousStyle = jotaiStore.get(currentSessionAtom)?.activeStyle
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockResolvedValue(
      verifiedCube('Rejected Online LUT'),
    )

    await act(async () => {
      await result.current.loadOnlineLUT(
        createOnlineLUTEntry({
          title: 'Rejected Online LUT',
          trustedContract: {
            role: 'display-look',
            inputGamut: 'arri-wide-gamut-3',
            inputTransfer: 'logc3',
            inputRange: 'full',
          },
        }),
      )
    })
    await flushScheduledToasts()

    expect(result.current.lut).toBe(previousLut)
    expect(jotaiStore.get(currentSessionAtom)?.activeStyle).toBe(previousStyle)
    expect(jotaiStore.get(currentSessionAtom)?.renderState).toMatchObject({
      lastErrorCode: 'LUT_PARSE_FAILED',
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to load LUT', {
      description: 'Unsupported LUT color contract.',
    })
  })

  it('rejects online fetch errors and leaves the current RAW session and LUT intact', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Previous LUT', 'previous.cube'),
      )
    })

    const previousLut = result.current.lut
    const previousSession = jotaiStore.get(currentSessionAtom)
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockRejectedValue(
      new Error('Hash mismatch'),
    )

    await act(async () => {
      await result.current.loadOnlineLUT(createOnlineLUTEntry())
    })
    await flushScheduledToasts()

    const nextSession = jotaiStore.get(currentSessionAtom)
    expect(result.current.lut).toBe(previousLut)
    expect(nextSession).toMatchObject({
      id: previousSession?.id,
      sourceFile: previousSession?.sourceFile,
      activeStyle: previousSession?.activeStyle,
      lutProfileSelection: previousSession?.lutProfileSelection,
      renderState: expect.objectContaining({
        lastErrorCode: 'LUT_PARSE_FAILED',
      }),
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to load LUT', {
      description: 'Hash mismatch',
    })
  })

  it('ignores aborted verified online LUT fetches without changing error state or active LUT', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Previous LUT', 'previous.cube'),
      )
    })

    const previousLut = result.current.lut
    const previousLastErrorCode =
      jotaiStore.get(currentSessionAtom)?.renderState.lastErrorCode
    const controller = new AbortController()
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    )

    await act(async () => {
      await result.current.loadOnlineLUT(createOnlineLUTEntry(), {
        signal: controller.signal,
      })
    })
    await flushScheduledToasts()

    expect(result.current.lut).toBe(previousLut)
    expect(jotaiStore.get(currentSessionAtom)?.renderState.lastErrorCode).toBe(
      previousLastErrorCode,
    )
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Failed to load LUT',
      expect.anything(),
    )
  })

  it('does not apply an online LUT when the signal is aborted after fetch resolves', async () => {
    jotaiStore.set(currentSessionAtom, createTestSession())
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadLUT(
        createCubeFile('Previous LUT', 'previous.cube'),
      )
    })

    const previousLut = result.current.lut
    const previousLastErrorCode =
      jotaiStore.get(currentSessionAtom)?.renderState.lastErrorCode
    const controller = new AbortController()
    onlineProfileFetchMock.fetchVerifiedCubeAsset.mockImplementation(
      async () => {
        controller.abort()
        return verifiedCube('Late Aborted Online LUT')
      },
    )

    await act(async () => {
      await result.current.loadOnlineLUT(createOnlineLUTEntry(), {
        signal: controller.signal,
      })
    })
    await flushScheduledToasts()

    expect(result.current.lut).toBe(previousLut)
    expect(jotaiStore.get(currentSessionAtom)?.renderState.lastErrorCode).toBe(
      previousLastErrorCode,
    )
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Failed to load LUT',
      expect.anything(),
    )
  })

  it('stores embedded object URLs, upgrades display source, and revokes on reset', async () => {
    const embeddedPreview = deferred<{
      width: number
      height: number
      data: Uint8Array
      mimeType: string
      timings: Record<string, number | undefined>
    } | null>()
    const quickDecode = deferred<DecodedImage>()
    const boundedHqDecode = deferred<DecodedImage>()

    rawRuntimeMock.extractEmbeddedPreview.mockReturnValue(
      embeddedPreview.promise,
    )
    rawRuntimeMock.decodeQuickRaw.mockReturnValue(quickDecode.promise)
    rawRuntimeMock.decodeBoundedHqRaw.mockReturnValue(boundedHqDecode.promise)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = result.current.loadFile(new File(['raw'], 'frame.ARW'))
      await Promise.resolve()
    })

    await act(async () => {
      embeddedPreview.resolve({
        width: 1600,
        height: 1067,
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/jpeg',
        timings: { total: 8 },
      })
      await flushPromises()
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('embedded')
    })
    expect(result.current.embeddedPreviewUrl).toBe('blob:embedded-preview')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

    await act(async () => {
      quickDecode.resolve(createDecodedImage('quick'))
      await flushPromises()
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('quick')
    })
    expect(result.current.embeddedPreviewUrl).toBe('blob:embedded-preview')

    await act(async () => {
      boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await loadPromise
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('bounded-hq')
    })

    act(() => {
      result.current.reset()
    })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:embedded-preview')
    expect(result.current.embeddedPreviewUrl).toBeNull()
    expect(result.current.displaySource).toBe('none')
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

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      const loadPromise = result.current.loadFile(
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
    expect(result.current.histogram.diagnostics.ownership).toBe(
      'main-thread-chunked-no-copy',
    )
  })

  it('keeps histogram independent from compare split changes', async () => {
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
        data: new Uint16Array([0, 0, 0, 65535, 65535, 65535]),
      }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      const loadPromise = result.current.loadFile(
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
    const histogram = result.current.histogram

    act(() => {
      result.current.setCompareSplit(0.8)
    })

    expect(result.current.histogram).toBe(histogram)
  })

  it('opens one runtime session for a load and disposes it after preview completion', async () => {
    setCapabilityVectorForTest({
      coi: true,
      pthread: true,
      deviceMemoryGB: 4,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: true,
    })
    const file = new File(['raw'], 'frame.ARW')
    const extractEmbeddedPreview = vi.fn().mockResolvedValue(null)
    const quick = createDecodedImage('quick')
    const decodeQuickRaw = vi.fn().mockResolvedValue(quick)
    const decodeBoundedHqRaw = vi
      .fn()
      .mockResolvedValue(createDecodedImage('bounded-hq'))
    const dispose = vi.fn()

    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview,
      decodeQuickRaw,
      decodeBoundedHqRaw,
      dispose,
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(file)
    })

    const openSignal = rawRuntimeMock.openSession.mock.calls[0]?.[1]
    expect(rawRuntimeMock.openSession).toHaveBeenCalledTimes(1)
    expect(rawRuntimeMock.openSession).toHaveBeenCalledWith(file, openSignal)
    expect(openSignal).toBeInstanceOf(AbortSignal)
    expect(openSignal.aborted).toBe(false)
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(openSignal)
    expect(decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      openSignal,
    )
    expect(decodeBoundedHqRaw).toHaveBeenCalledWith(
      {
        maxOutputPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
        pinnedExposure: quick.renderExposure,
      },
      undefined,
      openSignal,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(rawRuntimeMock.extractEmbeddedPreview).not.toHaveBeenCalled()
    expect(rawRuntimeMock.decodeQuickRaw).not.toHaveBeenCalled()
    expect(rawRuntimeMock.decodeBoundedHqRaw).not.toHaveBeenCalled()
  })

  it('preserves compare split in the new session when loading a file', async () => {
    const file = new File(['raw'], 'frame.ARW')

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setCompareSplit(0.8)
    })

    await act(async () => {
      await result.current.loadFile(file)
    })

    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.8)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.8,
    })
  })

  it('routes a compare split written in the loadFile tick into the new session only', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setCompareSplit(0.8)
    })
    expect(getDetachedPreviewView().compareSplit).toBe(0.8)
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()

    // Both callbacks come from the pre-load render: the split is written
    // before React re-renders with the session that loadFile just created.
    const { loadFile, setCompareSplit } = result.current
    let loadPromise!: Promise<void>
    await act(async () => {
      loadPromise = loadFile(new File(['raw'], 'frame.ARW'))
      setCompareSplit(0.3)

      expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
        'frame.ARW',
      )
      expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
        mode: 'compare',
        compareSplit: 0.3,
      })
      expect(getDetachedPreviewView()).toEqual({
        mode: 'compare',
        compareSplit: 0.8,
      })

      await loadPromise
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.3)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.3,
    })
    expect(getDetachedPreviewView()).toEqual({
      mode: 'compare',
      compareSplit: 0.8,
    })
  })

  it('routes a view mode written in the loadFile tick into the new session only', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    // Both callbacks come from the pre-load render: the mode is written
    // before React re-renders with the session that loadFile just created.
    const { loadFile, setViewMode } = result.current
    let loadPromise!: Promise<void>
    await act(async () => {
      loadPromise = loadFile(new File(['raw'], 'frame.ARW'))
      setViewMode('original')

      expect(jotaiStore.get(currentSessionAtom)?.viewState.mode).toBe(
        'original',
      )
      expect(getDetachedPreviewView().mode).toBe('compare')

      await loadPromise
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.viewMode).toBe('original')
    expect(result.current.params).not.toHaveProperty('viewMode')
    expect(jotaiStore.get(currentSessionAtom)?.viewState.mode).toBe('original')
    expect(getDetachedPreviewView().mode).toBe('compare')
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

  it('keeps sample view writes made before any source out of the color intent', () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const storedIntentBefore = getProcessingParams()

    act(() => {
      result.current.setViewMode('original')
      result.current.setCompareSplit(0.25)
    })

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(result.current.viewMode).toBe('original')
    expect(result.current.compareSplit).toBe(0.25)
    expect(result.current.params).not.toHaveProperty('viewMode')
    expect(result.current.params).not.toHaveProperty('compareSplit')
    expect(getDetachedPreviewView()).toEqual({
      mode: 'original',
      compareSplit: 0.25,
    })
    expect(getProcessingParams()).toBe(storedIntentBefore)
  })

  it('publishes the color intent alone, with the view beside it', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const colorKeys = [...COLOR_GRAPH_INTENT_KEYS].sort()

    act(() => {
      result.current.setViewMode('original')
      result.current.setCompareSplit(0.25)
    })
    expect(Object.keys(result.current.params).sort()).toEqual(colorKeys)
    expect(result.current.viewMode).toBe('original')
    expect(result.current.compareSplit).toBe(0.25)

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.62)
    })
    expect(Object.keys(result.current.params).sort()).toEqual(colorKeys)
    expect(result.current.viewMode).toBe('processed')
    expect(result.current.compareSplit).toBe(0.62)
  })

  it('keeps the published color intent across view-only changes', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    act(() => {
      result.current.setIntensity(0.37)
    })
    const sampleParams = result.current.params

    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.2)
    })
    expect(result.current.params).toBe(sampleParams)

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const sessionParams = result.current.params
    act(() => {
      result.current.setViewMode('original')
      result.current.setCompareSplit(0.8)
    })
    expect(result.current.params).toBe(sessionParams)
  })

  it('writes color only through setParams, never the view', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.3)
    })

    // A legacy caller handing view fields over still reaches color alone.
    act(() => {
      result.current.setParams({
        viewMode: 'original',
        compareSplit: 0.9,
        userContrast: 22,
      } as Parameters<typeof result.current.setParams>[0])
    })

    expect(result.current.params.userContrast).toBe(22)
    expect(result.current.params).not.toHaveProperty('viewMode')
    expect(result.current.viewMode).toBe('processed')
    expect(result.current.compareSplit).toBe(0.3)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'processed',
      compareSplit: 0.3,
    })
  })

  it('keeps a continuous look strength independent of sample view writes', () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setIntensity(0.37)
    })
    const storedIntentAfterStrength = getProcessingParams()
    expect(storedIntentAfterStrength.intensity).toBe(0.37)

    act(() => {
      result.current.setCompareSplit(0.2)
      result.current.setViewMode('processed')
    })

    expect(getProcessingParams()).toBe(storedIntentAfterStrength)
    expect(result.current.params.intensity).toBe(0.37)
    expect(result.current.viewMode).toBe('processed')
    expect(result.current.compareSplit).toBe(0.2)

    act(() => {
      result.current.setIntensity(0.81)
    })

    expect(result.current.params.intensity).toBe(0.81)
    expect(result.current.viewMode).toBe('processed')
    expect(result.current.compareSplit).toBe(0.2)
  })

  it('carries the replaced session split into the next source and reopens in compare', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    act(() => {
      result.current.setViewMode('original')
      result.current.setCompareSplit(0.62)
    })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'second.ARW'))
    })

    expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
      'second.ARW',
    )
    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.62)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.62,
    })
    expect(getProcessingParams()).not.toHaveProperty('viewMode')
    expect(getProcessingParams()).not.toHaveProperty('compareSplit')
  })

  it('returns to the detached sample view when reset drops the session', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    act(() => {
      result.current.setCompareSplit(0.8)
    })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.4)
    })
    expect(result.current.compareSplit).toBe(0.4)

    act(() => {
      result.current.reset()
    })

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.8)
    expect(getDetachedPreviewView()).toEqual({
      mode: 'compare',
      compareSplit: 0.8,
    })
    expect(getProcessingParams()).not.toHaveProperty('compareSplit')
  })

  it('publishes a view mode change from the session view, outside the color params', () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const storedParamsBefore = getProcessingParams()

    act(() => {
      result.current.setViewMode('original')
    })

    expect(result.current.viewMode).toBe('original')
    expect(result.current.params).not.toHaveProperty('viewMode')
    expect(getProcessingParams()).toBe(storedParamsBefore)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'original',
      compareSplit: 0.5,
    })
  })

  it('publishes a committed compare split from the session view, outside the color params', () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const storedParamsBefore = getProcessingParams()

    act(() => {
      result.current.setCompareSplit(2)
    })

    expect(result.current.compareSplit).toBe(1)
    expect(result.current.params).not.toHaveProperty('compareSplit')
    expect(getProcessingParams()).toBe(storedParamsBefore)
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'processed',
      compareSplit: 1,
    })
  })

  it('keeps active style intensity session canonical while projecting numeric params', () => {
    jotaiStore.set(currentSessionAtom, {
      ...createTestSession(),
      activeStyle: {
        kind: 'builtin',
        name: 'Warm',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
      },
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const storedParamsBefore = getProcessingParams()

    act(() => {
      result.current.setIntensity(0.62)
    })

    expect(result.current.activeIntensity).toBe(0.62)
    expect(result.current.params.intensity).toBe(0.62)
    expect(getProcessingParams()).toBe(storedParamsBefore)
    expect(
      jotaiStore.get(currentSessionAtom)?.activeStyle?.currentIntensity,
    ).toBe(0.62)
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

  it('keeps preview viewport session-only without touching processing params or export state', () => {
    const session = createTestSession()
    jotaiStore.set(currentSessionAtom, session)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const paramsBefore = result.current.params

    act(() => {
      result.current.setPreviewViewport({
        zoom: 2,
        panX: 40,
        panY: -20,
        fitMode: 'custom',
      })
    })

    expect(result.current.previewViewport).toEqual({
      zoom: 2,
      panX: 40,
      panY: -20,
      fitMode: 'custom',
    })
    expect(result.current.params).toBe(paramsBefore)
    expect(result.current.compareSplit).toBe(0.5)
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toBe(
      session.exportState,
    )
  })

  it('enters ready state after quick preview before bounded HQ resolves', async () => {
    const boundedHq = deferred<DecodedImage>()
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockReturnValue(boundedHq.promise)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'sample.RAF'))
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.displaySource).toBe('quick')
  })

  it('keeps quick preview and no global error when bounded HQ fails', async () => {
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockRejectedValue(
      Object.assign(new Error('bounded failed'), {
        code: 'RAW_HQ_DECODE_FAILED',
      }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'sample.RAF'))
    })
    await waitFor(() => {
      expect(result.current.displaySource).toBe('quick')
    })

    const session = jotaiStore.get(currentSessionAtom)
    expect(result.current.error).toBeNull()
    expect(result.current.status).toBe('ready')
    expect(session?.renderState).toMatchObject({ status: 'ready' })
    expect(session?.renderState.lastErrorCode).toBeUndefined()
  })

  it('keeps full-resolution export enabled when processed-window capability is supported but bounded HQ preview fails', async () => {
    const file = createFileWithSize('large.ARW', 33 * 1024 * 1024)
    const decodeQuickRaw = vi
      .fn()
      .mockResolvedValue(createDecodedImage('quick'))
    const decodeBoundedHqRaw = vi.fn().mockRejectedValue(
      Object.assign(new Error('bounded unavailable'), {
        code: 'RAW_HQ_DECODE_FAILED',
      }),
    )

    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw,
      decodeBoundedHqRaw,
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: vi.fn(),
    })
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'large_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    stubDownloadLink()

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(file)
    })

    const session = jotaiStore.get(currentSessionAtom)
    expect(decodeQuickRaw).toHaveBeenCalled()
    expect(decodeBoundedHqRaw).toHaveBeenCalled()
    expect(result.current.displaySource).toBe('quick')
    expect(result.current.canExport).toBe(true)
    expect(session?.previewBundle.boundedHqPreview).toEqual({
      status: 'failed',
      errorCode: 'RAW_HQ_DECODE_FAILED',
    })
    expect(session?.exportState.fullResCapability).toEqual({
      status: 'supported',
      width: 6048,
      height: 4024,
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledWith(
      expect.objectContaining({ file }),
    )
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

  it('keeps full-resolution export disabled when processed-window capability is supported but quick preview fails', async () => {
    const file = createFileWithSize('large.ARW', 33 * 1024 * 1024)
    const decodeQuickRaw = vi.fn().mockRejectedValue(
      Object.assign(new Error('quick unavailable'), {
        code: 'RAW_QUICK_DECODE_FAILED',
      }),
    )
    const decodeBoundedHqRaw = vi.fn()
    const probeExportCapability = vi
      .fn()
      .mockResolvedValue(createSupportedCapability())

    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue({
        width: 1600,
        height: 1067,
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/jpeg',
      }),
      decodeQuickRaw,
      decodeBoundedHqRaw,
      probeExportCapability,
      dispose: vi.fn(),
    })
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'large_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    stubDownloadLink()

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(file)
    })

    const session = jotaiStore.get(currentSessionAtom)
    expect(decodeQuickRaw).toHaveBeenCalled()
    expect(decodeBoundedHqRaw).not.toHaveBeenCalled()
    expect(result.current.displaySource).toBe('embedded')
    expect(result.current.status).toBe('error')
    expect(result.current.canExport).toBe(false)
    expect(result.current.exportRefusal).toEqual({
      code: 'quick-preview-pending',
    })
    expect(session?.previewBundle.quickDecodePreview).toEqual({
      status: 'failed',
      errorCode: 'RAW_QUICK_DECODE_FAILED',
    })
    expect(session?.previewBundle.boundedHqPreview).toEqual({
      status: 'failed',
      errorCode: 'RAW_QUICK_DECODE_FAILED',
    })
    expect(session?.exportState.fullResCapability).toEqual({
      status: 'unsupported',
      reason: 'Quick preview did not complete.',
    })
    expect(probeExportCapability).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      { description: 'Quick preview is still being prepared.' },
    )
    expect(toastMock.error).toHaveBeenCalledWith('Preview unavailable', {
      description:
        'Full-resolution export needs a decoded RAW preview exposure before it can run.',
    })
  })

  it('keeps full-resolution export disabled until the source file is actually loaded', () => {
    jotaiStore.set(currentSessionAtom, createTestSession())

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    expect(result.current.canExport).toBe(false)
  })

  it('carries a committed geometry into full-resolution export and refuses only the HQ preview', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    expect(result.current.canExport).toBe(true)
    const { exportImage, exportPreviewImage, transform } = result.current

    await act(async () => {
      acceptTransformGeometry(transform, SAMPLE_GEOMETRY)
      await exportImage()
      await exportPreviewImage()
    })
    await flushScheduledToasts()

    // Full resolution reproduces the geometry, so the job runs and receives it.
    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    expect(
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0].geometry,
    ).toEqual(SAMPLE_GEOMETRY)
    expect(result.current.canExport).toBe(true)

    // The bounded HQ preview cannot, and says so rather than delivering an
    // ungeometried frame under the same name.
    expect(exportSystemMock.runPreviewExportJob).not.toHaveBeenCalled()
    expect(result.current.canPreviewExport).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith(
      'HQ preview export is not ready',
      {
        description: enMessages['raw.transform.hqExportReason'],
      },
    )
  })

  it('does not publish an in-flight JPEG after preview transform invalidation', async () => {
    const pending = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      ),
    )
    const request =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]

    act(() =>
      acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
    )
    expect(request.signal.aborted).toBe(true)
    const committedSession = jotaiStore.get(currentSessionAtom)
    expect(committedSession?.exportGeometry).toEqual(SAMPLE_GEOMETRY)
    expect(committedSession?.exportState.status).toBe('idle')
    expect(committedSession?.exportState.result).toBeUndefined()
    await act(async () => {
      pending.resolve({
        filename: 'stale.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(result.current.exportResult).toBeNull()
    expect(result.current.exportShareCapability.available).toBe(false)
    expect(result.current.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)).toBe(committedSession)
  })

  it('clears a completed export and releases its output when a geometry is committed', async () => {
    const cleanup = vi.fn(async () => undefined)
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-geometry-invalidation',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
      cleanup,
    }
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

    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')

    act(() =>
      acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
    )

    expect(result.current.exportResult).toBeNull()
    expect(result.current.status).toBe('ready')
    expect(result.current.canExport).toBe(true)
    expect(result.current.previewTransform?.active).toBe(true)
    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      exportGeometry: SAMPLE_GEOMETRY,
      exportState: { status: 'idle', result: undefined },
    })
    await waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(1)
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
        dispatch({ type: 'capture', sourceId, captureKey: 'frame-a' })
      })
      act(() => {
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-a',
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
          requestId: 1,
          failure: 'transform',
        })
      })
      expect(deriveTransformStatus(liveTransform())).toBe('invalid')
      await expectBothRefused(
        'This Transform leaves too little usable image. Reduce the adjustment or reset Transform to export.',
      )

      act(() => {
        dispatch({ type: 'capture', sourceId, captureKey: 'frame-b' })
      })
      act(() => {
        dispatch({ type: 'capture-failed', sourceId, captureKey: 'frame-b' })
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

    it('does not revive an export when the Transform is edited away and back to the geometry it ran with', async () => {
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
      const heldGeometry = jotaiStore.get(currentSessionAtom)?.exportGeometry
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
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      const captureKey = state!.capture!.key
      const original = state!.intent.manual

      act(() =>
        dispatch({
          type: 'edit',
          sourceId,
          intent: { manual: { ...original, rotate: 40 } },
        }),
      )
      act(() =>
        dispatch({ type: 'edit', sourceId, intent: { manual: original } }),
      )
      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey,
          requestId: 901,
          geometry: SAMPLE_GEOMETRY,
        }),
      )
      act(() =>
        dispatch({
          type: 'rendered',
          sourceId,
          captureKey,
          requestId: 901,
          geometry: SAMPLE_GEOMETRY,
          frame: FRAME,
        }),
      )
      const reaccepted = jotaiStore.get(currentSessionAtom)
      expect(deriveTransformStatus(reaccepted!.transform!)).toBe('accepted')
      // The geometry never moved: the session holds the very same object.
      expect(reaccepted?.exportGeometry).toBe(heldGeometry)
      expect(job.signal.aborted).toBe(true)

      await act(async () => {
        pending.resolve({
          filename: 'stale.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        })
        await exportPromise
      })

      expect(result.current.exportResult).toBeNull()
      expect(jotaiStore.get(currentSessionAtom)).toBe(reaccepted)
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'idle',
      )
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
      act(() => dispatch({ type: 'capture', sourceId, captureKey: 'frame-n' }))
      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-n',
          requestId: 950,
          geometry: SAMPLE_GEOMETRY,
        }),
      )
      await flushPostCommitTasks()
      expect(deriveTransformStatus(liveTransform())).toBe('neutral')
      expect(result.current.exportResult).toBe(neutralResult)
      expect(cleanup).not.toHaveBeenCalled()
    })

    it('keeps a delivered export when a new frame answers the same geometry again', async () => {
      const cleanup = deliverFileBackedExports()
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      act(() =>
        acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
      )
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      await act(async () => {
        await result.current.exportImage()
      })
      const transformedResult = result.current.exportResult
      expect(transformedResult).not.toBeNull()

      // A new frame answers the same geometry again: the request and the
      // worker's answer arrive separately and neither discards the export.
      act(() => dispatch({ type: 'capture', sourceId, captureKey: 'frame-r' }))
      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-r',
          requestId: 951,
          geometry: SAMPLE_GEOMETRY,
        }),
      )
      act(() =>
        dispatch({
          type: 'rendered',
          sourceId,
          captureKey: 'frame-r',
          requestId: 951,
          geometry: SAMPLE_GEOMETRY,
          frame: FRAME,
        }),
      )
      await flushPostCommitTasks()

      expect(deriveTransformStatus(liveTransform())).toBe('accepted')
      expect(result.current.exportResult).toBe(transformedResult)
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'ready',
      )
      expect(cleanup).not.toHaveBeenCalled()
    })

    const PENDING_REFUSAL =
      'Transform is still preparing the current photo. Export once the preview shows it.'
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

    function manifestStatus() {
      return jotaiStore.get(currentSessionAtom)?.exportState.result
        ?.manifestState?.status
    }

    it('ends an export of an accepted geometry when a new frame leaves it pending while the plan is sampled', async () => {
      exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      act(() =>
        acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
      )
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      const intent = state!.intent
      toastMock.error.mockClear()
      toastMock.dismiss.mockClear()

      await act(async () => {
        const exporting = result.current.exportImage()
        // The attempt started and samples the device; the preview reads a
        // new frame meanwhile, with no edit.
        expect(toastMock.dismiss).toHaveBeenCalled()
        dispatch({ type: 'capture', sourceId, captureKey: 'frame-planning' })
        await exporting
      })
      await flushScheduledToasts()

      expect(liveTransform().intent).toBe(intent)
      expect(deriveTransformStatus(liveTransform())).toBe('pending')
      expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(result.current.status).toBe('ready')
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'idle',
      )
      expect(toastMock.error).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        { description: PENDING_REFUSAL },
      )
    })

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

    it('seals the manifest of a delivered export when a new frame leaves the same Transform pending', async () => {
      const job = deliverSealGatedExports()
      job.finishJob()
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(job.source)
      })
      act(() =>
        acceptTransformGeometry(result.current.transform, SAMPLE_GEOMETRY),
      )
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      await act(async () => {
        await result.current.exportImage()
      })
      const delivered = result.current.exportResult
      expect(delivered).not.toBeNull()
      expect(manifestStatus()).toBe('sealing')

      // The session keeps the delivered JPEG through a new frame, so its
      // manifest still lands on it.
      act(() =>
        dispatch({ type: 'capture', sourceId, captureKey: 'frame-sealing' }),
      )
      expect(deriveTransformStatus(liveTransform())).toBe('pending')
      act(() => job.seal())

      await waitFor(() => expect(manifestStatus()).toBe('ready'))
      expect(result.current.exportResult?.output).toBe(delivered?.output)
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'ready',
      )
    })

    it('stops offering a delivered JPEG once a later export of it is refused by a new frame', async () => {
      const job = deliverSealGatedExports()
      job.finishJob()
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
      await act(async () => {
        await result.current.exportImage()
      })
      const delivered = result.current.exportResult
      expect(delivered).not.toBeNull()
      expect(manifestStatus()).toBe('sealing')
      const { output: deliveredOutput } =
        await exportSystemMock.runFullResolutionExportJob.mock.results[0]!.value

      // The export released the preview; the user restores it and exports
      // again, and the restored preview reads a new frame while the second
      // export samples the device, with no edit.
      await act(async () => {
        await result.current.restorePreviewAfterExport()
      })
      expect(result.current.exportResult).toBe(delivered)
      toastMock.error.mockClear()
      await act(async () => {
        const exporting = result.current.exportImage()
        dispatch({ type: 'capture', sourceId, captureKey: 'frame-again' })
        await exporting
      })
      await flushScheduledToasts()
      await flushPostCommitTasks()

      expect(liveTransform().intent).toBe(intent)
      expect(toastMock.error).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        { description: PENDING_REFUSAL },
      )
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      )
      // The second export had claimed the export slot, so the first JPEG
      // could no longer be delivered: it is no longer offered, and its file
      // is removed.
      expect(result.current.exportResult).toBeNull()
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'idle',
      )
      expect(deliveredOutput.cleanup).toHaveBeenCalledTimes(1)

      // The same geometry is answered on that frame, and the first manifest
      // finishes hashing: neither brings the first JPEG back.
      act(() =>
        dispatch({
          type: 'request',
          sourceId,
          captureKey: 'frame-again',
          requestId: 991,
          geometry: SAMPLE_GEOMETRY,
        }),
      )
      act(() =>
        dispatch({
          type: 'rendered',
          sourceId,
          captureKey: 'frame-again',
          requestId: 991,
          geometry: SAMPLE_GEOMETRY,
          frame: FRAME,
        }),
      )
      act(() => job.seal())
      await flushPostCommitTasks()

      expect(deriveTransformStatus(liveTransform())).toBe('accepted')
      expect(result.current.exportResult).toBeNull()
      expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
        'idle',
      )
    })

    it('keeps an export current when a neutral Transform with a request out is reset, mid-job and while sealing', async () => {
      const job = deliverSealGatedExports()
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(job.source)
      })
      const { dispatch, state } = transformPort(result)
      const sourceId = state!.sourceId
      function requestOnNeutral(captureKey: string, requestId: number) {
        act(() => dispatch({ type: 'capture', sourceId, captureKey }))
        act(() =>
          dispatch({
            type: 'request',
            sourceId,
            captureKey,
            requestId,
            geometry: SAMPLE_GEOMETRY,
          }),
        )
        expect(liveTransform().request).not.toBeNull()
      }
      requestOnNeutral('frame-n1', 960)
      const intent = liveTransform().intent

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
      const jobInput =
        exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]

      // Resetting a neutral Transform withdraws the request and asks for
      // nothing new: the export goes on.
      act(() => dispatch({ type: 'reset', sourceId }))
      expect(liveTransform().request).toBeNull()
      expect(liveTransform().intent).toBe(intent)
      expect(jobInput.signal.aborted).toBe(false)
      await act(async () => {
        job.finishJob()
        await exportPromise
      })

      const delivered = result.current.exportResult
      expect(delivered).not.toBeNull()
      expect(result.current.status).toBe('ready')
      expect(manifestStatus()).toBe('sealing')

      // The same reset while the manifest seals leaves it to land.
      requestOnNeutral('frame-n2', 961)
      act(() => dispatch({ type: 'reset', sourceId }))
      expect(liveTransform().intent).toBe(intent)
      act(() => job.seal())

      await waitFor(() => expect(manifestStatus()).toBe('ready'))
      expect(result.current.exportResult?.output).toBe(delivered?.output)
    })
  })

  it('keeps a geometry commit and a view mode change from one tick in the session only', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const storedParamsBefore = getProcessingParams()
    const { transform, setViewMode } = result.current

    act(() => {
      acceptTransformGeometry(transform, SAMPLE_GEOMETRY)
      setViewMode('processed')
      // The committed Transform shows the processed photo alone, so the
      // original is refused even through a callback from before the commit.
      setViewMode('original')

      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        exportGeometry: SAMPLE_GEOMETRY,
        viewState: { mode: 'processed', compareSplit: 0.5 },
      })
      expect(getProcessingParams()).toBe(storedParamsBefore)
    })

    expect(result.current.viewMode).toBe('processed')
    expect(result.current.params).not.toHaveProperty('viewMode')
    expect(result.current.previewTransform?.active).toBe(true)
    expect(result.current.previewTransform?.geometry).toEqual(SAMPLE_GEOMETRY)
    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      exportGeometry: SAMPLE_GEOMETRY,
      viewState: { mode: 'processed', compareSplit: 0.5 },
    })
    expect(getProcessingParams()).toBe(storedParamsBefore)
    expect(getDetachedPreviewView().mode).toBe('compare')
  })

  it('keeps a view mode written before a geometry commit in the same tick', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const { transform, setViewMode } = result.current

    act(() => {
      setViewMode('processed')
      acceptTransformGeometry(transform, SAMPLE_GEOMETRY)

      expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
        exportGeometry: SAMPLE_GEOMETRY,
        viewState: { mode: 'processed' },
      })
    })

    expect(result.current.viewMode).toBe('processed')
    expect(result.current.previewTransform?.geometry).toEqual(SAMPLE_GEOMETRY)
  })

  it('lands a Transform edit from a replacing loadFile tick on neither source', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    const first = result.current.transform!
    const firstSourceId = first.state!.sourceId

    await act(async () => {
      const loading = result.current.loadFile(new File(['raw'], 'second.ARW'))
      // The edit still addresses the first source, which the load replaced.
      first.dispatch({
        type: 'edit',
        sourceId: firstSourceId,
        intent: { manual: { ...NEUTRAL_TRANSFORM, rotate: 5 } },
      })
      await loading
    })

    const replacement = jotaiStore.get(currentSessionAtom)
    expect(replacement?.sourceFile.name).toBe('second.ARW')
    expect(replacement?.id).not.toBe(firstSourceId)
    expect(replacement?.transform?.intent.manual).toEqual(NEUTRAL_TRANSFORM)
    expect(replacement?.exportGeometry).toBeUndefined()
    expect(result.current.canExport).toBe(true)
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

  it('resets the compare view as one write on the GPU preview', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.2)
      result.current.setPreviewViewport({
        zoom: 3,
        panX: 40,
        panY: -20,
        fitMode: 'custom',
      })
    })
    const storedParamsBefore = getProcessingParams()

    act(() => result.current.resetCompareView())

    expect(jotaiStore.get(currentSessionAtom)?.viewState).toEqual({
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    })
    expect(result.current.viewMode).toBe('compare')
    expect(result.current.compareSplit).toBe(0.5)
    expect(getProcessingParams()).toBe(storedParamsBefore)
  })

  it('replaces preview transform source identity and resets its active flag with a new RAW', async () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    const first = result.current.previewTransform!
    const firstTransform = result.current.transform
    act(() => acceptTransformGeometry(firstTransform, SAMPLE_GEOMETRY))
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'second.ARW'))
    })
    const replacementSession = jotaiStore.get(currentSessionAtom)
    act(() => acceptTransformGeometry(firstTransform, SAMPLE_GEOMETRY))

    expect(jotaiStore.get(currentSessionAtom)).toBe(replacementSession)
    expect(replacementSession?.exportGeometry).toBeUndefined()
    expect(result.current.previewTransform?.sourceId).not.toBe(first.sourceId)
    expect(result.current.previewTransform?.active).toBe(false)
    expect(result.current.canExport).toBe(true)
    act(() => result.current.reset())
    expect(result.current.previewTransform?.sourceId).toBeNull()
  })

  it('keeps a replacement session export when a previous source commits a geometry', async () => {
    const cleanup = vi.fn(async () => undefined)
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'second_neutral_fullres.jpg',
      output: {
        kind: 'file-backed',
        exportId: 'export-replacement-session',
        filename: 'second_neutral_fullres.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
        openBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
        cleanup,
      } satisfies FileBackedOutputResult,
    })
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    const first = result.current.transform
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'second.ARW'))
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
    const readySession = jotaiStore.get(currentSessionAtom)
    expect(readySession?.exportState.status).toBe('ready')

    act(() => acceptTransformGeometry(first, SAMPLE_GEOMETRY))
    await flushPostCommitTasks()

    expect(jotaiStore.get(currentSessionAtom)).toBe(readySession)
    expect(result.current.exportResult?.filename).toBe(
      'second_neutral_fullres.jpg',
    )
    expect(result.current.previewTransform?.active).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
  })

  it.each(['missing-color-transform', 'unsupported-orientation'])(
    'keeps full-resolution export disabled when capability reports %s',
    async (reason) => {
      rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
      rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
        createDecodedImage('quick'),
      )
      rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
        createDecodedImage('bounded-hq'),
      )
      rawRuntimeMock.probeExportCapability.mockResolvedValue(
        createUnsupportedCapability(reason),
      )

      const { result } = renderHook(() => useRawWorkflow(), { wrapper })

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })

      expect(result.current.canExport).toBe(false)
      expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
        fullResCapability: {
          status: 'unsupported',
          reason,
        },
      })

      await act(async () => {
        await result.current.exportImage()
      })
      await flushScheduledToasts()

      expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(toastMock.error).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        { description: reason },
      )
    },
  )

  it('keeps full-resolution export disabled for raw-mosaic window capability', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createRawMosaicCapability(),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(result.current.canExport).toBe(false)
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      fullResCapability: {
        status: 'unsupported',
        reason: 'processed-window-unavailable',
      },
    })

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      { description: 'processed-window-unavailable' },
    )
  })

  it('keeps full-resolution export disabled with product copy when JPEG readiness fails', async () => {
    const reason =
      'Full-resolution JPEG export is not available in this browser build.'

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockRejectedValue(new Error(reason))

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(result.current.canExport).toBe(false)
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      fullResCapability: {
        status: 'unsupported',
        reason,
      },
    })

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      { description: reason },
    )
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

  it('records derived active plan and checkpoint durability while full-resolution export is running', async () => {
    const pendingExport = deferred<{ filename: string; blob: Blob }>()

    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {},
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createSupportedCapability(),
    )
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
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

    const exportState = jotaiStore.get(currentSessionAtom)?.exportState
    expect(exportState).toMatchObject({
      status: 'exporting',
      activePlan: {
        preferredRows: 128,
        concurrency: 1,
        runtimeMemoryProfile: 'low-memory',
        outputSink: 'blob-handoff',
        checkpointMode: 'safe-retry',
      },
      retryRecommended: false,
    })
    expect(exportState?.result).toBeUndefined()
    expect(exportState?.lastProgress).toBeUndefined()
    expect(result.current.previewSuspended).toBe(true)

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPlan: expect.objectContaining({
          preferredRows: 128,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
        }),
      }),
    )

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    expect(result.current.previewSuspended).toBe(true)
  })

  it('dismisses existing toasts before the export handoff takes over', async () => {
    const pendingExport = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    expect(toastMock.dismiss).not.toHaveBeenCalled()

    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(toastMock.dismiss).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })
    await flushScheduledToasts()

    expect(toastMock.success).not.toHaveBeenCalledWith(
      'JPEG ready',
      expect.anything(),
    )
  })

  it('releases the desktop preview pipeline during export', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      maxTouchPoints: 0,
      storage: {},
      hardwareConcurrency: 8,
    })
    vi.stubGlobal('crossOriginIsolated', true)

    const pipelineDispose = vi.fn()
    const originalPipelineDispose = vi.fn()
    const pipeline = {
      dispose: pipelineDispose,
    } as never
    const originalPipeline = {
      dispose: originalPipelineDispose,
    } as never

    const pendingExport = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    act(() => {
      result.current.pipelineRef.current = pipeline
      result.current.setOriginalPreviewPipeline(originalPipeline)
    })

    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPlan: expect.objectContaining({
          preferredRows: 512,
          concurrency: 2,
          runtimeMemoryProfile: 'desktop',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
          derivedLabel: expect.stringContaining('wkchromium'),
        }),
      }),
    )
    expect(result.current.previewSuspended).toBe(true)
    expect(pipelineDispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(originalPipelineDispose).toHaveBeenCalledWith({
      releaseContext: true,
    })
    expect(result.current.pipelineRef.current).toBeNull()

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
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

  it('refuses a local LUT that finishes reading while export holds the preview', async () => {
    const pendingExport = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
    )
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const lateLook = createDeferredCubeFile('Late Look', 'late-look.cube')
    let lutLoad!: Promise<LutLoadOutcome>
    act(() => {
      lutLoad = result.current.loadLUT(lateLook.file)
    })
    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      ),
    )
    const request =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]
    expect(result.current.previewSuspended).toBe(true)

    let outcome: LutLoadOutcome | undefined
    await act(async () => {
      lateLook.finishRead()
      outcome = await lutLoad
    })

    expect(outcome).toBe('aborted')
    expect(request.signal.aborted).toBe(false)
    expect(result.current.status).toBe('exporting')
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.currentLutName).toBeNull()

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(result.current.exportResult?.filename).toBe('frame.jpg')
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.currentLutName).toBeNull()
  })

  it('refuses a local LUT that finishes reading after export delivers its JPEG', async () => {
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    const lateLook = createDeferredCubeFile('Late Look', 'late-look.cube')
    let lutLoad!: Promise<LutLoadOutcome>
    act(() => {
      lutLoad = result.current.loadLUT(lateLook.file)
    })
    await act(async () => {
      await result.current.exportImage()
    })
    expect(result.current.exportResult?.filename).toBe('frame.jpg')
    expect(result.current.previewSuspended).toBe(true)

    let outcome: LutLoadOutcome | undefined
    await act(async () => {
      lateLook.finishRead()
      outcome = await lutLoad
    })

    expect(outcome).toBe('aborted')
    expect(result.current.exportResult?.filename).toBe('frame.jpg')
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.currentLutName).toBeNull()
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
  })

  it('keeps desktop-fast export running when bounded HQ settles after export starts', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      maxTouchPoints: 0,
      storage: {},
      hardwareConcurrency: 8,
    })
    vi.stubGlobal('crossOriginIsolated', true)

    const boundedHqDecode = deferred<DecodedImage>()
    const pendingExport = deferred<{ filename: string; blob: Blob }>()
    const runtimeDispose = vi.fn()
    let boundedHqSignal: AbortSignal | undefined

    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi.fn((_options, _progress, signal) => {
        boundedHqSignal = signal
        return boundedHqDecode.promise
      }),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: runtimeDispose,
    })
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      pendingExport.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
      'exporting',
    )

    await act(async () => {
      boundedHqDecode.resolve(
        createDecodedImage('bounded-hq', {
          renderExposure: { ev: 1, multiplier: 2, source: 'image-statistics' },
        }),
      )
      await flushPromises()
    })

    expect(boundedHqSignal?.aborted).toBe(true)
    expect(runtimeDispose).toHaveBeenCalledTimes(1)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
      'exporting',
    )

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
  })

  it('fails closed when plan-time resources cannot safely complete export', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {
        getDirectory: vi.fn(),
        estimate: vi.fn(async () => ({ quota: 100_000_000, usage: 0 })),
      },
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    rawRuntimeMock.probeExportCapability.mockResolvedValue({
      ...createSupportedCapability(),
      width: 11662,
      height: 8746,
      rawWidth: 11662,
      rawHeight: 8746,
    })
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.RAF'))
    })

    expect(result.current.canExport).toBe(true)

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_POLICY_CANNOT_COMPLETE',
      retryRecommended: false,
    })
    expect(toastMock.error).toHaveBeenCalledWith(
      'Export failed',
      expect.objectContaining({
        description: expect.stringMatching(
          /cannot safely complete this large local full-resolution export/i,
        ),
      }),
    )
  })

  it('does not start unsafe large iOS WebKit blob-handoff export without a durable sink', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {},
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    rawRuntimeMock.probeExportCapability.mockResolvedValue({
      ...createSupportedCapability(),
      width: 11662,
      height: 8746,
      rawWidth: 11662,
      rawHeight: 8746,
    })
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.RAF'))
    })

    expect(result.current.canExport).toBe(false)
    expect(result.current.exportRefusal).toEqual({
      code: 'cannot-safely-complete',
    })

    await act(async () => {
      await result.current.exportImage()
    })
    await flushScheduledToasts()

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      expect.objectContaining({
        description: expect.stringMatching(
          /cannot safely complete this large local full-resolution export/i,
        ),
      }),
    )
  })

  it('writes an ios-safe OPFS export without a checkpoint identity', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {
        getDirectory: vi.fn(),
        estimate: vi.fn(async () => ({ quota: 1_000_000_000, usage: 0 })),
      },
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    rawRuntimeMock.probeExportCapability.mockResolvedValue(
      createSupportedCapability(),
    )
    let markersDuringJob: unknown[] = []
    exportSystemMock.runFullResolutionExportJob.mockImplementation(async () => {
      markersDuringJob = storedMarkers()
      return {
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    const file = new File(['raw'], 'frame.ARW', { lastModified: 123 })

    await act(async () => {
      await result.current.loadFile(file)
    })
    await act(async () => {
      await result.current.exportImage()
    })
    await flushPostCommitTasks()

    const [request] = exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    expect(request).toMatchObject({
      executionPlan: expect.objectContaining({
        preferredRows: 128,
        concurrency: 1,
        runtimeMemoryProfile: 'low-memory',
        outputSink: 'opfs-file',
        checkpointMode: 'safe-retry',
        derivedLabel: expect.stringContaining('wkwebkit-mobile'),
      }),
      outputLocation: expect.objectContaining({ sink: 'opfs-file' }),
    })
    expect(request).not.toHaveProperty('checkpoint')
    // The running attempt was marked by its tuple and ended with the job.
    expect(markersDuringJob).toEqual([
      expect.objectContaining({
        attempt: 'this-page-attempt-1',
        source: JSON.stringify(['frame.ARW', 3, 123]),
        terminal: null,
      }),
    ])
    expect(storedMarkers()).toEqual([])
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      status: 'ready',
    })
  })

  it('retires the matching hint after a successful OPFS export, so it is gone on the next visit', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {
        getDirectory: vi.fn(),
        estimate: vi.fn(async () => ({ quota: 1_000_000_000, usage: 0 })),
      },
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)
    const file = new File(['raw'], 'frame.ARW', { lastModified: 123 })
    await seedCrashedExport(file)
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(file)
    })
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(true)
    })
    await act(async () => {
      await result.current.exportImage()
    })
    await flushPostCommitTasks()

    const [request] = exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    expect(request.executionPlan).toMatchObject({
      outputSink: 'opfs-file',
      productCopy: 'interrupted-retry',
    })
    await waitFor(() => {
      expect(result.current.exportInterrupted).toBe(false)
    })
    expect(storedMarkers()).toEqual([])
    await expect(
      readSourceInterruption(createMarkerPage('next-visit'), file),
    ).resolves.toBeNull()
  })

  it('evacuates preview resources and clears stale export result before full-resolution export', async () => {
    const boundedHqDecode = deferred<DecodedImage>()
    const runtimeDispose = vi.fn()
    const pipelineDispose = vi.fn()
    let boundedHqSignal: AbortSignal | undefined

    rawRuntimeMock.openSession.mockResolvedValue({
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi.fn((_options, _progress, signal) => {
        boundedHqSignal = signal
        return boundedHqDecode.promise
      }),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: runtimeDispose,
    })
    exportSystemMock.runFullResolutionExportJob.mockImplementation(async () => {
      expect(boundedHqSignal?.aborted).toBe(true)
      expect(runtimeDispose).toHaveBeenCalledTimes(1)
      expect(pipelineDispose).toHaveBeenCalledWith({
        releaseContext: true,
      })
      expect(result.current.decodedImageRef.current).toBeNull()
      expect(
        jotaiStore.get(currentSessionAtom)?.exportState.result,
      ).toBeUndefined()

      return {
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['new'], { type: 'image/jpeg' }),
      }
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    act(() => {
      result.current.pipelineRef.current = {
        dispose: pipelineDispose,
      } as never
      const activeSession = jotaiStore.get(currentSessionAtom)!
      jotaiStore.set(currentSessionAtom, {
        ...activeSession,
        exportState: {
          ...activeSession.exportState,
          status: 'ready',
          result: {
            output: createBlobOutputResult({
              blob: new Blob(['old'], { type: 'image/jpeg' }),
              filename: 'stale_fullres.jpg',
            }),
            filename: 'stale_fullres.jpg',
            width: 6048,
            height: 4024,
            size: 3,
            createdAt: 1,
            copyCapability: {
              mode: 'unavailable',
              reasonCode: 'clipboard-unsupported',
            },
          },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.exportResult?.filename).toBe('stale_fullres.jpg')
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
    expect(result.current.pipelineRef.current).toBeNull()
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    expect(result.current.canExport).toBe(true)

    await act(async () => {
      boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await flushPromises()
    })
  })

  it('evacuates original reference snapshots before starting full-resolution export', async () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => true),
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
    const snapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick' as const,
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }
    originalReferenceSnapshotMock.renderOriginalReferenceSnapshot.mockResolvedValue(
      snapshot,
    )
    exportSystemMock.runFullResolutionExportJob.mockImplementation(async () => {
      expect(
        originalReferenceSnapshotMock.releaseOriginalReferenceSnapshot,
      ).toHaveBeenCalledWith(snapshot)

      return {
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('compare')
    })
    await waitFor(() => {
      expect(result.current.originalReferenceSnapshot).toBe(snapshot)
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
  })

  it('cancels pending original reference snapshot work before starting full-resolution export', async () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => true),
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
    const pendingSnapshot = deferred<{
      key: string
      objectUrl: string
      width: number
      height: number
      source: 'quick'
      mimeType: string
      estimatedBytes: number
    }>()
    const snapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick' as const,
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }
    originalReferenceSnapshotMock.renderOriginalReferenceSnapshot.mockReturnValue(
      pendingSnapshot.promise,
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('compare')
    })
    await waitFor(() => {
      expect(
        originalReferenceSnapshotMock.renderOriginalReferenceSnapshot,
      ).toHaveBeenCalled()
    })

    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingSnapshot.resolve(snapshot)
      await exportPromise
    })

    expect(
      originalReferenceSnapshotMock.releaseOriginalReferenceSnapshot,
    ).toHaveBeenCalledWith(snapshot)
    expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
  })

  it('fails before starting export when original reference snapshot evacuation throws', async () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => true),
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
    const snapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick' as const,
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }
    originalReferenceSnapshotMock.renderOriginalReferenceSnapshot.mockResolvedValue(
      snapshot,
    )
    originalReferenceSnapshotMock.releaseOriginalReferenceSnapshot.mockImplementationOnce(
      () => {
        throw new Error('snapshot release failed')
      },
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setViewMode('compare')
    })
    await waitFor(() => {
      expect(result.current.originalReferenceSnapshot).toBe(snapshot)
    })

    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
      retryRecommended: false,
    })
  })

  it('emits enriched low-memory evacuation diagnostics before full-resolution export', async () => {
    const events: unknown[] = []
    const debugListener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }
    window.addEventListener('lumaforge-export-debug', debugListener)
    const boundedHqDecode = deferred<DecodedImage>()
    let boundedHqSettled = false
    let boundedHqSignal: AbortSignal | undefined
    const runtimeDispose = vi.fn()
    const pipelineDispose = vi.fn()

    try {
      rawRuntimeMock.openSession.mockResolvedValue({
        sourceDimensions: defaultSourceDimensions,
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
        decodeBoundedHqRaw: vi.fn((_options, _progress, signal) => {
          boundedHqSignal = signal
          return boundedHqDecode.promise
        }),
        probeExportCapability: vi
          .fn()
          .mockResolvedValue(createSupportedCapability()),
        dispose: runtimeDispose,
      })
      exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })

      const { result } = renderHook(() => useRawWorkflow(), { wrapper })

      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      act(() => {
        result.current.pipelineRef.current = {
          dispose: pipelineDispose,
        } as never
      })
      await act(async () => {
        await result.current.exportImage()
      })

      const evacuation = events.find(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: string }).type === 'resource-evacuated',
      ) as { payload?: Record<string, unknown> } | undefined

      expect(evacuation?.payload).toMatchObject({
        profile: 'mobile-balanced',
        requiredOwners: [
          'preview',
          'bounded-hq',
          'gpu',
          'export-result',
          'lut-fetch',
        ],
        disposedOwners: [
          'preview',
          'bounded-hq',
          'gpu',
          'export-result',
          'lut-fetch',
        ],
        registryCheck: { ok: true },
        remainingLive: [],
      })
      expect(boundedHqSignal?.aborted).toBe(true)
      expect(runtimeDispose).toHaveBeenCalledTimes(1)
      expect(pipelineDispose).toHaveBeenCalledWith({ releaseContext: true })

      await act(async () => {
        boundedHqSettled = true
        boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      })
    } finally {
      window.removeEventListener('lumaforge-export-debug', debugListener)

      if (!boundedHqSettled) {
        boundedHqSettled = true
        boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
        await flushPromises()
      }
    }
  })

  it('fails before starting the export worker when required evacuation throws', async () => {
    const pipelineDispose = vi.fn(() => {
      throw new Error('dispose failed')
    })

    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.pipelineRef.current = {
        dispose: pipelineDispose,
      } as never
    })
    await act(async () => {
      await result.current.exportImage()
    })

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(jotaiStore.get(currentSessionAtom)?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
      retryRecommended: false,
    })
  })

  it('does not mark a reset session as exporting when reset aborts during evacuation', async () => {
    const pipelineDispose = deferred<void>()
    const runExport = deferred<{ filename: string; blob: Blob }>()
    const disposePreviewPipeline = vi.fn(() => pipelineDispose.promise)

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      runExport.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    act(() => {
      result.current.pipelineRef.current = {
        dispose: disposePreviewPipeline,
      } as never
    })

    let exportPromise!: Promise<void>
    await act(async () => {
      exportPromise = result.current.exportImage()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(disposePreviewPipeline).toHaveBeenCalledWith({
        releaseContext: true,
      })
    })

    await act(async () => {
      result.current.reset()
    })

    await act(async () => {
      pipelineDispose.resolve()
      runExport.resolve({
        filename: 'late_fullres.jpg',
        blob: new Blob(['late'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(exportSystemMock.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(result.current.status).toBe('idle')
  })

  it('downloads a ready export only when downloadExportResult is called', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const { click } = stubDownloadLink()

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.exportImage()
    })

    expect(click).not.toHaveBeenCalled()

    await act(async () => {
      result.current.downloadExportResult()
      await Promise.resolve()
    })

    expect(click).toHaveBeenCalledTimes(1)
  })

  it('does not open file-backed export output until a result action runs', async () => {
    const events: unknown[] = []
    const debugListener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }
    window.addEventListener('lumaforge-export-debug', debugListener)
    const openBlob = vi.fn(
      async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    )
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob,
    }

    try {
      exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
        filename: 'frame_neutral_fullres.jpg',
        output,
      })
      const { click } = stubDownloadLink()

      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await result.current.exportImage()
      })

      expect(openBlob).not.toHaveBeenCalled()
      expect(result.current.exportResult?.output.kind).toBe('file-backed')

      await act(async () => {
        await result.current.downloadExportResult()
      })

      expect(openBlob).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalledTimes(1)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'output-materialized',
          payload: expect.objectContaining({
            action: 'download',
            outputKind: 'file-backed',
            filename: 'frame_neutral_fullres.jpg',
            byteLength: 4,
          }),
        }),
      )
    } finally {
      window.removeEventListener('lumaforge-export-debug', debugListener)
    }
  })

  it('records terminal export progress for post-reload completion diagnostics', async () => {
    const events: unknown[] = []
    const debugListener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }
    window.addEventListener('lumaforge-export-debug', debugListener)
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
    }

    try {
      exportSystemMock.runFullResolutionExportJob.mockImplementation(
        async ({ filename, onProgress }) => {
          onProgress?.({ completedStrips: 4, totalStrips: 4, progress: 99 })
          onProgress?.({ completedStrips: 4, totalStrips: 4, progress: 100 })
          return {
            filename,
            output,
          }
        },
      )

      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await result.current.exportImage()
      })

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'export-progress',
          payload: expect.objectContaining({
            progress: 99,
            completedStrips: 4,
            totalStrips: 4,
          }),
        }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'export-progress',
          payload: expect.objectContaining({
            progress: 100,
            completedStrips: 4,
            totalStrips: 4,
          }),
        }),
      )
    } finally {
      window.removeEventListener('lumaforge-export-debug', debugListener)
    }
  })

  it('cleans up file-backed export output when resetting the session', async () => {
    const cleanup = vi.fn(async () => undefined)
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
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

    expect(result.current.exportResult?.output).toMatchObject({
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
    })

    act(() => {
      result.current.reset()
    })
    await waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(1)
    })

    act(() => {
      result.current.reset()
    })
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('preserves metadata lazily for file-backed export output', async () => {
    const output = createMemoryFileBackedOutputResult({
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
      mimeType: 'image/jpeg',
      bytes: makeJfifOnlyJpegBytes(),
    })

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

    const exportResult = result.current.exportResult
    if (!exportResult) throw new Error('missing export result')

    const bytes = await readBlobBytes(
      await materializeOutputBlob(exportResult.output),
    )
    expect(bytesIncludeAscii(bytes, 'Exif\0\0')).toBe(true)
    expect(bytesIncludeAscii(bytes, 'Sony')).toBe(true)
    expect(bytesIncludeAscii(bytes, 'A7')).toBe(true)
  })

  it('keeps a ready export after share cancellation', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    vi.stubGlobal('navigator', {
      canShare: vi.fn(() => true),
      share: vi.fn().mockRejectedValue(new DOMException('Abort', 'AbortError')),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.exportImage()
    })
    await act(async () => {
      await result.current.shareExportResult()
    })

    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Share failed',
      expect.anything(),
    )
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()
  })

  it('does not probe file share capability while rendering a ready export', async () => {
    const canShare = vi.fn((_data?: ShareData) => true)
    vi.stubGlobal('navigator', {
      canShare,
      share: vi.fn().mockResolvedValue(undefined),
    })
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    await act(async () => {
      await result.current.exportImage()
    })

    expect(result.current.exportResult).toBeDefined()
    expect(result.current.exportShareCapability).toEqual({ available: true })
    expect(canShare).not.toHaveBeenCalled()
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

  it('clears a ready export when generic params change render graph inputs but not when the view moves', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
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
      result.current.setViewMode('processed')
      result.current.setCompareSplit(0.25)
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()

    act(() => {
      result.current.setParams({ styleKind: 'builtin', builtinPreset: 'warm' })
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
  })

  it('clears a ready export when generic params change intensity', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
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
      result.current.setParams({ intensity: 0.2 })
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
  })

  it('clears a ready export when user tone changes', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
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
      result.current.setToneParams({ userExposureEv: 1 })
    })

    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
  })

  it('resets only tone params from the tone reset action', () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setParams({
        userExposureEv: 1,
        userContrast: 50,
        userHighlights: -40,
        userShadows: 40,
        userWhites: -20,
        userBlacks: 20,
        styleKind: 'custom',
        intensity: 0.2,
      })
    })
    act(() => {
      result.current.resetTone()
    })

    expect(result.current.params).toMatchObject({
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      styleKind: 'custom',
      intensity: 0.2,
    })
  })

  it('updates and resets color params without resetting tone params', () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setToneParams({ userExposureEv: 1, userContrast: 25 })
      result.current.setColorParams({ userTemperature: 35, userTint: -10 })
    })

    expect(result.current.params).toMatchObject({
      userExposureEv: 1,
      userContrast: 25,
      userTemperature: 35,
      userTint: -10,
    })

    act(() => {
      result.current.resetColor()
    })

    expect(result.current.params).toMatchObject({
      userExposureEv: 1,
      userContrast: 25,
      userTemperature: 0,
      userTint: 0,
    })
  })

  it('merges back-to-back partial tone updates before React re-renders', () => {
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setToneParams({ userExposureEv: 1 })
      result.current.setToneParams({ userContrast: 50 })
      result.current.setToneParams({ userHighlights: -40 })
      result.current.setToneParams({ userShadows: 40 })
      result.current.setToneParams({ userWhites: -20 })
      result.current.setToneParams({ userBlacks: 20 })
    })

    expect(result.current.params).toMatchObject({
      userExposureEv: 1,
      userContrast: 50,
      userHighlights: -40,
      userShadows: 40,
      userWhites: -20,
      userBlacks: 20,
    })
  })

  it('passes user tone into full-resolution export graph', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_tone_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setToneParams({
        userExposureEv: 1,
        userContrast: 50,
        userHighlights: -40,
        userShadows: 40,
        userWhites: -20,
        userBlacks: 20,
      })
    })
    await act(async () => {
      await result.current.exportImage()
    })

    const [{ graph }] =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    const userExposureStep = graph.steps.find(
      (step: ExportColorGraphStep) => step.kind === 'user-exposure',
    )
    const userContrastStep = graph.steps.find(
      (step: ExportColorGraphStep) => step.kind === 'user-contrast',
    )
    const userRegionalToneStep = graph.steps.find(
      (step: ExportColorGraphStep) => step.kind === 'user-regional-tone',
    )
    expect(userExposureStep).toMatchObject({
      kind: 'user-exposure',
      ev: 1,
      multiplier: 2,
    })
    expect(userContrastStep).toMatchObject({
      kind: 'user-contrast',
      amount: 50,
      factor: Math.pow(2, 50 / 200),
    })
    expect(userRegionalToneStep).toMatchObject({
      kind: 'user-regional-tone',
      highlights: -40,
      shadows: 40,
      whites: -20,
      blacks: 20,
    })
  })

  it('passes user color into full-resolution export graph', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_color_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.setColorParams({
        userTemperature: 35,
        userTint: -10,
      })
    })
    await act(async () => {
      await result.current.exportImage()
    })

    const [{ graph }] =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]!
    expect(
      graph.steps.find(
        (step: ExportColorGraphStep) => step.kind === 'user-color-balance',
      ),
    ).toMatchObject({
      kind: 'user-color-balance',
      temperature: 35,
      tint: -10,
    })
  })

  it('preserves non-neutral tone when a new image loads', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    act(() => {
      result.current.setToneParams({
        userExposureEv: 1,
        userContrast: 50,
        userHighlights: -40,
        userShadows: 40,
        userWhites: -20,
        userBlacks: 20,
      })
    })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'first.ARW'))
    })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'second.ARW'))
    })

    expect(result.current.params).toMatchObject({
      userExposureEv: 1,
      userContrast: 50,
      userHighlights: -40,
      userShadows: 40,
      userWhites: -20,
      userBlacks: 20,
    })
  })

  it('preserves a ready export when controls repeat the active render graph', async () => {
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
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
      result.current.clearLUT()
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()

    act(() => {
      result.current.setIntensity(result.current.activeIntensity)
    })
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()
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
    act(() => result.current.resetPreviewViewport())
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

  it('lets an in-flight export finish through view-only changes', async () => {
    const pendingExport = deferred<{
      filename: string
      blob: Blob
    }>()
    let exportSignal: AbortSignal | undefined
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
      result.current.setViewMode('original')
      result.current.setCompareSplit(0.62)
      result.current.setPreviewViewport({
        zoom: 2,
        panX: 40,
        panY: -20,
        fitMode: 'custom',
      })
    })

    expect(exportSignal?.aborted).toBe(false)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe(
      'exporting',
    )

    await act(async () => {
      pendingExport.resolve({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })

    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(result.current.exportResult?.filename).toBe(
      'frame_neutral_fullres.jpg',
    )
    // The export held the preview while it ran, so the original and the
    // split were refused; the viewport change landed.
    expect(jotaiStore.get(currentSessionAtom)?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 2,
    })
  })

  it('exports and seals a non-detent look strength exactly', async () => {
    exportSystemMock.runFullResolutionExportJob.mockImplementation(
      async ({ filename }: { filename: string }) => ({
        filename,
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }),
    )
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
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
    expect(result.current.activeIntensity).toBe(0.37)
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
    expect(result.current.activeIntensity).toBe(0.62)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('idle')
    expect(
      jotaiStore.get(currentSessionAtom)?.exportState.result,
    ).toBeUndefined()
  })

  describe('a LUT change and an older export action in the same tick', () => {
    const slog3Contract = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }
    const vlogContract = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }

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

    it('exports the contract chosen in that tick through graph, identity and manifest', async () => {
      const { result } = renderHook(() => useRawWorkflow(), { wrapper })
      await act(async () => {
        await result.current.loadFile(new File(['raw'], 'frame.ARW'))
      })
      await act(async () => {
        await result.current.loadLUT(
          createCubeFile('Client Secret Sauce', 'client-look.cube'),
        )
      })
      act(() => {
        result.current.selectLUTProfile(slog3Contract)
      })
      await waitFor(() => {
        expect(result.current.lutData?.profileResolution).toMatchObject({
          kind: 'confirmed',
          profile: { inputGamut: 's-gamut3-cine' },
        })
      })

      // Both actions come from one render. The contract change lands in the
      // store; the pipeline's LUT copy follows only once its effect runs.
      const { selectLUTProfile, exportImage, lutDataRef } = result.current
      await act(async () => {
        selectLUTProfile(vlogContract)
        expect(lutDataRef.current?.profileResolution).toMatchObject({
          profile: { inputGamut: 's-gamut3-cine' },
        })
        await exportImage()
      })

      expect(
        executedGraphSteps().find((step) => step.kind === 'gamut-to-lut-input'),
      ).toMatchObject({ gamut: 'v-gamut' })
      const sealed = await readSealedResult()
      expect(sealed.identity?.lut?.contract).toMatchObject({
        status: 'confirmed',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
      })
      expect(sealed.manifest?.lut).toMatchObject({
        kind: 'local-file',
        filename: 'client-look.cube',
        sha256:
          jotaiStore.get(currentSessionAtom)?.activeStyle?.lutAsset?.sha256,
        input_contract: { gamut: 'v-gamut', transfer: 'v-log' },
      })
    })

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

  it('keeps a ready export when the bounded HQ frame upgrades the preview', async () => {
    const boundedHqDecode = deferred<DecodedImage>()
    const quickExposure: RawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    }

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
      createDecodedImage('quick', { renderExposure: quickExposure }),
    )
    rawRuntimeMock.decodeBoundedHqRaw.mockReturnValue(boundedHqDecode.promise)
    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    act(() => {
      const activeSession = jotaiStore.get(currentSessionAtom)!
      jotaiStore.set(currentSessionAtom, {
        ...activeSession,
        exportState: {
          ...activeSession.exportState,
          status: 'ready',
          result: {
            output: createBlobOutputResult({
              blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
              filename: 'frame_neutral_fullres.jpg',
            }),
            filename: 'frame_neutral_fullres.jpg',
            width: 6048,
            height: 4024,
            size: 4,
            createdAt: 1,
            copyCapability: {
              mode: 'unavailable',
              reasonCode: 'clipboard-unsupported',
            },
          },
        },
      })
    })

    expect(result.current.displaySource).toBe('quick')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()

    await act(async () => {
      boundedHqDecode.resolve(
        createDecodedImage('bounded-hq', {
          renderExposure: {
            ev: 1,
            multiplier: 2,
            source: 'image-statistics',
          },
        }),
      )
      await flushPromises()
    })

    // The HQ frame renders with the source exposure the quick decode pinned,
    // so a size upgrade is not a new render and the export stays valid.
    expect(rawRuntimeMock.decodeBoundedHqRaw).toHaveBeenCalledWith(
      { maxOutputPixels: expect.any(Number), pinnedExposure: quickExposure },
      undefined,
      expect.any(AbortSignal),
    )
    expect(result.current.displaySource).toBe('bounded-hq')
    expect(result.current.decodedImageRef.current?.renderExposure).toEqual(
      quickExposure,
    )
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
    expect(jotaiStore.get(currentSessionAtom)?.exportState.result).toBeDefined()
  })

  it('defers preview-size copy canvas creation until after low-memory export releases preview context', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    const renderToHiddenCanvas = vi.fn()
    const dispose = vi.fn()
    const fakeCanvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob(['png'], { type: type ?? 'image/png' }))
      }),
    }

    class FakeClipboardItem {
      static supports(type: string) {
        return type === 'image/png'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal('navigator', {
      clipboard: { write: clipboardWrite },
    })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )
    exportSystemMock.runFullResolutionExportJob.mockResolvedValue({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    renderToHiddenCanvas.mockResolvedValue(fakeCanvas)

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      result.current.updateStats({
        uploadTime: 1,
        lutUploadTime: 0,
        processTime: 2,
        totalTime: 3,
        inputSize: { width: 800, height: 600 },
        previewSize: { width: 640, height: 480 },
        inputFormat: 'uint16-rgb',
        transformPath: 'no-lut',
        lutRole: null,
        lutInputTransfer: null,
        lutOutputTransfer: null,
        lutSize: null,
      })
      result.current.pipelineRef.current = {
        renderToHiddenCanvas,
        dispose,
      } as never
    })
    await act(async () => {
      await result.current.exportImage()
    })
    expect(result.current.pipelineRef.current).toBeNull()
    expect(dispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(renderToHiddenCanvas).not.toHaveBeenCalled()
    expect(result.current.exportResult?.copyCapability).toMatchObject({
      mode: 'preview-size',
    })

    act(() => {
      result.current.pipelineRef.current = {
        renderToHiddenCanvas,
        dispose,
      } as never
    })

    await act(async () => {
      await result.current.copyExportResult()
    })
    await flushScheduledToasts()

    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 640,
      height: 480,
    })
    expect(fakeCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/png',
    )
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalledWith('Preview-size image copied')
  })

  it('aborts and disposes stale runtime session when replacing files', async () => {
    const staleQuickDecode = deferred<DecodedImage>()
    const staleSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockReturnValue(staleQuickDecode.promise),
      decodeBoundedHqRaw: vi.fn(),
      dispose: vi.fn(),
    }
    const currentSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi
        .fn()
        .mockResolvedValue(createDecodedImage('bounded-hq')),
      dispose: vi.fn(),
    }
    let staleSignal: AbortSignal | undefined
    let currentSignal: AbortSignal | undefined

    rawRuntimeMock.openSession
      .mockImplementationOnce((_file: File, signal?: AbortSignal) => {
        staleSignal = signal
        return Promise.resolve(staleSession)
      })
      .mockImplementationOnce((_file: File, signal?: AbortSignal) => {
        currentSignal = signal
        return Promise.resolve(currentSession)
      })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let staleLoadPromise!: Promise<void>
    let currentLoadPromise!: Promise<void>

    await act(async () => {
      staleLoadPromise = result.current.loadFile(
        new File(['stale'], 'stale.ARW'),
      )
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(staleSession.decodeQuickRaw).toHaveBeenCalled()
    })

    await act(async () => {
      currentLoadPromise = result.current.loadFile(
        new File(['current'], 'current.ARW'),
      )
      await currentLoadPromise
    })

    expect(staleSignal).toBeInstanceOf(AbortSignal)
    expect(staleSignal?.aborted).toBe(true)
    expect(staleSession.dispose).toHaveBeenCalledTimes(1)
    expect(currentSignal).toBeInstanceOf(AbortSignal)
    expect(currentSignal?.aborted).toBe(false)
    expect(currentSession.dispose).toHaveBeenCalledTimes(1)
    const replacementSession = jotaiStore.get(currentSessionAtom)
    expect(replacementSession?.sourceFile.name).toBe('current.ARW')

    await act(async () => {
      staleQuickDecode.reject(new Error('stale decode aborted'))
      await staleLoadPromise
    })
    await flushScheduledToasts()

    expect(staleSession.dispose).toHaveBeenCalledTimes(1)
    expect(jotaiStore.get(currentSessionAtom)).toBe(replacementSession)
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeNull()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('ignores a stale quick decode success after a replacement session is ready', async () => {
    const staleQuickDecode = deferred<DecodedImage>()
    const staleSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockReturnValue(staleQuickDecode.promise),
      decodeBoundedHqRaw: vi
        .fn()
        .mockResolvedValue(createDecodedImage('bounded-hq')),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: vi.fn(),
    }
    rawRuntimeMock.openSession.mockImplementationOnce(() =>
      Promise.resolve(staleSession),
    )
    const currentExposure: RawRenderExposure = {
      ev: 0.5,
      multiplier: Math.pow(2, 0.5),
      source: 'image-statistics',
    }
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(
      createDecodedImage('quick', { renderExposure: currentExposure }),
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let staleLoadPromise!: Promise<void>

    await act(async () => {
      staleLoadPromise = result.current.loadFile(
        new File(['stale'], 'stale.ARW'),
      )
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(staleSession.decodeQuickRaw).toHaveBeenCalled()
    })
    await act(async () => {
      await result.current.loadFile(new File(['current'], 'current.ARW'))
    })
    await flushScheduledToasts()
    toastMock.success.mockClear()
    const replacementSession = jotaiStore.get(currentSessionAtom)
    expect(replacementSession?.sourceFile.name).toBe('current.ARW')
    expect(result.current.status).toBe('ready')

    await act(async () => {
      staleQuickDecode.resolve(
        createDecodedImage('quick', {
          width: 10,
          height: 10,
          renderExposure: {
            ev: 2,
            multiplier: 4,
            source: 'image-statistics',
          },
        }),
      )
      await staleLoadPromise
    })
    await flushScheduledToasts()

    expect(result.current.decodedImageRef.current?.renderExposure).toEqual(
      currentExposure,
    )
    expect(jotaiStore.get(currentSessionAtom)).toBe(replacementSession)
    expect(result.current.sourceFileName).toBe('current.ARW')
    expect(result.current.displaySource).toBe('bounded-hq')
    expect(result.current.status).toBe('ready')
    expect(staleSession.probeExportCapability).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
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

  it('ignores a stale export failure after a replacement file is ready', async () => {
    const staleExport = deferred<{ filename: string; blob: Blob }>()
    exportSystemMock.runFullResolutionExportJob.mockReturnValue(
      staleExport.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await result.current.loadFile(new File(['stale'], 'stale.ARW'))
    })
    let staleExportPromise!: Promise<void>
    await act(async () => {
      staleExportPromise = result.current.exportImage()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(exportSystemMock.runFullResolutionExportJob).toHaveBeenCalledTimes(
        1,
      )
    })
    const staleRequest =
      exportSystemMock.runFullResolutionExportJob.mock.calls[0]![0]

    await act(async () => {
      await result.current.loadFile(new File(['current'], 'current.ARW'))
    })
    expect(staleRequest.signal.aborted).toBe(true)
    const replacementSession = jotaiStore.get(currentSessionAtom)
    expect(replacementSession?.sourceFile.name).toBe('current.ARW')

    await act(async () => {
      staleExport.reject(new Error('stale export worker failed'))
      await staleExportPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBe(replacementSession)
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeNull()
    expect(result.current.exportResult).toBeNull()
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Export failed',
      expect.anything(),
    )
  })

  it('preserves ready session across unmount while bounded HQ is still pending', async () => {
    const boundedHqDecode = deferred<DecodedImage>()

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockReturnValue(boundedHqDecode.promise)

    const mounted = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await mounted.result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(mounted.result.current.status).toBe('ready')
    expect(mounted.result.current.displaySource).toBe('quick')
    expect(mounted.result.current.sourceFileName).toBe('frame.ARW')

    act(() => {
      mounted.unmount()
    })

    const preservedSession = jotaiStore.get(currentSessionAtom)
    const remounted = renderHook(() => useRawWorkflow(), { wrapper })
    expect(remounted.result.current.status).toBe('ready')
    expect(remounted.result.current.displaySource).toBe('quick')
    expect(remounted.result.current.sourceFileName).toBe('frame.ARW')
    expect(remounted.result.current.loadedImage.file?.name).toBe('frame.ARW')
    expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
      'frame.ARW',
    )
    expect(jotaiStore.get(currentSessionAtom)).toBe(preservedSession)
    await flushScheduledToasts()
    toastMock.success.mockClear()

    // The previous mount's bounded HQ decode settles into a workflow that no
    // longer owns it.
    await act(async () => {
      boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await flushPromises()
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBe(preservedSession)
    expect(remounted.result.current.displaySource).toBe('quick')
    expect(toastMock.success).not.toHaveBeenCalled()

    // The remounted workflow still routes view writes into the kept session.
    const storedParamsBefore = getProcessingParams()
    act(() => {
      remounted.result.current.setCompareSplit(0.3)
    })
    expect(jotaiStore.get(currentSessionAtom)?.viewState.compareSplit).toBe(0.3)
    expect(remounted.result.current.compareSplit).toBe(0.3)
    expect(getProcessingParams()).toBe(storedParamsBefore)

    remounted.unmount()
  })

  it('keeps a preserved session and its write routing across a StrictMode remount', async () => {
    const mounted = renderHook(() => useRawWorkflow(), { wrapper })
    await act(async () => {
      await mounted.result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })
    act(() => {
      mounted.unmount()
    })
    const preservedSession = jotaiStore.get(currentSessionAtom)
    expect(preservedSession?.sourceFile.name).toBe('frame.ARW')
    vi.mocked(pageMarkers().inspect).mockClear()

    const remounted = renderHook(() => useRawWorkflow(), {
      wrapper,
      reactStrictMode: true,
    })

    // StrictMode replays mount effects, including the unmount cleanup.
    expect(pageMarkers().inspect).toHaveBeenCalledTimes(2)
    expect(jotaiStore.get(currentSessionAtom)).toBe(preservedSession)
    expect(remounted.result.current.status).toBe('ready')
    expect(remounted.result.current.sourceFileName).toBe('frame.ARW')
    expect(remounted.result.current.previewTransform?.sourceId).toBe(
      preservedSession?.id,
    )

    const storedParamsBefore = getProcessingParams()
    act(() => {
      remounted.result.current.setCompareSplit(0.3)
      acceptTransformGeometry(
        remounted.result.current.transform,
        SAMPLE_GEOMETRY,
      )
    })

    expect(jotaiStore.get(currentSessionAtom)).toMatchObject({
      id: preservedSession?.id,
      exportGeometry: SAMPLE_GEOMETRY,
      viewState: { compareSplit: 0.3 },
    })
    expect(getProcessingParams()).toBe(storedParamsBefore)
    expect(remounted.result.current.previewTransform?.active).toBe(true)

    remounted.unmount()
    expect(jotaiStore.get(currentSessionAtom)?.id).toBe(preservedSession?.id)
  })

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

    unmount()

    expect(jotaiStore.get(currentSessionAtom)?.id).toBe(exportedSession?.id)
    expect(jotaiStore.get(currentSessionAtom)?.exportState.status).toBe('ready')
  })

  it('does not mutate the kept session when an export resolves after unmount', async () => {
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

    act(() => {
      mounted.unmount()
    })
    expect(request.signal.aborted).toBe(true)
    const keptSession = jotaiStore.get(currentSessionAtom)
    expect(keptSession?.sourceFile.name).toBe('frame.ARW')

    await act(async () => {
      pendingExport.resolve({
        filename: 'late_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      await exportPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBe(keptSession)
    expect(keptSession?.exportState.result).toBeUndefined()
  })

  it('does not mutate the kept session when an export rejects after unmount', async () => {
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

    act(() => {
      mounted.unmount()
    })
    const keptSession = jotaiStore.get(currentSessionAtom)
    expect(keptSession?.sourceFile.name).toBe('frame.ARW')

    await act(async () => {
      pendingExport.reject(new Error('late export worker failed'))
      await exportPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBe(keptSession)
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Export failed',
      expect.anything(),
    )
  })

  it('aborts and disposes pending bounded HQ runtime session on reset', async () => {
    const boundedHqDecode = deferred<DecodedImage>()
    const runtimeSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi.fn().mockReturnValue(boundedHqDecode.promise),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: vi.fn(),
    }
    let signal: AbortSignal | undefined

    rawRuntimeMock.openSession.mockImplementation(
      (_file: File, nextSignal?: AbortSignal) => {
        signal = nextSignal
        return Promise.resolve(runtimeSession)
      },
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['raw'], 'frame.ARW'))
    })

    expect(result.current.status).toBe('ready')

    act(() => {
      result.current.reset()
    })

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()

    await act(async () => {
      boundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await flushPromises()
    })

    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
  })

  it('aborts and disposes stale pending bounded HQ runtime session when replacing files', async () => {
    const staleBoundedHqDecode = deferred<DecodedImage>()
    const staleSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi.fn().mockReturnValue(staleBoundedHqDecode.promise),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: vi.fn(),
    }
    const currentSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage('quick')),
      decodeBoundedHqRaw: vi
        .fn()
        .mockResolvedValue(createDecodedImage('bounded-hq')),
      probeExportCapability: vi
        .fn()
        .mockResolvedValue(createSupportedCapability()),
      dispose: vi.fn(),
    }
    let staleSignal: AbortSignal | undefined
    let currentSignal: AbortSignal | undefined

    rawRuntimeMock.openSession
      .mockImplementationOnce((_file: File, signal?: AbortSignal) => {
        staleSignal = signal
        return Promise.resolve(staleSession)
      })
      .mockImplementationOnce((_file: File, signal?: AbortSignal) => {
        currentSignal = signal
        return Promise.resolve(currentSession)
      })

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      await result.current.loadFile(new File(['stale'], 'stale.ARW'))
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.sourceFileName).toBe('stale.ARW')

    await act(async () => {
      await result.current.loadFile(new File(['current'], 'current.ARW'))
    })

    expect(staleSignal).toBeInstanceOf(AbortSignal)
    expect(staleSignal?.aborted).toBe(true)
    expect(staleSession.dispose).toHaveBeenCalledTimes(1)
    expect(currentSignal).toBeInstanceOf(AbortSignal)
    expect(currentSignal?.aborted).toBe(false)
    expect(result.current.status).toBe('ready')
    expect(result.current.sourceFileName).toBe('current.ARW')

    await act(async () => {
      staleBoundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await flushPromises()
    })

    expect(staleSession.dispose).toHaveBeenCalledTimes(1)
    expect(result.current.sourceFileName).toBe('current.ARW')
    expect(jotaiStore.get(currentSessionAtom)?.sourceFile.name).toBe(
      'current.ARW',
    )
  })

  it('aborts and disposes runtime session on reset', async () => {
    const quickDecode = deferred<DecodedImage>()
    const runtimeSession = {
      sourceDimensions: defaultSourceDimensions,
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockReturnValue(quickDecode.promise),
      decodeBoundedHqRaw: vi.fn(),
      dispose: vi.fn(),
    }
    let signal: AbortSignal | undefined

    rawRuntimeMock.openSession.mockImplementation(
      (_file: File, nextSignal?: AbortSignal) => {
        signal = nextSignal
        return Promise.resolve(runtimeSession)
      },
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = result.current.loadFile(new File(['raw'], 'frame.ARW'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled()
    })

    act(() => {
      result.current.reset()
    })

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')

    await act(async () => {
      quickDecode.reject(new Error('reset aborted decode'))
      await loadPromise
    })

    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not create embedded object URLs after unmount', async () => {
    const embeddedPreview = deferred<{
      width: number
      height: number
      data: Uint8Array
      mimeType: string
      timings: Record<string, number | undefined>
    } | null>()

    rawRuntimeMock.extractEmbeddedPreview.mockReturnValue(
      embeddedPreview.promise,
    )
    rawRuntimeMock.decodeQuickRaw.mockResolvedValue(createDecodedImage('quick'))
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )

    const { result, unmount } = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = result.current.loadFile(new File(['raw'], 'frame.ARW'))
      await Promise.resolve()
    })

    act(() => {
      unmount()
    })

    await act(async () => {
      embeddedPreview.resolve({
        width: 1600,
        height: 1067,
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/jpeg',
        timings: { total: 8 },
      })
      await loadPromise
    })

    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('ignores stale load failures after a replacement session starts', async () => {
    const currentQuickDecode = deferred<DecodedImage>()
    const currentBoundedHqDecode = deferred<DecodedImage>()

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockReturnValue(currentQuickDecode.promise)
    rawRuntimeMock.decodeBoundedHqRaw.mockReturnValue(
      currentBoundedHqDecode.promise,
    )

    const { result } = renderHook(() => useRawWorkflow(), { wrapper })
    let staleLoadPromise!: Promise<void>
    let currentLoadPromise!: Promise<void>

    await act(async () => {
      staleLoadPromise = result.current.loadFile(
        new File(['stale'], 'stale.ARW'),
      )
      await Promise.resolve()
    })

    await act(async () => {
      currentLoadPromise = result.current.loadFile(
        new File(['current'], 'current.ARW'),
      )
      await Promise.resolve()
    })

    await act(async () => {
      currentQuickDecode.resolve(createDecodedImage('quick'))
      currentBoundedHqDecode.resolve(createDecodedImage('bounded-hq'))
      await currentLoadPromise
    })
    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    // After the ack-before-work reorder, a superseded load bails at the
    // matchesActiveSession check that runs right after openSession resolves,
    // so it never reaches decodeQuickRaw. The stale promise resolves
    // cleanly without surfacing an error to the active session.
    await act(async () => {
      await staleLoadPromise
    })

    expect(result.current.error).toBeNull()
    expect(result.current.sourceFileName).toBe('current.ARW')
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Failed to load RAW file',
      expect.anything(),
    )
  })

  it('clears in-flight loading state on unmount so remount starts idle', async () => {
    const quickDecode = deferred<DecodedImage>()
    // Paint-boundary aware: orchestrator may exit before awaiting this
    // promise. Attach a no-op rejection handler to suppress the
    // spurious unhandled-rejection warning.
    quickDecode.promise.catch(() => undefined)

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockReturnValue(quickDecode.promise)
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )

    const mounted = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = mounted.result.current.loadFile(
        new File(['raw'], 'frame.ARW'),
      )
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mounted.result.current.status).toBe('loading')
    })

    act(() => {
      mounted.unmount()
    })

    const remounted = renderHook(() => useRawWorkflow(), { wrapper })
    expect(remounted.result.current.status).toBe('idle')
    expect(remounted.result.current.displaySource).toBe('none')

    await act(async () => {
      quickDecode.reject(new Error('late decode failed'))
      await loadPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(remounted.result.current.status).toBe('idle')
    expect(remounted.result.current.error).toBeNull()
    expect(toastMock.error).not.toHaveBeenCalledWith(
      'Failed to load RAW file',
      expect.anything(),
    )

    remounted.unmount()
  })

  it('does not recreate the discarded session when a quick decode resolves after unmount', async () => {
    const quickDecode = deferred<DecodedImage>()

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockReturnValue(quickDecode.promise)
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )

    const mounted = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = mounted.result.current.loadFile(
        new File(['raw'], 'frame.ARW'),
      )
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(rawRuntimeMock.decodeQuickRaw).toHaveBeenCalled()
    })

    act(() => {
      mounted.unmount()
    })
    expect(jotaiStore.get(currentSessionAtom)).toBeNull()

    const remounted = renderHook(() => useRawWorkflow(), { wrapper })

    await act(async () => {
      quickDecode.resolve(createDecodedImage('quick'))
      await loadPromise
    })
    await flushScheduledToasts()

    expect(jotaiStore.get(currentSessionAtom)).toBeNull()
    expect(remounted.result.current.status).toBe('idle')
    expect(remounted.result.current.displaySource).toBe('none')
    expect(rawRuntimeMock.probeExportCapability).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()

    remounted.unmount()
  })

  it('preserves completed failure state across unmount after active load failure', async () => {
    const quickDecode = deferred<DecodedImage>()
    // Rejection is racy with the paint-boundary yield; ensure a handler
    // is attached up-front to avoid an unhandled-rejection warning when
    // the rejection lands before the orchestrator resumes.
    quickDecode.promise.catch(() => undefined)

    rawRuntimeMock.extractEmbeddedPreview.mockResolvedValue(null)
    rawRuntimeMock.decodeQuickRaw.mockReturnValue(quickDecode.promise)
    rawRuntimeMock.decodeBoundedHqRaw.mockResolvedValue(
      createDecodedImage('bounded-hq'),
    )

    const mounted = renderHook(() => useRawWorkflow(), { wrapper })
    let loadPromise!: Promise<void>

    await act(async () => {
      loadPromise = mounted.result.current.loadFile(
        new File(['raw'], 'failed.ARW'),
      )
      await Promise.resolve()
    })

    await act(async () => {
      quickDecode.reject(new Error('quick decode failed'))
      await loadPromise
    })

    expect(mounted.result.current.status).toBe('error')
    expect(mounted.result.current.error).toBe('quick decode failed')

    act(() => {
      mounted.unmount()
    })

    const remounted = renderHook(() => useRawWorkflow(), { wrapper })
    expect(remounted.result.current.status).toBe('error')
    expect(remounted.result.current.error).toBe('quick decode failed')
    expect(remounted.result.current.sourceFileName).toBe('failed.ARW')

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
      expect(result.current.activeIntensity).toBe(0.4)
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

      expect(result.current.activeIntensity).toBe(0.33)
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
      // A departure is pinned by what it releases, once each; which session
      // the store keeps for a later mount is not part of these cases.
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

        const remounted = renderHook(() => useRawWorkflow(), { wrapper })
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

        const remounted = renderHook(() => useRawWorkflow(), { wrapper })
        act(() => remounted.unmount())
        await flushPostCommitTasks()

        expect(releases(counted)).toEqual({
          runtimeSessions: [1],
          outputs: [1],
          revokedUrls: ['blob:embedded-1'],
        })
      })
    })
  })
})
