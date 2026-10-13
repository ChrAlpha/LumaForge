import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  resolveUnsupportedLUTOutputReason,
} from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '@lumaforge/render-engine/export'
import type {
  CapabilityVector,
  ExportRuntimeResources,
} from '@lumaforge/render-engine/policy'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExportPlanFacts } from '~/lib/export/export-plan'
import { selectExportPlan } from '~/lib/export/export-plan'
import { composeManualTransform } from '~/lib/transform/transform-render'
import { FOLDING_TRANSFORM } from '~/modules/raw-processor/test-support/transform-geometry-test-cases'

import {
  deriveExportRefusal,
  deriveLutContractExportRefusal,
} from '../../model/derive-session'
import type { FullResExportReason } from '../../model/export-result'
import type { ImageSession, TransformState } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import type {
  TransformEvent,
  TransformStatus,
} from '../transform/transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  reduceTransformState,
} from '../transform/transform-state'
import {
  deriveFullResExportReadiness,
  deriveTransformExportRefusalReason,
  planFullResExport,
  planFullResExportRequest,
} from './export-readiness'

function createSession(
  exportState: Partial<ImageSession['exportState']> = {},
): ImageSession {
  return {
    id: 'session-export-readiness',
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
    },
    activeStyle: null,
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
      fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      ...exportState,
    },
    exportGeometry: null,
    transform: createTransformState('session-export-readiness'),
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

/**
 * The session's Transform after the events that reach each status: a first
 * edit whose request for `geometry` is unanswered, an answered one, and the
 * two failures.
 */
function transformAt(
  status: TransformStatus,
  sourceId = 'session-export-readiness',
  geometry: ExportGeometry = SAMPLE_GEOMETRY,
): TransformState {
  const events: TransformEvent[] = []
  const edit: TransformEvent = {
    type: 'edit',
    sourceId,
    intent: {
      manual: { ...createTransformState(sourceId).intent.manual, rotate: 2 },
    },
  }
  const capture: TransformEvent = {
    type: 'capture',
    sourceId,
    captureKey: 'k',
    clientEpoch: 1,
  }
  const request: TransformEvent = {
    type: 'request',
    sourceId,
    captureKey: 'k',
    clientEpoch: 1,
    requestId: 1,
    geometry,
  }
  if (status !== 'neutral') events.push(edit, capture)
  if (status === 'pending' || status === 'accepted' || status === 'invalid')
    events.push(request)
  if (status === 'accepted')
    events.push({
      type: 'rendered',
      sourceId,
      captureKey: 'k',
      clientEpoch: 1,
      requestId: 1,
      geometry,
      frame: { width: 800, height: 600 },
    })
  if (status === 'invalid')
    events.push({
      type: 'render-failed',
      sourceId,
      captureKey: 'k',
      clientEpoch: 1,
      requestId: 1,
      failure: 'transform',
    })
  if (status === 'unavailable')
    events.push({
      type: 'capture-failed',
      sourceId,
      captureKey: 'k',
      clientEpoch: 1,
    })
  const state = events.reduce(
    reduceTransformState,
    createTransformState(sourceId),
  )
  expect(deriveTransformStatus(state)).toBe(status)
  return state
}

