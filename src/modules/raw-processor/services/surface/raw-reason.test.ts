import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { PREVIEW_COLOR_PLAN_REASONS } from '@lumaforge/render-engine/preview'
import { describe, expect, it } from 'vitest'

import type { Translate } from '~/lib/i18n'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import { FULL_RES_EXPORT_REASON_CODES } from '../../model/export-result'
import type { PreviewLookReason } from './raw-reason'
import {
  FULL_RES_EXPORT_REASON_COPY,
  fullResExportReasonText,
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

function lut(profileResolution: LUTContractResolution): LUTData {
  return {
    size: 2,
    data: new Float32Array(2 ** 3 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    profileResolution,
  }
}

const CUSTOM: ColorGraphIntent = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.4,
}

describe('resolvePreviewLookReason', () => {
  it('reports an unconfirmed contract and nothing once it is confirmed', () => {
    expect(
      resolvePreviewLookReason({
        intent: CUSTOM,
        lut: lut({ kind: 'recommended', recommendations: [profile()] }),
        executor: 'webgpu',
      }),
    ).toBe('lut-input-unconfirmed')
    expect(
      resolvePreviewLookReason({
        intent: CUSTOM,
        lut: lut({ kind: 'confirmed', profile: profile(), confidence: 'user' }),
        executor: 'webgpu',
      }),
    ).toBeNull()
  })

  it('asks the executor it names: a built-in preset draws only on WebGPU', () => {
    const builtin: ColorGraphIntent = {
      ...CUSTOM,
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

describe('full-resolution export reason copy', () => {
  const zhT: Translate = (key) => zhMessages[key]

  it('gives each refusal without diagnostic text its own translated copy', () => {
    const copied = FULL_RES_EXPORT_REASON_CODES.filter(
      (code) => code !== 'runtime-unsupported' && code !== 'lut-output-refused',
    )
    for (const code of copied) {
      const key = FULL_RES_EXPORT_REASON_COPY[code]
      expect(zhMessages[key]).not.toBe(enMessages[key])
      expect(fullResExportReasonText({ code }, zhT)).toBe(zhMessages[key])
    }
    expect(new Set(Object.values(FULL_RES_EXPORT_REASON_COPY)).size).toBe(
      copied.length,
    )
  })

  it('shows diagnostic text as data in every locale', () => {
    for (const code of ['runtime-unsupported', 'lut-output-refused'] as const) {
      const reason = { code, detail: 'processed-window-unavailable' }
      expect(fullResExportReasonText(reason, zhT)).toBe(
        'processed-window-unavailable',
      )
    }
  })
})
