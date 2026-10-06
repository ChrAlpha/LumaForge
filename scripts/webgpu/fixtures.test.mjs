// @vitest-environment node
import { readFileSync } from 'node:fs'

import { TRANSFER_FUNCTIONS } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { scenarios } from './fixtures.mjs'

const goldens = JSON.parse(
  readFileSync(new URL('./goldens.json', import.meta.url), 'utf8'),
)
const PRESETS = [
  'neutral',
  'warm',
  'cool',
  'film-soft',
  'film-contrast',
  'cinematic',
  'fade',
  'mono',
]

describe('webGPU validation scenarios', () => {
  const names = scenarios(Object.keys(TRANSFER_FUNCTIONS)).map(
    (scenario) => scenario.name,
  )

  it('keeps the technical original, built-in presets and the neutral scene', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'neutral',
        'original',
        ...PRESETS.map((preset) => `preset-${preset}`),
      ]),
    )
    expect(new Set(names).size).toBe(names.length)
  })

  it('renders no scenario through a shader compare', () => {
    for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS))) {
      expect(scenario.name).not.toMatch(/^compare-/)
      expect(scenario.params.viewMode ?? 'processed').not.toBe('compare')
      expect(scenario.params).not.toHaveProperty('compareSplit')
    }
  })

  it('holds a golden only for scenes the suite still renders', () => {
    const frames = Object.keys(goldens.frames)
    for (const frame of frames)
      expect(names).toContain(frame.split('/').slice(1).join('/'))
    expect(frames).toEqual(
      expect.arrayContaining([
        'float/original',
        ...PRESETS.map((preset) => `u16/preset-${preset}`),
      ]),
    )
  })
})
