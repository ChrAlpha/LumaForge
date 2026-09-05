import { describe, expect, it } from 'vitest'

import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import { countMoreFormats, HEADLINE_FORMATS, PIPELINE_STEPS } from './content'

describe('landing content truthfulness', () => {
  it('only headlines formats the decoder actually accepts', () => {
    for (const extension of HEADLINE_FORMATS) {
      expect(SUPPORTED_RAW_EXTENSIONS.has(extension)).toBe(true)
    }
    expect(new Set(HEADLINE_FORMATS).size).toBe(HEADLINE_FORMATS.length)
  })

  it('derives the "and more" count from the decoder support set', () => {
    expect(countMoreFormats()).toBe(
      SUPPORTED_RAW_EXTENSIONS.size - HEADLINE_FORMATS.length,
    )
    expect(countMoreFormats()).toBeGreaterThan(0)
  })

  it('names every headline format in both locales and interpolates the count', () => {
    for (const messages of [enMessages, zhMessages]) {
      const sentence = messages['landing.formats']
      expect(sentence).toContain('{{more}}')
      for (const extension of HEADLINE_FORMATS) {
        expect(sentence).toContain(`.${extension.toUpperCase()}`)
      }
    }
  })

  it('keeps the contract rail ordered with one optional step and one output', () => {
    const roles = PIPELINE_STEPS.map(([, role]) => role)
    expect(roles.filter((role) => role === 'optional')).toHaveLength(1)
    expect(roles.at(-1)).toBe('output')
    expect(roles.slice(0, 5).every((role) => role === 'stage')).toBe(true)
  })
})
