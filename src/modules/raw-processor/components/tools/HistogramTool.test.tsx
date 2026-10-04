import type { ReadyPreviewHistogram } from '@lumaforge/luma-color-runtime'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HistogramTool } from './HistogramTool'

function readyHistogram(
  overrides: Partial<ReadyPreviewHistogram> = {},
): ReadyPreviewHistogram {
  const luma = new Uint32Array(256)
  luma[0] = 21_019
  luma[128] = 1_716_133
  luma[255] = 10_048
  return {
    state: 'ready',
    source: 'quick',
    width: 1600,
    height: 1092,
    sampledPixels: 1_747_200,
    totalPixels: 1_747_200,
    bins: {
      luma,
      red: new Uint32Array(256),
      green: new Uint32Array(256),
      blue: new Uint32Array(256),
    },
    clipping: {
      shadowAnyChannel: 21_019,
      highlightAnyChannel: 10_048,
      shadowLuma: 21_019,
      highlightLuma: 10_048,
    },
    diagnostics: {
      ownership: 'main-thread-chunked-no-copy',
      copiedInputBytes: 0,
      transferredInput: false,
      inputByteLength: 0,
      rowBandRows: 32,
    },
    ...overrides,
  }
}

describe('histogramTool', () => {
  it('titles the card "Histogram" and demotes the source to meta', () => {
    const { container } = render(
      <HistogramTool histogram={readyHistogram()} heading />,
    )

    expect(
      screen.getByRole('heading', { name: 'Histogram' }),
    ).toBeInTheDocument()
    const source = container.querySelector('[data-histogram-source]')
    expect(source).toHaveTextContent('Quick preview')
    expect(source?.tagName).not.toMatch(/^H\d$/)
  })

  it('leaves the title to the desktop tool card trigger', () => {
    render(
      <HistogramTool histogram={readyHistogram({ source: 'bounded-hq' })} />,
    )

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('HQ preview')).toBeInTheDocument()
  })

  it('reports clipping as a share of sampled pixels, not raw counts', () => {
    const { container } = render(
      <HistogramTool histogram={readyHistogram()} heading />,
    )

    const clipping = container.querySelector('[data-histogram-clipping]')!
    expect(clipping).toHaveClass('tabular-nums')
    expect(clipping).toHaveTextContent('Shadows 1.2%')
    expect(clipping).toHaveTextContent('Highlights 0.6%')
    expect(clipping.textContent).not.toMatch(/21019|10048/)
  })

  it('keeps an honest 0% when nothing clips', () => {
    render(
      <HistogramTool
        histogram={readyHistogram({
          clipping: {
            shadowAnyChannel: 0,
            highlightAnyChannel: 0,
            shadowLuma: 0,
            highlightLuma: 0,
          },
        })}
      />,
    )

    expect(screen.getByText('Shadows 0%')).toBeInTheDocument()
    expect(screen.getByText('Highlights 0%')).toBeInTheDocument()
  })
})
