import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MobileExportActionState } from './MobileExportAction'
import {
  getMobileExportActionState,
  MobileExportAction,
} from './MobileExportAction'

function pillOf(button: HTMLElement) {
  return button.firstElementChild as HTMLElement
}

describe('getMobileExportActionState', () => {
  const idle = {
    canExport: false,
    isProcessing: false,
    isExporting: false,
    hasResult: false,
  }

  it('is ready only when export can run and the pipeline is idle', () => {
    expect(getMobileExportActionState(idle)).toBe('idle')
    expect(getMobileExportActionState({ ...idle, canExport: true })).toBe(
      'ready',
    )
    expect(
      getMobileExportActionState({
        ...idle,
        canExport: true,
        isProcessing: true,
      }),
    ).toBe('idle')
  })

  it('lets a running export outrank a previous result', () => {
    expect(getMobileExportActionState({ ...idle, hasResult: true })).toBe(
      'done',
    )
    expect(
      getMobileExportActionState({
        ...idle,
        hasResult: true,
        isProcessing: true,
        isExporting: true,
      }),
    ).toBe('exporting')
  })
})

describe('mobileExportAction', () => {
  function renderAction(
    state: MobileExportActionState,
    overrides: Partial<React.ComponentProps<typeof MobileExportAction>> = {},
  ) {
    const onClick = vi.fn()
    render(
      <MobileExportAction
        state={state}
        expanded={false}
        onClick={onClick}
        {...overrides}
      />,
    )
    return {
      onClick,
      button: screen.getByRole('button'),
    }
  }

  it('names the blocked state and stays tappable so the panel can explain', async () => {
    const { button, onClick } = renderAction('idle')
    expect(button).toHaveAccessibleName('Export blocked: open details')
    expect(button).toHaveAttribute('data-mobile-export-action')
    expect(button).toHaveAttribute('data-state', 'idle')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('Export')
    // Neutral lift, never Lab Green while blocked.
    expect(pillOf(button)).toHaveClass('bg-[oklch(0.96_0.006_255/0.1)]')
    expect(pillOf(button).className).not.toMatch(/bg-lf-green/)
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('paints the ready state Lab Green with dark text', () => {
    const { button } = renderAction('ready')
    expect(button).toHaveAccessibleName('Export ready: open options')
    expect(pillOf(button)).toHaveClass('bg-lf-green', 'text-lf-surface')
  })

  it('shows rounded tabular progress while exporting and stays enabled', () => {
    const { button } = renderAction('exporting', { progress: 41.6 })
    expect(button).toHaveAccessibleName('Exporting 42%')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('42%')
    expect(button.querySelector('.tabular-nums')).toHaveTextContent('42%')
    expect(button.querySelector('[data-export-action-spinner]')).not.toBeNull()
    expect(pillOf(button).className).not.toMatch(/bg-lf-green/)
  })

  it('clamps out-of-range progress', () => {
    const { button } = renderAction('exporting', { progress: 140 })
    expect(button).toHaveAccessibleName('Exporting 100%')
  })

  it('marks a finished export with a check on Deep Lab Green', () => {
    const { button } = renderAction('done')
    expect(button).toHaveAccessibleName('Exported: open result')
    expect(button).toHaveTextContent('Exported')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(pillOf(button)).toHaveClass('bg-lf-green-deep')
  })

  it('reflects the open panel and lifts the pill', () => {
    const { button } = renderAction('idle', { expanded: true })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(pillOf(button)).toHaveClass('bg-[oklch(0.96_0.006_255/0.14)]')
    expect(pillOf(button).className).toMatch(/inset_0_0_0_1px/)
  })

  it('keeps a 44px hit area, a focus ring, a press shift, and a disabled state', () => {
    const { button } = renderAction('idle', { disabled: true })
    expect(button).toHaveClass('min-h-11', 'min-w-11')
    expect(button).toHaveClass('enabled:active:translate-y-[0.5px]')
    expect(pillOf(button)).toHaveClass(
      'group-focus-visible:outline-lf-green/80',
      'group-disabled:opacity-45',
    )
    expect(button).toBeDisabled()
    // No stylesheet transform for the press (DESIGN.md Press Feedback).
    expect(button.className).not.toMatch(/active:transform|active:scale/)
  })
})
