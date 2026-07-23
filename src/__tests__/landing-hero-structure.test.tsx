import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import { Component } from '~/pages/(main)/index.sync'

function renderLanding() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </I18nProvider>,
  )
}

describe('landing semantic structure', () => {
  beforeEach(() => {
    localStorage.setItem('lumaforge.locale', 'en')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('uses a real local WebP for the photographic comparison', () => {
    renderLanding()

    const figure = screen
      .getAllByRole('figure')
      .find((candidate) =>
        candidate.querySelector('img[src="/landing-raw-finish.webp"]'),
      )
    expect(figure).toBeDefined()
    const compareImages = figure!.querySelectorAll('img')

    expect(compareImages).toHaveLength(2)
    for (const image of compareImages) {
      expect(image).toHaveAttribute('src', '/landing-raw-finish.webp')
      expect(image.getAttribute('src')).not.toMatch(/^https?:\/\//)
    }

    const assetPath = resolve(
      __dirname,
      '..',
      '..',
      'public',
      'landing-raw-finish.webp',
    )
    const assetHeader = readFileSync(assetPath).subarray(0, 12)
    expect(assetHeader.toString('ascii', 0, 4)).toBe('RIFF')
    expect(assetHeader.toString('ascii', 8, 12)).toBe('WEBP')
  })

  it('shows a real browser workspace as product evidence', () => {
    const { container } = renderLanding()

    const image = screen.getByRole('img', {
      name: /actual lumaforge raw lab session showing a split comparison/i,
    })
    expect(image).toHaveAttribute('src', '/landing-workspace-evidence.webp')
    expect(image).toHaveAttribute('loading', 'lazy')

    const assetPath = resolve(
      __dirname,
      '..',
      '..',
      'public',
      'landing-workspace-evidence.webp',
    )
    const assetHeader = readFileSync(assetPath).subarray(0, 12)
    expect(assetHeader.toString('ascii', 0, 4)).toBe('RIFF')
    expect(assetHeader.toString('ascii', 8, 12)).toBe('WEBP')

    const section = screen
      .getByRole('heading', {
        level: 2,
        name: 'The same controls feed preview and export.',
      })
      .closest('section')
    expect(section).not.toBeNull()
    expect(
      within(section as HTMLElement).getByText(/frame-anchored compare/i),
    ).toBeInTheDocument()
    expect(
      within(section as HTMLElement).getByText(/actual browser session/i),
    ).toBeInTheDocument()
    expect(within(section as HTMLElement).queryByRole('list')).toBeNull()
    expect(container.querySelector('.lf-section-label')).toBeNull()

    const copy = section!.querySelector('.lf-evidence-copy')
    expect(Array.from(copy!.children, (child) => child.tagName)).toEqual([
      'H2',
      'P',
    ])
  })

  it('presents the complete five-step finishing workflow', () => {
    renderLanding()

    const workflowTitle = screen.getByRole('heading', {
      level: 2,
      name: 'One file. The whole decision path.',
    })
    const workflow = workflowTitle.closest('section')
    expect(workflow).not.toBeNull()

    const list = within(workflow as HTMLElement).getByRole('list')
    expect(list.tagName).toBe('OL')

    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent('01')
    expect(items[0]).toHaveTextContent('Open the RAW')
    expect(items[0]).toHaveTextContent('embedded preview')
    expect(items[1]).toHaveTextContent(
      'exposure, contrast, highlights, shadows',
    )
    expect(items[2]).toHaveTextContent(
      'temperature, tint, saturation, vibrance',
    )
    expect(items[2]).toHaveTextContent('eight-band HSL')
    expect(items[2]).toHaveTextContent('.cube')
    expect(items[3]).toHaveTextContent('RGB or luminance histograms')
    expect(items[3]).toHaveTextContent('compare the original')
    expect(items[4]).toHaveTextContent('05')
    expect(items[4]).toHaveTextContent('Export with proof')
    expect(items[4]).toHaveTextContent('full-resolution JPEG')
    expect(items[4]).toHaveTextContent('resolved color graph')
  })

  it('renders the color contract as an ordered seven-step rail', () => {
    renderLanding()

    const rail = screen.getByRole('list', {
      name: 'Color pipeline from RAW development to JPEG',
    })
    expect(rail.tagName).toBe('OL')

    const expectedSteps = [
      ['RAW technical development', 'stage'],
      ['Color balance', 'stage'],
      ['Exposure and regional tone', 'stage'],
      ['Saturation and vibrance', 'stage'],
      ['Eight-band HSL', 'stage'],
      ['Optional declared LUT', 'optional'],
      ['sRGB JPEG', 'output'],
    ]
    const items = within(rail).getAllByRole('listitem')

    expect(items).toHaveLength(expectedSteps.length)
    items.forEach((item, index) => {
      const [label, role] = expectedSteps[index]
      expect(item).toHaveTextContent(String(index + 1).padStart(2, '0'))
      expect(item).toHaveTextContent(label)
      expect(item).toHaveAttribute('data-contract-role', role)
    })
  })

  it('states three processing guarantees', () => {
    renderLanding()

    const trust = screen.getByRole('region', {
      name: 'LumaForge processing guarantees',
    })
    const terms = [...trust.querySelectorAll('dt')]
    const definitions = [...trust.querySelectorAll('dd')]

    expect(terms).toHaveLength(3)
    expect(definitions).toHaveLength(3)
    expect(terms.map((term) => term.textContent)).toEqual([
      'Local RAW handling',
      'Preview is not export',
      'Fail closed by design',
    ])
    expect(definitions[0]).toHaveTextContent('not an upload queue')
    expect(definitions[1]).toHaveTextContent('Full-resolution export')
    expect(definitions[2]).toHaveTextContent('export stops')
  })

  it('provides a skip link to the main content', () => {
    renderLanding()

    expect(
      screen.getByRole('link', { name: 'Skip to main content' }),
    ).toHaveAttribute('href', '#landing-main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'landing-main')
  })

  it('exposes truthful compare bounds and reaches them with Home and End', async () => {
    const user = userEvent.setup()
    renderLanding()

    const slider = screen.getByRole('slider', {
      name: /illustrative muted and color treatment/,
    })
    expect(slider).toHaveAttribute('aria-valuemin', '2')
    expect(slider).toHaveAttribute('aria-valuemax', '98')
    expect(slider).toHaveAttribute('aria-valuenow', '50')
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '50% Muted treatment, 50% Color treatment',
    )

    const handle = slider.querySelector('.lf-compare-handle')
    expect(handle).toHaveAttribute('aria-hidden', 'true')
    expect(handle).toHaveTextContent('')
    expect(
      handle!.querySelector('svg.lucide-chevrons-left-right'),
    ).toHaveAttribute('width', '19')

    slider.focus()
    await user.keyboard('{Home}')
    expect(slider).toHaveAttribute('aria-valuenow', '2')
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '2% Muted treatment, 98% Color treatment',
    )

    await user.keyboard('{End}')
    expect(slider).toHaveAttribute('aria-valuenow', '98')
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '98% Muted treatment, 2% Color treatment',
    )
  })
})

describe('landing asset and CSS contract', () => {
  it('does not retain remote, legacy, or synthetic compare surfaces', () => {
    const cssPaths = [
      resolve(__dirname, '..', 'pages', '(main)', 'index.css'),
      resolve(__dirname, '..', 'pages', '(main)', 'index.sections.css'),
    ]
    const css = cssPaths.map((path) => readFileSync(path, 'utf8')).join('\n')
    const removedSelectorPatterns = [
      /\.lf-compare-svg\b/,
      /\.lf-compare-finish\b/,
      /\.lf-compare-stage\b/,
      /\.lf-contract-strip\b/,
      /\.lf-hero-glow\b/,
      /\.lf-hero-panel\b/,
      /\.lf-product-window\b/,
      /\.lf-window-body\b/,
      /\.lf-window-chrome\b/,
    ]

    expect(css).not.toMatch(/images\.unsplash\.com/)
    expect(css).not.toMatch(/https?:\/\//)
    for (const selectorPattern of removedSelectorPatterns) {
      expect(css).not.toMatch(selectorPattern)
    }

    expect(
      existsSync(
        resolve(
          __dirname,
          '..',
          'components',
          'common',
          'LandingCompareSvg.tsx',
        ),
      ),
    ).toBe(false)
  })
})
