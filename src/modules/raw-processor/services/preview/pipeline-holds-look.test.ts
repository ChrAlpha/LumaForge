import type {
  ColorGraphIntent,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { pipelineHoldsLook } from './pipeline-holds-look'

const LOOK: ColorGraphIntent = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.6,
  ...NEUTRAL_USER_COLOR_INTENT,
}

const LUT: LUTData = {
  size: 2,
  data: new Float32Array(2 ** 3 * 3),
  domainMin: [0, 0, 0],
  domainMax: [1, 1, 1],
  profileResolution: { kind: 'unknown' },
}

const EXPOSURE: RawRenderExposure = {
  ev: 0.5,
  multiplier: 2 ** 0.5,
  source: 'image-statistics',
}

function createPipeline(
  held: { params?: ColorGraphIntent; lut?: LUTData | null } = {},
) {
  return {
    getParams: () => ({
      ...(held.params ?? LOOK),
      viewMode: 'processed' as const,
    }),
    getLutData: () => (held.lut === undefined ? LUT : held.lut),
  }
}

function holds(
  overrides: Partial<Parameters<typeof pipelineHoldsLook>[0]> = {},
) {
  const pipeline = overrides.pipeline ?? createPipeline()
  return pipelineHoldsLook({
    pipeline,
    publishedPipeline: pipeline,
    frameExposure: EXPOSURE,
    intent: LOOK,
    lut: LUT,
    rawRenderExposure: EXPOSURE,
    ...overrides,
  })
}

describe('pipelineHoldsLook', () => {
  it('vouches for the published pipeline holding the color, LUT and exposure', () => {
    expect(holds()).toBe(true)
    // View fields the pipeline also holds are not part of the look.
    expect(holds({ frameExposure: { ...EXPOSURE } })).toBe(true)
  })

  it('refuses a pipeline the preview no longer publishes', () => {
    const pipeline = createPipeline()
    expect(holds({ pipeline, publishedPipeline: createPipeline() })).toBe(false)
    expect(holds({ pipeline, publishedPipeline: null })).toBe(false)
  })

  it('refuses a pipeline lagging the color', () => {
    const lagging = (params: ColorGraphIntent) =>
      holds({ pipeline: createPipeline({ params }) })
    expect(lagging({ ...LOOK, userExposureEv: 0.4 })).toBe(false)
    expect(lagging({ ...LOOK, intensity: 0.61 })).toBe(false)
    expect(lagging({ ...LOOK, styleKind: 'none' })).toBe(false)
  })

  it('refuses a pipeline lagging the LUT a custom look draws', () => {
    const lagging = (lut: LUTData | null) =>
      holds({ pipeline: createPipeline({ lut }) })
    expect(lagging(null)).toBe(false)
    expect(lagging({ ...LUT, data: LUT.data.slice() })).toBe(false)
    expect(lagging({ ...LUT, domainMax: [2, 2, 2] })).toBe(false)
    expect(
      lagging({
        ...LUT,
        profileResolution: { kind: 'unknown' },
      }),
    ).toBe(false)
    expect(holds({ lut: null, pipeline: createPipeline({ lut: null }) })).toBe(
      true,
    )
  })

  it('reads no LUT for a look that draws none', () => {
    const neutral: ColorGraphIntent = { ...LOOK, styleKind: 'none' }
    expect(
      holds({
        intent: neutral,
        lut: null,
        pipeline: createPipeline({ params: neutral }),
      }),
    ).toBe(true)
  })

  it('refuses a frame without the exposure the request names', () => {
    expect(holds({ frameExposure: null })).toBe(false)
    expect(holds({ frameExposure: null, rawRenderExposure: null })).toBe(false)
    expect(holds({ rawRenderExposure: null })).toBe(false)
    expect(
      holds({ frameExposure: { ...EXPOSURE, ev: 1, multiplier: 2 } }),
    ).toBe(false)
    expect(holds({ frameExposure: { ...EXPOSURE, source: 'identity' } })).toBe(
      false,
    )
  })

  it('refuses a pipeline that cannot say what it holds', () => {
    const uninitialized = {
      getParams: () => {
        throw new Error('PREVIEW_PIPELINE_NOT_INITIALIZED')
      },
      getLutData: () => null,
    }
    expect(holds({ pipeline: uninitialized })).toBe(false)
  })
})
