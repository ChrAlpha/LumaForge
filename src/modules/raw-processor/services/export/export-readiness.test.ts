import { afterEach, describe, expect, it, vi } from 'vitest'

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
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      recovery: { status: 'none' },
      checkpointDurable: false,
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
