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
    // The Look tab must not reuse a tone or colour term (色调 is Tint).
    expect(zhMessages['raw.mobile.mode.look']).toBe('风格')
    expect(zhMessages['raw.mobile.mode.look']).not.toBe(
      zhMessages['raw.color.tint'],
    )
    // UI copy uses a period, colon, or parentheses, never an em dash.
    expect(enMessages['raw.preview.cpuDegraded.banner']).not.toMatch(/—/)
    expect(zhMessages['raw.preview.cpuDegraded.banner']).not.toMatch(/—/)
    // The mobile Look and export surfaces call the colour contract 契约,
    // as the details sheet beside them does.
    for (const key of [
      'raw.mobile.look.needsContract',
      'raw.mobile.lut.chooseContract',
      'raw.mobile.lut.editContractAria',
      'raw.mobile.more.lutNeedsContract',
    ] as const) {
      expect(zhMessages[key]).toContain('契约')
      expect(zhMessages[key]).not.toContain('合同')
    }
    expect(enMessages['raw.export.derivedLabelHint']).toContain('{{label}}')
    expect(zhMessages['raw.export.derivedLabelHint']).toContain('{{label}}')
  })
})
