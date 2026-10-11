import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ReadyPreviewHistogram } from '@lumaforge/luma-color-runtime'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  HistogramPlot,
  HistogramTool,
  readyHistogram as shownHistogram,
} from './HistogramTool'

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

  it('keeps the previous bins on screen while a run is due', () => {
    const previous = readyHistogram()
    const computing = render(
      <HistogramTool histogram={{ state: 'computing', previous }} />,
    )
    expect(
      computing.container.querySelector('[data-histogram-source]'),
    ).toHaveTextContent('Computing')
    expect(
      computing.container.querySelector('[data-histogram-plot="card"]'),
    ).not.toBeNull()
    expect(screen.getByText('Shadows 1.2%')).toBeInTheDocument()
    computing.unmount()

    const stale = render(
      <HistogramTool histogram={{ state: 'stale', previous }} />,
    )
    expect(
      stale.container.querySelector('[data-histogram-source]'),
    ).toHaveTextContent('Stale')
    expect(
      stale.container.querySelector('[data-histogram-plot="card"]'),
    ).not.toBeNull()
  })

  it('draws no plot and no clipping while the first run computes', () => {
    const { container } = render(
      <HistogramTool histogram={{ state: 'computing', previous: null }} />,
    )

    expect(
      container.querySelector('[data-histogram-source]'),
    ).toHaveTextContent('Computing')
    expect(container.querySelector('[data-histogram-plot]')).toBeNull()
    expect(container.querySelector('[data-histogram-clipping]')).toBeNull()
  })

  it.each([
    [
      { state: 'unavailable', reason: 'no-image' },
      'Not loaded',
      'Choose a RAW to show preview distribution.',
    ],
    [
      { state: 'unavailable', reason: 'embedded-only' },
      'Embedded only',
      'Histogram requires a rendered RAW preview.',
    ],
    [
      { state: 'unsupported', reason: 'No pixels to sample.' },
      'Unsupported',
      'No pixels to sample.',
    ],
  ] as const)('explains an empty histogram: %o', (histogram, label, reason) => {
    const { container } = render(<HistogramTool histogram={histogram} />)

    expect(
      container.querySelector('[data-histogram-source]'),
    ).toHaveTextContent(label)
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(container.querySelector('[data-histogram-plot]')).toBeNull()
    expect(container.querySelector('[data-histogram-clipping]')).toBeNull()
  })

  it('hands the bins on screen to other surfaces', () => {
    const ready = readyHistogram()
    expect(shownHistogram(ready)).toBe(ready)
    expect(shownHistogram({ state: 'stale', previous: ready })).toBe(ready)
    expect(shownHistogram({ state: 'computing', previous: ready })).toBe(ready)
    expect(shownHistogram({ state: 'computing', previous: null })).toBeNull()
    expect(
      shownHistogram({ state: 'unavailable', reason: 'no-image' }),
    ).toBeNull()
    expect(shownHistogram({ state: 'unsupported', reason: 'x' })).toBeNull()
  })

  it('draws the mini plot without the grid, at pixel-width strokes', () => {
    const { container } = render(
      <HistogramPlot
        bins={readyHistogram().bins}
        ariaLabel="Histogram"
        variant="mini"
      />,
    )

    const plot = container.querySelector('[data-histogram-plot="mini"]')!
    expect(plot).toHaveClass('h-7', 'w-24')
    expect(plot.querySelector('.raw-histogram-grid')).toBeNull()
    expect(
      plot.querySelector('.raw-histogram-luma')?.getAttribute('vector-effect'),
    ).toBe('non-scaling-stroke')
    // Empty channels draw a fill but no line.
    expect(plot.querySelector('.raw-histogram-channel-line')).toBeNull()
  })

  it.each([
    'src/modules/raw-processor/components/mobile/FloatingHistogramCard.tsx',
    'src/modules/raw-processor/components/mobile/ScrubValueHud.tsx',
    'src/modules/raw-processor/components/DesktopRawToolSurface.tsx',
  ])('%s draws the histogram from the shared owner', (path) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8')
    expect(source).not.toMatch(/from '\.{1,2}\/tools\/HistogramTool'/)
    expect(source).toMatch(/from '\.{1,2}\/shared\/HistogramTool'/)
  })

  it('owns the presentation without importing a tool surface', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/modules/raw-processor/components/shared/HistogramTool.tsx',
      ),
      'utf8',
    )
    expect(source).not.toMatch(/from '\.\.\/(?:tools|mobile)\//)
  })
})
