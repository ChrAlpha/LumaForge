import { describe, expect, it } from 'vitest'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { buildMobileExportRecap } from './export-recap'

const neutral = {
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
}

describe('buildMobileExportRecap', () => {
  it('reads only state: size when known, the look and its strength, Transform', () => {
    expect(
      buildMobileExportRecap({
        ...neutral,
        canExport: true,
        canPreviewExport: true,
        deliveredSize: { width: 9728, height: 6656 },
        lutName: 'ARRI 3110 Film A',
        intensity: 0.62,
        transformApplied: true,
      }),
    ).toEqual({
      output: 'full-resolution',
      size: { width: 9728, height: 6656 },
      // The exact amount, as the whole percent the Strength row sets.
      look: { name: 'ARRI 3110 Film A', percent: 62 },
      adjustments: 0,
      transformApplied: true,
    })

    expect(
      buildMobileExportRecap({
        ...neutral,
        canExport: true,
        canPreviewExport: false,
        deliveredSize: undefined,
        lutName: null,
        intensity: 0.7,
        transformApplied: false,
      }),
    ).toEqual({
      output: 'full-resolution',
      size: null,
      look: null,
      adjustments: 0,
      transformApplied: false,
    })
  })

  it('never recaps a full-resolution JPEG the session cannot write', () => {
    const input = {
      ...neutral,
      deliveredSize: { width: 9728, height: 6656 },
      lutName: null,
      intensity: 0.7,
      transformApplied: false,
    }
    // Full resolution blocked, the HQ preview open: only the preview.
    expect(
      buildMobileExportRecap({
        ...input,
        canExport: false,
        canPreviewExport: true,
      }),
    ).toMatchObject({ output: 'hq-preview', size: null })
    // Neither can run: no output at all.
    expect(
      buildMobileExportRecap({
        ...input,
        canExport: false,
        canPreviewExport: false,
      }),
    ).toMatchObject({ output: null, size: null })
  })
})
