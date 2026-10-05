import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Slider } from './Slider'

describe('slider', () => {
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

  it('uses muted styling hooks when disabled', () => {
    render(
      <Slider
        value={[0]}
        min={-100}
        max={100}
        disabled
        thumbAriaLabel="Exposure"
      />,
    )

    const thumb = screen.getByRole('slider', { name: 'Exposure' })
    const root = thumb.closest('[data-slot="slider-root"]')
    expect(root).toHaveClass('data-[disabled]:opacity-70')
    expect(root?.querySelector('[data-slot="slider-track"]')).toHaveClass(
      'group-data-[disabled]:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)]',
    )
    expect(root?.querySelector('[data-slot="slider-range"]')).toHaveClass(
      'group-data-[disabled]:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.15)]',
    )
    expect(thumb).toHaveClass('data-[disabled]:bg-lf-surface-sunk')
  })

  it('applies an inline background when a custom track is provided', () => {
    render(
      <Slider
        value={[0]}
        min={-100}
        max={100}
        track="linear-gradient(to right, red 0%, blue 100%)"
        thumbAriaLabel="Custom"
      />,
    )
    const thumb = screen.getByRole('slider', { name: 'Custom' })
    const track = thumb
      .closest('[data-slot="slider-root"]')
      ?.querySelector('[data-slot="slider-track"]') as HTMLElement | null
    expect(track).not.toBeNull()
    expect(track?.style.background).toContain('linear-gradient')
  })

  it('bipolar renders a centred range overlay at zero width when value is 0', () => {
    render(
      <Slider
        value={[0]}
        min={-100}
        max={100}
        bipolar
        thumbAriaLabel="Temperature"
      />,
    )
    const root = screen
      .getByRole('slider', { name: 'Temperature' })
      .closest('[data-slot="slider-root"]')
    expect(root).toHaveAttribute('data-bipolar', '')
    const overlay = root?.querySelector(
      '[data-slot="slider-range"][data-bipolar]',
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay?.style.left).toBe('50%')
    expect(overlay?.style.width).toBe('0%')
    // No offset, no amber.
    expect(overlay?.style.background).toBe('')
  })

  it('bipolar renders an overlay extending right of centre for a positive value', () => {
    render(
      <Slider
        value={[50]}
        min={-100}
        max={100}
        bipolar
        thumbAriaLabel="Temperature"
      />,
    )
    const overlay = screen
      .getByRole('slider', { name: 'Temperature' })
      .closest('[data-slot="slider-root"]')
      ?.querySelector(
        '[data-slot="slider-range"][data-bipolar]',
      ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay?.style.left).toBe('50%')
    expect(overlay?.style.width).toBe('25%')
  })

  it('bipolar renders an overlay extending left of centre for a negative value', () => {
    render(
      <Slider
        value={[-50]}
        min={-100}
        max={100}
        bipolar
        thumbAriaLabel="Tint"
      />,
    )
    const overlay = screen
      .getByRole('slider', { name: 'Tint' })
      .closest('[data-slot="slider-root"]')
      ?.querySelector(
        '[data-slot="slider-range"][data-bipolar]',
      ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay?.style.left).toBe('25%')
    expect(overlay?.style.width).toBe('25%')
  })

  it('bipolar grows the fill from the anchor it is given', () => {
    render(
      <Slider
        value={[40]}
        min={0}
        max={100}
        bipolar
        bipolarAnchor={70}
        thumbAriaLabel="Strength"
        thumbAriaDescribedBy="strength-reason"
      />,
    )
    const thumb = screen.getByRole('slider', { name: 'Strength' })
    expect(thumb).toHaveAttribute('aria-describedby', 'strength-reason')
    const overlay = thumb
      .closest('[data-slot="slider-root"]')
      ?.querySelector(
        '[data-slot="slider-range"][data-bipolar]',
      ) as HTMLElement | null
    // From 40 up to the anchor at 70.
    expect(overlay?.style.left).toBe('40%')
    expect(overlay?.style.width).toBe('30%')
  })

  it('bipolar with a directional track uses the lower-opacity amber overlay default', () => {
    render(
      <Slider
        value={[30]}
        min={-100}
        max={100}
        bipolar
        track="linear-gradient(to right, red, blue)"
        thumbAriaLabel="Temperature"
      />,
    )
    const overlay = screen
      .getByRole('slider', { name: 'Temperature' })
      .closest('[data-slot="slider-root"]')
      ?.querySelector(
        '[data-slot="slider-range"][data-bipolar]',
      ) as HTMLElement | null
    expect(overlay?.style.background).toContain('0.30')
  })

  it('bipolar without a track uses the higher-opacity amber overlay default', () => {
    render(
      <Slider
        value={[30]}
        min={-100}
        max={100}
        bipolar
        thumbAriaLabel="Exposure"
      />,
    )
    const overlay = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-slot="slider-root"]')
      ?.querySelector(
        '[data-slot="slider-range"][data-bipolar]',
      ) as HTMLElement | null
    expect(overlay?.style.background).toContain('0.55')
  })

  it('thumb carries the unified cool-lift focus ring and hover scale', () => {
    render(
      <Slider value={[0]} min={-100} max={100} thumbAriaLabel="Exposure" />,
    )
    const thumb = screen.getByRole('slider', { name: 'Exposure' })
    expect(thumb).toHaveClass('focus-visible:outline-lf-green/80')
    expect(thumb).toHaveClass('hover:scale-[1.06]')
  })
})
