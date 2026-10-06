import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  createBlobOutputResult,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import type {
  CapabilityVector,
  ExportRuntimeResources,
} from '@lumaforge/render-engine/policy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CheckpointBackend,
  ExportCheckpointManifest,
} from '~/lib/export/checkpoint-store'
import { createMemoryCheckpointBackend } from '~/lib/export/checkpoint-store'
import type {
  ExportDebugEvent,
  ExportExecutionPlan,
} from '~/lib/export/execution-profile'
import {
  getExportModeCopy,
  selectExportExecutionPlan,
} from '~/lib/export/execution-profile'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { SourceFingerprintFacts } from '~/lib/export/source-fingerprint'
import { FOLDING_TRANSFORM } from '~/lib/export/transform-geometry-test-cases'
import type { DecodedImage } from '~/lib/raw/decoder'
import {
  resetCapabilityVectorForTest,
  setCapabilityVectorForTest,
} from '~/lib/runtime/capability-vector'
import { composeManualTransform } from '~/modules/transform-demo/transform-render'

import type { ExportResult } from '../../model/export-result'
import type { ExportRecoveryState, ImageSession } from '../../model/session'
import type { ProcessingStatus } from '../../model/workflow'
import type { BuildExportManifestInput } from './attach-export-manifest'
import { ExportManifestUnavailableError } from './attach-export-manifest'
import { createPreExportSnapshot } from './export-evacuation'
import { resolveExportEnvironment } from './export-manifest'
import { clearExportResultState } from './export-state'
import type {
  runFullResolutionExportJob,
  selectCurrentExportExecutionPlan,
} from './export-system'
import type { ExportContext } from './orchestrate-full-res-export'
import { orchestrateFullResExport } from './orchestrate-full-res-export'

const mocks = vi.hoisted(() => ({
  selectCurrentExportExecutionPlan: vi.fn(),
  runFullResolutionExportJob: vi.fn(),
  selectCheckpointResumeExecutionPlan: vi.fn(),
  createOpfsCheckpointBackend: vi.fn(),
  createSourceFingerprint: vi.fn(),
  buildManifestForExportResult: vi.fn(),
  reserveOpfsOutputDirectory: vi.fn(),
  scheduleAbandonedOpfsOutputCollection: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, dismiss: mocks.toastDismiss },
}))

vi.mock('./export-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export-system')>()),
  selectCurrentExportExecutionPlan: mocks.selectCurrentExportExecutionPlan,
  runFullResolutionExportJob: mocks.runFullResolutionExportJob,
}))

vi.mock('./export-evacuation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export-evacuation')>()
  return {
    ...actual,
    createPreExportSnapshot: vi.fn(actual.createPreExportSnapshot),
  }
})

vi.mock('./attach-export-manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attach-export-manifest')>()),
  buildManifestForExportResult: mocks.buildManifestForExportResult,
}))

vi.mock('~/lib/export/checkpoint-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/export/checkpoint-store')>()),
  createOpfsCheckpointBackend: mocks.createOpfsCheckpointBackend,
  selectCheckpointResumeExecutionPlan:
    mocks.selectCheckpointResumeExecutionPlan,
}))

vi.mock('~/lib/export/source-fingerprint', () => ({
  createSourceFingerprint: mocks.createSourceFingerprint,
}))

vi.mock('~/lib/export/opfs-output-lifetime', () => ({
  reserveOpfsOutputDirectory: mocks.reserveOpfsOutputDirectory,
  scheduleAbandonedOpfsOutputCollection:
    mocks.scheduleAbandonedOpfsOutputCollection,
}))

type JobInput = Parameters<typeof runFullResolutionExportJob>[0]
type PlanInput = Parameters<typeof selectCurrentExportExecutionPlan>[0]
type ResumePlanInput = {
  manifest: ExportCheckpointManifest
  fidelity: 'safe' | 'balanced' | 'max'
}
type SetSessionValue = Parameters<ExportContext['atoms']['setSession']>[0]

const FIXED_ISO = '2026-10-05T12:00:00.000Z'
const FIXED_NOW = Date.parse(FIXED_ISO)
const EXPORT_ID = '00000000-0000-4000-8000-000000000001'
const TAB_DIRECTORY = 'tab-page-1'
const FULL_RES_FILENAME = 'frame_neutral_fullres.jpg'

const SOURCE_FILE = new File([new Uint8Array([73, 73, 42, 0])], 'frame.dng', {
  lastModified: 1_700_000_000_000,
})
const JPEG_BLOB = new Blob([new Uint8Array([255, 216, 255, 217])], {
  type: 'image/jpeg',
})
const RAW_RENDER_EXPOSURE = {
  ev: 0.5,
  multiplier: Math.SQRT2,
  source: 'dng-baseline',
} as const

const DEFAULT_PARAMS: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
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

const DESKTOP_CAPABILITY: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: 16,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}

const MOBILE_CAPABILITY: CapabilityVector = {
  coi: false,
  pthread: false,
  deviceMemoryGB: null,
  hwConcurrency: 4,
  webKitClass: 'webkit-mobile',
  deviceFormFactor: 'mobile',
  maybeOpfsSupported: true,
}

const BLOB_RUNTIME: ExportRuntimeResources = {
  opfsSinkAvailable: false,
  opfsAvailableMB: null,
  streamingSinkAvailable: false,
}

const OPFS_RUNTIME: ExportRuntimeResources = {
  opfsSinkAvailable: true,
  opfsAvailableMB: 10_000,
  streamingSinkAvailable: false,
}

const DESKTOP_ACTIVE_PLAN = {
  profileName: 'desktop-fast',
  preferredRows: 512,
  concurrency: 2,
  runtimeMemoryProfile: 'desktop',
  outputSink: 'blob-handoff',
  checkpointMode: 'safe-retry',
} as const

const PRE_EXPORT_OWNERS = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
] as const

const CLIPBOARD_UNAVAILABLE = {
  mode: 'unavailable',
  reason: 'Clipboard image copy is not supported in this browser.',
} as const

const SEALED_MANIFEST = {
  manifest_sha256: 'a'.repeat(64),
  produced_at: '2026-10-05T12:00:01.000Z',
  source_raw: { sha256: 'b'.repeat(64) },
  output: { sha256: 'c'.repeat(64), filename: FULL_RES_FILENAME },
} as unknown as RenderManifest

const OPTIONS = { quality: 'high', fidelity: 'balanced' } as const

/** Its projective horizon crosses the unconstrained output frame. */
const FOLDING_MATRIX = composeManualTransform(
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  FOLDING_TRANSFORM,
  6000 / 4000,
)

/** Committed geometries the engine refuses to plan. */
const INVALID_GEOMETRIES: ReadonlyArray<
  readonly [label: string, geometry: ExportGeometry]
> = [
  [
    'a fold inside the unconstrained frame',
    { matrix: FOLDING_MATRIX, constrainCrop: false },
  ],
  [
    'a matrix missing an entry',
    { matrix: [1, 0, 0, 0, 1, 0, 0, 0], constrainCrop: true },
  ],
  [
    'a non-finite entry',
    { matrix: [1, 0, 0, 0, Number.NaN, 0, 0, 0, 1], constrainCrop: true },
  ],
  [
    'a singular matrix',
    { matrix: [1, 2, 0, 2, 4, 0, 0, 0, 1], constrainCrop: false },
  ],
]

function createSession(
  id = 'session-1',
  overrides: {
    exportState?: Partial<ImageSession['exportState']>
    activeStyle?: ImageSession['activeStyle']
    exportGeometry?: ExportGeometry
  } = {},
): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      file: SOURCE_FILE,
      name: SOURCE_FILE.name,
      extension: 'dng',
      sizeBytes: SOURCE_FILE.size,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'ready', width: 1600, height: 1067 },
      quickDecodePreview: { status: 'ready', width: 1500, height: 1000 },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'quick',
      boundedHqRequiredForExport: false,
    },
    activeStyle: overrides.activeStyle ?? null,
    ...(overrides.exportGeometry
      ? { exportGeometry: overrides.exportGeometry }
      : {}),
    viewState: {
      mode: 'compare',
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
      fullResCapability: { status: 'supported', width: 6000, height: 4000 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
      ...overrides.exportState,
    },
  }
}

