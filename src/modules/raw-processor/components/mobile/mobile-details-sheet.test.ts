import type { NormalizedSelectiveColorBands } from '@lumaforge/luma-color-runtime'
import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Translate } from '~/lib/i18n'
import type { ImageMetadata } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'
import enMessages from '~/locales/en.json'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { countAdjustments } from './adjustment-count'
import {
  buildMobileDetailsSheet,
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
const neutralHsl: NormalizedSelectiveColorBands = {
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
  adjustments: 0,
  currentLutName: null,
  transformActive: false,
  canExport: true,
  canPreviewExport: true,
}

describe('the details sheet input', () => {
  it('reads decoded metadata and preview stats as the workflow holds them', () => {
    type SheetInput = Parameters<typeof buildMobileDetailsSheet>[0]
    expectTypeOf<SheetInput['metadata']>().toEqualTypeOf<ImageMetadata | null>()
    expectTypeOf<SheetInput['stats']>().toEqualTypeOf<Pick<
      PipelineStats,
      'processTime' | 'previewSize'
    > | null>()
  })
})

describe('the Adjust step', () => {
  it('names the same adjustment count the export recap does', () => {
    const edits = {
      tone: { ...TONE_NEUTRAL, userExposureEv: 0.3, userShadows: 12 },
      color: { ...COLOR_NEUTRAL, userTint: -4 },
      selectiveColor: {
        ...neutralHsl,
        blue: { hue: 0, saturation: -20, lightness: 5 },
      },
    }
    const sheet = buildMobileDetailsSheet(
      { ...base, adjustments: countAdjustments(edits) },
      t,
    )
    expect(countAdjustments(edits)).toBe(5)
    expect(sheet.pipelineSteps[1]).toEqual({
      index: 2,
      label: 'Adjust',
      detail: '5 fields changed',
    })
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

  it('names the output that can be written now, not the full-resolution promise', () => {
    const output = (canExport: boolean, canPreviewExport: boolean) =>
      buildMobileDetailsSheet({ ...base, canExport, canPreviewExport }, t)
        .pipelineSteps[4]
    expect(output(true, false).detail).toBe('Full-resolution JPEG')
    expect(output(false, true).detail).toBe('HQ preview JPEG only')
    expect(output(false, false).detail).toBe('No JPEG can be written yet')
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
        supportLevel: 'unsupported',
        adjustments: 1,
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
      'Sony ILCE-7M4 · Not supported',
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
        adjustments: 2,
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

  it('names the look the preview leaves out instead of a confirmed contract', () => {
    const linear = {
      ...displayLook,
      outputGamut: 'rec2020' as const,
      outputTransfer: 'linear' as const,
    }
    const sheet = buildMobileDetailsSheet(
      {
        ...base,
        currentLutName: 'Linear.cube',
        lutProfileResolution: {
          kind: 'confirmed',
          profile: linear,
          confidence: 'user',
        },
        previewLookReason: 'lut-output-transfer-linear',
      },
      t,
    )
    expect(sheet.pipelineSteps[2].detail).toBe(
      'Linear.cube · Not in preview · linear LUT output not supported',
    )

    const unconfirmed = buildMobileDetailsSheet(
      {
        ...base,
        currentLutName: 'Film.cube',
        lutProfileResolution: { kind: 'unknown' },
        previewLookReason: 'lut-input-unconfirmed',
      },
      t,
    )
    expect(unconfirmed.pipelineSteps[2].detail).toBe(
      'Film.cube · Not in preview · confirm the LUT input',
    )
    expect(unconfirmed.lutRows[1]).toEqual({
      label: 'Contract',
      value: 'Needs contract',
    })
  })

  it('keeps a built-in style a WebGPU preview fact the CPU preview leaves out', () => {
    const sheet = buildMobileDetailsSheet(
      { ...base, previewLookReason: 'builtin-no-ts-executor' },
      t,
    )
    expect(sheet.pipelineSteps[2].detail).toBe(
      'Not in the CPU preview · built-in styles draw on WebGPU only',
    )
  })

  it('never reads an unsupported file as experimental', () => {
    const { fileRows, pipelineSteps } = buildMobileDetailsSheet(
      { ...base, supportLevel: 'unsupported' },
      t,
    )
    expect(pipelineSteps[0].detail).toBe('Sony ILCE-7M4 · Not supported')
    expect(fileRows[1]).toEqual({ label: 'Support', value: 'Not supported' })
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