/** A session whose accepted Transform answered and holds `geometry`. */
function createGeometrySession(
  geometry: ExportGeometry = SAMPLE_GEOMETRY,
): ImageSession {
  const transform = transformAt('accepted', undefined, geometry)
  return {
    ...createSession(),
    transform,
    exportGeometry: heldTransformGeometry(transform),
  }
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const
const SOURCE = { width: 4000, height: 3000 }
const IDENTITY_EXPOSURE = { ev: 0, multiplier: 1, source: 'identity' } as const

/** Its projective horizon crosses the unconstrained output frame. */
const FOLDING_MATRIX = composeManualTransform(
  IDENTITY,
  FOLDING_TRANSFORM,
  SOURCE.width / SOURCE.height,
)

/**
 * Committed geometries the engine refuses to plan: the fold the manual
 * controls can compose, then state that is malformed or non-finite. The
 * engine's own geometry tests hold the rest of what it refuses.
 */
const INVALID_GEOMETRIES: ReadonlyArray<
  readonly [label: string, geometry: ExportGeometry]
> = [
  [
    'a fold inside the unconstrained frame',
    { matrix: FOLDING_MATRIX, constrainCrop: false },
  ],
  [
    'a matrix that is not an array',
    { matrix: {} as unknown as ExportGeometry['matrix'], constrainCrop: true },
  ],
  [
    'an infinite entry',
    {
      matrix: [1, 0, Number.POSITIVE_INFINITY, 0, 1, 0, 0, 0, 1],
      constrainCrop: false,
    },
  ],
]

describe('export readiness helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps unsafe large iOS blob-handoff exports disabled with product copy', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: {},
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    const readiness = deriveFullResExportReadiness({
      sourceFile: new File(['raw'], 'frame.RAF'),
      session: createSession({
        fullResCapability: {
          status: 'supported',
          width: 11662,
          height: 8746,
        },
      }),
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    })

    expect(readiness).toEqual({
      canExport: false,
      refusal: { code: 'cannot-safely-complete' },
    })
  })

  it('assumes a reachable OPFS has room, sampling no storage and handing out no plan', () => {
    const estimate = vi.fn(async () => ({ quota: 1, usage: 1 }))
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: { getDirectory: vi.fn(), estimate },
      hardwareConcurrency: 4,
    })
    vi.stubGlobal('crossOriginIsolated', false)

    const sourceFile = new File(['raw'], 'frame.RAF')
    const session = createSession({
      fullResCapability: { status: 'supported', width: 11662, height: 8746 },
    })
    // Optimistic: the export samples real storage, and refuses then if the
    // sink cannot hold the output. Nothing readiness planned may run, so it
    // answers only whether the export may start.
    expect(
      deriveFullResExportReadiness({
        sourceFile,
        session,
        rawRenderExposure: IDENTITY_EXPOSURE,
      }),
    ).toEqual({
      canExport: true,
      sourceFile,
      session,
      rawRenderExposure: IDENTITY_EXPOSURE,
      fullResCapability: { status: 'supported', width: 11662, height: 8746 },
      deliveredSize: { width: 11662, height: 8746 },
    })
    expect(estimate).not.toHaveBeenCalled()
  })

  it.each(INVALID_GEOMETRIES)(
    'refuses %s before any export work is planned',
    (_label, geometry) => {
      // The engine is the final authority; readiness only mirrors its verdict.
      expect(() => planExportGeometry(geometry, SOURCE)).toThrow(
        INVALID_EXPORT_GEOMETRY,
      )

      expect(
        deriveFullResExportReadiness({
          sourceFile: new File(['raw'], 'frame.ARW'),
          session: { ...createSession(), exportGeometry: geometry },
          rawRenderExposure: IDENTITY_EXPOSURE,
        }),
      ).toEqual({
        canExport: false,
        refusal: { code: 'geometry-unplannable' },
      })
    },
  )

  it('plans the delivered frame from the committed geometry', () => {
    // Constraining the crop pulls the same fold back inside its horizon.
    const geometry = { matrix: FOLDING_MATRIX, constrainCrop: true }
    const planned = planExportGeometry(geometry, SOURCE)
    expect(planned.outputWidth).toBeLessThan(SOURCE.width)

    const cropped = deriveFullResExportReadiness({
      sourceFile: new File(['raw'], 'frame.ARW'),
      session: createGeometrySession(geometry),
      rawRenderExposure: IDENTITY_EXPOSURE,
    })
    expect(cropped.canExport).toBe(true)
    if (!cropped.canExport) throw new Error('expected export readiness')
    expect(cropped.deliveredSize).toEqual({
      width: planned.outputWidth,
      height: planned.outputHeight,
    })

    // No geometry is either a cleared one or the key the session factory
    // leaves out until a Transform moves the geometry.
    for (const session of [
      createSession(),
      { ...createSession(), exportGeometry: null },
    ]) {
      const neutral = deriveFullResExportReadiness({
        sourceFile: new File(['raw'], 'frame.ARW'),
        session,
        rawRenderExposure: IDENTITY_EXPOSURE,
      })
      if (!neutral.canExport) throw new Error('expected export readiness')
      expect(neutral.deliveredSize).toEqual(SOURCE)
    }
  })

  it('refuses with the first unmet requirement, in order', () => {
    const sourceFile = new File(['raw'], 'frame.ARW')
    const builtin: ImageSession['activeStyle'] = {
      kind: 'builtin',
      name: 'Neutral',
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
    }
    const quickPending: ImageSession['previewBundle'] = {
      ...createSession().previewBundle,
      quickDecodePreview: { status: 'idle' },
    }
    const folding = { matrix: FOLDING_MATRIX, constrainCrop: false }
    const cases: Array<
      readonly [
        refusal: FullResExportReason,
        input: Parameters<typeof deriveFullResExportReadiness>[0],
      ]
    > = [
      [
        { code: 'source-loading' },
        {
          sourceFile: null,
          session: createSession({ status: 'exporting' }),
          rawRenderExposure: null,
        },
      ],
      [
        { code: 'source-loading' },
        { sourceFile, session: null, rawRenderExposure: null },
      ],
      [
        { code: 'export-running' },
        {
          sourceFile,
          session: {
            ...createSession({
              status: 'exporting',
              fullResCapability: { status: 'probing' },
            }),
            previewBundle: quickPending,
          },
          rawRenderExposure: null,
        },
      ],
      [
        { code: 'quick-preview-pending' },
        {
          sourceFile,
          session: {
            ...createSession({ fullResCapability: { status: 'unknown' } }),
            previewBundle: quickPending,
          },
          rawRenderExposure: null,
        },
      ],
      ...(
        [
          [{ code: 'capability-unchecked' }, { status: 'unknown' }],
          [{ code: 'capability-probing' }, { status: 'probing' }],
          [
            {
              code: 'runtime-unsupported',
              detail: 'processed-window-unavailable',
            },
            {
              status: 'unsupported',
              reason: 'processed-window-unavailable',
            },
          ],
        ] as const
      ).map(
        ([refusal, fullResCapability]) =>
          [
            refusal,
            {
              sourceFile,
              session: {
                ...createSession({ fullResCapability }),
                activeStyle: builtin,
              },
              rawRenderExposure: null,
            },
          ] as const,
      ),
      [
        { code: 'builtin-style' },
        {
          sourceFile,
          session: {
            ...createSession(),
            activeStyle: builtin,
            exportGeometry: folding,
          },
          rawRenderExposure: null,
        },
      ],
      [
        { code: 'geometry-unplannable' },
        {
          sourceFile,
          session: { ...createSession(), exportGeometry: folding },
          rawRenderExposure: null,
        },
      ],
      [
        { code: 'exposure-pending' },
        { sourceFile, session: createSession(), rawRenderExposure: null },
      ],
    ]
    for (const [refusal, input] of cases) {
      expect(deriveFullResExportReadiness(input)).toEqual({
        canExport: false,
        refusal,
      })
    }
  })

  it('names each LUT contract refusal by code, keeping the color runtime text as data', () => {
    const lutStyle = (
      profileResolution: LUTContractResolution,
    ): ImageSession['activeStyle'] => ({
      kind: 'custom',
      name: 'LUT',
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
      lutAsset: { format: 'cube', dimension: 33, profileResolution },
    })
    const vlog = getLUTColorProfile('panasonic-vgamut-vlog')!
    const linear: LUTColorProfile = {
      ...vlog,
      role: 'technical-output',
      outputGamut: 'v-gamut',
      outputTransfer: 'linear',
      outputRange: 'full',
    }
    const cases = [
      [{ kind: 'unknown' }, { code: 'lut-input-unconfirmed' }],
      [
        { kind: 'recommended', recommendations: [vlog] },
        { code: 'lut-input-unconfirmed' },
      ],
      [
        { kind: 'unsupported-output', recommendations: [] },
        { code: 'lut-output-unsupported' },
      ],
      [
        { kind: 'confirmed', confidence: 'metadata', profile: linear },
        {
          code: 'lut-output-refused',
          detail: resolveUnsupportedLUTOutputReason(linear)!.message,
        },
      ],
    ] as const satisfies ReadonlyArray<
      readonly [LUTContractResolution, FullResExportReason]
    >
    for (const [resolution, refusal] of cases) {
      const style = lutStyle(resolution)
      expect(deriveLutContractExportRefusal(style)).toEqual(refusal)
      const readiness = deriveFullResExportReadiness({
        sourceFile: new File(['raw'], 'frame.ARW'),
        session: { ...createSession(), activeStyle: style },
        rawRenderExposure: IDENTITY_EXPOSURE,
      })
      expect(readiness).toEqual({ canExport: false, refusal })
    }
    expect(deriveLutContractExportRefusal(null)).toBeUndefined()
    expect(
      deriveLutContractExportRefusal(
        lutStyle({
          kind: 'confirmed',
          confidence: 'metadata',
          profile: {
            ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
            role: 'combined-look-output',
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            outputRange: 'full',
          },
        }),
      ),
    ).toBeUndefined()
  })

  it('decides on the runtime verdict, never on its diagnostic text', () => {
    for (const reason of ['', 'Quick preview is still being prepared.']) {
      const session = createSession({
        fullResCapability: { status: 'unsupported', reason },
      })
      expect(deriveExportRefusal(session)).toEqual({
        code: 'runtime-unsupported',
        detail: reason,
      })
    }
  })
})