function createPreviousResult(): ExportResult {
  return {
    kind: 'full-resolution',
    output: createBlobOutputResult({
      filename: 'previous.jpg',
      blob: JPEG_BLOB,
    }),
    filename: 'previous.jpg',
    width: 6000,
    height: 4000,
    size: JPEG_BLOB.size,
    createdAt: 1,
    copyCapability: CLIPBOARD_UNAVAILABLE,
    manifestState: { status: 'ready' },
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 1500,
    height: 1000,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(0),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 6000, height: 4000 },
    renderExposure: RAW_RENDER_EXPOSURE,
  }
}

function createRecoveredManifest(): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-recovered',
    sourceFingerprint: {
      name: SOURCE_FILE.name,
      size: SOURCE_FILE.size,
      lastModified: SOURCE_FILE.lastModified,
      width: 6000,
      height: 4000,
      hashPrefixHex: 'source-prefix',
    },
    fileName: SOURCE_FILE.name,
    sourceSize: SOURCE_FILE.size,
    sourceLastModified: SOURCE_FILE.lastModified,
    outputWidth: 6000,
    outputHeight: 4000,
    graphFingerprint: '[]',
    profile: 'desktop-fast',
    attempt: 1,
    preferredRows: 512,
    totalRows: 4000,
    recoveryMode: 'safe-retry',
    outputSink: 'opfs-file',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 1024,
    jpegState: 'restart-required',
    updatedAt: '2026-10-04T08:00:00.000Z',
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

/** Lets every pending continuation (including the detached manifest) run. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const cleanups: Array<() => void> = []

type HarnessOptions = {
  session?: ImageSession
  /** The session the React closure rendered with; defaults to the live one. */
  atomsSession?: ImageSession | null
  params?: ProcessingParams
  lut?: LUTData | null
  registry?: ResourceRegistry | null
  capability?: CapabilityVector
  runtime?: ExportRuntimeResources
  planGate?: Promise<void>
  checkpointWrite?: { gate?: Promise<void>; error?: Error }
}

/**
 * A direct ExportContext whose functional setters apply to real test state.
 * Every observable step lands in one ordered trace, prefixed by channel:
 * `state:` for workflow writes, `debug:` for export diagnostics, `service:`
 * for side-effecting collaborators, `toast:` for user notifications and
 * `test:` for the moments a test intervenes.
 */
function createHarness(options: HarnessOptions = {}) {
  const trace: string[] = []
  const debugEvents: ExportDebugEvent[] = []
  const plans: ExportExecutionPlan[] = []
  const planInputs: Array<PlanInput | ResumePlanInput> = []
  const manifestInputs: BuildExportManifestInput[] = []
  const idleTasks: Array<{ task: () => void; timeout?: number }> = []
  const initialSession = options.session ?? createSession()
  const registry =
    options.registry === undefined ? createResourceRegistry() : options.registry
  const capability = options.capability ?? DESKTOP_CAPABILITY
  const runtime = options.runtime ?? BLOB_RUNTIME
  const manifest = deferred<RenderManifest>()
  const checkpointStore = createMemoryCheckpointBackend()
  const checkpointWriteStarted = deferred()
  const state: {
    status: ProcessingStatus | null
    error: string | null | undefined
    progress: number | null
    session: ImageSession | null
    recovery: ExportRecoveryState | null
  } = {
    status: null,
    error: undefined,
    progress: null,
    session: initialSession,
    recovery: null,
  }

  const onDebug = (event: Event) => {
    const detail = (event as CustomEvent<ExportDebugEvent>).detail
    debugEvents.push(detail)
    trace.push(`debug:${detail.type}`)
  }
  window.addEventListener('lumaforge-export-debug', onDebug)
  cleanups.push(() =>
    window.removeEventListener('lumaforge-export-debug', onDebug),
  )

  vi.stubGlobal(
    'requestIdleCallback',
    (task: () => void, idleOptions?: { timeout?: number }) => {
      trace.push('service:requestIdleCallback')
      idleTasks.push({ task, timeout: idleOptions?.timeout })
      return idleTasks.length
    },
  )

  const recordService = (name: string) =>
    vi.fn(() => {
      trace.push(`service:${name}`)
    })

  const refs: ExportContext['refs'] = {
    exportAbortControllerRef: { current: null },
    exportGraphVersionRef: { current: 3 },
    isMountedRef: { current: true },
    sessionRef: { current: initialSession },
    pipelineRef: { current: null },
    resourceRegistryRef: { current: registry },
    previewCopyCanvasRef: { current: null },
  }

  const ctx: ExportContext = {
    atoms: {
      setStatus: vi.fn((status: ProcessingStatus) => {
        state.status = status
        trace.push(`state:status:${status}`)
      }),
      setError: vi.fn((error: string | null) => {
        state.error = error
        trace.push(`state:error:${error}`)
      }),
      setProgress: vi.fn((progress: number) => {
        state.progress = progress
        trace.push(`state:progress:${progress}`)
      }),
      setSession: vi.fn((value: SetSessionValue) => {
        const prev = state.session
        const next = typeof value === 'function' ? value(prev) : value
        state.session = next
        // The workflow re-syncs sessionRef from session state on commit.
        refs.sessionRef.current = next
        trace.push(
          `state:session:${next === prev ? 'unchanged' : (next?.exportState.status ?? 'null')}`,
        )
      }),
      loadedImage: {
        file: SOURCE_FILE,
        metadata: { width: 6000, height: 4000 },
      },
      session:
        options.atomsSession === undefined
          ? initialSession
          : options.atomsSession,
      params: options.params ?? DEFAULT_PARAMS,
      lutDataRef: { current: options.lut ?? null },
      decodedImageRef: { current: createDecodedImage() },
      stats: null,
      setDiscoveredRecoveryState: vi.fn((next: ExportRecoveryState) => {
        state.recovery = next
        trace.push(`state:recovery:${next.status}`)
      }),
    },
    refs,
    services: {
      scheduleToast: vi.fn((notify: () => void) => {
        trace.push('service:scheduleToast')
        notify()
      }),
      // Mirrors the workflow's abortExportWork: abort, then release the ref.
      abortExportWork: vi.fn(() => {
        trace.push('service:abortExportWork')
        const controller = refs.exportAbortControllerRef.current
        if (controller && !controller.signal.aborted) controller.abort()
        refs.exportAbortControllerRef.current = null
      }),
      abortRuntimeWork: recordService('abortRuntimeWork'),
      terminateRawDecodeBridge: recordService('terminateRawDecodeBridge'),
      registerCurrentPreviewPipelineForEvacuation: recordService(
        'registerCurrentPreviewPipelineForEvacuation',
      ),
      registerExportResultResource: recordService(
        'registerExportResultResource',
      ),
      revokeCurrentEmbeddedPreviewUrl: recordService(
        'revokeCurrentEmbeddedPreviewUrl',
      ),
    },
  }

  mocks.toastError.mockImplementation((title: string) => {
    trace.push(`toast:error:${title}`)
  })
  mocks.toastDismiss.mockImplementation(() => {
    trace.push('toast:dismiss')
  })

  // Real plans from the real policy, for an explicitly chosen device.
  mocks.selectCurrentExportExecutionPlan.mockImplementation(
    async (input: PlanInput) => {
      trace.push('service:selectCurrentExportExecutionPlan')
      planInputs.push(input)
      await options.planGate
      const plan = selectExportExecutionPlan({
        performancePreference: input.fidelity,
        sourceWidth: input.sourceWidth,
        sourceHeight: input.sourceHeight,
        previousCrashLikeInterruption:
          input.previousCrashLikeInterruption ?? false,
        previousResourceFailure: input.previousResourceFailure ?? false,
        previousUserInterrupted: input.previousUserInterrupted ?? false,
        capability,
        runtime,
      })
      plans.push(plan)
      return plan
    },
  )
  mocks.selectCheckpointResumeExecutionPlan.mockImplementation(
    async (input: ResumePlanInput) => {
      trace.push('service:selectCheckpointResumeExecutionPlan')
      planInputs.push(input)
      const plan = selectExportExecutionPlan({
        performancePreference: input.fidelity,
        sourceWidth: input.manifest.outputWidth,
        sourceHeight: input.manifest.outputHeight,
        previousCrashLikeInterruption: true,
        capability,
        runtime,
      })
      plans.push(plan)
      return plan
    },
  )

  mocks.createOpfsCheckpointBackend.mockImplementation(
    (): CheckpointBackend => ({
      async write(exportId, checkpointManifest) {
        trace.push(`service:checkpoint-write:${exportId}`)
        checkpointWriteStarted.resolve()
        await options.checkpointWrite?.gate
        if (options.checkpointWrite?.error) throw options.checkpointWrite.error
        await checkpointStore.write(exportId, checkpointManifest)
      },
      list: () => checkpointStore.list(),
      async remove(exportId) {
        trace.push(`service:checkpoint-remove:${exportId}`)
        await checkpointStore.remove(exportId)
      },
      async removeManifest(exportId) {
        trace.push(`service:checkpoint-remove-manifest:${exportId}`)
        await checkpointStore.removeManifest?.(exportId)
      },
    }),
  )
  mocks.reserveOpfsOutputDirectory.mockResolvedValue(TAB_DIRECTORY)
  mocks.createSourceFingerprint.mockImplementation(
    async (file: File, facts: SourceFingerprintFacts = {}) => ({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      width: facts.width,
      height: facts.height,
      hashPrefixHex: 'source-prefix',
    }),
  )

  mocks.buildManifestForExportResult.mockImplementation(
    (input: BuildExportManifestInput) => {
      trace.push('service:buildManifestForExportResult')
      manifestInputs.push(input)
      return manifest.promise
    },
  )

  /**
   * Stands in for the worker job with the real job's attempt order:
   * `started` -> beforeStart -> run -> `disposed` (in finally).
   */
  function installJob() {
    const started = deferred<JobInput>()
    const outcome = deferred<{ error?: unknown }>()
    let jobInput: JobInput | null = null

    mocks.runFullResolutionExportJob.mockImplementation(
      async (input: JobInput) => {
        trace.push('service:runFullResolutionExportJob')
        jobInput = input
        const attempt = {
          attempt: 1,
          profile: input.executionPlan?.profile.name,
          preferredRows: input.executionPlan?.preferredRows,
          concurrency: input.executionPlan?.concurrency,
        }
        input.onAttempt?.({ ...attempt, phase: 'started', freshWorker: true })
        await input.beforeStart?.()
        started.resolve(input)
        try {
          const settled = await outcome.promise
          if ('error' in settled) throw settled.error
          return {
            filename: input.filename,
            output: createBlobOutputResult({
              filename: input.filename,
              blob: JPEG_BLOB,
            }),
            attempts: 1,
          }
        } finally {
          input.onAttempt?.({
            ...attempt,
            phase: 'disposed',
            freshWorker: false,
            priorClientDisposed: true,
          })
        }
      },
    )

    return {
      started: started.promise,
      progress(completedStrips: number, totalStrips: number) {
        jobInput?.onProgress?.({
          completedStrips,
          totalStrips,
          progress: Math.round((completedStrips / totalStrips) * 100),
        })
      },
      resolve: () => outcome.resolve({}),
      reject: (error: unknown) => outcome.resolve({ error }),
    }
  }

  return {
    ctx,
    trace,
    state,
    debugEvents,
    plans,
    planInputs,
    manifestInputs,
    manifest,
    checkpointStore,
    checkpointWriteStarted: checkpointWriteStarted.promise,
    idleTasks,
    installJob,
    mark(label: string) {
      trace.push(`test:${label}`)
      return trace.length - 1
    },
    since(index: number) {
      return trace.slice(index)
    },
    channel(name: 'state' | 'debug' | 'service' | 'toast') {
      return trace.filter((entry) => entry.startsWith(`${name}:`))
    },
    debugPayloads<TType extends ExportDebugEvent['type']>(type: TType) {
      return debugEvents
        .filter(
          (event): event is Extract<ExportDebugEvent, { type: TType }> =>
            event.type === type,
        )
        .map((event) => event.payload)
    },
    replaceSession(next: ImageSession | null) {
      state.session = next
      refs.sessionRef.current = next
    },
  }
}

