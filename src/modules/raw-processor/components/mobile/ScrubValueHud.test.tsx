import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { ScrubValueHud } from './ScrubValueHud'

function readyHistogram(): Extract<PreviewHistogramState, { state: 'ready' }> {
  const luma = new Uint32Array(256)
  const red = new Uint32Array(256)
  luma[40] = 3
  luma[200] = 1
  red[60] = 2
  return {
    state: 'ready',
    source: 'quick',
    width: 2,
    height: 2,
    sampledPixels: 4,
    totalPixels: 4,
    bins: {
      luma,
      red,
      green: new Uint32Array(256),
      blue: new Uint32Array(256),
    },
    clipping: {
      shadowAnyChannel: 0,
      highlightAnyChannel: 0,
      shadowLuma: 0,
      highlightLuma: 0,
    },
    diagnostics: {
      ownership: 'main-thread-chunked-no-copy',
      copiedInputBytes: 0,
      transferredInput: false,
      inputByteLength: 24,
      rowBandRows: 32,
    },
  } as Extract<PreviewHistogramState, { state: 'ready' }>
}

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
    // Sized to its content so the value and unit never wrap apart.
    expect(hud).toHaveClass('w-max')
    expect(screen.getByText('+1.25 EV', { exact: false })).toHaveClass(
      'whitespace-nowrap',
    )
  })

  it('reads a Strength scrub as the whole percent, and 0 as Off', () => {
    const { rerender } = render(
      <ScrubValueHud
        field={{ kind: 'strength' }}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
        lookIntensity={0.62}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    expect(hud).toHaveTextContent('Strength')
    expect(hud).toHaveTextContent('62%')

    rerender(
      <ScrubValueHud
        field={{ kind: 'strength' }}
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
        lookIntensity={0}
      />,
    )
    expect(screen.getByLabelText(/adjustment readout/i)).toHaveTextContent(
      'Off',
    )
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

  it('fits the readout inside the topbar band on its solid plate', () => {
    render(
      <ScrubValueHud
        field={{ kind: 'tone', key: 'userContrast' }}
        tone={{ ...TONE_NEUTRAL, userContrast: 12 }}
        color={COLOR_NEUTRAL}
        selectiveColor={undefined}
        manualTransform={undefined}
      />,
    )
    const hud = screen.getByLabelText(/adjustment readout/i)
    // 8px + a 10px label + 4px + a 1.85rem value stays inside 56px.
    expect(hud).toHaveClass('top-safe-offset-2', 'gap-1')
    expect(hud.firstElementChild).toHaveClass('leading-none')
    expect(hud.className).not.toMatch(/text-shadow/)
  })

  describe('mini histogram', () => {
    const hud = (
      field: Parameters<typeof ScrubValueHud>[0]['field'],
      histogram: PreviewHistogramState | null,
    ) =>
      render(
        <ScrubValueHud
          field={field}
          tone={{ ...TONE_NEUTRAL, userExposureEv: 0.5 }}
          color={COLOR_NEUTRAL}
          selectiveColor={undefined}
          manualTransform={NEUTRAL_TRANSFORM}
          lookIntensity={0.62}
          histogram={histogram}
        />,
      )

    it('draws the histogram at 96 x 28 to the right of the value while the user has it on', () => {
      const { container } = hud(
        { kind: 'tone', key: 'userExposureEv' },
        readyHistogram(),
      )
      const mini = container.querySelector('[data-scrub-hud-histogram]')!
      const plot = mini.querySelector('svg[data-histogram-plot="mini"]')
      expect(plot).toHaveClass('h-7', 'w-24')
      // The same drawing as the floating card: RGB under the luma line.
      expect(plot?.querySelector('.raw-histogram-luma')).not.toBeNull()
      expect(
        plot?.querySelector('.raw-histogram-channel-fill-red'),
      ).not.toBeNull()
      // No grid at this size.
      expect(plot?.querySelector('.raw-histogram-grid')).toBeNull()
      // To the right of the value, in one row.
      const value = screen.getByText('+0.50 EV')
      expect(value.nextElementSibling).toBe(mini)
    })

    it('keeps drawing the last bins while a newer run is due', () => {
      const { container } = hud(
        { kind: 'hsl', band: 'red', key: 'hue' },
        { state: 'stale', previous: readyHistogram() },
      )
      expect(
        container.querySelector('[data-scrub-hud-histogram]'),
      ).not.toBeNull()
    })

    it('rides a Strength scrub too', () => {
      const { container } = hud({ kind: 'strength' }, readyHistogram())
      expect(screen.getByLabelText(/adjustment readout/i)).toHaveTextContent(
        '62%',
      )
      expect(
        container.querySelector('[data-scrub-hud-histogram]'),
      ).not.toBeNull()
    })

    it('draws nothing when it is off, unsupported, not computed yet, or the scrub is a Transform', () => {
      for (const [field, histogram] of [
        [{ kind: 'tone', key: 'userExposureEv' }, null],
        [
          { kind: 'tone', key: 'userExposureEv' },
          { state: 'unsupported', reason: 'CPU preview' },
        ],
        [
          { kind: 'tone', key: 'userExposureEv' },
          { state: 'computing', previous: null },
        ],
        [{ kind: 'transform', key: 'rotate' }, readyHistogram()],
      ] as const) {
        const { container, unmount } = hud(
          field as Parameters<typeof ScrubValueHud>[0]['field'],
          histogram as PreviewHistogramState | null,
        )
        expect(container.querySelector('[data-scrub-hud-histogram]')).toBeNull()
        unmount()
      }
    })
  })
})