describe('deriveTransformExportRefusalReason', () => {
  const FULL_RES_REFUSALS = ['pending', 'invalid', 'unavailable'] as const

  it('admits a full-resolution export only for a neutral or accepted Transform', () => {
    for (const status of ['neutral', 'accepted'] as const) {
      const transform = transformAt(status)
      const session: ImageSession = {
        ...createSession(),
        transform,
        exportGeometry: heldTransformGeometry(transform),
      }
      expect(
        deriveTransformExportRefusalReason(session, 'full-resolution'),
      ).toBeUndefined()
    }
  })

  it.each(FULL_RES_REFUSALS)(
    'refuses a full-resolution export while the Transform is %s',
    (status) => {
      const transform = transformAt(status)
      const session: ImageSession = { ...createSession(), transform }
      expect(
        deriveTransformExportRefusalReason(session, 'full-resolution'),
      ).toEqual({ code: `transform-${status}` })
      // An accepted answer the session still holds does not stand for a
      // newer intent.
      expect(
        deriveTransformExportRefusalReason(
          { ...session, exportGeometry: SAMPLE_GEOMETRY },
          'full-resolution',
        ),
      ).toEqual({ code: `transform-${status}` })
    },
  )

  it('admits an HQ preview export only for a neutral Transform with no geometry', () => {
    expect(
      deriveTransformExportRefusalReason(createSession(), 'hq-preview'),
    ).toBeUndefined()
    expect(
      deriveTransformExportRefusalReason(
        { ...createSession(), transform: transformAt('neutral') },
        'hq-preview',
      ),
    ).toBeUndefined()
    // A held geometry beside a neutral Transform is a deliberately
    // inconsistent input: the geometry alone still refuses a preview export.
    expect(
      deriveTransformExportRefusalReason(
        { ...createSession(), exportGeometry: SAMPLE_GEOMETRY },
        'hq-preview',
      ),
    ).toBe('transform-held')
    for (const status of [
      'accepted',
      'pending',
      'invalid',
      'unavailable',
    ] as const) {
      expect(
        deriveTransformExportRefusalReason(
          { ...createSession(), transform: transformAt(status) },
          'hq-preview',
        ),
      ).toBe('transform-held')
    }
  })
})