type Harness = ReturnType<typeof createHarness>

async function runToReady(h: Harness) {
  const job = h.installJob()
  const run = orchestrateFullResExport(OPTIONS, h.ctx)
  await job.started
  job.resolve()
  await run
  const result = h.state.session?.exportState.result
  if (!result) throw new Error('Expected the export to publish a result.')
  return result
}

function stubOpfsDirectory() {
  Object.defineProperty(window.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: vi.fn() },
  })
  cleanups.push(() => {
    delete (window.navigator as { storage?: unknown }).storage
  })
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(EXPORT_ID)
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetCapabilityVectorForTest()
  window.localStorage.clear()
  delete (window as { __LUMAFORGE_EXPORT_DEBUG_HISTORY__?: unknown })
    .__LUMAFORGE_EXPORT_DEBUG_HISTORY__
})

describe('orchestrateFullResExport success', () => {
  it('evacuates the preview, publishes the JPEG as ready, then attaches the sealed manifest', async () => {
    const registry = createResourceRegistry()
    const previousResult = createPreviousResult()
    const h = createHarness({
      registry,
      session: createSession('session-1', {
        exportState: {
          status: 'ready',
          result: previousResult,
          lastSuccessfulSize: { width: 6000, height: 4000 },
        },
      }),
    })
    registry.register({
      id: 'preview-gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      estimatedBytes: 4096,
      dispose: () => {
        h.trace.push('service:dispose:preview-gpu-pipeline')
      },
    })
    h.ctx.refs.previewCopyCanvasRef.current = document.createElement('canvas')
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    const controller = h.ctx.refs.exportAbortControllerRef.current
    job.progress(1, 2)
    job.progress(2, 2)
    job.resolve()
    await run

    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'toast:dismiss',
      'service:selectCurrentExportExecutionPlan',
      'service:registerCurrentPreviewPipelineForEvacuation',
      'debug:export-plan-selected',
      'state:session:exporting',
      'service:abortRuntimeWork',
      'service:revokeCurrentEmbeddedPreviewUrl',
      'service:abortRuntimeWork',
      'state:session:exporting',
      'service:dispose:preview-gpu-pipeline',
      'debug:resource-evacuated',
      'service:runFullResolutionExportJob',
      'debug:export-worker-attempt',
      'service:terminateRawDecodeBridge',
      'state:progress:50',
      'state:session:exporting',
      'debug:export-progress',
      'state:progress:100',
      'state:session:exporting',
      'debug:export-worker-attempt',
      'service:registerExportResultResource',
      'state:session:ready',
      'state:status:ready',
      'service:buildManifestForExportResult',
    ])
    expect(h.channel('debug')).toEqual([
      'debug:export-plan-selected',
      'debug:resource-evacuated',
      'debug:export-worker-attempt',
      'debug:export-progress',
      'debug:export-worker-attempt',
    ])

    const result = h.state.session?.exportState.result
    expect(h.state.session?.exportState).toEqual({
      status: 'ready',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 6000, height: 4000 },
      activePlan: DESKTOP_ACTIVE_PLAN,
      checkpointDurable: false,
      recovery: { status: 'none' },
      result: {
        kind: 'full-resolution',
        output: {
          kind: 'blob',
          filename: FULL_RES_FILENAME,
          blob: JPEG_BLOB,
          byteLength: JPEG_BLOB.size,
          mimeType: 'image/jpeg',
        },
        filename: FULL_RES_FILENAME,
        width: 6000,
        height: 4000,
        size: JPEG_BLOB.size,
        createdAt: FIXED_NOW,
        copyCapability: CLIPBOARD_UNAVAILABLE,
        manifestState: { status: 'sealing' },
      },
      lastProgress: { completedStrips: 2, totalStrips: 2 },
      retryRecommended: false,
      lastSuccessfulSize: { width: 6000, height: 4000 },
    })
    expect(result).not.toBe(previousResult)
    expect(h.state).toMatchObject({
      status: 'ready',
      progress: 100,
      error: null,
    })
    expect(h.ctx.services.registerExportResultResource).toHaveBeenCalledWith(
      result,
    )
    expect(
      vi.mocked(h.ctx.services.registerExportResultResource).mock.calls[0][0],
    ).toBe(result)
    expect(controller?.signal.aborted).toBe(false)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
    expect(h.ctx.refs.previewCopyCanvasRef.current).toBeNull()
    expect(registry.snapshot().live).toEqual([])

    expect(h.planInputs).toEqual([
      {
        fidelity: 'balanced',
        sourceWidth: 6000,
        sourceHeight: 4000,
        previousCrashLikeInterruption: undefined,
        previousResourceFailure: false,
        previousUserInterrupted: false,
      },
    ])
    expect(input).toMatchObject({
      file: SOURCE_FILE,
      filename: FULL_RES_FILENAME,
      quality: 0.92,
      checkpoint: undefined,
    })
    expect(input.outputLocation).toBeUndefined()
    expect(input).not.toHaveProperty('geometry')
    expect(input.executionPlan).toBe(h.plans[0])
    expect(input.beforeStart).toBe(h.ctx.services.terminateRawDecodeBridge)
    expect(input.signal).toBe(controller?.signal)
    expect(input.graph).toMatchObject({ supported: true, lutProfile: null })
    expect(input.graph.steps[1]).toEqual({
      kind: 'raw-render-exposure',
      ev: RAW_RENDER_EXPOSURE.ev,
      multiplier: RAW_RENDER_EXPOSURE.multiplier,
    })

    expect(h.debugPayloads('export-plan-selected')).toEqual([
      expect.objectContaining({
        profile: 'desktop-fast',
        preferredRows: 512,
        concurrency: 2,
        runtimeMemoryProfile: 'desktop',
        outputSink: 'blob-handoff',
        checkpointMode: 'safe-retry',
        checkpointDurableExpected: false,
      }),
    ])
    expect(h.debugPayloads('resource-evacuated')).toEqual([
      {
        profile: 'desktop-fast',
        requiredOwners: [...PRE_EXPORT_OWNERS],
        disposedOwners: [...PRE_EXPORT_OWNERS],
        registryCheck: { ok: true },
        remainingLive: [],
        estimatedBytesByOwner: {},
        totalEstimatedBytes: 0,
        evacuatedAt: FIXED_ISO,
      },
    ])
    expect(h.debugPayloads('export-worker-attempt')).toEqual([
      {
        attempt: 1,
        profile: 'desktop-fast',
        preferredRows: 512,
        concurrency: 2,
        phase: 'started',
        freshWorker: true,
      },
      {
        attempt: 1,
        profile: 'desktop-fast',
        preferredRows: 512,
        concurrency: 2,
        phase: 'disposed',
        freshWorker: false,
        priorClientDisposed: true,
      },
    ])
    expect(h.debugPayloads('export-progress')).toEqual([
      {
        completedStrips: 2,
        totalStrips: 2,
        progress: 100,
        recordedAt: FIXED_ISO,
      },
    ])

    expect(h.manifestInputs).toHaveLength(1)
    const manifestInput = h.manifestInputs[0]
    expect(manifestInput.result).toBe(result)
    expect(manifestInput.graph).toBe(input.graph)
    expect(manifestInput.params).toBe(h.ctx.atoms.params)
    expect(manifestInput).toMatchObject({
      sourceFile: SOURCE_FILE,
      rawRenderExposure: RAW_RENDER_EXPOSURE,
      sourceDimensions: { width: 6000, height: 4000 },
      style: null,
      quality: 0.92,
      policy: { kind: 'export-full', row_slice: 512, concurrency: 2 },
      environment: resolveExportEnvironment('desktop'),
    })
    expect(manifestInput).not.toHaveProperty('geometry')

    const sealedAt = h.mark('manifest-sealed')
    h.manifest.resolve(SEALED_MANIFEST)
    await settle()

    expect(h.since(sealedAt)).toEqual([
      'test:manifest-sealed',
      'state:session:ready',
      'debug:export-manifest-ready',
    ])
    expect(h.state.session?.exportState.result).toEqual({
      ...result,
      manifest: SEALED_MANIFEST,
      manifestState: { status: 'ready' },
    })
    expect(h.state.session?.exportState.result?.output).toBe(result?.output)
    expect(h.debugPayloads('export-manifest-ready')).toEqual([
      {
        manifestSha256: 'a'.repeat(64),
        outputSha256: 'c'.repeat(64),
        sourceSha256: 'b'.repeat(64),
        filename: FULL_RES_FILENAME,
        producedAt: '2026-10-05T12:00:01.000Z',
      },
    ])
  })

  it('sizes the job, result and manifest from the committed geometry', async () => {
    const geometry: ExportGeometry = {
      matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
      constrainCrop: true,
    }
    const planned = planExportGeometry(geometry, { width: 6000, height: 4000 })
    const delivered = {
      width: planned.outputWidth,
      height: planned.outputHeight,
    }
    expect(delivered.width).toBeLessThan(6000)
    const h = createHarness({
      session: createSession('session-1', { exportGeometry: geometry }),
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(
      { quality: 'standard', fidelity: 'balanced' },
      h.ctx,
    )
    const input = await job.started
    job.resolve()
    await run

    expect(input.geometry).toBe(geometry)
    expect(input.quality).toBe(0.86)
    expect(h.state.session?.exportState.result).toMatchObject(delivered)
    expect(h.state.session?.exportState.lastSuccessfulSize).toEqual(delivered)
    expect(h.manifestInputs[0]).toMatchObject({
      sourceDimensions: { width: 6000, height: 4000 },
      geometry: {
        matrix: geometry.matrix,
        constrain_crop: true,
        output: delivered,
      },
      quality: 0.86,
    })
  })

  it('journals the frame a committed geometry delivers, not the sensor frame', async () => {
    // Constraining the crop pulls the fold back inside its horizon.
    const geometry: ExportGeometry = {
      matrix: FOLDING_MATRIX,
      constrainCrop: true,
    }
    const planned = planExportGeometry(geometry, { width: 6000, height: 4000 })
    const delivered = {
      width: planned.outputWidth,
      height: planned.outputHeight,
    }
    expect(delivered.width).toBeLessThan(6000)
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      session: createSession('session-1', { exportGeometry: geometry }),
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started

    expect(await h.checkpointStore.list()).toEqual([
      expect.objectContaining({
        exportId: EXPORT_ID,
        outputWidth: delivered.width,
        outputHeight: delivered.height,
        totalRows: delivered.height,
      }),
    ])
    expect(input.geometry).toBe(geometry)
    job.resolve()
    await run

    expect(h.state.session?.exportState.result).toMatchObject(delivered)
    expect(h.state.session?.exportState.lastSuccessfulSize).toEqual(delivered)
  })

  it('writes a durable checkpoint on resume, clears recovery and removes both manifests after success', async () => {
    const recoveredManifest = createRecoveredManifest()
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const job = h.installJob()

    const run = orchestrateFullResExport(
      {
        ...OPTIONS,
        previousInterrupted: true,
        recoveredExportId: 'export-recovered',
        recoveredManifest,
      },
      h.ctx,
    )
    const input = await job.started
    expect(await h.checkpointStore.list()).toEqual([
      expect.objectContaining({
        exportId: EXPORT_ID,
        fileName: SOURCE_FILE.name,
        outputWidth: 6000,
        outputHeight: 4000,
        totalRows: 4000,
        graphFingerprint: JSON.stringify(input.graph.steps),
        recoveryMode: 'safe-retry',
        jpegState: 'restart-required',
        completedRowsForDiagnostics: 0,
        updatedAt: FIXED_ISO,
      }),
    ])
    job.resolve()
    await run

    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'toast:dismiss',
      'service:selectCheckpointResumeExecutionPlan',
      `service:checkpoint-write:${EXPORT_ID}`,
      'debug:checkpoint-written',
      'state:recovery:none',
      'service:registerCurrentPreviewPipelineForEvacuation',
      'debug:export-plan-selected',
      'state:session:exporting',
      'service:abortRuntimeWork',
      'service:revokeCurrentEmbeddedPreviewUrl',
      'service:abortRuntimeWork',
      'state:session:exporting',
      'debug:resource-evacuated',
      'service:runFullResolutionExportJob',
      'debug:export-worker-attempt',
      'service:terminateRawDecodeBridge',
      'debug:export-worker-attempt',
      'service:registerExportResultResource',
      'state:session:ready',
      'state:status:ready',
      'service:requestIdleCallback',
      'service:buildManifestForExportResult',
    ])
    expect(mocks.selectCurrentExportExecutionPlan).not.toHaveBeenCalled()
    expect(h.planInputs).toEqual([
      { manifest: recoveredManifest, fidelity: 'balanced' },
    ])
    expect(h.plans[0]).toMatchObject({
      outputSink: 'opfs-file',
      productCopy: 'interrupted-retry',
    })
    expect(input.outputLocation).toEqual({
      sink: 'opfs-file',
      tabDirectory: TAB_DIRECTORY,
      exportId: EXPORT_ID,
    })
    expect(input.checkpoint).toEqual({
      exportId: EXPORT_ID,
      graphFingerprint: JSON.stringify(input.graph.steps),
      sourceFingerprint: {
        name: SOURCE_FILE.name,
        size: SOURCE_FILE.size,
        lastModified: SOURCE_FILE.lastModified,
        width: 6000,
        height: 4000,
        hashPrefixHex: 'source-prefix',
      },
    })
    expect(h.debugPayloads('checkpoint-written')).toEqual([
      {
        exportId: EXPORT_ID,
        completedRowsForDiagnostics: 0,
        totalRows: 4000,
        updatedAt: FIXED_ISO,
      },
    ])
    expect(h.debugPayloads('export-plan-selected')).toEqual([
      expect.objectContaining({
        outputSink: 'opfs-file',
        checkpointDurableExpected: true,
      }),
    ])
    expect(h.state.recovery).toEqual({ status: 'none' })
    expect(h.state.session?.exportState).toMatchObject({
      status: 'ready',
      checkpointDurable: true,
      activePlan: { outputSink: 'opfs-file' },
    })

    // Cleanup waits for idle time so it never delays the ready state.
    expect(await h.checkpointStore.list()).toHaveLength(1)
    expect(h.idleTasks).toEqual([{ task: expect.any(Function), timeout: 2000 }])
    const idleAt = h.mark('idle')
    h.idleTasks[0].task()
    await settle()

    expect(h.since(idleAt)).toEqual([
      'test:idle',
      `service:checkpoint-remove-manifest:${EXPORT_ID}`,
      'service:checkpoint-remove-manifest:export-recovered',
    ])
    expect(await h.checkpointStore.list()).toEqual([])
  })

  it("writes an OPFS output under this tab's directory and leaves collecting closed tabs to idle time", async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started

    // Scheduled once the plan exists, and never awaited by the export.
    expect(mocks.scheduleAbandonedOpfsOutputCollection).toHaveBeenCalledTimes(1)
    expect(mocks.scheduleAbandonedOpfsOutputCollection).toHaveBeenCalledWith()
    const [scheduledAt] =
      mocks.scheduleAbandonedOpfsOutputCollection.mock.invocationCallOrder
    expect(scheduledAt).toBeGreaterThan(
      mocks.selectCurrentExportExecutionPlan.mock.invocationCallOrder[0]!,
    )
    expect(scheduledAt).toBeLessThan(
      mocks.runFullResolutionExportJob.mock.invocationCallOrder[0]!,
    )
    expect(mocks.reserveOpfsOutputDirectory).toHaveBeenCalledTimes(1)
    expect(input.outputLocation).toEqual({
      sink: 'opfs-file',
      tabDirectory: TAB_DIRECTORY,
      exportId: EXPORT_ID,
    })
    expect(input.checkpoint?.exportId).toBe(EXPORT_ID)

    job.resolve()
    await run

    expect(h.state.session?.exportState.status).toBe('ready')
  })

  it('schedules the collection for an in-memory plan without reserving a tab directory', async () => {
    const h = createHarness()
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    job.resolve()
    await run

    expect(input.executionPlan?.outputSink).toBe('blob-handoff')
    expect(input.outputLocation).toBeUndefined()
    expect(mocks.scheduleAbandonedOpfsOutputCollection).toHaveBeenCalledTimes(1)
    expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
    expect(h.state.session?.exportState.status).toBe('ready')
  })

  it.each([
    {
      name: 'the checkpoint write fails',
      options: {
        checkpointWrite: { error: new Error('QuotaExceededError') },
      },
      failFingerprint: false,
    },
    {
      name: 'fingerprinting the source fails',
      options: {},
      failFingerprint: true,
    },
  ])(
    'keeps writing to OPFS without durability when $name',
    async ({ options, failFingerprint }) => {
      const h = createHarness({ runtime: OPFS_RUNTIME, ...options })
      if (failFingerprint) {
        mocks.createSourceFingerprint.mockRejectedValue(
          new Error('NotReadableError'),
        )
      }
      const job = h.installJob()

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      const input = await job.started
      job.resolve()
      await run

      expect(h.channel('debug')).toEqual([
        'debug:export-plan-selected',
        'debug:resource-evacuated',
        'debug:export-worker-attempt',
        'debug:export-worker-attempt',
      ])
      // The plan diagnostic reports the durability the plan expected, not the
      // durability the failed write actually delivered.
      expect(h.debugPayloads('export-plan-selected')).toEqual([
        expect.objectContaining({
          outputSink: 'opfs-file',
          checkpointDurableExpected: true,
        }),
      ])
      // Only durability changes: the job still writes the planned OPFS file.
      expect(input.executionPlan?.outputSink).toBe('opfs-file')
      expect(input.outputLocation).toEqual({
        sink: 'opfs-file',
        tabDirectory: TAB_DIRECTORY,
        exportId: EXPORT_ID,
      })
      expect(input.checkpoint).toBeUndefined()
      expect(h.state.session?.exportState).toMatchObject({
        status: 'ready',
        checkpointDurable: false,
        activePlan: { outputSink: 'opfs-file' },
      })
      expect(h.idleTasks).toEqual([])
      expect(await h.checkpointStore.list()).toEqual([])
    },
  )

  it('reports a replacement plan from the job as the active plan before its worker runs', async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const job = h.installJob()
    const blobPlan = selectExportExecutionPlan({
      performancePreference: 'balanced',
      sourceWidth: 6000,
      sourceHeight: 4000,
      capability: DESKTOP_CAPABILITY,
      runtime: BLOB_RUNTIME,
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    expect(h.state.session?.exportState.activePlan?.outputSink).toBe(
      'opfs-file',
    )
    const replacedAt = h.mark('replacement-plan')
    input.onPlan?.(blobPlan)

    expect(h.since(replacedAt)).toEqual([
      'test:replacement-plan',
      'debug:export-plan-selected',
      'state:session:exporting',
    ])
    expect(h.state.session?.exportState).toMatchObject({
      status: 'exporting',
      activePlan: DESKTOP_ACTIVE_PLAN,
      // The journal was written for this export; the sink change does not
      // rewrite its durability.
      checkpointDurable: true,
    })
    expect(h.debugPayloads('export-plan-selected')).toEqual([
      expect.objectContaining({
        outputSink: 'opfs-file',
        checkpointDurableExpected: true,
      }),
      expect.objectContaining({
        outputSink: 'blob-handoff',
        checkpointDurableExpected: false,
      }),
    ])

    job.resolve()
    await run
    expect(h.state.session?.exportState).toMatchObject({
      status: 'ready',
      activePlan: DESKTOP_ACTIVE_PLAN,
    })
  })

  it('ignores a replacement plan reported after the export was superseded', async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    h.ctx.refs.exportGraphVersionRef.current += 1
    const sessionAfterSupersession = h.state.session
    const replacedAt = h.mark('replacement-plan')
    input.onPlan?.(h.plans[0]!)
    job.resolve()
    await run

    expect(h.since(replacedAt)).toEqual(['test:replacement-plan'])
    expect(h.state.session).toBe(sessionAfterSupersession)
  })
})

