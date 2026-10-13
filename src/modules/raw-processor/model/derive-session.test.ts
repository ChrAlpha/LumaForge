import { describe, expect, it } from 'vitest'

import {
  deriveCanEdit,
  deriveExportRefusal,
  deriveLutContractExportRefusal,
  selectDisplaySource,
} from './derive-session'
import type { ImageSession, PreviewBundle } from './session'
import { createImageSession } from './session-factory'

function sessionWith(
  preview: Partial<PreviewBundle>,
  exportState: Partial<ImageSession['exportState']> = {},
): ImageSession {
  const session = createImageSession(new File(['raw'], 'frame.ARW'))
  return {
    ...session,
    previewBundle: { ...session.previewBundle, ...preview },
    exportState: { ...session.exportState, ...exportState },
  }
}

const SUPPORTED = {
  fullResCapability: { status: 'supported', width: 8000, height: 6000 },
} as const

describe('session derivation', () => {
  it('displays the best ready preview and edits once any one is ready', () => {
    const none = sessionWith({})
    expect(selectDisplaySource(none.previewBundle)).toBe('none')
    expect(deriveCanEdit(none)).toBe(false)

    const embedded = sessionWith({
      embeddedPreview: { status: 'ready', width: 160, height: 120 },
    })
    expect(selectDisplaySource(embedded.previewBundle)).toBe('embedded')
    expect(deriveCanEdit(embedded)).toBe(true)

    const quick = sessionWith({
      embeddedPreview: { status: 'ready', width: 160, height: 120 },
      quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
    })
    expect(selectDisplaySource(quick.previewBundle)).toBe('quick')

    const hq = sessionWith({
      quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
      boundedHqPreview: { status: 'ready', width: 4000, height: 3000 },
    })
    expect(selectDisplaySource(hq.previewBundle)).toBe('bounded-hq')
  })

  it('needs no bounded HQ preview and no fresh result to export', () => {
    const hqFailed = sessionWith(
      {
        quickDecodePreview: { status: 'ready', width: 2000, height: 1250 },
        boundedHqPreview: {
          status: 'failed',
          errorCode: 'RAW_HQ_DECODE_FAILED',
        },
      },
      SUPPORTED,
    )
    expect(selectDisplaySource(hqFailed.previewBundle)).toBe('quick')
    expect(deriveExportRefusal(hqFailed)).toBeUndefined()
    expect(
      deriveExportRefusal({
        ...hqFailed,
        exportState: { ...hqFailed.exportState, status: 'ready' },
      }),
    ).toBeUndefined()
  })

  it('names a LUT contract export refusal only for a custom LUT', () => {
    expect(
      deriveLutContractExportRefusal({
        kind: 'builtin',
        name: 'Neutral',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
      }),
    ).toBeUndefined()
  })
})
