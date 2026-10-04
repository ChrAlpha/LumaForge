import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MobileMoreSheet } from './MobileMoreSheet'

describe('mobileMoreSheet', () => {
  it('renders headings and never names libraw-wasm', () => {
    render(
      <MobileMoreSheet
        open
        onClose={vi.fn()}
        pipelineSteps={[
          {
            index: 1,
            label: 'RAW decode',
            detail: 'Sony α7 IV · Official support',
          },
        ]}
        lutRows={[{ label: 'LUT', value: 'Not used' }]}
        fileRows={[{ label: 'Camera', value: 'Sony α7 IV' }]}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /file & pipeline/i }),
    ).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', { name: /file & pipeline/i })
    expect(dialog).toHaveAttribute('data-mobile-substrate', 'ink-sheet')
    expect(dialog.className).not.toMatch(
      /bg-material|bg-background|bg-fill|text-text|border-border/,
    )
    expect(screen.queryByText(/libraw-wasm/i)).not.toBeInTheDocument()
    expect(screen.getByText('Sony α7 IV')).toBeInTheDocument()
  })

  it('renders each pipeline step with its live state, not a timing column', () => {
    render(
      <MobileMoreSheet
        open
        onClose={vi.fn()}
        pipelineSteps={[
          { index: 1, label: 'RAW decode', detail: 'Official support' },
          { index: 2, label: 'Adjust', detail: '3 fields changed' },
        ]}
        lutRows={[]}
        fileRows={[{ label: 'Preview render', value: '42 ms' }]}
      />,
    )
    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toHaveTextContent('2Adjust3 fields changed')
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    expect(screen.getByText('Preview render')).toBeInTheDocument()
    expect(screen.getByText('42 ms')).toBeInTheDocument()
  })

  it('closes via the close button', async () => {
    const onClose = vi.fn()
    render(
      <MobileMoreSheet
        open
        onClose={onClose}
        pipelineSteps={[]}
        lutRows={[]}
        fileRows={[]}
      />,
    )
    const close = screen.getByRole('button', {
      name: /close file & pipeline details/i,
    })
    expect(close).toHaveClass('size-[44px]')
    await userEvent.click(close)
    expect(onClose).toHaveBeenCalled()
  })
})
