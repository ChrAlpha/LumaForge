import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { RawCpuPreviewStage } from './RawCpuPreviewStage'

interface CpuPreviewOptions {
  variant: string
  params: Record<string, unknown>
  decodedFrame: DecodedPreviewFrame | null
}

const cpuFrame = { width: 6, height: 4 }
const useCpuPreview = vi.fn(
  (
    _options: CpuPreviewOptions,
  ): { frame: unknown; inFlight: boolean; failureReason: string | null } => ({
    frame: null,
    inFlight: false,
    failureReason: null,
  }),
)

vi.mock('../hooks/useCpuPreview', () => ({
  useCpuPreview: (options: CpuPreviewOptions) => useCpuPreview(options),
}))
vi.mock('./CpuPreviewCanvas', () => ({
  CpuPreviewCanvas: () => <div data-testid="cpu-canvas" />,
}))

const image = {
  width: 6,
  height: 4,
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
} as unknown as DecodedImage

const decodedFrame: DecodedPreviewFrame = {
  sessionId: 'session-1',
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: 6,
  height: 4,
  exposure: {
    kind: 'source-pin',
    value: { ev: 0, multiplier: 1, source: 'identity' },
  },
  quickPredecessorFrameId: null,
}

const color: ColorGraphIntent = {
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0.37,
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.5,
}

function renderStage(
  props: Partial<React.ComponentProps<typeof RawCpuPreviewStage>> = {},
) {
  return render(
    <RawCpuPreviewStage
      image={image}
      decodedFrame={decodedFrame}
      color={color}
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
    useCpuPreview.mockReset()
    useCpuPreview.mockReturnValue({
      frame: null,
      inFlight: false,
      failureReason: null,
    })
  })

  it('hands the CPU preview the accepted frame descriptor', () => {
    renderStage()
    expect(useCpuPreview.mock.calls.at(-1)?.[0].decodedFrame).toBe(decodedFrame)
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
        decodedFrame={decodedFrame}
        color={color}
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

  it('renders the color intent alone, with the RAW render exposure', () => {
    const exposedImage = {
      ...image,
      renderExposure: {
        ev: 1.25,
        multiplier: 2 ** 1.25,
        source: 'image-statistics',
      },
    } as unknown as DecodedImage
    renderStage({
      image: exposedImage,
      // A record that still carries view fields must not leak them.
      color: { ...color, viewMode: 'compare', compareSplit: 0.8 } as never,
    })

    const { params } = useCpuPreview.mock.calls.at(-1)![0]
    expect(params).toEqual({
      ...color,
      lut: null,
      rawRenderExposure: exposedImage.renderExposure,
    })
    expect(params).not.toHaveProperty('viewMode')
    expect(params).not.toHaveProperty('compareSplit')
  })

  it('hands only processed frames to the Transform capture', () => {
    useCpuPreview.mockReturnValue({
      frame: cpuFrame,
      inFlight: false,
      failureReason: null,
    })
    const onProcessedFrame = vi.fn()

    const { rerender } = renderStage({ onProcessedFrame })
    expect(onProcessedFrame).toHaveBeenLastCalledWith(cpuFrame, false)

    // The stage's own Original toggle shows the neutral frame, never captured.
    fireEvent.click(screen.getByRole('button', { name: 'Original' }))
    expect(lastVariant()).toBe('neutral')
    expect(onProcessedFrame).toHaveBeenLastCalledWith(null, false)

    const stage = (
      props: Partial<React.ComponentProps<typeof RawCpuPreviewStage>>,
    ) => (
      <RawCpuPreviewStage
        image={image}
        decodedFrame={decodedFrame}
        color={color}
        lut={null}
        fallbackThumbnailUrl={null}
        onProcessedFrame={onProcessedFrame}
        {...props}
      />
    )
    // A controlled neutral variant (the mobile lens) is not captured either.
    rerender(stage({ variant: 'neutral' }))
    expect(onProcessedFrame).toHaveBeenLastCalledWith(null, false)

    rerender(stage({ variant: 'processed' }))
    expect(onProcessedFrame).toHaveBeenLastCalledWith(cpuFrame, false)

    // Under an applied Transform the stage renders processed and captures it.
    rerender(stage({ variant: 'neutral', transformActive: true }))
    expect(lastVariant()).toBe('processed')
    expect(onProcessedFrame).toHaveBeenLastCalledWith(cpuFrame, false)

    // A frame being replaced is still the processed photo on screen, but
    // not yet the photo as it now looks.
    useCpuPreview.mockReturnValue({
      frame: cpuFrame,
      inFlight: true,
      failureReason: null,
    })
    rerender(stage({ variant: 'processed', decodedFrame: null }))
    expect(onProcessedFrame).toHaveBeenLastCalledWith(cpuFrame, true)

    // A failed render shows no processed photo.
    useCpuPreview.mockReturnValue({
      frame: cpuFrame,
      inFlight: false,
      failureReason: 'render-failed',
    })
    rerender(stage({ variant: 'processed' }))
    expect(onProcessedFrame).toHaveBeenLastCalledWith(null, false)
  })
})
