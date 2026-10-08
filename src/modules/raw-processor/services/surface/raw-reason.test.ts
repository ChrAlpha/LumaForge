import type {
  ColorGraphIntentSource,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { PREVIEW_COLOR_PLAN_REASONS } from '@lumaforge/render-engine/preview'
import { describe, expect, it } from 'vitest'

import { getExportModeCopy } from '~/lib/export/execution-profile'
import type { Translate } from '~/lib/i18n'
import { localizeCopyLabel, localizeRawReason } from '~/lib/i18n'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import {
  fullResExportReasonSentence,
  PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
} from '../../model/derive-session'
import {
  EXPORT_COPY_REASON_CODES,
  EXPORT_SHARE_REASON_CODES,
  FULL_RES_EXPORT_REASON_CODES,
  HQ_PREVIEW_EXPORT_REASON_CODES,
} from '../../model/export-result'
import type { PreviewLookReason } from './raw-reason'
import {
  EXPORT_COPY_LABEL_COPY,
  EXPORT_COPY_REASON_COPY,
  EXPORT_SHARE_REASON_COPY,
  FULL_RES_EXPORT_REASON_COPY,
  fullResExportReasonText,
  HQ_PREVIEW_EXPORT_REASON_COPY,
  PREVIEW_LOOK_REASON_COPY,
  previewLookReasonMessageKey,
  RAW_REASON_CODES,
  RAW_REASON_COPY,
  rawReasonMessageKey,
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

describe('rawReasonMessageKey', () => {
  it('maps every surface reason to existing copy in both locales', () => {
    expect(Object.keys(RAW_REASON_COPY).sort()).toEqual(
      [...RAW_REASON_CODES].sort(),
    )
    for (const code of RAW_REASON_CODES) {
      const key = rawReasonMessageKey(code)
      expect(enMessages[key]).toBeTruthy()
      expect(zhMessages[key]).toBeTruthy()
    }
  })

  it('reuses the copy the surfaces already show for the same block', () => {
    expect(rawReasonMessageKey('transform-pending')).toBe(
      'raw.transform.preparing',
    )
    expect(rawReasonMessageKey('transform-invalid')).toBe(
      'transform.error.transform',
    )
    expect(rawReasonMessageKey('transform-unavailable')).toBe(
      'raw.transform.unavailable',
    )
    expect(rawReasonMessageKey('transform-hq-export')).toBe(
      'raw.transform.hqExportReason',
    )
    expect(rawReasonMessageKey('transform-compare')).toBe(
      'raw.mobile.compare.unavailable',
    )
    expect(rawReasonMessageKey('cpu-preview')).toBe(
      'raw.preview.cpuDegraded.banner',
    )
    expect(rawReasonMessageKey('no-lut')).toBe('raw.strength.reason')
  })

  it('names each running stage with its progress copy', () => {
    expect(rawReasonMessageKey('runtime-warming')).toBe('raw.progress.warming')
    expect(rawReasonMessageKey('source-loading')).toBe('raw.progress.loading')
    expect(rawReasonMessageKey('preview-decoding')).toBe(
      'raw.progress.decoding',
    )
    expect(rawReasonMessageKey('look-processing')).toBe(
      'raw.progress.processing',
    )
    expect(rawReasonMessageKey('export-running')).toBe('raw.progress.exporting')
  })
})

describe('export copy the sentence matcher localizes today', () => {
  const zhT: Translate = (key) => zhMessages[key]

  it('reads each English export sentence as its Chinese copy', () => {
    for (const key of [
      'raw.exportSourceLoading',
      'raw.export.copyUnsupported',
      'raw.export.copyPreviewReason',
      'raw.export.copyHqPreviewReason',
      'raw.export.shareUnsupported',
      'raw.export.previewSourceLoading',
      'raw.export.previewLoadRequired',
      'raw.export.previewRestoreRequired',
      'raw.export.previewUnavailable',
      'raw.export.previewLookUnavailable',
    ] as const) {
      expect(localizeRawReason(enMessages[key], zhT)).toBe(zhMessages[key])
    }
  })

  it('reads each English copy label as its Chinese label', () => {
    for (const key of [
      'raw.export.copyFull',
      'raw.export.copyHqPreview',
      'raw.export.copyPreview',
    ] as const) {
      expect(localizeCopyLabel(enMessages[key], zhT)).toBe(zhMessages[key])
    }
  })

  it('passes runtime diagnostic text through unchanged', () => {
    expect(localizeRawReason('processed-window-unavailable', zhT)).toBe(
      'processed-window-unavailable',
    )
  })
})

describe('export reason copy', () => {
  const zhT: Translate = (key) => zhMessages[key]
  const enT: Translate = (key) => enMessages[key]
  const copied = FULL_RES_EXPORT_REASON_CODES.filter(
    (code) => code !== 'runtime-unsupported' && code !== 'lut-output-refused',
  )

  it('names every full-resolution refusal without diagnostic text in both locales', () => {
    expect(Object.keys(FULL_RES_EXPORT_REASON_COPY).sort()).toEqual(
      [...copied].sort(),
    )
    for (const code of copied) {
      const key = FULL_RES_EXPORT_REASON_COPY[code]
      expect(enMessages[key]).toBeTruthy()
      expect(zhMessages[key]).toBeTruthy()
      expect(zhMessages[key]).not.toBe(enMessages[key])
      expect(fullResExportReasonText({ code }, zhT)).toBe(zhMessages[key])
    }
    expect(new Set(Object.values(FULL_RES_EXPORT_REASON_COPY)).size).toBe(
      copied.length,
    )
  })

  it('says in English exactly what the sentence fields say today', () => {
    const sentences: Record<(typeof copied)[number], string> = {
      'source-loading': 'Full-resolution export source is still loading.',
      'export-running': 'Full-resolution export is already running.',
      'quick-preview-pending': 'Quick preview is still being prepared.',
      'capability-unchecked':
        'Full-resolution export support has not been checked yet.',
      'capability-probing':
        'Checking full-resolution export support for this RAW file.',
      'builtin-style':
        'Built-in styles are not supported by full-resolution JPEG export.',
      'lut-input-unconfirmed':
        'Choose a LUT input profile before full-resolution export.',
      'lut-output-unsupported':
        'This LUT output transfer is not supported by full-resolution JPEG export.',
      'geometry-unplannable':
        'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.',
      'exposure-pending': 'RAW preview exposure is still being prepared.',
      'cannot-safely-complete': getExportModeCopy('cannot-safely-complete'),
      'transform-pending':
        'Transform is still preparing the current photo. Export once the preview shows it.',
      'transform-invalid':
        'This Transform leaves too little usable image. Reduce the adjustment or reset Transform to export.',
      'transform-unavailable':
        'The processed preview is unavailable. Wait for it or reset Transform to export.',
    }
    for (const code of copied) {
      expect(fullResExportReasonSentence({ code })).toBe(sentences[code])
      expect(fullResExportReasonText({ code }, enT)).toBe(sentences[code])
    }
  })

  it('shows diagnostic text as data in every locale', () => {
    for (const code of ['runtime-unsupported', 'lut-output-refused'] as const) {
      const reason = { code, detail: 'processed-window-unavailable' }
      expect(fullResExportReasonText(reason, zhT)).toBe(
        'processed-window-unavailable',
      )
      expect(fullResExportReasonSentence(reason)).toBe(
        'processed-window-unavailable',
      )
    }
  })

  it('keeps the meaning the sentence matcher gives each export sentence', () => {
    expect(FULL_RES_EXPORT_REASON_COPY['source-loading']).toBe(
      'raw.exportSourceLoading',
    )
    expect(HQ_PREVIEW_EXPORT_REASON_COPY).toEqual({
      'transform-held': 'raw.transform.hqExportReason',
      'no-source': 'raw.export.previewLoadRequired',
      'preview-released': 'raw.export.previewRestoreRequired',
      'look-dropped': 'raw.export.previewLookUnavailable',
      'hq-preview-pending': 'raw.export.previewSourceLoading',
      'not-ready': 'raw.export.previewUnavailable',
    })
    expect(Object.keys(HQ_PREVIEW_EXPORT_REASON_COPY).sort()).toEqual(
      [...HQ_PREVIEW_EXPORT_REASON_CODES].sort(),
    )
    expect(enMessages['raw.transform.hqExportReason']).toBe(
      PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
    )
    expect(EXPORT_COPY_REASON_COPY).toEqual({
      'clipboard-unsupported': 'raw.export.copyUnsupported',
      'full-resolution-copy-unsupported': 'raw.export.copyPreviewReason',
      'hq-preview-copy-unsupported': 'raw.export.copyHqPreviewReason',
      'preview-copy-not-ready': 'raw.export.copyPreviewNotReady',
    })
    expect(Object.keys(EXPORT_COPY_REASON_COPY).sort()).toEqual(
      [...EXPORT_COPY_REASON_CODES].sort(),
    )
    expect(enMessages['raw.export.copyPreviewNotReady']).toBe(
      'Preview image is not ready to copy.',
    )
    expect(EXPORT_SHARE_REASON_COPY).toEqual({
      'no-result': 'raw.export.shareNoResult',
      'share-unsupported': 'raw.export.shareUnsupported',
    })
    expect(Object.keys(EXPORT_SHARE_REASON_COPY).sort()).toEqual(
      [...EXPORT_SHARE_REASON_CODES].sort(),
    )
    expect(enMessages['raw.export.shareNoResult']).toBe(
      'Export a JPEG before sharing.',
    )
    expect(zhMessages['raw.export.shareNoResult']).toBeTruthy()
  })

  it('labels each copy mode with the label its capability carries', () => {
    const labels: Record<keyof typeof EXPORT_COPY_LABEL_COPY, string> = {
      'full-resolution': 'Copy full-resolution image',
      'hq-preview': 'Copy HQ preview image',
      'preview-size': 'Copy preview-size image',
    }
    expect(Object.keys(EXPORT_COPY_LABEL_COPY).sort()).toEqual(
      Object.keys(labels).sort(),
    )
    for (const mode of Object.keys(labels) as Array<keyof typeof labels>) {
      const key = EXPORT_COPY_LABEL_COPY[mode]
      expect(enMessages[key]).toBe(labels[mode])
      expect(zhMessages[key]).toBeTruthy()
    }
  })
})
