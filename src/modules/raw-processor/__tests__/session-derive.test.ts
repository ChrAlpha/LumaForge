import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'

import {
  deriveCanEdit,
  deriveCanExport,
  deriveExportDisabledReason,
  deriveLutContractExportReason,
  selectDisplaySource,
} from '../model/derive-session'
import type { ImageSession } from '../model/session'

const baseSession: ImageSession = {
  id: 's1',
  createdAt: 1,
  sourceFile: {
    name: 'frame.ARW',
    extension: 'arw',
    sizeBytes: 1,
    supportLevel: 'experimental',
  },
  previewBundle: {
    embeddedPreview: { status: 'idle' },
    quickDecodePreview: { status: 'idle' },
    boundedHqPreview: { status: 'idle' },
    displaySource: 'none',
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
  renderState: { status: 'idle' },
  exportState: {
    status: 'idle',
    qualityPreset: 'high',
    fidelityLevel: 'balanced',
    fullResCapability: { status: 'unknown' },
    recovery: { status: 'none' },
    checkpointDurable: false,
    retryRecommended: false,
  },
}

describe('session derivation', () => {
  it('enables editing when any preview source is ready', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 200, height: 100 },
      },
    }

    expect(deriveCanEdit(session)).toBe(true)
    expect(selectDisplaySource(session.previewBundle)).toBe('quick')
  })

  it('enables export when full-resolution capability is supported even if bounded HQ preview failed', () => {
    expect(deriveCanExport(baseSession)).toBe(false)

    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1500 },
        boundedHqPreview: {
          status: 'failed',
          errorCode: 'RAW_BOUNDED_HQ_DECODE_FAILED',
        },
      },
      renderState: { status: 'idle' as const },
      exportState: {
        ...baseSession.exportState,
        status: 'idle',
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
    }

    expect(deriveCanExport(session)).toBe(true)
  })

  it('prefers bounded HQ for display without requiring it for export', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
        boundedHqPreview: { status: 'ready', width: 4000, height: 3000 },
      },
      exportState: {
        ...baseSession.exportState,
        status: 'idle',
        fullResCapability: { status: 'supported', width: 8000, height: 6000 },
      },
    }

    expect(selectDisplaySource(session.previewBundle)).toBe('bounded-hq')
    expect(deriveCanExport(session)).toBe(true)
  })

  it('keeps export available when bounded HQ fails after quick preview', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
        boundedHqPreview: {
          status: 'failed',
          errorCode: 'RAW_BOUNDED_HQ_DECODE_FAILED',
        },
      },
      exportState: {
        ...baseSession.exportState,
        status: 'idle',
        fullResCapability: { status: 'supported', width: 8000, height: 6000 },
      },
    }

    expect(selectDisplaySource(session.previewBundle)).toBe('quick')
    expect(deriveCanEdit(session)).toBe(true)
    expect(deriveCanExport(session)).toBe(true)
  })

  it('keeps export runnable when a previous result is ready', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      exportState: {
        ...baseSession.exportState,
        status: 'ready',
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
    }

    expect(deriveCanExport(session)).toBe(true)
    expect(deriveExportDisabledReason(session)).toBeUndefined()
  })

  it('requires quick preview before full-resolution export can be enabled', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        boundedHqPreview: { status: 'ready', width: 4000, height: 3000 },
      },
      exportState: {
        ...baseSession.exportState,
        status: 'idle',
        fullResCapability: { status: 'supported', width: 8000, height: 6000 },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'Quick preview is still being prepared.',
    )
  })

  it('disables export for builtin styles before the export button becomes available', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'builtin',
        name: 'Neutral',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'Built-in styles are not supported by full-resolution JPEG export.',
    )
  })

  it('surfaces unsupported LUT output before export is triggered', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'custom',
        name: 'Display LUT',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'unsupported-output',
            recommendations: [],
          },
        },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'This LUT output transfer is not supported by full-resolution JPEG export.',
    )
  })

  it('blocks export with the choose-input reason for a recommended LUT contract', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'custom',
        name: 'Recommended LUT',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'recommended',
            recommendations: [getLUTColorProfile('panasonic-vgamut-vlog')!],
          },
        },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'Choose a LUT input profile before full-resolution export.',
    )
  })

  it('blocks export with the choose-input reason for an unknown LUT contract', () => {
    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'custom',
        name: 'Unknown LUT',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'unknown',
          },
        },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'Choose a LUT input profile before full-resolution export.',
    )
  })

  it('disables export for resolved technical-output LUTs with linear output transfer', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')
    expect(profile).toBeDefined()

    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'custom',
        name: 'Technical LUT',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'confirmed',
            confidence: 'metadata',
            profile: {
              ...profile!,
              role: 'technical-output',
              outputGamut: 'v-gamut',
              outputTransfer: 'linear',
              outputRange: 'full',
            },
          },
        },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'This LUT output transfer is not supported by full-resolution JPEG export.',
    )
  })

  it('disables export for resolved technical-output LUTs with unknown output range', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')
    expect(profile).toBeDefined()

    const session: ImageSession = {
      ...baseSession,
      previewBundle: {
        ...baseSession.previewBundle,
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      },
      renderState: { status: 'ready' as const },
      exportState: {
        ...baseSession.exportState,
        fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      },
      activeStyle: {
        kind: 'custom',
        name: 'Technical LUT',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'confirmed',
            confidence: 'metadata',
            profile: {
              ...profile!,
              role: 'technical-output',
              outputGamut: 'v-gamut',
              outputTransfer: 'v-log',
              outputRange: 'unknown',
            },
          },
        },
      },
    }

    expect(deriveCanExport(session)).toBe(false)
    expect(deriveExportDisabledReason(session)).toBe(
      'This LUT output range must be explicit before full-resolution JPEG export.',
    )
  })

  it('names a LUT contract export block only for a custom LUT', () => {
    expect(deriveLutContractExportReason(null)).toBeUndefined()
    expect(
      deriveLutContractExportReason({
        kind: 'builtin',
        name: 'Builtin',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
      }),
    ).toBeUndefined()
    expect(
      deriveLutContractExportReason({
        kind: 'custom',
        name: 'Unknown',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: { kind: 'unknown' },
        },
      }),
    ).toBe('Choose a LUT input profile before full-resolution export.')
    const display = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }
    expect(
      deriveLutContractExportReason({
        kind: 'custom',
        name: 'Display',
        defaultIntensityLevel: 'standard',
        currentIntensityLevel: 'standard',
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: {
            kind: 'confirmed',
            profile: display,
            confidence: 'metadata',
          },
        },
      }),
    ).toBeUndefined()
  })
})
