import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as i18nModule from '~/lib/i18n'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'
import { UPRIGHT_MODES } from '~/modules/raw-processor/components/transform-fields'
import {
  EXPORT_COPY_LABEL_COPY,
  EXPORT_COPY_REASON_COPY,
  EXPORT_SHARE_REASON_COPY,
  FULL_RES_EXPORT_REASON_COPY,
  HQ_PREVIEW_EXPORT_REASON_COPY,
  RAW_REASON_COPY,
} from '~/modules/raw-processor/services/surface/raw-reason'

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
    // No export progress outlives the tab, so no copy blames the browser
    // for failing to store it.
    expect(Object.values(enMessages).join('\n')).not.toMatch(
      /cannot store export progress/i,
    )
    expect(enMessages['raw.export.lowMemory']).toContain('Keep the tab open')
  })

  it('gives every typed reason copy in both locales', () => {
    const keys = [
      ...Object.values(RAW_REASON_COPY),
      ...Object.values(FULL_RES_EXPORT_REASON_COPY),
      ...Object.values(HQ_PREVIEW_EXPORT_REASON_COPY),
      ...Object.values(EXPORT_COPY_LABEL_COPY),
      ...Object.values(EXPORT_COPY_REASON_COPY),
      ...Object.values(EXPORT_SHARE_REASON_COPY),
      'raw.export.copy',
    ] as const
    for (const key of keys) {
      expect(enMessages[key], key).toBeTruthy()
      expect(zhMessages[key], key).toBeTruthy()
    }
  })

  it('keeps exactly the copy that production code looks up', () => {
    const root = resolve(process.cwd(), 'src')
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(
        (path) =>
          /\.tsx?$/.test(path) &&
          !/\.(?:test|spec)\.tsx?$/.test(path) &&
          !/\.fixture\.tsx?$/.test(path),
      )
      .map((path) => readFileSync(join(root, path), 'utf8'))
    const catalogKeys = Object.keys(enMessages)
    const literals = new Set<string>()
    const prefixes = new Set<string>()
    for (const source of sources) {
      for (const [, key] of source.matchAll(
        /['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g,
      ))
        literals.add(key)
      for (const [, prefix] of source.matchAll(/`([a-z][\w.-]*\.)\$\{/g)) {
        if (catalogKeys.some((key) => key.startsWith(prefix)))
          prefixes.add(prefix)
      }
    }
    // Upright modes are the only dynamically built keys.
    expect([...prefixes].sort()).toEqual([
      'transform.mode.',
      'transform.modeHelp.',
    ])
    const used = new Set(literals)
    for (const prefix of prefixes) {
      for (const mode of UPRIGHT_MODES) {
        const key = `${prefix}${mode}`
        expect(enMessages[key as keyof typeof enMessages], key).toBeTruthy()
        used.add(key)
      }
    }
    expect(catalogKeys.filter((key) => !used.has(key))).toEqual([])
  })

  it('translates by key only: no helper matches English text back to copy', () => {
    expect(Object.keys(i18nModule).sort()).toEqual([
      'I18nProvider',
      'supportedLocales',
      'useI18n',
    ])
  })
})
