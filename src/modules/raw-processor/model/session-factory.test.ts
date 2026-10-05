import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LUTContractSelectionState, StyleAsset } from './session'
import { createImageSession } from './session-factory'

describe('createImageSession', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates the default RAW session shape from source file facts', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    )
    vi.spyOn(Date, 'now').mockReturnValue(12345)

    const file = new File(['raw'], 'Frame.ARW')
    const session = createImageSession(file)

    expect(session).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: 12345,
      sourceFile: {
        file,
        name: 'Frame.ARW',
        extension: 'arw',
        sizeBytes: 3,
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
      lutProfileSelection: undefined,
      viewState: {
        mode: 'compare',
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
    })
  })

  it('preserves the current extension derivation when the file has no dot', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000002',
    )
    vi.spyOn(Date, 'now').mockReturnValue(12346)

    const file = new File(['raw'], 'RAWFILE')

    expect(createImageSession(file).sourceFile).toEqual({
      file,
      name: 'RAWFILE',
      extension: 'rawfile',
      sizeBytes: 3,
      supportLevel: 'experimental',
    })
  })

  it('retains staged style and LUT profile selection when provided', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000003',
    )
    vi.spyOn(Date, 'now').mockReturnValue(12347)

    const activeStyle: StyleAsset = {
      kind: 'custom',
      name: 'Client LUT',
      defaultIntensity: 0.7,
      currentIntensity: 1,
      lutAsset: {
        format: 'cube',
        dimension: 17,
        fingerprint: 'lut-fingerprint',
      },
    }
    const lutProfileSelection: LUTContractSelectionState = {
      status: 'unknown',
      fingerprint: 'lut-fingerprint',
      title: 'Client LUT',
    }

    const session = createImageSession(new File(['raw'], 'frame.RAF'), {
      activeStyle,
      lutProfileSelection,
    })

    expect(session.activeStyle).toBe(activeStyle)
    expect(session.lutProfileSelection).toBe(lutProfileSelection)
  })
})
