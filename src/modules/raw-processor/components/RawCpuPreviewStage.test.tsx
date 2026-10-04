import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import { RawCpuPreviewStage } from './RawCpuPreviewStage'

const useCpuPreview = vi.fn((_options: { variant: string }) => ({
  frame: null,
  inFlight: false,
  failureReason: null,
}))

vi.mock('../hooks/useCpuPreview', () => ({
  useCpuPreview: (options: { variant: string }) => useCpuPreview(options),
}))
vi.mock('./CpuPreviewCanvas', () => ({
  CpuPreviewCanvas: () => <div data-testid="cpu-canvas" />,
}))

const image = {
  width: 6,
  height: 4,
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
} as unknown as DecodedImage

function renderStage(
  props: Partial<React.ComponentProps<typeof RawCpuPreviewStage>> = {},
) {
  return render(
    <RawCpuPreviewStage
      image={image}
      imageVersion={1}
      params={{} as never}
      lut={null}
      fallbackThumbnailUrl={null}
      {...props}
    />,
  )
}

function lastVariant() {
  return useCpuPreview.mock.calls.at(-1)?.[0].variant
}

describe('rawCpuPreviewStage', () => {
  beforeEach(() => {
    useCpuPreview.mockClear()
  })

  it('keeps its own original / processed toggle row by default', () => {
    renderStage()
    expect(screen.getByRole('button', { name: 'Original' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Original' }))
    expect(lastVariant()).toBe('neutral')
  })

  it('drops the row when the caller owns the variant, so the photo keeps the stage', () => {
    const { container, rerender } = renderStage({ variant: 'processed' })
    expect(screen.queryByRole('button', { name: 'Original' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Processed' })).toBeNull()
    // The preview frame is the stage's only child.
    expect(container.querySelector('.raw-lab-stage')!.children).toHaveLength(1)
    expect(lastVariant()).toBe('processed')

    rerender(
      <RawCpuPreviewStage
        image={image}
        imageVersion={1}
        params={{} as never}
        lut={null}
        fallbackThumbnailUrl={null}
        variant="neutral"
      />,
    )
    expect(lastVariant()).toBe('neutral')
  })

  it('shows the processed photo under an applied Transform whatever the variant', () => {
    renderStage({ variant: 'neutral', transformActive: true })
    expect(lastVariant()).toBe('processed')
  })
})
