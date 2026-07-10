import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

describe('i18n locale catalogs', () => {
  it('keeps English and Chinese translation keys in JSON locale files', () => {
    expect(Object.keys(zhMessages).sort()).toEqual(
      Object.keys(enMessages).sort(),
    )
    expect(enMessages['landing.kicker']).toBe('Browser-local RAW finishing')
    expect(zhMessages['landing.kicker']).toBe('浏览器本地 RAW 成片')
    expect(enMessages['landing.workflow.2.detail']).toContain('LUT')
    expect(enMessages['landing.heroCopy']).toContain('A LUT is optional')
    expect(enMessages['raw.onboarding.slogan']).toBe('Finish a RAW with a LUT')
    expect(zhMessages['raw.onboarding.slogan']).toBe('用 LUT 完成一张 RAW')
    expect(enMessages).not.toHaveProperty('raw.mobile.empty.title')
    expect(enMessages).not.toHaveProperty('raw.stage.uploadTitle')
    expect(zhMessages).not.toHaveProperty('raw.mobile.empty.title')
    expect(zhMessages).not.toHaveProperty('raw.stage.uploadTitle')
    expect(enMessages['raw.export.derivedLabelHint']).toContain('{{label}}')
    expect(zhMessages['raw.export.derivedLabelHint']).toContain('{{label}}')
  })
})
