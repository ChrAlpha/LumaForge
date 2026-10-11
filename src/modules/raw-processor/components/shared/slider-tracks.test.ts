import { describe, expect, it } from 'vitest'

import {
  hslHueTrack,
  hslLightnessTrack,
  hslSaturationTrack,
  saturationTrack,
  temperatureTrack,
  tintTrack,
  vibranceTrack,
} from './slider-tracks'

describe('slider-tracks', () => {
  describe('hslHueTrack', () => {
    it('puts the band centre at 50% and adjacent bands at the ends', () => {
      const track = hslHueTrack('red')
      expect(track).toMatch(/linear-gradient\(to right, /)
      expect(track).toMatch(/ 50%,/)
      expect(track).toMatch(/ 100%\)$/)
    })

    it('wraps neighbour selection so red picks magenta on the left and orange on the right', () => {
      const track = hslHueTrack('red')
      // magenta swatch hue 340, red swatch hue 27, orange swatch hue 55.
      expect(track).toContain('340')
      expect(track).toContain('27')
      expect(track).toContain('55')
    })

    it('wraps in the opposite direction for magenta (purple ↔ red)', () => {
      const track = hslHueTrack('magenta')
      // purple swatch hue 305, magenta swatch hue 340, red swatch hue 27.
      expect(track).toContain('305')
      expect(track).toContain('340')
      expect(track).toContain('27')
    })
  })

  describe('hslSaturationTrack', () => {
    it('places fully desaturated gray on the left and band hue on the right', () => {
      const track = hslSaturationTrack('green')
      expect(track).toMatch(/linear-gradient\(to right, /)
      expect(track).toContain('l 0 h') // chroma forced to 0 = gray
      expect(track).toContain('145') // green band hue
    })
  })

  describe('hslLightnessTrack', () => {
    it('uses 0.30 L on the dark end and 0.88 L on the light end with band hue', () => {
      const track = hslLightnessTrack('blue')
      expect(track).toContain('0.30 c h')
      expect(track).toContain('0.88 c h')
      expect(track).toContain('260') // blue band hue
    })
  })

  describe('temperatureTrack', () => {
    it('renders blue ↔ neutral ↔ yellow', () => {
      const track = temperatureTrack()
      expect(track).toContain('240') // blue hue
      expect(track).toContain('95') // yellow hue
      expect(track).toMatch(/ 50%,/)
    })
  })

  describe('tintTrack', () => {
    it('renders magenta ↔ neutral ↔ green', () => {
      const track = tintTrack()
      expect(track).toContain('340') // magenta hue
      expect(track).toContain('145') // green hue
      expect(track).toMatch(/ 50%,/)
    })
  })

  describe('saturationTrack', () => {
    it('renders gray ↔ neutral ↔ vivid warm at chroma 0.20', () => {
      expect(saturationTrack()).toBe(
        'linear-gradient(to right, ' +
          'oklch(from var(--color-lf-on-surface) l 0 h / 0.55) 0%, ' +
          'oklch(from var(--color-lf-on-surface) l c h / 0.06) 50%, ' +
          'oklch(0.72 0.20 50 / 0.55) 100%)',
      )
    })
  })

  describe('vibranceTrack', () => {
    it('renders gray ↔ neutral ↔ softer warm at chroma 0.13', () => {
      expect(vibranceTrack()).toBe(
        'linear-gradient(to right, ' +
          'oklch(from var(--color-lf-on-surface) l 0 h / 0.55) 0%, ' +
          'oklch(from var(--color-lf-on-surface) l c h / 0.06) 50%, ' +
          'oklch(0.72 0.13 50 / 0.55) 100%)',
      )
    })
  })
})
