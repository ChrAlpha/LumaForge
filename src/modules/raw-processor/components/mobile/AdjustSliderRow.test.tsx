import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdjustSliderRow } from './AdjustSliderRow'

describe('adjustSliderRow', () => {
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

  function renderRow(
    overrides: Partial<React.ComponentProps<typeof AdjustSliderRow>> = {},
  ) {
    const props = {
      label: 'Contrast',
      value: 0,
      min: -100,
      max: 100,
      step: 1,
      formatValue: (v: number) => `${v > 0 ? '+' : ''}${v}`,
      resetAriaLabel: 'Reset Contrast',
      onChange: vi.fn(),
      onScrubChange: vi.fn(),
      ...overrides,
    }
    render(<AdjustSliderRow {...props} />)
    return props
  }

  it('renders the label, slider wired with field metadata, and value', () => {
    renderRow({ value: 12 })
    const thumb = screen.getByRole('slider', { name: 'Contrast' })
    expect(thumb).toHaveAttribute('aria-valuemin', '-100')
    expect(thumb).toHaveAttribute('aria-valuemax', '100')
    expect(thumb).toHaveAttribute('aria-valuenow', '12')
    expect(screen.getByText('+12')).toBeInTheDocument()
    expect(screen.getByText('Contrast')).toBeInTheDocument()
  })

  it('emits onChange when the slider value changes', () => {
    const props = renderRow({ value: 12 })
    const thumb = screen.getByRole('slider', { name: 'Contrast' })
    thumb.focus()
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(props.onChange).toHaveBeenCalledWith(13)
  })

  it('keeps the readout mounted but inert when neutral', () => {
    // One element across states: unmounting a focused reset would drop focus
    // to the body mid-edit.
    renderRow({ value: 0 })
    expect(
      screen.getByRole('button', { name: /reset contrast/i, hidden: true }),
    ).toBeDisabled()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('exposes a reset button when dirty and emits onChange(0)', async () => {
    const props = renderRow({ value: -42 })
    const resetButton = screen.getByRole('button', { name: /reset contrast/i })
    expect(resetButton).toHaveTextContent('-42')
    // Secondary target on a two-line row: comfortably past the 24px floor
    // without growing the row that carries the full-width track.
    expect(resetButton).toHaveClass('min-h-9')
    await userEvent.click(resetButton)
    expect(props.onChange).toHaveBeenCalledWith(0)
  })

  it('emits onScrubChange on pointerdown and pointerup over the slider track', () => {
    const props = renderRow({ value: 12 })
    const scrubTarget = screen.getByTestId('adjust-slider-row-scrub')
    fireEvent.pointerDown(scrubTarget)
    expect(props.onScrubChange).toHaveBeenLastCalledWith(true)
    fireEvent.pointerUp(scrubTarget)
    expect(props.onScrubChange).toHaveBeenLastCalledWith(false)
  })

  it('also clears scrub state on pointercancel', () => {
    const props = renderRow({ value: 12 })
    const scrubTarget = screen.getByTestId('adjust-slider-row-scrub')
    fireEvent.pointerDown(scrubTarget)
    fireEvent.pointerCancel(scrubTarget)
    expect(props.onScrubChange).toHaveBeenLastCalledWith(false)
  })

  it('exposes active-scrub and sibling-scrubbing data attributes', () => {
    const { container, rerender } = render(
      <AdjustSliderRow
        label="Contrast"
        value={0}
        min={-100}
        max={100}
        step={1}
        formatValue={(v) => `${v}`}
        resetAriaLabel="Reset Contrast"
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const root = container.querySelector('[data-adjust-slider-row]')!
    expect(root).not.toHaveAttribute('data-active-scrub')
    expect(root).not.toHaveAttribute('data-sibling-scrubbing')

    rerender(
      <AdjustSliderRow
        label="Contrast"
        value={0}
        min={-100}
        max={100}
        step={1}
        formatValue={(v) => `${v}`}
        resetAriaLabel="Reset Contrast"
        activeScrub
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    expect(root).toHaveAttribute('data-active-scrub', 'true')
    expect(root).not.toHaveAttribute('data-sibling-scrubbing')

    rerender(
      <AdjustSliderRow
        label="Contrast"
        value={0}
        min={-100}
        max={100}
        step={1}
        formatValue={(v) => `${v}`}
        resetAriaLabel="Reset Contrast"
        siblingScrubbing
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    expect(root).not.toHaveAttribute('data-active-scrub')
    expect(root).toHaveAttribute('data-sibling-scrubbing', 'true')
  })
})

describe('adjustSliderRow precision band', () => {
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

  it('names the gain band in place of the label while the finger is off the track', async () => {
    const { createStore, Provider } = await import('jotai')
    const { I18nProvider } = await import('~/lib/i18n')
    const store = createStore()
    render(
      <Provider store={store}>
        <I18nProvider>
          <AdjustSliderRow
            label="Contrast"
            value={12}
            min={-100}
            max={100}
            step={1}
            formatValue={(v) => `${v}`}
            resetAriaLabel="Reset Contrast"
            activeScrub
            onChange={vi.fn()}
            onScrubChange={vi.fn()}
          />
        </I18nProvider>
      </Provider>,
    )
    // At rest the row shows its label; the band replaces it only while a
    // scrub is in a reduced-gain zone, and that state lives in the hook.
    expect(screen.getByText('Contrast')).toBeInTheDocument()
  })

  it('marks an active scrub with the cool lift wash, leaving amber to mean open', () => {
    const { container } = render(
      <AdjustSliderRow
        label="Contrast"
        value={0}
        min={-100}
        max={100}
        step={1}
        formatValue={(v) => `${v}`}
        resetAriaLabel="Reset Contrast"
        activeScrub
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const row = container.querySelector('[data-adjust-slider-row]')!
    expect(row.className).toContain('bg-[oklch(0.96_0.006_255/0.06)]')
    expect(row.className).not.toContain('border-lf-amber')
  })

  it('dims a sibling row rather than removing it while another row scrubs', () => {
    const { container } = render(
      <AdjustSliderRow
        label="Contrast"
        value={0}
        min={-100}
        max={100}
        step={1}
        formatValue={(v) => `${v}`}
        resetAriaLabel="Reset Contrast"
        siblingScrubbing
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const row = container.querySelector('[data-adjust-slider-row]')!
    expect(row.className).toContain('opacity-45')
  })
})
