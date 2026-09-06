import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'

import { DesktopAdjustRow } from './DesktopAdjustRow'

class PointerEventPolyfill extends MouseEvent {
  pointerType: string
  pointerId: number
  isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? ''
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? true
  }
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof DesktopAdjustRow>> = {},
) {
  const props = {
    label: 'Contrast',
    value: 0,
    min: -100,
    max: 100,
    step: 1,
    disabled: false,
    formatValue: (v: number) => `${v > 0 ? '+' : ''}${v}`,
    onChange: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider>
      <DesktopAdjustRow {...props} />
    </I18nProvider>,
  )
  return props
}

function mockTrackRect() {
  const track = document.querySelector(
    '[data-slot="slider-track"]',
  ) as HTMLElement
  track.getBoundingClientRect = () =>
    ({
      left: 100,
      width: 200,
      top: 40,
      height: 20,
      right: 300,
      bottom: 60,
      x: 100,
      y: 40,
      toJSON: () => ({}),
    }) as DOMRect
}

// `buttons: 1` models a held primary button; see useSliderScrub.test.tsx.
const mouse = (x: number, extra: Record<string, unknown> = {}) => ({
  pointerType: 'mouse',
  pointerId: 1,
  isPrimary: true,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: 50,
  ...extra,
})

describe('desktopAdjustRow', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    }
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

  it('labels the slider and renders the formatted value', () => {
    renderRow({ value: 12 })
    const thumb = screen.getByRole('slider', { name: 'Contrast' })
    expect(thumb).toHaveAttribute('aria-valuenow', '12')
    expect(screen.getByText('+12')).toBeInTheDocument()
  })

  it('scrubs from the row with an absolute jump then relative moves', () => {
    const props = renderRow({ value: 0 })
    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    mockTrackRect()
    fireEvent.pointerDown(row, mouse(250))
    expect(props.onChange).toHaveBeenLastCalledWith(50)
    expect(row).toHaveAttribute('data-scrubbing')
    fireEvent.pointerMove(row, mouse(260))
    expect(props.onChange).toHaveBeenLastCalledWith(60)
    fireEvent.pointerUp(row, mouse(260))
    expect(row).not.toHaveAttribute('data-scrubbing')
  })

  it('holding shift scrubs at one tenth speed and surfaces the fine hint', () => {
    const props = renderRow({ value: 0 })
    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    mockTrackRect()
    fireEvent.pointerDown(row, mouse(200))
    fireEvent.pointerMove(row, mouse(220, { shiftKey: true }))
    expect(props.onChange).toHaveBeenLastCalledWith(2)
    expect(row).toHaveAttribute('data-scrub-gain', 'fine')
    expect(screen.getByText(/fine/i)).toBeInTheDocument()
  })

  it('offers a reset button on the value when dirty and resets on double click', async () => {
    const props = renderRow({ value: -42 })
    const reset = screen.getByRole('button', { name: /reset contrast/i })
    expect(reset).toHaveTextContent('-42')
    await userEvent.click(reset)
    expect(props.onChange).toHaveBeenLastCalledWith(0)

    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    fireEvent.doubleClick(row)
    expect(props.onChange).toHaveBeenLastCalledWith(0)
  })

  it('keeps the readout mounted but inert when neutral', () => {
    // The element must not swap between button and output: unmounting a
    // focused reset drops focus to the body.
    renderRow({ value: 0 })
    const readout = screen.getByRole('button', {
      name: /reset contrast/i,
      hidden: true,
    })
    expect(readout).toBeDisabled()
  })

  it('does not scrub while disabled', () => {
    const props = renderRow({ value: 0, disabled: true })
    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    mockTrackRect()
    fireEvent.pointerDown(row, mouse(250))
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('forwards data attributes and an optional leading swatch', () => {
    renderRow({
      value: 3,
      rowProps: { 'data-tone-field': 'userContrast' },
      leading: <span data-testid="swatch" />,
    })
    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    expect(row).toHaveAttribute('data-tone-field', 'userContrast')
    expect(row).toHaveAttribute('data-dirty')
    expect(screen.getByTestId('swatch')).toBeInTheDocument()
  })
})

describe('desktopAdjustRow accessibility shapes', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    }
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

  it('names the slider by the visible label by default', () => {
    renderRow({ label: 'Exposure', value: 0 })
    expect(screen.getByRole('slider', { name: 'Exposure' })).toBeInTheDocument()
  })

  it('exposes a labelled group and an explicit slider name when asked', () => {
    renderRow({
      label: 'Red',
      labelPrefix: 'Hue',
      sliderLabel: 'Hue',
      asGroup: true,
      value: 0,
    })
    const group = screen.getByRole('group', { name: 'Hue: Red' })
    expect(group).toHaveAttribute('data-adjust-row')
    expect(screen.getByRole('slider', { name: 'Hue' })).toBeInTheDocument()
  })
})

describe('desktopAdjustRow reset hit target', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    }
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

  it('lifts the reset above the slider hit-area pseudo element', () => {
    renderRow({ value: 12 })
    const reset = screen.getByRole('button', { name: /reset contrast/i })
    // The Slider root paints `before:-inset-y-[19px]` across the row width,
    // which otherwise swallows every click on the value.
    expect(reset).toHaveClass('relative')
    expect(reset).toHaveClass('z-10')
  })

  it('pressing the reset does not start a row scrub', () => {
    const props = renderRow({ value: 12 })
    const row = document.querySelector('[data-adjust-row]') as HTMLElement
    mockTrackRect()
    fireEvent.pointerDown(
      screen.getByRole('button', { name: /reset contrast/i }),
      mouse(250),
    )
    expect(row).not.toHaveAttribute('data-scrubbing')
    expect(props.onChange).not.toHaveBeenCalled()
  })
})
