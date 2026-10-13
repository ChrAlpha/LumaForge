import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  NEUTRAL_SELECTIVE_COLOR,
  parseCubeLUT,
  pickColorGraphIntent,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import type {
  ExportGeometry,
  ExportOutputResult,
  FileBackedOutputResult,
} from '@lumaforge/render-engine/export'
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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'

import type { ExportDebugEvent } from '~/lib/export/execution-profile'
import { getExportModeCopy } from '~/lib/export/execution-profile'
import type {
  ExportExecutionPlan,
  ExportPlanFacts,
  ExportPlanRequest,
} from '~/lib/export/export-plan'
import { selectExportPlan } from '~/lib/export/export-plan'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import {
  resetCapabilityVectorForTest,
  setCapabilityVectorForTest,
} from '~/lib/runtime/capability-vector'
import { composeManualTransform } from '~/lib/transform/transform-render'
import { FOLDING_TRANSFORM } from '~/modules/raw-processor/test-support/transform-geometry-test-cases'

import type {
  ExportResult,
  FullResExportReason,
} from '../../model/export-result'
import type { ImageSession, TransformState } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import type { ProcessingStatus } from '../../model/workflow'
import { createTestDecodedImage } from '../../test-support/builders'
import type {
  TransformEvent,
  TransformStatus,
} from '../transform/transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  reduceTransformState,
} from '../transform/transform-state'
import type { BuildExportManifestInput } from './attach-export-manifest'
import { ExportManifestUnavailableError } from './attach-export-manifest'
import { createPreExportSnapshot } from './export-evacuation'
import type { ExportSourceTuple } from './export-interruption'
import {
  createExportInterruptionMarkers,
  encodeExportSourceHint,
} from './export-interruption'
import { resolveExportEnvironment } from './export-manifest'
import type { SourceInterruptionHint } from './export-recovery'
import { readSourceInterruption } from './export-recovery'
import {
  captureExportResultIdentity,
  isSameExportResult,
} from './export-result-identity'
import { claimExportSlot, clearExportResultState } from './export-state'
import type { runFullResolutionExportJob } from './export-system'
import type {
  ExportContext,
  FullResExportNotification,
} from './orchestrate-full-res-export'
import { orchestrateFullResExport } from './orchestrate-full-res-export'

const mocks = vi.hoisted(() => ({
  sampleExportPlanFacts: vi.fn(),
  planFullResExport: vi.fn(),
  runFullResolutionExportJob: vi.fn(),
  buildManifestForExportResult: vi.fn(),
  reserveOpfsOutputDirectory: vi.fn(),
  scheduleAbandonedOpfsOutputCollection: vi.fn(),
}))

vi.mock('./export-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export-system')>()),
  sampleExportPlanFacts: mocks.sampleExportPlanFacts,
  runFullResolutionExportJob: mocks.runFullResolutionExportJob,
}))

// The orchestrator's plans, watched on their way through the real planner;
// readiness plans inside its own module and never shows up here.
vi.mock('./export-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export-readiness')>()),
  planFullResExport: mocks.planFullResExport,
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

vi.mock('~/lib/export/opfs-output-lifetime', () => ({
  reserveOpfsOutputDirectory: mocks.reserveOpfsOutputDirectory,
  scheduleAbandonedOpfsOutputCollection:
    mocks.scheduleAbandonedOpfsOutputCollection,
}))

const { planFullResExport: actualPlanFullResExport } =
  await vi.importActual<typeof import('./export-readiness')>(
    './export-readiness',
  )

type JobInput = Parameters<typeof runFullResolutionExportJob>[0]
type PlanInput = ExportPlanRequest
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

const DEFAULT_PARAMS: ColorGraphIntent = {
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
  reasonCode: 'clipboard-unsupported',
} as const

const SEALED_MANIFEST = {
  manifest_sha256: 'a'.repeat(64),
  produced_at: '2026-10-05T12:00:01.000Z',
  source_raw: { sha256: 'b'.repeat(64) },
  output: { sha256: 'c'.repeat(64), filename: FULL_RES_FILENAME },
} as unknown as RenderManifest

/** The explicit export command carries no quality or fidelity choice. */
const OPTIONS = {} as const

/** A parsed two-point "Teal" cube carrying the given contract resolution. */
function tealLut(profileResolution: LUTData['profileResolution']): LUTData {
  const cube = `TITLE "Teal"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`
  return { ...toLUTData(parseCubeLUT(cube)), profileResolution }
}

/** Its projective horizon crosses the unconstrained output frame. */
const FOLDING_MATRIX = composeManualTransform(
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  FOLDING_TRANSFORM,
  6000 / 4000,
)

/** A committed geometry the engine refuses to plan: a fold in the frame. */
const FOLDING_GEOMETRY: ExportGeometry = {
  matrix: FOLDING_MATRIX,
  constrainCrop: false,
}

function createSession(
  id = 'session-1',
  overrides: {
    exportState?: Partial<ImageSession['exportState']>
    activeStyle?: ImageSession['activeStyle']
    exportGeometry?: ExportGeometry
    transform?: TransformState
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
    exportGeometry: overrides.exportGeometry ?? null,
    transform: overrides.transform ?? createTransformState(id),
    viewState: {
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 6000, height: 4000 },
      retryRecommended: false,
      ...overrides.exportState,
    },
  }
}

/** The geometry the preview answers the test Transform with. */
const TRANSFORM_GEOMETRY: ExportGeometry = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

let transformRequests = 0

/** Asks the session's Transform for a manual rotation; a new intent. */
function editTransform(state: TransformState, rotate: number) {
  return reduceTransformState(state, {
    type: 'edit',
    sourceId: state.sourceId,
    intent: { manual: { ...state.intent.manual, rotate } },
  })
}

/** Captures a frame, requests the geometry and has the preview answer it. */
function answerTransform(
  state: TransformState,
  geometry: ExportGeometry = TRANSFORM_GEOMETRY,
) {
  const requestId = ++transformRequests
  const captureKey = `frame-${requestId}`
  const { sourceId } = state
  const events: TransformEvent[] = [
    { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
    {
      type: 'request',
      sourceId,
      captureKey,
      clientEpoch: 1,
      requestId,
      geometry,
    },
    {
      type: 'rendered',
      sourceId,
      captureKey,
      clientEpoch: 1,
      requestId,
      geometry,
      frame: { width: 1500, height: 1000 },
    },
  ]
  return events.reduce(reduceTransformState, state)
}

/** A first edit and the events that bring its Transform to `status`. */
function transformAt(status: TransformStatus, sourceId = 'session-1') {
  const neutral = createTransformState(sourceId)
  if (status === 'neutral') return neutral
  if (status === 'accepted') return answerTransform(editTransform(neutral, 2))
  const requestId = ++transformRequests
  const captureKey = `frame-${requestId}`
  const events: TransformEvent[] = [
    { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
  ]
  if (status === 'unavailable') {
    events.push({
      type: 'capture-failed',
      sourceId,
      captureKey,
      clientEpoch: 1,
    })
  } else {
    events.push({
      type: 'request',
      sourceId,
      captureKey,
      clientEpoch: 1,
      requestId,
      geometry: TRANSFORM_GEOMETRY,
    })
    if (status === 'invalid')
      events.push({
        type: 'render-failed',
        sourceId,
        captureKey,
        clientEpoch: 1,
        requestId,
        failure: 'transform',
      })
  }
  const state = events.reduce(reduceTransformState, editTransform(neutral, 2))
  expect(deriveTransformStatus(state)).toBe(status)
  return state
}

/** A session holding an accepted Transform and the geometry it answered. */
function createAcceptedTransformSession(id = 'session-1') {
  const transform = transformAt('accepted', id)
  return createSession(id, {
    transform,
    exportGeometry: heldTransformGeometry(transform)!,
  })
}

/** A session whose Transform answered `geometry`, which it commits. */
function createGeometrySession(
  geometry: ExportGeometry,
  overrides: Parameters<typeof createSession>[1] = {},
  id = 'session-1',
) {
  return createSession(id, {
    ...overrides,
    transform: answerTransform(
      editTransform(createTransformState(id), 2),
      geometry,
    ),
    exportGeometry: geometry,
  })
}

/**
 * The same Transform on a new frame that has not been answered yet, or that
 * failed: no edit, so the intent stays the very same object.
 */
function recaptureTransform(
  state: TransformState,
  status: 'pending' | 'invalid' | 'unavailable',
) {
  const requestId = ++transformRequests
  const captureKey = `frame-${requestId}`
  const { sourceId } = state
  const events: TransformEvent[] = [
    { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
  ]
  if (status === 'unavailable') {
    events.push({
      type: 'capture-failed',
      sourceId,
      captureKey,
      clientEpoch: 1,
    })
  } else if (status === 'invalid') {
    events.push(
      {
        type: 'request',
        sourceId,
        captureKey,
        clientEpoch: 1,
        requestId,
        geometry: TRANSFORM_GEOMETRY,
      },
      {
        type: 'render-failed',
        sourceId,
        captureKey,
        clientEpoch: 1,
        requestId,
        failure: 'transform',
      },
    )
  }
  const next = events.reduce(reduceTransformState, state)
  expect(next.intent).toBe(state.intent)
  expect(deriveTransformStatus(next)).toBe(status)
  return next
}

/** The refusal each Transform status leaves a full-resolution export with. */
const TRANSFORM_REFUSALS = {
  pending: { code: 'transform-pending' },
  invalid: { code: 'transform-invalid' },
  unavailable: { code: 'transform-unavailable' },
} as const satisfies Record<string, FullResExportReason>

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
    identity: captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: 'previous-attempt',
      sessionId: 'session-1',
      sourceFile: SOURCE_FILE,
      intent: DEFAULT_PARAMS,
      lut: null,
      rawRenderExposure: RAW_RENDER_EXPOSURE,
      geometry: null,
    }),
  }
}