describe('full-resolution export request planning', () => {
  const DESKTOP: CapabilityVector = {
    coi: true,
    pthread: true,
    deviceMemoryGB: 16,
    hwConcurrency: 8,
    webKitClass: 'chromium',
    deviceFormFactor: 'desktop',
    maybeOpfsSupported: true,
  }
  const MOBILE: CapabilityVector = {
    coi: false,
    pthread: false,
    deviceMemoryGB: null,
    hwConcurrency: 4,
    webKitClass: 'webkit-mobile',
    deviceFormFactor: 'mobile',
    maybeOpfsSupported: true,
  }
  const BLOB: ExportRuntimeResources = {
    opfsSinkAvailable: false,
    opfsAvailableMB: null,
  }
  const OPFS: ExportRuntimeResources = {
    opfsSinkAvailable: true,
    opfsAvailableMB: 10_000,
  }
  const LARGE = { width: 9000, height: 6000 }

  it('asks for the sensor frame, the preference and the source hint only', () => {
    expect(
      planFullResExportRequest({
        source: { width: 6000, height: 4000 },
        performancePreference: 'max',
        interruption: {
          previousCrashLikeInterruption: true,
          previousResourceFailure: false,
          attempts: ['closed-page-attempt-1'],
        },
      }),
    ).toEqual({
      preference: 'max',
      source: { width: 6000, height: 4000 },
      history: {
        previousCrashLikeInterruption: true,
        previousResourceFailure: false,
      },
    })
    // No preference asks for the balanced plan; no hint asks for nothing.
    for (const interruption of [null, undefined]) {
      expect(planFullResExportRequest({ source: LARGE, interruption })).toEqual(
        {
          preference: 'balanced',
          source: LARGE,
          history: {
            previousCrashLikeInterruption: false,
            previousResourceFailure: false,
          },
        },
      )
    }
  })

  it('copies the source frame instead of keeping the caller object', () => {
    const source = { width: 6000, height: 4000 }
    const request = planFullResExportRequest({ source })
    source.width = 1
    expect(request.source).toEqual({ width: 6000, height: 4000 })
  })

  it('plans the request over the facts it is handed through the one plan entry', () => {
    const request = planFullResExportRequest({
      source: LARGE,
      performancePreference: 'safe',
      interruption: {
        previousCrashLikeInterruption: false,
        previousResourceFailure: true,
        attempts: ['a'],
      },
    })
    for (const facts of [
      { capability: DESKTOP, runtime: BLOB },
      { capability: MOBILE, runtime: OPFS },
    ] satisfies ExportPlanFacts[]) {
      const frozen = structuredClone(facts)
      const decision = planFullResExport(request, facts)
      expect(decision).toEqual({
        kind: 'run',
        plan: selectExportPlan({ ...request, ...facts }),
      })
      // Pure: the same request and facts plan the same way, untouched.
      expect(planFullResExport(request, facts)).toEqual(decision)
      expect(facts).toEqual(frozen)
    }
  })

  it('refuses a large mobile export without OPFS with the policy copy', () => {
    expect(
      planFullResExport(planFullResExportRequest({ source: LARGE }), {
        capability: MOBILE,
        runtime: BLOB,
      }),
    ).toEqual({
      kind: 'refuse',
      refusal: { code: 'cannot-safely-complete' },
    })
  })
})
