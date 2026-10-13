import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MobileExportActionState } from './MobileExportAction'
import {
  getMobileExportActionState,
  MobileExportAction,
} from './MobileExportAction'

describe('getMobileExportActionState', () => {
  const idle = {
    canExport: false,
    isProcessing: false,
    isExporting: false,
    resultKind: null,
  } as const

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
    expect(
      getMobileExportActionState({ ...idle, resultKind: 'full-resolution' }),
    ).toBe('done')
    expect(
      getMobileExportActionState({
        ...idle,
        resultKind: 'full-resolution',
        isProcessing: true,
        isExporting: true,
      }),
    ).toBe('exporting')
  })

  it('never gives an HQ preview result the full-resolution done state', () => {
    expect(
      getMobileExportActionState({ ...idle, resultKind: 'hq-preview' }),
    ).toBe('preview-done')
    expect(
      getMobileExportActionState({
        ...idle,
        canExport: true,
        resultKind: 'hq-preview',
      }),
    ).toBe('preview-done')
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
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('names the ready state', () => {
    const { button } = renderAction('ready')
    expect(button).toHaveAccessibleName('Export ready: open options')
  })

  it('shows rounded tabular progress while exporting and stays enabled', () => {
    const { button } = renderAction('exporting', { progress: 41.6 })
    expect(button).toHaveAccessibleName('Exporting 42%')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('42%')
    expect(button.querySelector('.tabular-nums')).toHaveTextContent('42%')
    expect(button.querySelector('[data-export-action-spinner]')).not.toBeNull()
  })

  it('clamps out-of-range progress', () => {
    const { button } = renderAction('exporting', { progress: 140 })
    expect(button).toHaveAccessibleName('Exporting 100%')
  })

  it('marks a finished export with a check', () => {
    const { button } = renderAction('done')
    expect(button).toHaveAccessibleName('Exported: open result')
    expect(button).toHaveTextContent('Exported')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('names an HQ preview result as such, never as exported', () => {
    const { button } = renderAction('preview-done')
    expect(button).toHaveAccessibleName('HQ preview JPEG ready: open result')
    expect(button).toHaveTextContent('HQ preview')
    expect(button).not.toHaveTextContent('Exported')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('reflects the open panel', () => {
    const { button } = renderAction('idle', { expanded: true })
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps a 44px hit area and a disabled state', () => {
    const { button } = renderAction('idle', { disabled: true })
    expect(button).toHaveClass('min-h-11', 'min-w-11')
    expect(button).toBeDisabled()
  })
})
