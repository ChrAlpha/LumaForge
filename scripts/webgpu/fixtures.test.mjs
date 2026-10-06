// @vitest-environment node
import { readFileSync } from 'node:fs'

import { TRANSFER_FUNCTIONS } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { isGoldenScenario, scenarios } from './fixtures.mjs'

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

  it('holds a golden for exactly the scenes without a TS reference', () => {
    const golden = ['float', 'u16'].flatMap((format) =>
      names
        .map((name) => `${format}/${name}`)
        .filter((name) => isGoldenScenario(name)),
    )
    expect(Object.keys(goldens.frames).sort()).toEqual(golden.sort())
  })

  it('compares every LUT export refuses to a stripped reference, never a golden', async () => {
    const { resolveExportColorGraph } =
      await import('@lumaforge/luma-color-runtime')
    const refused = scenarios(Object.keys(TRANSFER_FUNCTIONS)).filter(
      (scenario) =>
        scenario.lut &&
        !resolveExportColorGraph({
          styleKind: 'custom',
          builtinPreset: null,
          ...scenario.params,
          lut: scenario.lut,
        }).supported,
    )
    expect(refused.map((scenario) => scenario.name)).toEqual(
      expect.arrayContaining([
        'transfer-output-linear',
        'lut-refused-display-linear-output',
        'lut-refused-input-unconfirmed',
      ]),
    )
    for (const scenario of refused) {
      expect(scenario.exportRefused).toBe(true)
      expect(isGoldenScenario(`u16/${scenario.name}`)).toBe(false)
      expect(isGoldenScenario(`float/${scenario.name}`)).toBe(false)
    }
    // Refused looks run at partial strength over adjusted user color.
    for (const scenario of refused.filter((s) =>
      s.name.startsWith('lut-refused-'),
    )) {
      expect(scenario.params.intensity).toBeGreaterThan(0)
      expect(scenario.params.intensity).toBeLessThan(1)
      expect(scenario.params.userExposureEv).not.toBe(0)
      expect(scenario.params.userTemperature).not.toBe(0)
      expect(scenario.params.userSaturation).not.toBe(0)
      expect(
        Object.keys(scenario.params.selectiveColor ?? {}),
      ).not.toHaveLength(0)
    }
    const refusedNames = refused.map((scenario) => scenario.name)
    for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS)))
      if (scenario.exportRefused) expect(refusedNames).toContain(scenario.name)
  })
})