describe('orchestrateFullResExport refusals', () => {
  it('refuses with a toast and no state writes when the rendered session is not the live session', async () => {
    const h = createHarness({
      atomsSession: createSession('session-rendered-earlier'),
    })
    const liveSession = h.state.session
    const otherExport = new AbortController()
    h.ctx.refs.exportAbortControllerRef.current = otherExport

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.trace).toEqual([
      'service:scheduleToast',
      'toast:error:Full-resolution export is not ready',
    ])
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Full-resolution export is not ready',
      { description: 'Full-resolution export source is still loading.' },
    )
    expect(h.state).toEqual({
      status: null,
      error: undefined,
      progress: null,
      session: liveSession,
      recovery: null,
    })
    expect(otherExport.signal.aborted).toBe(false)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    expect(mocks.selectCurrentExportExecutionPlan).not.toHaveBeenCalled()
  })

  it.each(INVALID_GEOMETRIES)(
    'refuses %s before checkpoint, evacuation or worker work',
    async (_label, geometry) => {
      expect(() =>
        planExportGeometry(geometry, { width: 6000, height: 4000 }),
      ).toThrow(INVALID_EXPORT_GEOMETRY)
      const registry = createResourceRegistry()
      const previousResult = createPreviousResult()
      // A durable OPFS plan journals before the worker starts, so a refusal
      // that came late would leave a checkpoint behind.
      const h = createHarness({
        registry,
        runtime: OPFS_RUNTIME,
        session: createSession('session-1', {
          exportGeometry: geometry,
          exportState: { status: 'ready', result: previousResult },
        }),
      })
      registry.register({
        id: 'preview-gpu-pipeline',
        owner: 'gpu',
        kind: 'gpu-pipeline',
        estimatedBytes: 4096,
        dispose: () => {
          h.trace.push('service:dispose:preview-gpu-pipeline')
        },
      })
      const liveSession = h.state.session
      const otherExport = new AbortController()
      h.ctx.refs.exportAbortControllerRef.current = otherExport

      await orchestrateFullResExport(OPTIONS, h.ctx)

      expect(h.trace).toEqual([
        'service:scheduleToast',
        'toast:error:Full-resolution export is not ready',
      ])
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Full-resolution export is not ready',
        {
          description:
            'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.',
        },
      )
      // Nothing was planned, journaled, evacuated or started.
      expect(h.planInputs).toEqual([])
      expect(mocks.createOpfsCheckpointBackend).not.toHaveBeenCalled()
      expect(await h.checkpointStore.list()).toEqual([])
      expect(
        h.ctx.services.registerCurrentPreviewPipelineForEvacuation,
      ).not.toHaveBeenCalled()
      expect(h.ctx.services.abortRuntimeWork).not.toHaveBeenCalled()
      expect(registry.snapshot().live).toHaveLength(1)
      expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(h.state).toEqual({
        status: null,
        error: undefined,
        progress: null,
        session: liveSession,
        recovery: null,
      })
      expect(liveSession?.exportState.result).toBe(previousResult)
      expect(otherExport.signal.aborted).toBe(false)
      expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    },
  )

  it('refuses an unsupported color graph without touching other export work', async () => {
    const lut: LUTData = {
      size: 2,
      data: new Float32Array(2 * 2 * 2 * 3),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      title: 'Teal',
      inputProfile: 'display-srgb',
      profileResolution: { kind: 'unknown' },
    }
    const h = createHarness({
      params: { ...DEFAULT_PARAMS, styleKind: 'custom' },
      lut,
      session: createSession('session-1', {
        activeStyle: {
          kind: 'custom',
          name: 'Teal',
          defaultIntensity: 0.7,
          currentIntensity: 0.7,
          lutAsset: { format: 'cube', dimension: 17 },
        },
        exportState: {
          status: 'ready',
          result: createPreviousResult(),
        },
      }),
    })
    const otherExport = new AbortController()
    h.ctx.refs.exportAbortControllerRef.current = otherExport

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.trace).toEqual([
      'state:error:Choose a LUT input profile before full-resolution export.',
      'state:status:error',
      'state:session:failed',
    ])
    expect(h.state.session?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_UNSUPPORTED_PIPELINE',
      retryRecommended: false,
    })
    expect(h.state.session?.exportState.result).toBeUndefined()
    expect(h.state.session?.exportState.recommendedRetryLevel).toBeUndefined()
    expect(h.state.status).toBe('error')
    expect(h.state.error).toBe(
      'Choose a LUT input profile before full-resolution export.',
    )
    expect(otherExport.signal.aborted).toBe(false)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    expect(mocks.selectCurrentExportExecutionPlan).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('fails closed when the run-time plan cannot safely complete after readiness passed', async () => {
    // Readiness assumes OPFS has room; the run-time quota says it does not.
    setCapabilityVectorForTest(MOBILE_CAPABILITY)
    stubOpfsDirectory()
    const h = createHarness({
      capability: MOBILE_CAPABILITY,
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: 100,
        streamingSinkAvailable: false,
      },
      session: createSession('session-1', {
        exportState: {
          fullResCapability: { status: 'supported', width: 9000, height: 6000 },
        },
      }),
    })

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.plans[0]).toMatchObject({
      outputSink: 'blob-handoff',
      productCopy: 'cannot-safely-complete',
    })
    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'toast:dismiss',
      'service:selectCurrentExportExecutionPlan',
      'state:session:failed',
      'state:status:ready',
      'service:scheduleToast',
      'toast:error:Export failed',
    ])
    expect(mocks.toastError).toHaveBeenCalledWith('Export failed', {
      description: getExportModeCopy('cannot-safely-complete'),
    })
    expect(h.state.session?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_POLICY_CANNOT_COMPLETE',
      retryRecommended: false,
    })
    expect(h.state.session?.exportState.activePlan).toBeUndefined()
    expect(h.state.session?.exportState.recommendedRetryLevel).toBeUndefined()
    expect(
      h.ctx.services.registerCurrentPreviewPipelineForEvacuation,
    ).not.toHaveBeenCalled()
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
  })
})