/** A finished OPFS output, as the worker client hands it over. */
function createFileBackedOutput(filename: string) {
  return {
    kind: 'file-backed',
    exportId: 'opfs-export-1',
    filename,
    byteLength: JPEG_BLOB.size,
    mimeType: 'image/jpeg',
    sha256: 'c'.repeat(64),
    openBlob: vi.fn(async () => JPEG_BLOB),
    cleanup: vi.fn(async () => undefined),
  } satisfies FileBackedOutputResult
}

function createDecodedImage(): DecodedImage {
  return createTestDecodedImage({
    width: 1500,
    height: 1000,
    data: new Uint16Array(0),
    metadata: { width: 6000, height: 4000 },
    renderExposure: RAW_RENDER_EXPOSURE,
  })
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

const MARKER_PREFIX = 'lumaforge.export-interruption.v1.'
const OWNER_LOCK_PREFIX = 'lumaforge-export-attempt-owner:'

type MarkerStorageMode = 'available' | 'denied' | 'refuses-writes'

/** The origin's localStorage, shared by every page of the harness. */
function createMarkerStorage(mode: MarkerStorageMode) {
  const entries = new Map<string, string>()
  const storage = {
    get length() {
      return entries.size
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (mode === 'refuses-writes') {
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      entries.set(key, String(value))
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
  } as unknown as Storage
  return {
    storage: mode === 'denied' ? null : storage,
    markers() {
      return Array.from(entries.entries())
        .filter(([key]) => key.startsWith(MARKER_PREFIX))
        .map(([, value]) => JSON.parse(value) as Record<string, unknown>)
    },
  }
}

/** Exclusive `ifAvailable` Web Locks shared by every page of the harness. */
function createMarkerLocks() {
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

function toSourceTuple(file: File): ExportSourceTuple {
  return { name: file.name, size: file.size, lastModified: file.lastModified }
}

type HarnessOptions = {
  session?: ImageSession
  /** The session the React closure rendered with; defaults to the live one. */
  atomsSession?: ImageSession | null
  /** The color intent the store holds when the test starts. */
  params?: ColorGraphIntent
  lut?: LUTData | null
  registry?: ResourceRegistry | null
  capability?: CapabilityVector
  runtime?: ExportRuntimeResources
  planGate?: Promise<void>
  markerStorage?: MarkerStorageMode
  /** Holds this page's marker `begin` until it resolves. */
  beginGate?: Promise<void>
}

/**
 * A direct ExportContext whose functional setters apply to real test state.
 * Every observable step lands in one ordered trace, prefixed by channel:
 * `state:` for workflow writes, `debug:` for export diagnostics, `service:`
 * for side-effecting collaborators, `notify:` for user notifications and
 * `test:` for the moments a test intervenes.
 */
function createHarness(options: HarnessOptions = {}) {
  const trace: string[] = []
  const notifications: FullResExportNotification[] = []
  const debugEvents: ExportDebugEvent[] = []
  const plans: ExportExecutionPlan[] = []
  const planInputs: PlanInput[] = []
  const manifestInputs: BuildExportManifestInput[] = []
  const idleTasks: Array<{ task: () => void; timeout?: number }> = []
  const initialSession = options.session ?? createSession()
  const registry =
    options.registry === undefined ? createResourceRegistry() : options.registry
  const capability = options.capability ?? DESKTOP_CAPABILITY
  const runtime = options.runtime ?? BLOB_RUNTIME
  const manifest = deferred<RenderManifest>()
  const markerStore = createMarkerStorage(options.markerStorage ?? 'available')
  const markerLocks = createMarkerLocks()
  const beginStarted = deferred()
  const state: {
    status: ProcessingStatus | null
    error: string | null | undefined
    progress: number | null
    session: ImageSession | null
  } = {
    status: null,
    error: undefined,
    progress: null,
    session: initialSession,
  }
  let colorIntent: ColorGraphIntent = options.params ?? DEFAULT_PARAMS
  let storedLut: LUTData | null = options.lut ?? null

  function createMarkerPage(page: string) {
    let attempts = 0
    return createExportInterruptionMarkers({
      getStorage: () => markerStore.storage,
      getLocks: () => markerLocks.locks,
      createId: (kind) =>
        kind === 'owner' ? page : `${page}-attempt-${++attempts}`,
      now: () => FIXED_NOW,
    })
  }
  const pageMarkers = createMarkerPage('this-page')
  const interruptionMarkers: ExportContext['services']['interruptionMarkers'] =
    {
      ...pageMarkers,
      async begin(source) {
        beginStarted.resolve()
        await options.beginGate
        return pageMarkers.begin(source)
      },
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
      // The store: a write is read back in the same tick, before the caller
      // renders again.
      getSession: () => state.session,
      getColorIntent: () => colorIntent,
      getLutData: () => storedLut,
      decodedImageRef: { current: createDecodedImage() },
      previewFacts: null,
      refreshExportInterruption: vi.fn(() => {
        trace.push('state:interruption-refresh')
      }),
    },
    refs,
    services: {
      notify: vi.fn((notification: FullResExportNotification) => {
        notifications.push(notification)
        trace.push(`notify:${notification.kind}`)
      }),
      // Mirrors the workflow's abortExportWork: abort, then release the ref.
      abortExportWork: vi.fn(() => {
        trace.push('service:abortExportWork')
        const controller = refs.exportAbortControllerRef.current
        if (controller && !controller.signal.aborted) controller.abort()
        refs.exportAbortControllerRef.current = null
      }),
      previewRuntime: {
        cancel: recordService('cancelPreviewRuntime'),
        terminate: recordService('terminatePreviewRuntime'),
      },
      registerCurrentPreviewPipelineForEvacuation: recordService(
        'registerCurrentPreviewPipelineForEvacuation',
      ),
      registerExportResultResource: recordService(
        'registerExportResultResource',
      ),
      revokeCurrentEmbeddedPreviewUrl: recordService(
        'revokeCurrentEmbeddedPreviewUrl',
      ),
      interruptionMarkers,
    },
  }

  // Facts sampled for an explicitly chosen device, then real plans from the
  // real planner and policy.
  mocks.sampleExportPlanFacts.mockImplementation(async () => {
    trace.push('service:sampleExportPlanFacts')
    await options.planGate
    return { capability, runtime }
  })
  mocks.planFullResExport.mockImplementation(
    (request: PlanInput, facts: ExportPlanFacts) => {
      planInputs.push(request)
      const decision = actualPlanFullResExport(request, facts)
      plans.push(
        decision.kind === 'run'
          ? decision.plan
          : selectExportPlan({ ...request, ...facts }),
      )
      return decision
    },
  )
  mocks.reserveOpfsOutputDirectory.mockResolvedValue(TAB_DIRECTORY)

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
  function installJob(
    createOutput: (filename: string) => ExportOutputResult = (filename) =>
      createBlobOutputResult({ filename, blob: JPEG_BLOB }),
  ) {
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
            output: createOutput(input.filename),
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
    notifications,
    state,
    debugEvents,
    plans,
    planInputs,
    manifestInputs,
    manifest,
    markerStore,
    beginStarted: beginStarted.promise,
    createMarkerPage,
    /**
     * The hint this page reads for `file` after another page began an
     * export of it and closed without ending it.
     */
    async crashedHint(
      file: File = SOURCE_FILE,
    ): Promise<SourceInterruptionHint> {
      const closedPage = createMarkerPage('closed-page')
      const { stored } = await closedPage.begin(toSourceTuple(file))
      if (!stored)
        throw new Error('Expected the closed page to store a marker.')
      markerLocks.closePage('closed-page')
      const interruption = await readSourceInterruption(pageMarkers, file)
      if (!interruption) throw new Error('Expected a crash-like hint.')
      return interruption
    },
    idleTasks,
    installJob,
    mark(label: string) {
      trace.push(`test:${label}`)
      return trace.length - 1
    },
    since(index: number) {
      return trace.slice(index)
    },
    channel(name: 'state' | 'debug' | 'service' | 'notify') {
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
    /** Writes the session to the store, as a workflow write does. */
    replaceSession(next: ImageSession | null) {
      state.session = next
    },
    /** Writes the color intent to the store, as a color edit does. */
    writeColorIntent(next: ColorGraphIntent) {
      colorIntent = next
    },
    /**
     * Writes the LUT to the store, as a LUT apply or a contract change does,
     * before the workflow's LUT effect runs.
     */
    writeLut(next: LUTData | null) {
      storedLut = next
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
    // The running attempt is marked by its file tuple alone.
    expect(h.markerStore.markers()).toEqual([
      {
        version: 1,
        attempt: 'this-page-attempt-1',
        owner: 'this-page',
        ownerLocked: true,
        source: encodeExportSourceHint(toSourceTuple(SOURCE_FILE)),
        startedAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        terminal: null,
      },
    ])
    job.progress(1, 2)
    job.progress(2, 2)
    job.resolve()
    await run

    expect(h.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:error:null',
      'notify:started',
      'service:sampleExportPlanFacts',
      'service:registerCurrentPreviewPipelineForEvacuation',
      'debug:export-plan-selected',
      'state:session:exporting',
      'service:cancelPreviewRuntime',
      'service:revokeCurrentEmbeddedPreviewUrl',
      'service:cancelPreviewRuntime',
      'state:session:exporting',
      'service:dispose:preview-gpu-pipeline',
      'debug:resource-evacuated',
      'service:runFullResolutionExportJob',
      'debug:export-worker-attempt',
      'service:terminatePreviewRuntime',
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
    // A delivered export reports only that it started; the result is the news.
    expect(h.notifications).toEqual([{ kind: 'started' }])

    const result = h.state.session?.exportState.result
    expect(h.state.session?.exportState).toEqual({
      status: 'ready',
      fullResCapability: { status: 'supported', width: 6000, height: 4000 },
      activePlan: DESKTOP_ACTIVE_PLAN,
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
        identity: captureExportResultIdentity({
          resultKind: 'full-resolution',
          attemptId: EXPORT_ID,
          sessionId: 'session-1',
          sourceFile: SOURCE_FILE,
          intent: DEFAULT_PARAMS,
          lut: null,
          rawRenderExposure: RAW_RENDER_EXPOSURE,
          geometry: null,
        }),
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
        preference: 'balanced',
        source: { width: 6000, height: 4000 },
        history: {
          previousCrashLikeInterruption: false,
          previousResourceFailure: false,
          previousUserInterrupted: false,
        },
      },
    ])
    // A completed attempt leaves no marker behind.
    expect(h.markerStore.markers()).toEqual([])
    expect(h.ctx.atoms.refreshExportInterruption).not.toHaveBeenCalled()
    expect(input).toMatchObject({
      file: SOURCE_FILE,
      filename: FULL_RES_FILENAME,
      quality: 0.92,
    })
    expect(input).not.toHaveProperty('checkpoint')
    expect(input.outputLocation).toBeUndefined()
    expect(input).not.toHaveProperty('geometry')
    expect(input.executionPlan).toBe(h.plans[0])
    expect(input.beforeStart).toBe(h.ctx.services.previewRuntime.terminate)
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
    expect(manifestInput).toMatchObject({
      sourceFile: SOURCE_FILE,
      sourceDimensions: { width: 6000, height: 4000 },
      style: null,
      quality: 0.92,
      policy: { kind: 'export-full', row_slice: 512, concurrency: 2 },
      environment: resolveExportEnvironment('desktop'),
    })

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

  it('sizes the job, result and manifest from the geometry the store committed', async () => {
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
    const h = createHarness({ atomsSession: createSession() })
    // The store holds the accepted geometry before the caller rerenders.
    h.replaceSession(createGeometrySession(geometry))
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    job.resolve()
    await run

    expect(input.geometry).toBe(geometry)
    expect(input.quality).toBe(0.92)
    // The plan is sized by the sensor frame the worker decodes; only the
    // recorded result carries the cropped, delivered frame.
    expect(h.planInputs.map((planInput) => planInput.source)).toEqual([
      { width: 6000, height: 4000 },
    ])
    const published = h.state.session?.exportState.result
    expect(published).toMatchObject(delivered)
    expect(h.state.session?.exportState.lastSuccessfulSize).toEqual(delivered)
    // The manifest records the geometry the result's identity names, over
    // the frame the result delivers.
    expect(h.manifestInputs[0].result).toBe(published)
    expect(h.manifestInputs[0]).toMatchObject({
      sourceDimensions: { width: 6000, height: 4000 },
      result: {
        ...delivered,
        identity: {
          geometry: { matrix: geometry.matrix, constrainCrop: true },
        },
      },
      quality: 0.92,
    })
  })

  it.each([
    { sink: 'blob-handoff', runtime: BLOB_RUNTIME },
    { sink: 'opfs-file', runtime: OPFS_RUNTIME },
  ] as const)(
    'plans the safer retry from a matching hint and retires it after a $sink export',
    async ({ sink, runtime }) => {
      const h = createHarness({ runtime })
      const interruption = await h.crashedHint()
      expect(interruption.hint).toEqual({
        previousCrashLikeInterruption: true,
        previousResourceFailure: false,
        attempts: ['closed-page-attempt-1'],
      })
      const job = h.installJob()

      const run = orchestrateFullResExport({ ...OPTIONS, interruption }, h.ctx)
      const input = await job.started

      expect(h.planInputs).toEqual([
        {
          preference: 'balanced',
          source: { width: 6000, height: 4000 },
          history: {
            previousCrashLikeInterruption: true,
            previousResourceFailure: false,
            previousUserInterrupted: false,
          },
        },
      ])
      expect(h.plans[0]).toMatchObject({
        outputSink: sink,
        productCopy: 'interrupted-retry',
      })
      // The safer plan changes rows and concurrency, never the JPEG quality.
      expect(input.quality).toBe(0.92)
      // Sized from the current source and rendering the current look; no
      // checkpoint identity travels with the job.
      expect(input).not.toHaveProperty('checkpoint')
      expect(h.markerStore.markers().map((marker) => marker.attempt)).toEqual(
        expect.arrayContaining([
          'closed-page-attempt-1',
          'this-page-attempt-1',
        ]),
      )
      job.resolve()
      await run

      expect(h.state.session?.exportState).toMatchObject({
        status: 'ready',
        activePlan: { outputSink: sink },
      })
      // The used hint is retired whatever the sink, and the page re-reads.
      expect(h.markerStore.markers()).toEqual([])
      expect(h.ctx.atoms.refreshExportInterruption).toHaveBeenCalledTimes(1)
      expect(h.trace.indexOf('state:interruption-refresh')).toBeGreaterThan(
        h.trace.indexOf('state:status:ready'),
      )
      await expect(
        readSourceInterruption(h.createMarkerPage('next-page'), SOURCE_FILE),
      ).resolves.toBeNull()
      expect(h.idleTasks).toEqual([])
    },
  )

  it('asks for the resource-failure plan from a matching resource-failure hint', async () => {
    const h = createHarness()
    const failedPage = h.createMarkerPage('failed-page')
    const { attempt } = await failedPage.begin(toSourceTuple(SOURCE_FILE))
    failedPage.finish(attempt, 'resource-failure')
    const interruption = await readSourceInterruption(
      h.createMarkerPage('reader'),
      SOURCE_FILE,
    )
    expect(interruption?.hint).toEqual({
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
      attempts: [attempt],
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(
      { ...OPTIONS, interruption: interruption! },
      h.ctx,
    )
    const input = await job.started
    job.resolve()
    await run

    expect(h.planInputs[0]?.history).toMatchObject({
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
    })
    // A retry after a resource failure is lighter, not lower quality.
    expect(input.quality).toBe(0.92)
    expect(h.manifestInputs[0]).toMatchObject({ quality: 0.92 })
    expect(h.markerStore.markers()).toEqual([])
  })

  it('gives another file nothing from a hint read for an interrupted source', async () => {
    const h = createHarness()
    const interruptedFile = new File([new Uint8Array([1, 2])], 'other.dng', {
      lastModified: 1_600_000_000_000,
    })
    const interruption = await h.crashedHint(interruptedFile)
    const job = h.installJob()

    const run = orchestrateFullResExport({ ...OPTIONS, interruption }, h.ctx)
    await job.started
    job.resolve()
    await run

    expect(h.planInputs).toEqual([
      expect.objectContaining({
        history: expect.objectContaining({
          previousCrashLikeInterruption: false,
          previousResourceFailure: false,
        }),
      }),
    ])
    expect(h.plans[0]?.productCopy).not.toBe('interrupted-retry')
    // The other file's hint stays for that file's next export.
    expect(h.markerStore.markers()).toEqual([
      expect.objectContaining({
        attempt: 'closed-page-attempt-1',
        source: encodeExportSourceHint(toSourceTuple(interruptedFile)),
      }),
    ])
    expect(h.ctx.atoms.refreshExportInterruption).not.toHaveBeenCalled()
    expect(h.state.session?.exportState.status).toBe('ready')
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
      mocks.sampleExportPlanFacts.mock.invocationCallOrder[0]!,
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
    expect(input).not.toHaveProperty('checkpoint')

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
    { name: 'storage is denied', markerStorage: 'denied' },
    { name: 'storage refuses the write', markerStorage: 'refuses-writes' },
  ] as const)(
    'exports to OPFS unchanged when $name for the marker',
    async ({ markerStorage }) => {
      const h = createHarness({ runtime: OPFS_RUNTIME, markerStorage })
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
      // No export state outlives the tab, whatever the sink.
      expect(h.debugPayloads('export-plan-selected')).toEqual([
        expect.objectContaining({
          outputSink: 'opfs-file',
          checkpointDurableExpected: false,
        }),
      ])
      expect(input.executionPlan?.outputSink).toBe('opfs-file')
      expect(input.outputLocation).toEqual({
        sink: 'opfs-file',
        tabDirectory: TAB_DIRECTORY,
        exportId: EXPORT_ID,
      })
      expect(input).not.toHaveProperty('checkpoint')
      expect(h.state.session?.exportState).toMatchObject({
        status: 'ready',
        activePlan: { outputSink: 'opfs-file' },
      })
      expect(h.markerStore.markers()).toEqual([])
      expect(h.idleTasks).toEqual([])
    },
  )

  it('reports a replacement plan from the job as the active plan before its worker runs', async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const job = h.installJob()
    const blobPlan = selectExportPlan({
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
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
    })
    expect(h.debugPayloads('export-plan-selected')).toEqual([
      expect.objectContaining({
        outputSink: 'opfs-file',
        checkpointDurableExpected: false,
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

    expect(h.trace).toEqual(['notify:refused'])
    expect(h.notifications).toEqual([
      { kind: 'refused', refusal: { code: 'source-loading' } },
    ])
    expect(h.state).toEqual({
      status: null,
      error: undefined,
      progress: null,
      session: liveSession,
    })
    expect(otherExport.signal.aborted).toBe(false)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    expect(mocks.sampleExportPlanFacts).not.toHaveBeenCalled()
  })

  it.each([FOLDING_GEOMETRY])(
    'refuses an unplannable geometry before a marker, evacuation or worker work',
    async (geometry) => {
      expect(() =>
        planExportGeometry(geometry, { width: 6000, height: 4000 }),
      ).toThrow(INVALID_EXPORT_GEOMETRY)
      const registry = createResourceRegistry()
      const previousResult = createPreviousResult()
      // An OPFS plan reserves its output before the worker starts, so a
      // refusal that came late would leave a marker or a reservation behind.
      // The geometry sits beside the neutral Transform on purpose: it is
      // malformed admission input that the geometry gate alone must refuse.
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

      expect(h.trace).toEqual(['notify:refused'])
      expect(h.notifications).toEqual([
        { kind: 'refused', refusal: { code: 'geometry-unplannable' } },
      ])
      // Nothing was planned, marked, evacuated or started.
      expect(h.planInputs).toEqual([])
      expect(h.markerStore.markers()).toEqual([])
      expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
      expect(
        h.ctx.services.registerCurrentPreviewPipelineForEvacuation,
      ).not.toHaveBeenCalled()
      expect(h.ctx.services.previewRuntime.cancel).not.toHaveBeenCalled()
      expect(registry.snapshot().live).toHaveLength(1)
      expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(h.state).toEqual({
        status: null,
        error: undefined,
        progress: null,
        session: liveSession,
      })
      expect(liveSession?.exportState.result).toBe(previousResult)
      expect(otherExport.signal.aborted).toBe(false)
      expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    },
  )

  it.each(['pending'] as const)(
    'refuses a %s Transform before sampling, a marker, evacuation, the worker or an output',
    async (status) => {
      const registry = createResourceRegistry()
      const previousResult = createPreviousResult()
      const transform = transformAt(status)
      const h = createHarness({
        registry,
        runtime: OPFS_RUNTIME,
        session: createSession('session-1', {
          transform,
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

      expect(h.trace).toEqual(['notify:refused'])
      expect(h.notifications).toEqual([
        { kind: 'refused', refusal: TRANSFORM_REFUSALS[status] },
      ])
      expect(mocks.sampleExportPlanFacts).not.toHaveBeenCalled()
      expect(h.markerStore.markers()).toEqual([])
      expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
      expect(registry.snapshot().live).toHaveLength(1)
      expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
      expect(h.state).toEqual({
        status: null,
        error: undefined,
        progress: null,
        session: liveSession,
      })
      expect(otherExport.signal.aborted).toBe(false)
      expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
    },
  )

  it('reads the live Transform rather than the session the caller rendered with', async () => {
    const h = createHarness({ atomsSession: createSession() })
    // The Transform was edited after the caller rendered; the export reads
    // the session as it is now.
    h.replaceSession(
      createSession('session-1', { transform: transformAt('pending') }),
    )

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(mocks.sampleExportPlanFacts).not.toHaveBeenCalled()
    expect(h.notifications).toEqual([
      { kind: 'refused', refusal: TRANSFORM_REFUSALS.pending },
    ])
  })

  it('carries the runtime diagnostic as given, never deciding on its text', async () => {
    // The diagnostic reads like another refusal; the verdict alone decides.
    const h = createHarness({
      session: createSession('session-1', {
        exportState: {
          fullResCapability: {
            status: 'unsupported',
            reason: 'Quick preview is still being prepared.',
          },
        },
      }),
    })
    const liveSession = h.state.session

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expect(h.trace).toEqual(['notify:refused'])
    expect(h.notifications).toEqual([
      {
        kind: 'refused',
        refusal: {
          code: 'runtime-unsupported',
          detail: 'Quick preview is still being prepared.',
        },
      },
    ])
    expect(mocks.sampleExportPlanFacts).not.toHaveBeenCalled()
    expect(h.state.session).toBe(liveSession)
  })

  it('refuses an unsupported color graph without touching other export work', async () => {
    const lut = tealLut({ kind: 'unknown' })
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
    expect(mocks.sampleExportPlanFacts).not.toHaveBeenCalled()
    expect(h.notifications).toEqual([])
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
      'notify:started',
      'service:sampleExportPlanFacts',
      'state:session:failed',
      'state:status:ready',
      'notify:failed',
    ])
    expect(h.notifications).toEqual([
      { kind: 'started' },
      {
        kind: 'failed',
        code: 'EXPORT_POLICY_CANNOT_COMPLETE',
        message: getExportModeCopy('cannot-safely-complete'),
        retryLevel: null,
      },
    ])
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
    expect(h.ctx.services.previewRuntime.cancel).not.toHaveBeenCalled()
    expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    // A refused plan never begins an attempt.
    expect(h.markerStore.markers()).toEqual([])
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
  })
})

describe('orchestrateFullResExport refusal order', () => {
  /** What a refusal before the attempt leaves: one notice, nothing else. */
  function expectRefusedBeforeAttempt(
    h: Harness,
    liveSession: ImageSession | null,
    otherExport: AbortController,
    refusal: FullResExportReason,
  ) {
    expect(h.trace).toEqual(['notify:refused'])
    expect(h.notifications).toEqual([{ kind: 'refused', refusal }])
    expect(h.planInputs).toEqual([])
    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
    expect(mocks.scheduleAbandonedOpfsOutputCollection).not.toHaveBeenCalled()
    expect(h.ctx.services.previewRuntime.cancel).not.toHaveBeenCalled()
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(h.state).toEqual({
      status: null,
      error: undefined,
      progress: null,
      session: liveSession,
    })
    expect(otherExport.signal.aborted).toBe(false)
    expect(h.ctx.refs.exportAbortControllerRef.current).toBe(otherExport)
  }

  it('refuses a plan no storage could rescue before sampling device facts', async () => {
    // No reachable OPFS: readiness already knows the large mobile export can
    // only hand its output over in memory, which it refuses.
    setCapabilityVectorForTest(MOBILE_CAPABILITY)
    const h = createHarness({
      capability: MOBILE_CAPABILITY,
      session: createSession('session-1', {
        exportState: {
          fullResCapability: { status: 'supported', width: 9000, height: 6000 },
        },
      }),
    })
    const otherExport = new AbortController()
    h.ctx.refs.exportAbortControllerRef.current = otherExport

    await orchestrateFullResExport(OPTIONS, h.ctx)

    expectRefusedBeforeAttempt(h, h.state.session, otherExport, {
      code: 'cannot-safely-complete',
    })
  })
})

describe('orchestrateFullResExport failures', () => {
  it.each([
    {
      name: 'a retryable worker failure at balanced fidelity',
      error: new Error('FULL_RES_EXPORT_WORKER_FAILED'),
      performancePreference: 'balanced',
      code: 'FULL_RES_EXPORT_WORKER_FAILED',
      retryLevel: 'safe',
      message: 'FULL_RES_EXPORT_WORKER_FAILED',
      resourceFailure: true,
    },
    {
      name: 'an unclassified failure',
      error: new Error('decoder exploded'),
      performancePreference: 'balanced',
      code: 'EXPORT_RENDER_FAILED',
      retryLevel: undefined,
      message: 'decoder exploded',
      resourceFailure: false,
    },
    {
      name: 'a coded failure',
      error: Object.assign(new Error('Output sink closed'), {
        code: 'EXPORT_OUTPUT_SINK_FAILED',
      }),
      performancePreference: 'balanced',
      code: 'EXPORT_OUTPUT_SINK_FAILED',
      retryLevel: undefined,
      message: 'Output sink closed',
      resourceFailure: false,
    },
    {
      name: 'a failure that is not an Error',
      error: 'worker went away',
      performancePreference: 'balanced',
      code: 'EXPORT_RENDER_FAILED',
      retryLevel: undefined,
      message: null,
      resourceFailure: false,
    },
  ] as const)(
    'records $name as a failed export without a result',
    async ({
      error,
      performancePreference,
      code,
      retryLevel,
      message,
      resourceFailure,
    }) => {
      const h = createHarness()
      const job = h.installJob()

      const run = orchestrateFullResExport({ performancePreference }, h.ctx)
      await job.started
      job.progress(1, 4)
      const failedAt = h.mark('worker-failed')
      job.reject(error)
      await run
      await settle()

      // Only a resource failure stays behind, as a hint for the next export
      // of this source; the page re-reads it.
      expect(h.markerStore.markers()).toEqual(
        resourceFailure
          ? [
              expect.objectContaining({
                attempt: 'this-page-attempt-1',
                terminal: 'resource-failure',
              }),
            ]
          : [],
      )
      expect(h.since(failedAt)).toEqual([
        'test:worker-failed',
        'debug:export-worker-attempt',
        ...(resourceFailure ? ['state:interruption-refresh'] : []),
        'state:session:failed',
        'state:status:ready',
        'notify:failed',
      ])
      expect(h.notifications).toEqual([
        { kind: 'started' },
        {
          kind: 'failed',
          code,
          message,
          retryLevel: retryLevel ?? null,
        },
      ])
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
      'notify:started',
      'service:sampleExportPlanFacts',
      'service:registerCurrentPreviewPipelineForEvacuation',
      'debug:export-plan-selected',
      'state:session:exporting',
      'state:session:failed',
      'state:status:ready',
      'notify:failed',
    ])
    expect(h.notifications).toEqual([
      { kind: 'started' },
      {
        kind: 'failed',
        code: 'EXPORT_RESOURCE_REGISTRY_MISSING',
        message: 'EXPORT_RESOURCE_REGISTRY_MISSING',
        retryLevel: null,
      },
    ])
    // The attempt began before evacuation and ends as a plain failure.
    expect(h.markerStore.markers()).toEqual([])
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
      message: 'Export resources could not be evacuated before worker start.',
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
      message: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
    },
  ])(
    'fails closed before the worker starts when $name',
    async ({ register, evacuatedTrace, message }) => {
      const registry = createResourceRegistry()
      register(registry)
      const h = createHarness({ registry })

      await orchestrateFullResExport(OPTIONS, h.ctx)

      expect(
        h.trace.slice(h.trace.indexOf('debug:export-plan-selected')),
      ).toEqual([
        'debug:export-plan-selected',
        'state:session:exporting',
        'service:cancelPreviewRuntime',
        'service:revokeCurrentEmbeddedPreviewUrl',
        'service:cancelPreviewRuntime',
        'state:session:exporting',
        ...evacuatedTrace,
        'state:session:failed',
        'state:status:ready',
        'notify:failed',
      ])
      expect(h.notifications).toEqual([
        { kind: 'started' },
        {
          kind: 'failed',
          code: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
          message,
          retryLevel: null,
        },
      ])
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
    expect(h.notifications).toEqual([{ kind: 'started' }])
    // A cancelled attempt is not an interruption.
    expect(h.markerStore.markers()).toEqual([])
    expect(h.ctx.atoms.refreshExportInterruption).not.toHaveBeenCalled()
  })

  it("never lets an older attempt's end remove a newer attempt's marker", async () => {
    const h = createHarness()
    const first = h.installJob()
    const firstRun = orchestrateFullResExport(OPTIONS, h.ctx)
    await first.started

    // The page is ready to export again while the first job is still
    // settling, and the user starts a second export of the same source.
    h.replaceSession(createSession())
    const second = h.installJob()
    const secondRun = orchestrateFullResExport(OPTIONS, h.ctx)
    await second.started
    expect(h.markerStore.markers().map((marker) => marker.attempt)).toEqual([
      'this-page-attempt-1',
      'this-page-attempt-2',
    ])

    // The superseded job settles late, after the newer one began.
    first.reject(new DOMException('Aborted', 'AbortError'))
    await firstRun
    expect(h.markerStore.markers()).toEqual([
      expect.objectContaining({
        attempt: 'this-page-attempt-2',
        terminal: null,
      }),
    ])

    second.resolve()
    await secondRun
    expect(h.markerStore.markers()).toEqual([])
    expect(h.state.session?.exportState.status).toBe('ready')
  })

  const supersessions: Array<{
    name: string
    aborts?: boolean
    session?: () => ImageSession
    /** Leaves another attempt in the export slot. */
    takesSlot?: boolean
    supersede: (h: Harness) => void
  }> = [
    {
      name: 'export signal is aborted',
      aborts: true,
      supersede(h: Harness) {
        h.ctx.refs.exportAbortControllerRef.current?.abort()
      },
    },
    {
      name: 'another attempt takes the export slot',
      takesSlot: true,
      supersede(h: Harness) {
        h.ctx.refs.exportAbortControllerRef.current = new AbortController()
      },
    },
    {
      name: 'Transform is edited while the held geometry stays',
      session: createAcceptedTransformSession,
      supersede(h: Harness) {
        const live = h.state.session!
        h.replaceSession({
          ...live,
          transform: editTransform(live.transform!, 7),
        })
      },
    },
    {
      name: 'Transform is edited away and back to the same accepted geometry',
      session: createAcceptedTransformSession,
      supersede(h: Harness) {
        const live = h.state.session!
        const original = live.transform!.intent.manual.rotate
        const back = answerTransform(
          editTransform(editTransform(live.transform!, 7), original),
        )
        expect(deriveTransformStatus(back)).toBe('accepted')
        expect(heldTransformGeometry(back)).toEqual(live.exportGeometry)
        // The held geometry never moved, so it is the same object.
        h.replaceSession({ ...live, transform: back })
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
    async ({ supersede, session, takesSlot }) => {
      const h = createHarness({ session: session?.() })
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
      if (takesSlot) {
        expect(h.ctx.refs.exportAbortControllerRef.current).not.toBeNull()
      } else {
        expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
      }
      // The job completed, so its attempt is over even though it is dropped.
      expect(h.markerStore.markers()).toEqual([])
    },
  )

  it.each(supersessions)(
    'does not record a failure that arrives after the $name',
    async ({ supersede, aborts, session, takesSlot }) => {
      const h = createHarness({ session: session?.() })
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
      expect(h.notifications).toEqual([{ kind: 'started' }])
      if (takesSlot) {
        expect(h.ctx.refs.exportAbortControllerRef.current).not.toBeNull()
      } else {
        expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
      }
      // The attempt still ends by what happened to it: a cancellation leaves
      // nothing, a resource failure stays as a hint for the source.
      expect(h.markerStore.markers()).toEqual(
        aborts
          ? []
          : [expect.objectContaining({ terminal: 'resource-failure' })],
      )
    },
  )

  it.each(supersessions.filter(({ name }) => name === 'session is replaced'))(
    'removes the finished OPFS output of a JPEG that completes after the $name',
    async ({ supersede, session }) => {
      const h = createHarness({ runtime: OPFS_RUNTIME, session: session?.() })
      const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
      const job = h.installJob((filename) => {
        const output = createFileBackedOutput(filename)
        outputs.push(output)
        return output
      })

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      const input = await job.started
      supersede(h)
      job.resolve()
      await run

      expect(input.outputLocation?.sink).toBe('opfs-file')
      expect(outputs).toHaveLength(1)
      expect(outputs[0]!.cleanup).toHaveBeenCalledTimes(1)
      expect(h.ctx.services.registerExportResultResource).not.toHaveBeenCalled()
      expect(h.state.session?.exportState.result).toBeUndefined()
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
      'notify:started',
      'service:sampleExportPlanFacts',
      'test:superseded',
    ])
    expect(h.since(supersededAt)).toEqual(['test:superseded'])
    expect(h.state.session).toBe(replacement)
    // Visible status is left for the owner that superseded the export.
    expect(h.state.status).toBe('exporting')
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
    expect(h.markerStore.markers()).toEqual([])
  })

  it('reserves no OPFS output for an export superseded while its plan is sampled', async () => {
    const planGate = deferred()
    const h = createHarness({
      planGate: planGate.promise,
      runtime: OPFS_RUNTIME,
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    h.ctx.refs.exportGraphVersionRef.current += 1
    planGate.resolve()
    await run

    // The facts were sampled for an attempt that is no longer current, so
    // nothing is planned from them, let alone allocated.
    expect(mocks.sampleExportPlanFacts).toHaveBeenCalledTimes(1)
    expect(h.planInputs).toEqual([])
    expect(h.plans).toEqual([])
    expect(mocks.scheduleAbandonedOpfsOutputCollection).not.toHaveBeenCalled()
    expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('drops an export whose Transform is edited while its OPFS output is reserved', async () => {
    const reserve = deferred<string>()
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      session: createAcceptedTransformSession(),
    })
    mocks.reserveOpfsOutputDirectory.mockReturnValue(reserve.promise)

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await vi.waitFor(() =>
      expect(mocks.reserveOpfsOutputDirectory).toHaveBeenCalledTimes(1),
    )
    const live = h.state.session!
    h.replaceSession({ ...live, transform: editTransform(live.transform!, 9) })
    reserve.resolve(TAB_DIRECTORY)
    await run

    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('drops an export superseded while its marker is recorded, ending that attempt', async () => {
    const beginGate = deferred()
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      beginGate: beginGate.promise,
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await h.beginStarted
    const supersededAt = h.mark('superseded')
    h.replaceSession(createSession('session-2'))
    beginGate.resolve()
    await run

    expect(h.since(supersededAt)).toEqual(['test:superseded'])
    expect(h.markerStore.markers()).toEqual([])
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
    expect(h.markerStore.markers()).toEqual([])
    expect(h.state.session).toBe(sessionDuringEvacuation)
    expect(h.state.session?.exportState).toMatchObject({
      status: 'exporting',
      activePlan: DESKTOP_ACTIVE_PLAN,
    })
  })
})

describe('orchestrateFullResExport live Transform eligibility', () => {
  /** Leaves the accepted Transform `status` on a new frame, with no edit. */
  function recapture(h: Harness, status: keyof typeof TRANSFORM_REFUSALS) {
    const live = h.state.session!
    h.replaceSession({
      ...live,
      transform: recaptureTransform(live.transform!, status),
    })
  }

  function expectRefusedAndSettled(
    h: Harness,
    status: keyof typeof TRANSFORM_REFUSALS,
  ) {
    expect(h.notifications).toEqual([
      { kind: 'started' },
      { kind: 'refused', refusal: TRANSFORM_REFUSALS[status] },
    ])
    expect(h.state.status).toBe('ready')
    expect(h.state.progress).toBe(0)
    expect(h.state.session?.exportState.status).toBe('idle')
    expect(h.state.session?.exportState.result).toBeUndefined()
    expect(h.ctx.services.registerExportResultResource).not.toHaveBeenCalled()
    expect(mocks.buildManifestForExportResult).not.toHaveBeenCalled()
    expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
  }

  it('ends an export whose Transform goes pending on a new frame while its plan is sampled', async () => {
    const planGate = deferred()
    const h = createHarness({
      planGate: planGate.promise,
      runtime: OPFS_RUNTIME,
      session: createAcceptedTransformSession(),
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const recapturedAt = h.mark('recaptured')
    recapture(h, 'pending')
    planGate.resolve()
    await run

    expect(h.since(recapturedAt)).toEqual([
      'test:recaptured',
      'state:session:unchanged',
      'state:status:ready',
      'state:progress:0',
      'notify:refused',
    ])
    expectRefusedAndSettled(h, 'pending')
    expect(mocks.reserveOpfsOutputDirectory).not.toHaveBeenCalled()
    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('ends an export whose frame fails while its OPFS output is reserved', async () => {
    const reserve = deferred<string>()
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      session: createAcceptedTransformSession(),
    })
    mocks.reserveOpfsOutputDirectory.mockReturnValue(reserve.promise)

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await vi.waitFor(() =>
      expect(mocks.reserveOpfsOutputDirectory).toHaveBeenCalledTimes(1),
    )
    recapture(h, 'unavailable')
    reserve.resolve(TAB_DIRECTORY)
    await run

    expectRefusedAndSettled(h, 'unavailable')
    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('ends an export whose new frame refuses the geometry while its marker is recorded', async () => {
    const beginGate = deferred()
    const h = createHarness({
      beginGate: beginGate.promise,
      session: createAcceptedTransformSession(),
    })

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await h.beginStarted
    recapture(h, 'invalid')
    beginGate.resolve()
    await run

    expectRefusedAndSettled(h, 'invalid')
    // The marker it had begun ends with the attempt, as a cancellation.
    expect(h.markerStore.markers()).toEqual([])
    expect(mocks.runFullResolutionExportJob).not.toHaveBeenCalled()
  })

  it('stops the worker of an export whose Transform goes pending while it runs', async () => {
    const h = createHarness({ session: createAcceptedTransformSession() })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    const recapturedAt = h.mark('recaptured')
    recapture(h, 'pending')
    job.progress(1, 2)
    expect(input.signal?.aborted).toBe(true)
    job.reject(new DOMException('Aborted', 'AbortError'))
    await run
    await settle()

    expect(h.since(recapturedAt)).toEqual([
      'test:recaptured',
      'state:session:idle',
      'state:status:ready',
      'state:progress:0',
      'notify:refused',
    ])
    expectRefusedAndSettled(h, 'pending')
    expect(h.markerStore.markers()).toEqual([])
  })

  it.each(['invalid'] as const)(
    'delivers nothing and removes the finished OPFS output of a JPEG that completes after the Transform goes %s with no edit',
    async (status) => {
      const h = createHarness({
        runtime: OPFS_RUNTIME,
        session: createAcceptedTransformSession(),
      })
      const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
      const job = h.installJob((filename) => {
        const output = createFileBackedOutput(filename)
        outputs.push(output)
        return output
      })

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      const input = await job.started
      recapture(h, status)
      job.resolve()
      await run

      expect(input.outputLocation?.sink).toBe('opfs-file')
      expect(outputs).toHaveLength(1)
      expect(outputs[0]!.cleanup).toHaveBeenCalledTimes(1)
      expectRefusedAndSettled(h, status)
      expect(h.markerStore.markers()).toEqual([])
    },
  )

  // The windows between claiming the export slot and taking the session over
  // for the run, in which the earlier result is still shown.
  const replacedResultWindows: Array<{
    name: string
    hold: (h: Harness) => { reached: Promise<void>; release: () => void }
  }> = [
    {
      name: 'its plan is sampled',
      hold() {
        const reached = deferred()
        const gate = deferred()
        mocks.sampleExportPlanFacts.mockImplementation(async () => {
          reached.resolve()
          await gate.promise
          return { capability: DESKTOP_CAPABILITY, runtime: OPFS_RUNTIME }
        })
        return { reached: reached.promise, release: () => gate.resolve() }
      },
    },
    {
      name: 'its OPFS output is reserved',
      hold() {
        const reached = deferred()
        const reserve = deferred<string>()
        mocks.reserveOpfsOutputDirectory.mockImplementation(() => {
          reached.resolve()
          return reserve.promise
        })
        return {
          reached: reached.promise,
          release: () => reserve.resolve(TAB_DIRECTORY),
        }
      },
    },
    {
      name: 'its marker is recorded',
      hold(h: Harness) {
        const reached = deferred()
        const gate = deferred()
        const markers = h.ctx.services.interruptionMarkers
        h.ctx.services.interruptionMarkers = {
          ...markers,
          async begin(source) {
            reached.resolve()
            await gate.promise
            return markers.begin(source)
          },
        }
        return { reached: reached.promise, release: () => gate.resolve() }
      },
    },
  ]

  it.each(replacedResultWindows)(
    'drops the result a later export was started to replace when its Transform goes pending while $name',
    async ({ hold }) => {
      const h = createHarness({
        runtime: OPFS_RUNTIME,
        session: createAcceptedTransformSession(),
      })
      await runToReady(h)
      const disposeEarlier = vi.fn(async () => undefined)
      h.ctx.refs.resourceRegistryRef.current!.register({
        id: 'export-result-earlier',
        owner: 'export-result',
        kind: 'blob',
        dispose: disposeEarlier,
      })
      const held = hold(h)

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      await held.reached
      recapture(h, 'pending')
      held.release()
      await run
      await settle()

      // The later attempt claimed the export slot, so the earlier result can
      // no longer be delivered; the session stops offering it.
      expect(h.notifications).toEqual([
        { kind: 'started' },
        { kind: 'started' },
        { kind: 'refused', refusal: TRANSFORM_REFUSALS.pending },
      ])
      expect(h.state.status).toBe('ready')
      expect(h.state.progress).toBe(0)
      expect(h.state.session?.exportState.status).toBe('idle')
      expect(h.state.session?.exportState.result).toBeUndefined()
      expect(h.ctx.refs.exportAbortControllerRef.current).toBeNull()
      expect(disposeEarlier).toHaveBeenCalledTimes(1)
      // Only the earlier export ever registered a result.
      expect(h.ctx.services.registerExportResultResource).toHaveBeenCalledTimes(
        1,
      )
      expect(mocks.runFullResolutionExportJob).toHaveBeenCalledTimes(1)
      expect(h.markerStore.markers()).toEqual([])

      // The earlier manifest, still hashing, lands on nothing.
      h.manifest.resolve(SEALED_MANIFEST)
      await settle()
      expect(h.state.session?.exportState.result).toBeUndefined()
      expect(h.debugPayloads('export-manifest-ready')).toEqual([])
    },
  )

  it('keeps the earlier result when the Transform is refused before a later export starts', async () => {
    const h = createHarness({ session: createAcceptedTransformSession() })
    const earlier = await runToReady(h)
    const disposeEarlier = vi.fn(async () => undefined)
    h.ctx.refs.resourceRegistryRef.current!.register({
      id: 'export-result-earlier',
      owner: 'export-result',
      kind: 'blob',
      dispose: disposeEarlier,
    })

    recapture(h, 'pending')
    await orchestrateFullResExport(OPTIONS, h.ctx)
    h.manifest.resolve(SEALED_MANIFEST)
    await settle()

    expect(h.notifications).toEqual([
      { kind: 'started' },
      { kind: 'refused', refusal: TRANSFORM_REFUSALS.pending },
    ])
    expect(h.state.session?.exportState.status).toBe('ready')
    expect(h.state.session?.exportState.result).toEqual({
      ...earlier,
      manifest: SEALED_MANIFEST,
      manifestState: { status: 'ready' },
    })
    expect(disposeEarlier).not.toHaveBeenCalled()
  })

  it('reports the refusal rather than a failure that arrives after the Transform goes pending', async () => {
    const h = createHarness({ session: createAcceptedTransformSession() })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    recapture(h, 'pending')
    job.reject(new Error('FULL_RES_EXPORT_WORKER_FAILED'))
    await run
    await settle()

    expectRefusedAndSettled(h, 'pending')
    expect(h.state.session?.exportState.lastErrorCode).toBeUndefined()
  })
})

describe('orchestrateFullResExport completed output ownership', () => {
  function installFileBackedJob(
    h: Harness,
    outputs: Array<ReturnType<typeof createFileBackedOutput>>,
  ) {
    return h.installJob((filename) => {
      const output = createFileBackedOutput(filename)
      outputs.push(output)
      return output
    })
  }

  it('hands the finished output to the registered result and never removes it itself', async () => {
    const h = createHarness({
      runtime: OPFS_RUNTIME,
      session: createAcceptedTransformSession(),
    })
    const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
    const job = installFileBackedJob(h, outputs)

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    job.resolve()
    await run
    h.manifest.resolve(SEALED_MANIFEST)
    await settle()

    expect(h.ctx.services.registerExportResultResource).toHaveBeenCalledTimes(1)
    const [registered] = vi.mocked(h.ctx.services.registerExportResultResource)
      .mock.calls[0]!
    // The result wraps the output to inject metadata on delivery; removing
    // it is still the output's own cleanup.
    expect(registered.output).toMatchObject({
      kind: 'file-backed',
      exportId: outputs[0]!.exportId,
      cleanup: outputs[0]!.cleanup,
    })
    expect(h.state.session?.exportState.result?.output).toBe(registered.output)
    expect(h.state.session?.exportState.result?.manifestState).toEqual({
      status: 'ready',
    })
    expect(outputs[0]!.cleanup).not.toHaveBeenCalled()
  })

  it('removes the finished output when the source can no longer export at completion', async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
    const job = installFileBackedJob(h, outputs)

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    const live = h.state.session!
    h.replaceSession({
      ...live,
      exportState: {
        ...live.exportState,
        fullResCapability: { status: 'unsupported', reason: 'probe failed' },
      },
    })
    job.resolve()
    await run

    expect(outputs[0]!.cleanup).toHaveBeenCalledTimes(1)
    expect(h.ctx.services.registerExportResultResource).not.toHaveBeenCalled()
  })

  it('removes the finished output when the result cannot be registered', async () => {
    const h = createHarness({ runtime: OPFS_RUNTIME })
    vi.mocked(h.ctx.services.registerExportResultResource).mockImplementation(
      () => {
        throw new Error('RESOURCE_REGISTRY_DUPLICATE_ID:export-result-1')
      },
    )
    const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
    const job = installFileBackedJob(h, outputs)

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    job.resolve()
    await run

    expect(outputs[0]!.cleanup).toHaveBeenCalledTimes(1)
    expect(h.state.session?.exportState.status).toBe('failed')
    expect(h.state.session?.exportState.result).toBeUndefined()
  })

  it.each([
    {
      name: 'rejects',
      cleanup: () => Promise.reject(new Error('NotFoundError')),
    },
    {
      name: 'throws',
      cleanup: () => {
        throw new Error('InvalidStateError')
      },
    },
  ])(
    'settles a dropped export quietly when removing its output $name',
    async ({ cleanup }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = createHarness({ runtime: OPFS_RUNTIME })
      const outputs: Array<ReturnType<typeof createFileBackedOutput>> = []
      const job = h.installJob((filename) => {
        const output = createFileBackedOutput(filename)
        output.cleanup.mockImplementation(cleanup)
        outputs.push(output)
        return output
      })

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      await job.started
      h.ctx.refs.exportGraphVersionRef.current += 1
      job.resolve()
      await expect(run).resolves.toBeUndefined()
      await settle()

      expect(outputs[0]!.cleanup).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(h.notifications).toEqual([{ kind: 'started' }])
    },
  )
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
      expect(h.notifications).toEqual([{ kind: 'started' }])
      expect(h.debugPayloads('export-manifest-failed')).toEqual([
        { reason, message },
      ])
    },
  )

  // A manifest that settles for an attempt that is no longer current writes
  // nothing, its diagnostic included. While the attempt is current, the
  // result it seals must still be the one the session shows.
  const manifestSupersessions: Array<{
    name: string
    session?: () => ImageSession
    supersede: (h: Harness) => void
    resolvedTrace: string[]
    rejectedTrace: string[]
    attached: boolean
  }> = [
    {
      name: 'the session is replaced',
      supersede(h: Harness) {
        h.replaceSession(createSession('session-2'))
      },
      resolvedTrace: [],
      rejectedTrace: [],
      attached: false,
    },
    {
      name: 'the result is cleared on the same session',
      supersede(h: Harness) {
        h.ctx.refs.exportGraphVersionRef.current += 1
        h.ctx.atoms.setSession(clearExportResultState)
      },
      resolvedTrace: [],
      rejectedTrace: [],
      attached: false,
    },
    {
      name: 'a later attempt claims the export slot and ends',
      supersede(h: Harness) {
        const slot = h.ctx.refs.exportAbortControllerRef
        claimExportSlot(slot, new AbortController(), 'later-attempt')
        slot.current = null
      },
      resolvedTrace: [],
      rejectedTrace: [],
      attached: false,
    },
    {
      name: 'the Transform is edited',
      session: createAcceptedTransformSession,
      supersede(h: Harness) {
        const live = h.state.session!
        h.replaceSession({
          ...live,
          transform: editTransform(live.transform!, 11),
        })
      },
      resolvedTrace: [],
      rejectedTrace: [],
      attached: false,
    },
    {
      name: 'the result is replaced on the current attempt',
      supersede(h: Harness) {
        h.ctx.atoms.setSession((prev) =>
          prev
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  result: createPreviousResult(),
                },
              }
            : prev,
        )
      },
      resolvedTrace: ['state:session:unchanged', 'debug:export-manifest-ready'],
      rejectedTrace: [
        'state:session:unchanged',
        'debug:export-manifest-failed',
      ],
      attached: false,
    },
    {
      name: 'a new frame leaves the same Transform pending',
      session: createAcceptedTransformSession,
      supersede(h: Harness) {
        const live = h.state.session!
        h.replaceSession({
          ...live,
          transform: recaptureTransform(live.transform!, 'pending'),
        })
      },
      resolvedTrace: ['state:session:ready', 'debug:export-manifest-ready'],
      rejectedTrace: ['state:session:ready', 'debug:export-manifest-failed'],
      attached: true,
    },
    {
      name: 'a new frame answers the same Transform',
      session: createAcceptedTransformSession,
      supersede(h: Harness) {
        const live = h.state.session!
        h.replaceSession({
          ...live,
          transform: answerTransform(live.transform!, live.exportGeometry!),
        })
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
    async ({
      supersede,
      session,
      outcome,
      expectedTrace,
      attached,
      attachedResult,
    }) => {
      const h = createHarness({ session: session?.() })
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
  it('samples the complete color intent from the store', () => {
    expectTypeOf<
      ReturnType<ExportContext['atoms']['getColorIntent']>
    >().toEqualTypeOf<ColorGraphIntent>()
  })

  const CONFIRMED_LUT = tealLut({
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
  })
  const TEAL_STYLE: ImageSession['activeStyle'] = {
    kind: 'custom',
    name: 'Teal',
    defaultIntensity: 0.7,
    currentIntensity: 0.37,
    lutAsset: { format: 'cube', dimension: 17 },
  }
  const EDITED_PARAMS: ColorGraphIntent = {
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

  it('records the request it was asked for through rendering and late sealing', async () => {
    const params: ColorGraphIntent = { ...EDITED_PARAMS }
    const geometry: ExportGeometry = {
      matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
      constrainCrop: true,
    }
    const expected = captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: EXPORT_ID,
      sessionId: 'session-1',
      sourceFile: SOURCE_FILE,
      intent: EDITED_PARAMS,
      lut: CONFIRMED_LUT,
      rawRenderExposure: RAW_RENDER_EXPOSURE,
      geometry,
    })
    const h = createHarness({
      params,
      lut: CONFIRMED_LUT,
      session: createGeometrySession(geometry, { activeStyle: TEAL_STYLE }),
    })
    const changeView = (mode: ImageSession['viewState']['mode']) => {
      const live = h.state.session!
      h.replaceSession({
        ...live,
        viewState: { ...live.viewState, mode, compareSplit: 0.2, zoom: 3 },
      })
    }
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    await job.started
    // While the worker renders, what the request was read from moves on
    // without ending the attempt: the intent record in place, the LUT the
    // store holds, the decoded image the ref holds, and the view.
    Object.assign(params, { intensity: 1, userContrast: -40 })
    h.writeLut({
      ...CONFIRMED_LUT,
      data: new Float32Array(2 * 2 * 2 * 3).fill(1),
    })
    h.ctx.atoms.decodedImageRef.current = {
      ...createDecodedImage(),
      renderExposure: { ev: 2, multiplier: 4, source: 'user' },
    }
    changeView('original')
    job.resolve()
    await run

    const published = h.state.session?.exportState.result
    expect(published?.manifestState).toEqual({ status: 'sealing' })
    expect(published?.identity).toEqual(expected)
    expect(isSameExportResult(published!.identity!, expected)).toBe(true)
    expect(Object.isFrozen(published!.identity)).toBe(true)
    expect(
      vi.mocked(h.ctx.services.registerExportResultResource).mock.calls[0][0],
    ).toBe(published)
    // The manifest seals the result's own request, whatever the record says.
    expect(h.manifestInputs[0].result).toBe(published)
    expect(h.manifestInputs[0]).not.toHaveProperty('params')
    expect(h.manifestInputs[0]).not.toHaveProperty('rawRenderExposure')

    // Sealing lands after another view change.
    changeView('processed')
    h.manifest.resolve(SEALED_MANIFEST)
    await settle()

    const sealed = h.state.session?.exportState.result
    expect(sealed).toEqual({
      ...published,
      manifest: SEALED_MANIFEST,
      manifestState: { status: 'ready' },
    })
    expect(sealed?.identity).toBe(published?.identity)
  })

  it('names two identical attempts in the same millisecond apart without randomUUID', async () => {
    vi.stubGlobal('crypto', {})
    const h = createHarness()

    const first = await runToReady(h)
    h.manifest.resolve(SEALED_MANIFEST)
    await settle()
    const firstSealed = h.state.session?.exportState.result
    const second = await runToReady(h)
    await settle()
    const secondSealed = h.state.session?.exportState.result

    expect(Date.now()).toBe(FIXED_NOW)
    expect(first.identity!.attemptId).not.toBe(second.identity!.attemptId)
    expect(first.identity!.inputSignature).toBe(second.identity!.inputSignature)
    expect(isSameExportResult(first.identity!, second.identity!)).toBe(false)
    // Sealing keeps each attempt's own identity.
    expect(firstSealed?.manifestState).toEqual({ status: 'ready' })
    expect(firstSealed?.identity).toBe(first.identity)
    expect(secondSealed?.manifestState).toEqual({ status: 'ready' })
    expect(secondSealed?.identity).toBe(second.identity)
  })

  it('exports the color written after the caller rendered, and only that request', async () => {
    vi.mocked(createPreExportSnapshot).mockClear()
    const h = createHarness({
      params: { ...EDITED_PARAMS, intensity: 0.7, userContrast: 0 },
      lut: CONFIRMED_LUT,
      session: createSession('session-1', { activeStyle: TEAL_STYLE }),
    })
    // The color moved in the store after the caller rendered and before
    // the action ran.
    h.writeColorIntent(EDITED_PARAMS)
    const expected = captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: EXPORT_ID,
      sessionId: 'session-1',
      sourceFile: SOURCE_FILE,
      intent: EDITED_PARAMS,
      lut: CONFIRMED_LUT,
      rawRenderExposure: RAW_RENDER_EXPOSURE,
      geometry: null,
    })
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    // A write after admission belongs to no request this attempt answers.
    h.writeColorIntent({ ...EDITED_PARAMS, intensity: 1, userContrast: -40 })
    job.resolve()
    await run

    expect(input.graph).toEqual(
      resolveExportColorGraph({
        ...pickColorGraphIntent(EDITED_PARAMS),
        lut: CONFIRMED_LUT,
        rawRenderExposure: RAW_RENDER_EXPOSURE,
      }),
    )
    expect(lutOutputStep(input)).toMatchObject({ intensity: 0.37 })
    const [snapshotInput] = vi.mocked(createPreExportSnapshot).mock.calls[0]
    expect(snapshotInput.intent).toEqual(pickColorGraphIntent(EDITED_PARAMS))
    const published = h.state.session?.exportState.result
    expect(published?.identity).toEqual(expected)
    expect(h.manifestInputs[0].graph).toBe(input.graph)
    expect(h.manifestInputs[0].result).toBe(published)
  })

  it('reads the look strength and the color from the same instant', async () => {
    vi.mocked(createPreExportSnapshot).mockClear()
    const renderedStyle = { ...TEAL_STYLE!, currentIntensity: 0.7 }
    const h = createHarness({
      params: { ...EDITED_PARAMS, intensity: 0.7 },
      lut: CONFIRMED_LUT,
      session: createSession('session-1', { activeStyle: renderedStyle }),
    })
    // One strength change writes the session's look and the color it
    // projects; both land before the action an older render built runs.
    const liveSession = createSession('session-1', { activeStyle: TEAL_STYLE })
    h.replaceSession(liveSession)
    h.writeColorIntent(EDITED_PARAMS)
    const job = h.installJob()

    const run = orchestrateFullResExport(OPTIONS, h.ctx)
    const input = await job.started
    job.resolve()
    await run

    const [snapshotInput] = vi.mocked(createPreExportSnapshot).mock.calls[0]
    expect(snapshotInput.style).toBe(liveSession.activeStyle)
    expect(snapshotInput.intent.intensity).toBe(
      liveSession.activeStyle?.currentIntensity,
    )
    expect(lutOutputStep(input)).toMatchObject({ intensity: 0.37 })
    expect(h.manifestInputs[0].style).toBe(liveSession.activeStyle)
    expect(h.state.session?.exportState.result?.identity).toEqual(
      captureExportResultIdentity({
        resultKind: 'full-resolution',
        attemptId: EXPORT_ID,
        sessionId: 'session-1',
        sourceFile: SOURCE_FILE,
        intent: EDITED_PARAMS,
        lut: CONFIRMED_LUT,
        rawRenderExposure: RAW_RENDER_EXPOSURE,
        geometry: null,
      }),
    )
  })

  // A LUT apply or a contract change writes the LUT, the session's look and
  // the color in one tick, after it bumps the export graph version. An
  // action an older render built that runs in that tick, or before the
  // workflow's LUT effect catches up, must still export one LUT: the graph,
  // the result's identity and the manifest's look all name the store's.
  describe('when the LUT changes in the same tick as an older action runs', () => {
    // A scene LUT names its output, so it exports once it is confirmed.
    const SLOG3_PROFILE = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      outputRange: 'full',
    } as const
    const SLATE_LUT: LUTData = {
      ...CONFIRMED_LUT,
      data: new Float32Array(2 * 2 * 2 * 3).fill(0.5),
      title: 'Slate',
      profileResolution: {
        kind: 'confirmed',
        confidence: 'metadata',
        profile: SLOG3_PROFILE,
      },
    }

    function styleFor(
      lut: LUTData,
      sha256: string,
    ): NonNullable<ImageSession['activeStyle']> {
      return {
        kind: 'custom',
        name: lut.title ?? 'Custom LUT',
        defaultIntensity: 0.7,
        currentIntensity: 0.37,
        lutAsset: {
          format: 'cube',
          dimension: 17,
          title: lut.title,
          profileResolution: lut.profileResolution,
          sha256,
        },
      }
    }

    async function exportAfterSameTickLutChange(setup: {
      rendered: { lut: LUTData | null; style: ImageSession['activeStyle'] }
      renderedParams: ColorGraphIntent
      written: { lut: LUTData; style: NonNullable<ImageSession['activeStyle']> }
    }) {
      const h = createHarness({
        params: setup.renderedParams,
        lut: setup.rendered.lut,
        session: createSession('session-1', {
          activeStyle: setup.rendered.style,
        }),
      })
      // The change invalidates the export graph first, then writes the LUT,
      // the look and the color, all before the older action runs.
      h.ctx.refs.exportGraphVersionRef.current += 1
      h.writeLut(setup.written.lut)
      h.replaceSession(
        createSession('session-1', { activeStyle: setup.written.style }),
      )
      h.writeColorIntent(EDITED_PARAMS)
      const job = h.installJob()

      const run = orchestrateFullResExport(OPTIONS, h.ctx)
      const input = await job.started
      job.resolve()
      await run

      const lut = setup.written.lut
      expect(input.graph).toEqual(
        resolveExportColorGraph({
          ...pickColorGraphIntent(EDITED_PARAMS),
          lut,
          rawRenderExposure: RAW_RENDER_EXPOSURE,
        }),
      )
      const published = h.state.session?.exportState.result
      expect(published?.identity).toEqual(
        captureExportResultIdentity({
          resultKind: 'full-resolution',
          attemptId: EXPORT_ID,
          sessionId: 'session-1',
          sourceFile: SOURCE_FILE,
          intent: EDITED_PARAMS,
          lut,
          rawRenderExposure: RAW_RENDER_EXPOSURE,
          geometry: null,
        }),
      )
      expect(published?.identity?.lut?.contract).toMatchObject({
        status: 'confirmed',
        inputGamut: SLOG3_PROFILE.inputGamut,
      })
      const [manifestInput] = h.manifestInputs
      expect(manifestInput.result).toBe(published)
      expect(manifestInput.graph).toBe(input.graph)
      expect(manifestInput.style).toBe(setup.written.style)
      expect(manifestInput.style?.lutAsset?.profileResolution).toBe(
        lut.profileResolution,
      )
      return input
    }

    it('exports the LUT applied over another one', async () => {
      vi.mocked(createPreExportSnapshot).mockClear()
      const input = await exportAfterSameTickLutChange({
        rendered: { lut: CONFIRMED_LUT, style: TEAL_STYLE },
        renderedParams: EDITED_PARAMS,
        written: { lut: SLATE_LUT, style: styleFor(SLATE_LUT, 'slate-sha') },
      })

      expect(input.graph).not.toEqual(
        resolveExportColorGraph({
          ...pickColorGraphIntent(EDITED_PARAMS),
          lut: CONFIRMED_LUT,
          rawRenderExposure: RAW_RENDER_EXPOSURE,
        }),
      )
      const [snapshotInput] = vi.mocked(createPreExportSnapshot).mock.calls[0]
      expect(snapshotInput.graph).toBe(input.graph)
      expect(snapshotInput.lutTitle).toBe('Slate')
    })
  })
})
