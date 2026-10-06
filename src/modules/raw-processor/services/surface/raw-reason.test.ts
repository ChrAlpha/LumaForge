import type {
  ColorGraphIntentSource,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { PREVIEW_COLOR_PLAN_REASONS } from '@lumaforge/render-engine/preview'
import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import type { PreviewLookReason } from './raw-reason'
import {
  PREVIEW_LOOK_REASON_COPY,
  previewLookReasonMessageKey,
  resolvePreviewLookReason,
  supportLevelMessageKey,
} from './raw-reason'

function profile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-profile',
    label: 'Test profile',
    role: 'scene-creative',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function confirmed(p: LUTColorProfile): LUTContractResolution {
  return { kind: 'confirmed', profile: p, confidence: 'user' }
}

function lut(profileResolution: LUTContractResolution): LUTData {
  return {
    size: 2,
    data: new Float32Array(2 ** 3 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'v-log',
    profileResolution,
  }
}

function custom(intensity = 0.7): ColorGraphIntentSource {
  return {
    styleKind: 'custom',
    builtinPreset: null,
    intensity,
    ...NEUTRAL_USER_COLOR_INTENT,
    userExposureEv: 0.4,
  }
}

const recommended: LUTContractResolution = {
  kind: 'recommended',
  recommendations: [profile()],
}

describe('resolvePreviewLookReason', () => {
  it('reports an unconfirmed contract as a look the preview does not draw', () => {
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut(recommended),
        executor: 'webgpu',
      }),
    ).toBe('lut-input-unconfirmed')
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut({ kind: 'unknown' }),
        executor: 'cpu',
      }),
    ).toBe('lut-input-unconfirmed')
  })

  it('names an unknown output range and a linear output, which export refuses', () => {
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut(confirmed(profile({ outputRange: 'unknown' }))),
        executor: 'webgpu',
      }),
    ).toBe('lut-output-range-unknown')
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut(
          confirmed(
            profile({ outputGamut: 'rec2020', outputTransfer: 'linear' }),
          ),
        ),
        executor: 'webgpu',
      }),
    ).toBe('lut-output-transfer-linear')
  })

  it('has no reason once a valid contract is confirmed or restored', () => {
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut(confirmed(profile())),
        executor: 'webgpu',
      }),
    ).toBeNull()
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: lut({
          kind: 'confirmed',
          profile: profile(),
          confidence: 'persisted-user',
        }),
        executor: 'cpu',
      }),
    ).toBeNull()
  })

  it('keeps refusing an unconfirmed contract at strength 0 and 0.37', () => {
    for (const intensity of [0, 0.37]) {
      expect(
        resolvePreviewLookReason({
          intent: custom(intensity),
          lut: lut(recommended),
          executor: 'webgpu',
        }),
      ).toBe('lut-input-unconfirmed')
      expect(
        resolvePreviewLookReason({
          intent: custom(intensity),
          lut: lut(confirmed(profile())),
          executor: 'webgpu',
        }),
      ).toBeNull()
    }
  })

  it('reports a selected LUT whose data is not loaded', () => {
    expect(
      resolvePreviewLookReason({
        intent: custom(),
        lut: null,
        executor: 'webgpu',
      }),
    ).toBe('lut-not-loaded')
  })

  it('keeps a built-in preset a WebGPU preview fact the CPU preview cannot draw', () => {
    const builtin: ColorGraphIntentSource = {
      ...custom(),
      styleKind: 'builtin',
      builtinPreset: 'warm',
    }
    expect(
      resolvePreviewLookReason({
        intent: builtin,
        lut: null,
        executor: 'webgpu',
      }),
    ).toBeNull()
    expect(
      resolvePreviewLookReason({ intent: builtin, lut: null, executor: 'cpu' }),
    ).toBe('builtin-no-ts-executor')
    expect(
      resolvePreviewLookReason({
        intent: { ...builtin, builtinPreset: null },
        lut: null,
        executor: 'webgpu',
      }),
    ).toBe('builtin-preset-missing')
  })

  it('has no reason without a look', () => {
    expect(
      resolvePreviewLookReason({
        intent: { ...custom(), styleKind: 'none', intensity: 0 },
        lut: null,
        executor: 'cpu',
      }),
    ).toBeNull()
  })
})

describe('preview look reason copy', () => {
  const reasons = PREVIEW_COLOR_PLAN_REASONS.filter(
    (reason): reason is PreviewLookReason => reason !== 'neutral-variant',
  )

  it('names every reason a processed preview can report, in both locales', () => {
    expect(Object.keys(PREVIEW_LOOK_REASON_COPY).sort()).toEqual(
      [...reasons].sort(),
    )
    for (const reason of reasons) {
      const key = previewLookReasonMessageKey(reason)
      expect(enMessages[key]).toBeTruthy()
      expect(zhMessages[key]).toBeTruthy()
      expect(enMessages[key]).not.toMatch(/—/)
      expect(zhMessages[key]).not.toMatch(/—/)
    }
    expect(new Set(reasons.map(previewLookReasonMessageKey)).size).toBe(
      reasons.length,
    )
  })

  it('says the look is not drawn instead of calling it applied', () => {
    for (const reason of reasons) {
      const key = previewLookReasonMessageKey(reason)
      expect(enMessages[key]).toMatch(/^Not in (the CPU )?preview · /)
      expect(zhMessages[key]).toMatch(/预览未套用 · /)
    }
  })
})

describe('supportLevelMessageKey', () => {
  it('keeps an unsupported file unsupported', () => {
    expect(supportLevelMessageKey('unsupported')).toBe(
      'raw.support.unsupported',
    )
    expect(supportLevelMessageKey('experimental')).toBe(
      'raw.support.experimental',
    )
  })
})