describe('orchestrateFullResExport failures', () => {
  it.each([
    {
      name: 'a retryable worker failure at balanced fidelity',
      error: new Error('FULL_RES_EXPORT_WORKER_FAILED'),
      fidelity: 'balanced',
      code: 'FULL_RES_EXPORT_WORKER_FAILED',
      retryLevel: 'safe',
      description: 'FULL_RES_EXPORT_WORKER_FAILED. Retry with safe fidelity.',
    },
    {
      name: 'a resource failure at max fidelity',
      error: new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'),
      fidelity: 'max',
      code: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      retryLevel: 'balanced',
      description:
        'FULL_RES_EXPORT_RESOURCE_FAILURE. Retry with balanced fidelity.',
    },
    {
      name: 'a retryable failure with no safer fidelity left',
      error: new Error('FULL_RES_EXPORT_WORKER_FAILED'),
      fidelity: 'safe',
      code: 'FULL_RES_EXPORT_WORKER_FAILED',
      retryLevel: undefined,
      description: 'FULL_RES_EXPORT_WORKER_FAILED',
    },
    {
      name: 'an unclassified failure',
      error: new Error('decoder exploded'),
      fidelity: 'balanced',
      code: 'EXPORT_RENDER_FAILED',
      retryLevel: undefined,
      description: 'decoder exploded',
    },
    {
      name: 'a coded failure',
      error: Object.assign(new Error('Output sink closed'), {
        code: 'EXPORT_OUTPUT_SINK_FAILED',
      }),
      fidelity: 'balanced',
      code: 'EXPORT_OUTPUT_SINK_FAILED',
      retryLevel: undefined,
      description: 'Output sink closed',
    },
  ] as const)(
    'records $name as a failed export without a result',
    async ({ error, fidelity, code, retryLevel, description }) => {
      const h = createHarness()
      const job = h.installJob()

      const run = orchestrateFullResExport({ quality: 'high', fidelity }, h.ctx)
      await job.started
      job.progress(1, 4)
      const failedAt = h.mark('worker-failed')
      job.reject(error)
      await run
      await settle()

      expect(h.since(failedAt)).toEqual([
        'test:worker-failed',
        'debug:export-worker-attempt',
        'state:session:failed',
        'state:status:ready',
        'service:scheduleToast',
        'toast:error:Export failed',
      ])
      expect(mocks.toastError).toHaveBeenCalledWith('Export failed', {
        description,
      })
      expect(h.state.session?.exportState).toMatchObject({
        status: 'failed',
        lastErrorCode: code,
        retryRecommended: Boolean(retryLevel),
        lastProgress: { completedStrips: 1, totalStrips: 4 },
        activePlan: { outputSink: 'blob-handoff' },
      })
      expect(h.state.session?.exportState.recommendedRetryLevel).toBe(
        retryLevel,
      )
      expect(h.state.session?.exportState.result).toBeUndefined()
      expect(h.state).toMatchObject({ status: 'ready', progress: 25 })
      expect(h.ctx.services.registerExportResultResource).not.toHaveBeenCalled()
      expect(mocks.buildManifestForExportResult).not.toHaveBeenCalled()
      expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
    },
  )

  it('fails before evacuation when the resource registry is missing', async () => {
    const h = createHarness({ registry: null })

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'toast:dismiss',
      'service:selectCurrentExportExecutionPlan',
      'service:registerCurrentPreviewPipelineForEvacuation',
      'debug:export-plan-selected',
      'state:session:exporting',
      'state:session:failed',
      'state:status:ready',
      'service:scheduleToast',
      'toast:error:Export failed',
    ])
    expect(mocks.toastError).toHaveBeenCalledWith('Export failed', {
      description: 'EXPORT_RESOURCE_REGISTRY_MISSING',
    })
    expect(h.state.session?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_RESOURCE_REGISTRY_MISSING',
      retryRecommended: false,
    })
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'a resource refuses to dispose',
      register(registry: ResourceRegistry) {
        registry.register({
          id: 'preview-gpu-pipeline',
          owner: 'gpu',
          kind: 'gpu-pipeline',
          dispose: () => {
            throw new Error('device lost')
          },
        })
      },
      evacuatedTrace: [],
      description:
        'Export resources could not be evacuated before worker start.',
    },
    {
      name: 'a resource registers during evacuation',
      register(registry: ResourceRegistry) {
        registry.register({
          id: 'preview-gpu-pipeline',
          owner: 'gpu',
          kind: 'gpu-pipeline',
          dispose: () => {
            registry.register({
              id: 'late-preview-frame',
              owner: 'preview',
              kind: 'array-buffer',
              dispose: () => {},
            })
          },
        })
      },
      evacuatedTrace: ['debug:resource-evacuated'],
      description: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
    },
  ])(
    'fails closed before the worker starts when $name',
    async ({ register, evacuatedTrace, description }) => {
      const registry = createResourceRegistry()
      register(registry)
      const h = createHarness({ registry })

      await orchestrateFullResExport(OPTIONS, h.ctx)

      expect(
        h.trace.slice(h.trace.indexOf('debug:export-plan-selected')),
      ).toEqual([
        'debug:export-plan-selected',
        'state:session:exporting',
        'service:abortRuntimeWork',
        'service:revokeCurrentEmbeddedPreviewUrl',
        'service:abortRuntimeWork',
        'state:session:exporting',
        ...evacuatedTrace,
        'state:session:failed',
        'state:status:ready',
        'service:scheduleToast',
        'toast:error:Export failed',
      ])
      expect(mocks.toastError).toHaveBeenCalledWith('Export failed', {
        description,
      })
      expect(h.state.session?.exportState).toMatchObject({
        status: 'failed',
        lastErrorCode: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
        retryRecommended: false,
      })
      expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
      if (evacuatedTrace.length > 0) {
        expect(h.debugPayloads('resource-evacuated')).toEqual([
          expect.objectContaining({
            registryCheck: {
              ok: false,
              live: [
                {
                  id: 'late-preview-frame',
                  owner: 'preview',
                  kind: 'array-buffer',
                },
              ],
            },
          }),
        ])
      }
    },
  )
})

