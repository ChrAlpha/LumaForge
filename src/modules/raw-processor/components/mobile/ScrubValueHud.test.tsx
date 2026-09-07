import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { ScrubValueHud } from './ScrubValueHud'

describe('scrubValueHud', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders nothing when no field is scrubbing', () => {
    const { container } = render(
      <ScrubValueHud
        field={null}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
      />,
    )
    expect(container.querySelector('[data-scrub-value-hud]')).toBeNull()
  })

  it('renders the live tone value with the localized label when scrubbing a tone field', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'tone', key: 'userExposureEv' }}
        tone={{ ...TONE_NEUTRAL, userExposureEv: 1.25 }}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    expect(hud).toBeInTheDocument()
    expect(hud).toHaveTextContent(/exposure/i)
    expect(hud).toHaveTextContent('+1.25')
    expect(hud).toHaveAttribute('data-scrub-value-hud')
  })

  it('renders the live color value when scrubbing a color field', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'color', key: 'userTint' }}
        tone={TONE_NEUTRAL}
        color={{ ...COLOR_NEUTRAL, userTint: -18 }}
        selectiveColor={undefined}
        manualTransform={undefined}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    expect(hud).toHaveTextContent(/tint/i)
    expect(hud).toHaveTextContent('-18')
  })

  it('renders the live HSL value with band + field label when scrubbing an HSL field', () => {
    const bands = {
      red: { hue: 0, saturation: 0, lightness: 0 },
      orange: { hue: 14, saturation: 0, lightness: 0 },
      yellow: { hue: 0, saturation: 0, lightness: 0 },
      green: { hue: 0, saturation: 0, lightness: 0 },
      aqua: { hue: 0, saturation: 0, lightness: 0 },
      blue: { hue: 0, saturation: 0, lightness: 0 },
      purple: { hue: 0, saturation: 0, lightness: 0 },
      magenta: { hue: 0, saturation: 0, lightness: 0 },
    }
    render(
      <ScrubValueHud
        field={{ kind: 'hsl', band: 'orange', key: 'hue' }}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={bands}
        manualTransform={undefined}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    expect(hud).toHaveTextContent(/orange/i)
    expect(hud).toHaveTextContent(/hue/i)
    expect(hud).toHaveTextContent('+14')
  })

  it('renders the live geometry offset when scrubbing a Transform field', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'transform', key: 'rotate' }}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={{ ...NEUTRAL_TRANSFORM, rotate: -2.4 }}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    expect(hud).toHaveTextContent(/rotate/i)
    expect(hud).toHaveTextContent('-2.4')
  })

  it('reports Scale as the absolute percentage the row shows, not its offset', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'transform', key: 'scale' }}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={{ ...NEUTRAL_TRANSFORM, scale: 118 }}
      />,
    )
    expect(screen.getByLabelText(/adjustment readout/i)).toHaveTextContent(
      '118%',
    )
  })

  it('is non-interactive (does not capture pointer events over the preview)', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'tone', key: 'userContrast' }}
        tone={{ ...TONE_NEUTRAL, userContrast: 12 }}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
      />,
    )
    expect(screen.getByLabelText(/adjustment readout/i)).toHaveClass(
      'pointer-events-none',
    )
  })
})
