import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '@lumaforge/render-engine/export'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FOLDING_TRANSFORM } from '~/lib/export/transform-geometry-test-cases'
import { composeManualTransform } from '~/modules/transform-demo/transform-render'

import type { ImageSession } from '../../model/session'
import { deriveFullResExportReadiness } from './export-readiness'

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
      boundedHqRequiredForExport: false,
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
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      retryRecommended: false,
      ...exportState,
    },
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const
const SOURCE = { width: 4000, height: 3000 }
const IDENTITY_EXPOSURE = { ev: 0, multiplier: 1, source: 'identity' } as const
const INVALID_GEOMETRY_REASON =
  'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.'

/** Its projective horizon crosses the unconstrained output frame. */
const FOLDING_MATRIX = composeManualTransform(
  IDENTITY,
  FOLDING_TRANSFORM,
  SOURCE.width / SOURCE.height,
)

/**
 * Committed geometries the engine refuses to plan: the known fold, then state
 * that is malformed, non-finite or singular.
 */
const INVALID_GEOMETRIES: ReadonlyArray<
  readonly [label: string, geometry: ExportGeometry]
> = [
  [
    'a fold inside the unconstrained frame',
    { matrix: FOLDING_MATRIX, constrainCrop: false },
  ],
  [
    'a matrix missing an entry',
    { matrix: IDENTITY.slice(0, 8), constrainCrop: true },
  ],
  [
    'a matrix that is not an array',
    { matrix: {} as never, constrainCrop: true },
  ],
  [
    'a NaN entry',
    { matrix: [1, 0, 0, 0, Number.NaN, 0, 0, 0, 1], constrainCrop: true },
  ],
  [
    'an infinite entry',
    {
      matrix: [1, 0, Number.POSITIVE_INFINITY, 0, 1, 0, 0, 0, 1],
      constrainCrop: false,
    },
  ],
  [
    'a singular matrix',
    { matrix: [1, 2, 0, 2, 4, 0, 0, 0, 1], constrainCrop: true },
  ],
  [
    'an all-zero matrix',
    { matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0], constrainCrop: false },
  ],
  [
    'a horizon crossing the source frame',
    { matrix: [1, 0, 0, 0, 1, 0, -2, 0, 1], constrainCrop: true },
  ],
]

describe('export readiness helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps full-resolution export available while a geometry is committed', () => {
    const input = {
      sourceFile: new File(['raw'], 'frame.ARW'),
      session: { ...createSession(), exportGeometry: SAMPLE_GEOMETRY },
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' as const },
    }

    // Full resolution reproduces the geometry, so it is no longer a blocker.
    const readiness = deriveFullResExportReadiness(input)
    expect(readiness.canExport).toBe(true)
    expect(readiness.disabledReason).toBeUndefined()
    expect(
      deriveFullResExportReadiness({
        ...input,
        session: { ...input.session, exportGeometry: null },
      }).canExport,
    ).toBe(true)
  })

  it('requires a source file and active session before full-resolution export is ready', () => {
    const file = new File(['raw'], 'frame.ARW')
    const rawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    } as const

    expect(
      deriveFullResExportReadiness({
        sourceFile: null,
        session: createSession(),
        rawRenderExposure,
      }),
    ).toEqual({
      canExport: false,
      disabledReason: 'Full-resolution export source is still loading.',
    })
    expect(
      deriveFullResExportReadiness({
        sourceFile: file,
        session: null,
        rawRenderExposure,
      }),
    ).toEqual({
      canExport: false,
      disabledReason: 'Full-resolution export source is still loading.',
    })
  })

  it('keeps export disabled while capability is probing or unsupported after quick preview is ready', () => {
    const file = new File(['raw'], 'frame.ARW')
    const rawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    } as const

    expect(
      deriveFullResExportReadiness({
        sourceFile: file,
        session: createSession({
          fullResCapability: { status: 'probing' },
        }),
        rawRenderExposure,
      }),
    ).toEqual({
      canExport: false,
      disabledReason:
        'Checking full-resolution export support for this RAW file.',
    })
    expect(
      deriveFullResExportReadiness({
        sourceFile: file,
        session: createSession({
          fullResCapability: {
            status: 'unsupported',
            reason: 'processed-window-unavailable',
          },
        }),
        rawRenderExposure,
      }),
    ).toEqual({
      canExport: false,
      disabledReason: 'processed-window-unavailable',
    })
  })

  it('requires decoded RAW render exposure after source and capability are ready', () => {
    expect(
      deriveFullResExportReadiness({
        sourceFile: new File(['raw'], 'frame.ARW'),
        session: createSession(),
        rawRenderExposure: null,
      }),
    ).toEqual({
      canExport: false,
      disabledReason: 'RAW preview exposure is still being prepared.',
    })
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

    expect(readiness.canExport).toBe(false)
    expect(readiness.disabledReason).toMatch(
      /cannot safely complete this large local full-resolution export/i,
    )
  })

  it('assumes a reachable OPFS has room without sampling storage', () => {
    const estimate = vi.fn(async () => ({ quota: 1, usage: 1 }))
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 1,
      storage: { getDirectory: vi.fn(), estimate },
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
      rawRenderExposure: IDENTITY_EXPOSURE,
    })

    // Optimistic: the export samples real storage, and refuses then if the
    // sink cannot hold the output.
    expect(readiness.canExport).toBe(true)
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
      ).toEqual({ canExport: false, disabledReason: INVALID_GEOMETRY_REASON })
    },
  )

  it('plans the delivered frame from the committed geometry', () => {
    // Constraining the crop pulls the same fold back inside its horizon.
    const geometry = { matrix: FOLDING_MATRIX, constrainCrop: true }
    const planned = planExportGeometry(geometry, SOURCE)
    expect(planned.outputWidth).toBeLessThan(SOURCE.width)

    const cropped = deriveFullResExportReadiness({
      sourceFile: new File(['raw'], 'frame.ARW'),
      session: { ...createSession(), exportGeometry: geometry },
      rawRenderExposure: IDENTITY_EXPOSURE,
    })
    expect(cropped.canExport).toBe(true)
    if (!cropped.canExport) throw new Error('expected export readiness')
    expect(cropped.deliveredSize).toEqual({
      width: planned.outputWidth,
      height: planned.outputHeight,
    })

    for (const exportGeometry of [null, undefined]) {
      const neutral = deriveFullResExportReadiness({
        sourceFile: new File(['raw'], 'frame.ARW'),
        session: { ...createSession(), exportGeometry },
        rawRenderExposure: IDENTITY_EXPOSURE,
      })
      if (!neutral.canExport) throw new Error('expected export readiness')
      expect(neutral.deliveredSize).toEqual(SOURCE)
    }
  })

  it('marks export ready only when source, session, quick preview, capability, exposure, and plan are safe', () => {
    const sourceFile = new File(['raw'], 'frame.ARW')
    const session = createSession()
    const rawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    } as const

    const readiness = deriveFullResExportReadiness({
      sourceFile,
      session,
      rawRenderExposure,
    })

    expect(readiness.canExport).toBe(true)
    if (!readiness.canExport) throw new Error('expected export readiness')
    expect(readiness.disabledReason).toBeUndefined()
    expect(readiness.sourceFile).toBe(sourceFile)
    expect(readiness.session).toBe(session)
    expect(readiness.rawRenderExposure).toBe(rawRenderExposure)
    expect(readiness.fullResCapability).toEqual({
      status: 'supported',
      width: 4000,
      height: 3000,
    })
  })
})