describe('orchestrateFullResExport cancellation and supersession', () => {
  it('stays silent when cancelled mid-job and leaves a newer export controller in place', async () => {
    const h = createHarness()
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    const cancelled = h.ctx.refs.exportAbortControllerRef.current
    const cancelAt = h.mark('cancel')
    h.ctx.services.abortExportWork()
    const newer = new AbortController()
    h.ctx.refs.exportAbortControllerRef.current = newer
    job.progress(2, 2)
    job.reject(new DOMException('Aborted', 'AbortError'))
    await run
    await settle()

    expect(h.since(cancelAt)).toEqual([
      'test:cancel',
      'service:abortExportWork',
    ])
    expect(cancelled?.signal.aborted).toBe(true)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBe(newer)
    expect(newer.signal.aborted).toBe(false)
    // The orchestrator leaves the exporting state for whoever cancelled it.
    expect(h.state.status).toBe('exporting')
    expect(h.state.session?.exportState.status).toBe('exporting')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  const supersessions = [
    {
      name: 'export signal is aborted',
      supersede(h: Harness) {
        h.ctx.refs.exportAbortControllerRef.current?.abort()
      },
    },
    {
      name: 'export graph version advances',
      supersede(h: Harness) {
        h.ctx.refs.exportGraphVersionRef.current += 1
      },
    },
    {
      name: 'session is replaced',
      supersede(h: Harness) {
        h.replaceSession(createSession('session-2'))
      },
    },
    {
      name: 'view unmounts',
      supersede(h: Harness) {
        h.ctx.refs.isMountedRef.current = false
      },
    },
  ]

  it.each(supersessions)(
    'does not publish a JPEG that completes after the $name',
    async ({ supersede }) => {
      const h = createHarness()
      const job = h.installJob()

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      await job.started
      const supersededAt = h.mark('superseded')
      supersede(h)
      const sessionAfterSupersession = h.state.session
      job.progress(2, 2)
      job.resolve()
      await run
      await settle()

      expect(h.since(supersededAt)).toEqual(['test:superseded'])
      expect(h.state.session).toBe(sessionAfterSupersession)
      expect(h.state.session?.exportState.result).toBeUndefined()
      expect(h.state.status).toBe('exporting')
      expect(h.ctx.services.registerExportResultResource).not.toHaveBeenCalled()
      expect(mocks.buildManifestForExportResult).not.toHaveBeenCalled()
      expect(h.ctx.refs.previewCopyCanvasRef.current).toBeNull()
      expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
    },
  )

  it.each(supersessions)(
    'does not record a failure that arrives after the $name',
    async ({ supersede }) => {
      const h = createHarness()
      const job = h.installJob()

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      await job.started
      const supersededAt = h.mark('superseded')
      supersede(h)
      const sessionAfterSupersession = h.state.session
      job.reject(new Error('FULL_RES_EXPORT_WORKER_FAILED'))
      await run
      await settle()

      expect(h.since(supersededAt)).toEqual(['test:superseded'])
      expect(h.state.session).toBe(sessionAfterSupersession)
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
    },
  )

  it('drops an export superseded while its plan is being selected', async () => {
    const planGate = deferred()
    const h = createHarness({ planGate: planGate.promise })
    const replacement = createSession('session-2')

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const supersededAt = h.mark('superseded')
    h.replaceSession(replacement)
    planGate.resolve()
    await run

    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'toast:dismiss',
      'service:selectCurrentExportExecutionPlan',
      'test:superseded',
    ])
    expect(h.since(supersededAt)).toEqual(['test:superseded'])
    expect(h.state.session).toBe(replacement)
    // Visible status is left for the owner that superseded the export.
    expect(h.state.status).toBe('exporting')
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
  })

  it('drops an export superseded while its checkpoint is written, leaving the checkpoint behind', async () => {
    const writeGate = deferred()
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      checkpointWrite: { gate: writeGate.promise },
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await h.checkpointWriteStarted
    const supersededAt = h.mark('superseded')
    h.replaceSession(createSession('session-2'))
    writeGate.resolve()
    await run

    expect(h.since(supersededAt)).toEqual(['test:superseded'])
    expect(h.debugPayloads('checkpoint-written')).toEqual([])
    expect(await h.checkpointStore.list()).toEqual([
      expect.objectContaining({ exportId: EXPORT_ID }),
    ])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('drops an export superseded during evacuation before the worker starts', async () => {
    const disposeStarted = deferred()
    const disposeGate = deferred()
    const registry = createResourceRegistry()
    registry.register({
      id: 'preview-gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      dispose: async () => {
        disposeStarted.resolve()
        await disposeGate.promise
      },
    })
    const h = createHarness({ registry })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await disposeStarted.promise
    const sessionDuringEvacuation = h.state.session
    const supersededAt = h.mark('superseded')
    h.ctx.refs.exportGraphVersionRef.current += 1
    disposeGate.resolve()
    await run

    expect(h.since(supersededAt)).toEqual(['test:superseded'])
    expect(h.debugPayloads('resource-evacuated')).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(h.state.session).toBe(sessionDuringEvacuation)
    expect(h.state.session?.exportState).toMatchObject({
      status: 'exporting',
      activePlan: DESKTOP_ACTIVE_PLAN,
    })
  })
})

describe('orchestrateFullResExport delayed manifest', () => {
  it.each([
    {
      name: 'an unhashed output',
      error: new ExportManifestUnavailableError(
        'output-unhashed',
        'The export output hash was not recorded.',
      ),
      reason: 'output-unhashed',
      message: 'The export output hash was not recorded.',
    },
    {
      name: 'an unexpected hashing error',
      error: new Error('digest failed'),
      reason: 'internal',
      message: 'digest failed',
    },
    {
      name: 'a non-Error rejection',
      error: 'hash worker gone',
      reason: 'internal',
      message: 'hash worker gone',
    },
  ])(
    'keeps the delivered JPEG ready when sealing fails with $name',
    async ({ error, reason, message }) => {
      const h = createHarness()
      const result = await runToReady(h)

      const failedAt = h.mark('manifest-failed')
      h.manifest.reject(error)
      await settle()

      expect(h.since(failedAt)).toEqual([
        'test:manifest-failed',
        'state:session:ready',
        'debug:export-manifest-failed',
      ])
      expect(h.state.session?.exportState).toMatchObject({
        status: 'ready',
        retryRecommended: false,
      })
      expect(h.state.session?.exportState.lastErrorCode).toBeUndefined()
      expect(h.state.session?.exportState.result).toEqual({
        ...result,
        manifestState: { status: 'unavailable', reason },
      })
      expect(h.state.session?.exportState.result?.output).toBe(result.output)
      expect(h.state.status).toBe('ready')
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(h.debugPayloads('export-manifest-failed')).toEqual([
        { reason, message },
      ])
    },
  )

  // The manifest continuation is guarded by mount, session id and result
  // identity only; its failure diagnostic is emitted unconditionally.
  const manifestSupersessions = [
    {
      name: 'the session is replaced',
      supersede(h: Harness) {
        h.replaceSession(createSession('session-2'))
      },
      resolvedTrace: [],
      rejectedTrace: ['debug:export-manifest-failed'],
      attached: false,
    },
    {
      name: 'the view unmounts',
      supersede(h: Harness) {
        h.ctx.refs.isMountedRef.current = false
      },
      resolvedTrace: [],
      rejectedTrace: ['debug:export-manifest-failed'],
      attached: false,
    },
    {
      name: 'the result is cleared on the same session',
      supersede(h: Harness) {
        h.ctx.refs.exportGraphVersionRef.current += 1
        h.ctx.atoms.setSession(clearExportResultState)
      },
      resolvedTrace: ['state:session:unchanged', 'debug:export-manifest-ready'],
      rejectedTrace: [
        'state:session:unchanged',
        'debug:export-manifest-failed',
      ],
      attached: false,
    },
    {
      name: 'the export graph version advances but the result stays',
      supersede(h: Harness) {
        h.ctx.refs.exportGraphVersionRef.current += 1
      },
      resolvedTrace: ['state:session:ready', 'debug:export-manifest-ready'],
      rejectedTrace: ['state:session:ready', 'debug:export-manifest-failed'],
      attached: true,
    },
  ]
  const manifestOutcomes = manifestSupersessions.flatMap(
    ({ resolvedTrace, rejectedTrace, ...scenario }) => [
      {
        ...scenario,
        outcome: 'resolves' as const,
        expectedTrace: resolvedTrace,
        attachedResult: {
          manifest: SEALED_MANIFEST,
          manifestState: { status: 'ready' },
        },
      },
      {
        ...scenario,
        outcome: 'rejects' as const,
        expectedTrace: rejectedTrace,
        attachedResult: {
          manifestState: { status: 'unavailable', reason: 'internal' },
        },
      },
    ],
  )

  it.each(manifestOutcomes)(
    'settles a manifest that $outcome after $name',
    async ({ supersede, outcome, expectedTrace, attached, attachedResult }) => {
      const h = createHarness()
      const result = await runToReady(h)
      supersede(h)
      const sessionBeforeManifest = h.state.session

      const settledAt = h.mark('manifest-settles')
      if (outcome === 'resolves') h.manifest.resolve(SEALED_MANIFEST)
      else h.manifest.reject(new Error('digest failed'))
      await settle()

      expect(h.since(settledAt)).toEqual([
        'test:manifest-settles',
        ...expectedTrace,
      ])
      if (attached) {
        expect(h.state.session?.exportState.result).toEqual({
          ...result,
          ...attachedResult,
        })
      } else {
        expect(h.state.session).toBe(sessionBeforeManifest)
      }
    },
  )
})

describe('orchestrateFullResExport color intent', () => {
  const CONFIRMED_LUT: LUTData = {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    title: 'Teal',
    inputProfile: 'display-srgb',
    profileResolution: {
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: 'display-srgb',
        label: 'Display sRGB',
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
        aliases: [],
      },
    },
  }
  const TEAL_STYLE: ImageSession['activeStyle'] = {
    kind: 'custom',
    name: 'Teal',
    defaultIntensity: 0.7,
    currentIntensity: 0.37,
    lutAsset: { format: 'cube', dimension: 17 },
  }
  const EDITED_PARAMS: ProcessingParams = {
    ...DEFAULT_PARAMS,
    styleKind: 'custom',
    // Between the Light (0.4) and Standard (0.7) detents.
    intensity: 0.37,
    userContrast: 12,
    userTemperature: -6,
    userVibrance: 18,
    selectiveColor: {
      ...NEUTRAL_SELECTIVE_COLOR,
      red: { hue: 10, saturation: 0, lightness: 0 },
    },
  }

  function lutOutputStep(input: JobInput) {
    return input.graph.steps.find((step) => step.kind === 'lut-output-to-srgb')
  }

  it('records the intent the export graph reads in the pre-export snapshot', async () => {
    vi.mocked(createPreExportSnapshot).mockClear()
    const h = createHarness({
      params: EDITED_PARAMS,
      lut: CONFIRMED_LUT,
      session: createSession('session-1', { activeStyle: TEAL_STYLE }),
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    job.resolve()
    await run

    expect(vi.mocked(createPreExportSnapshot)).toHaveBeenCalledTimes(1)
    const [snapshotInput] = vi.mocked(createPreExportSnapshot).mock.calls[0]
    expect(snapshotInput.intent).toEqual(pickColorGraphIntent(EDITED_PARAMS))
    expect(snapshotInput.graph).toBe(input.graph)
    expect(snapshotInput.graphFingerprint).toBe(
      JSON.stringify(input.graph.steps),
    )
    expect(lutOutputStep(input)).toMatchObject({ intensity: 0.37 })
    expect(
      input.graph.steps.find((step) => step.kind === 'user-selective-color'),
    ).toMatchObject({
      bands: { red: { hue: 10, saturation: 0, lightness: 0 } },
    })
  })

  it('keeps the LUT in the export graph at zero strength', async () => {
    const h = createHarness({
      params: { ...EDITED_PARAMS, intensity: 0 },
      lut: CONFIRMED_LUT,
      session: createSession('session-1', { activeStyle: TEAL_STYLE }),
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    job.resolve()
    await run

    expect(input.graph).toMatchObject({
      supported: true,
      lutProfile: { id: 'display-srgb' },
    })
    expect(input.graph.steps.some((step) => step.kind === 'lut3d')).toBe(true)
    expect(lutOutputStep(input)).toMatchObject({ intensity: 0 })
  })

  it('refuses an unconfirmed LUT contract at zero strength', async () => {
    const h = createHarness({
      params: { ...EDITED_PARAMS, intensity: 0 },
      lut: { ...CONFIRMED_LUT, profileResolution: { kind: 'unknown' } },
      session: createSession('session-1', { activeStyle: TEAL_STYLE }),
    })

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.trace).toEqual([
      'state:error:Choose a LUT input profile before full-resolution export.',
      'state:status:error',
      'state:session:failed',
    ])
    expect(h.state.session?.exportState).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EXPORT_UNSUPPORTED_PIPELINE',
    })
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })
})
