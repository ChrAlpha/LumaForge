import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type { Translate } from '~/lib/i18n'
import enMessages from '~/locales/en.json'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import {
  buildMobileDetailsSheet,
  countAdjustedFields,
  getLutContractStatus,
} from './mobile-details-sheet'

const t: Translate = (key, values) => {
  let message: string = enMessages[key]
  for (const [k, v] of Object.entries(values ?? {})) {
    message = message.replace(`{{${k}}}`, String(v))
  }
  return message
}

const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
const neutralHsl: HSLToolValue = {
  red: neutralBand,
  orange: neutralBand,
  yellow: neutralBand,
  green: neutralBand,
  aqua: neutralBand,
  blue: neutralBand,
  purple: neutralBand,
  magenta: neutralBand,
}

const displayLook = {
  ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
  role: 'combined-look-output' as const,
  outputGamut: 'srgb-rec709' as const,
  outputTransfer: 'srgb' as const,
  outputRange: 'full' as const,
}

const base = {
  supportLevel: 'experimental' as const,
  metadata: { make: 'Sony', model: 'ILCE-7M4', width: 7008, height: 4672 },
  stats: {
    processTime: 41.6,
    inputSize: { width: 7008, height: 4672 },
    previewSize: { width: 2048, height: 1365 },
  },
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
  currentLutName: null,
  transformActive: false,
}

describe('countAdjustedFields', () => {
  it('counts every tone, color, and HSL field away from neutral', () => {
    expect(
      countAdjustedFields({
        tone: TONE_NEUTRAL,
        color: COLOR_NEUTRAL,
        selectiveColor: neutralHsl,
      }),
    ).toBe(0)
    expect(
      countAdjustedFields({
        tone: { ...TONE_NEUTRAL, userExposureEv: 0.3, userShadows: 12 },
        color: { ...COLOR_NEUTRAL, userTint: -4 },
        selectiveColor: {
          ...neutralHsl,
          blue: { hue: 0, saturation: -20, lightness: 5 },
        },
      }),
    ).toBe(5)
  })
})

describe('getLutContractStatus', () => {
  it('separates no LUT, an unresolved contract, and a confirmed one', () => {
    expect(getLutContractStatus({ currentLutName: null })).toBe('not-used')
    expect(
      getLutContractStatus({
        currentLutName: 'Film.cube',
        lutProfileResolution: { kind: 'unknown' },
      }),
    ).toBe('needs-contract')
    expect(getLutContractStatus({ currentLutName: 'Film.cube' })).toBe(
      'needs-contract',
    )
    expect(
      getLutContractStatus({
        currentLutName: 'Film.cube',
        lutProfileResolution: {
          kind: 'confirmed',
          profile: displayLook,
          confidence: 'user',
        },
      }),
    ).toBe('confirmed')
  })

  it('does not confirm a contract that still lacks an output side', () => {
    expect(
      getLutContractStatus({
        currentLutName: 'Film.cube',
        lutProfileResolution: {
          kind: 'confirmed',
          profile: getLUTColorProfile('sony-sgamut3cine-slog3')!,
          confidence: 'metadata',
        },
      }),
    ).toBe('needs-contract')
  })
})

describe('buildMobileDetailsSheet', () => {
  it('reports real pipeline state instead of placeholder timings', () => {
    const sheet = buildMobileDetailsSheet(base, t)

    expect(sheet.pipelineSteps).toEqual([
      {
        index: 1,
        label: 'RAW decode',
        detail: 'Sony ILCE-7M4 · Experimental support',
      },
      { index: 2, label: 'Adjust', detail: 'None' },
      { index: 3, label: 'LUT', detail: 'Not used' },
      { index: 4, label: 'Transform', detail: 'Not applied' },
      { index: 5, label: 'Output', detail: 'Full-resolution JPEG' },
    ])
    expect(JSON.stringify(sheet)).not.toContain('—')
    expect(sheet.lutRows).toEqual([{ label: 'LUT', value: 'Not used' }])
  })

  it('labels the preview render time as a preview fact, next to support and location', () => {
    const { fileRows } = buildMobileDetailsSheet(base, t)

    expect(fileRows).toEqual([
      { label: 'Camera', value: 'Sony ILCE-7M4' },
      { label: 'Support', value: 'Experimental support' },
      { label: 'Size', value: '7008 x 4672' },
      { label: 'Preview', value: '2048 x 1365' },
      { label: 'Preview render', value: '42 ms' },
      { label: 'Processing', value: 'This browser, nothing uploaded' },
    ])
  })

  it('follows edits, the LUT contract, and the transform', () => {
    const sheet = buildMobileDetailsSheet(
      {
        ...base,
        supportLevel: 'official',
        tone: { ...TONE_NEUTRAL, userContrast: 10 },
        currentLutName: 'Film.cube',
        lutProfileResolution: {
          kind: 'confirmed',
          profile: displayLook,
          confidence: 'user',
        },
        transformActive: true,
      },
      t,
    )

    expect(sheet.pipelineSteps.map((step) => step.detail)).toEqual([
      'Sony ILCE-7M4 · Official support',
      '1 field changed',
      'Film.cube · Contract confirmed',
      'Applied',
      'Full-resolution JPEG',
    ])
    expect(sheet.lutRows).toEqual([
      { label: 'LUT', value: 'Film.cube' },
      {
        label: 'Contract',
        value: `Contract confirmed · ${displayLook.label}`,
      },
    ])

    const unresolved = buildMobileDetailsSheet(
      {
        ...base,
        color: { ...COLOR_NEUTRAL, userSaturation: 8, userVibrance: 4 },
        currentLutName: 'Film.cube',
        lutProfileResolution: { kind: 'unknown' },
      },
      t,
    )
    expect(unresolved.pipelineSteps[1].detail).toBe('2 fields changed')
    expect(unresolved.pipelineSteps[2].detail).toBe(
      'Film.cube · Needs contract',
    )
  })

  it('says a fact is not loaded rather than inventing it', () => {
    const { fileRows, pipelineSteps } = buildMobileDetailsSheet(
      { ...base, metadata: null, stats: null },
      t,
    )
    expect(pipelineSteps[0].detail).toBe('Experimental support')
    expect(fileRows.find((row) => row.label === 'Preview render')?.value).toBe(
      'Not loaded',
    )
  })
})
