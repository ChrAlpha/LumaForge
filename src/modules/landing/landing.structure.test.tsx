import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import { Component } from '~/pages/(main)/index.sync'

import { countMoreFormats } from './content'

const ROOT = resolve(__dirname, '..', '..', '..')

function renderLanding() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </I18nProvider>,
  )
}

function expectLocalWebp(relativePath: string) {
  const header = readFileSync(resolve(ROOT, 'public', relativePath)).subarray(
    0,
    12,
  )
  expect(header.toString('ascii', 0, 4)).toBe('RIFF')
  expect(header.toString('ascii', 8, 12)).toBe('WEBP')
}

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('no-preference') ? !reduced : reduced,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

describe('landing semantic structure', () => {
  beforeEach(() => {
    localStorage.setItem('lumaforge.locale', 'en')
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
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
    expectLocalWebp('landing-raw-finish.webp')

    const caption = figure!.querySelector('figcaption')
    expect(caption).toHaveTextContent('SGL00940.ARW · 9504 × 6336')
    expect(caption).toHaveTextContent('Illustrative compare of two treatments')
  })

  it('shows a real browser workspace as product evidence on every viewport', () => {
    const { container } = renderLanding()

    const image = screen.getByRole('img', {
      name: /actual lumaforge raw lab session showing a split comparison/i,
    })
    expect(image).toHaveAttribute('src', '/landing-workspace-evidence.webp')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('width', '1440')
    expect(image).toHaveAttribute('height', '900')

    const picture = image.closest('picture')
    expect(picture).not.toBeNull()
    const source = picture!.querySelector('source')
    expect(source).toHaveAttribute(
      'srcset',
      '/landing-workspace-evidence-mobile.webp',
    )
    expect(source).toHaveAttribute('media', '(max-width: 640px)')
    expectLocalWebp('landing-workspace-evidence.webp')
    expectLocalWebp('landing-workspace-evidence-mobile.webp')

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

  it('names the real supported formats instead of a feature grid', () => {
    const { container } = renderLanding()

    const formats = screen.getByText(
      new RegExp(`and ${countMoreFormats()} more RAW formats`),
    )
    expect(formats).toHaveTextContent('.ARW')
    expect(formats).toHaveTextContent('No account, no install, no upload.')
    expect(formats.closest('.lf-hero')).not.toBeNull()

    expect(container.querySelector('.lf-hero ul')).toBeNull()
    expect(container.querySelector('.lf-hero-feature-rail')).toBeNull()
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

  it('states three processing guarantees as a ledger', () => {
    renderLanding()

    const ledger = screen.getByRole('region', {
      name: 'LumaForge processing guarantees',
    })
    const rows = [...ledger.querySelectorAll('dl > div')]
    const terms = [...ledger.querySelectorAll('dt')]
    const definitions = [...ledger.querySelectorAll('dd')]

    expect(rows).toHaveLength(3)
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
    expect(within(ledger).queryByRole('heading')).toBeNull()
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

  it('rests at the centre when the visitor prefers reduced motion', () => {
    stubReducedMotion(true)
    renderLanding()

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '50')
  })

  it('arms the reveal sweep only when motion is allowed and yields to input', async () => {
    stubReducedMotion(false)
    const user = userEvent.setup()
    renderLanding()

    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuenow', '86')

    slider.focus()
    await user.keyboard('{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuenow', '84')
  })
})

describe('landing asset and CSS contract', () => {
  it('ships local module CSS without legacy, remote, or synthetic surfaces', () => {
    const cssPaths = [
      resolve(__dirname, 'landing.css'),
      resolve(__dirname, 'landing.sections.css'),
    ]
    const css = cssPaths.map((path) => readFileSync(path, 'utf8')).join('\n')
    const removedSelectorPatterns = [
      /\.lf-compare-svg\b/,
      /\.lf-compare-finish\b/,
      /\.lf-compare-stage\b/,
      /\.lf-contract-strip\b/,
      /\.lf-hero-glow\b/,
      /\.lf-hero-panel\b/,
      /\.lf-hero-feature-rail\b/,
      /\.lf-photo-meta\b/,
      /\.lf-product-window\b/,
      /\.lf-trust\b/,
      /\.lf-window-body\b/,
      /\.lf-window-chrome\b/,
    ]

    expect(css).not.toMatch(/images\.unsplash\.com/)
    expect(css).not.toMatch(/https?:\/\//)
    expect(css).not.toMatch(/backdrop-filter/)
    expect(css).not.toMatch(/background-clip:\s*text/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/oklch\(\s*[01](?:\.0+)?\s+0\s+0/)
    for (const selectorPattern of removedSelectorPatterns) {
      expect(css).not.toMatch(selectorPattern)
    }

    for (const legacyPath of [
      'src/pages/(main)/index.css',
      'src/pages/(main)/index.sections.css',
      'src/components/common/LandingCompareSvg.tsx',
      'src/components/common/LandingPhotoCompare.tsx',
    ]) {
      expect(existsSync(resolve(ROOT, legacyPath))).toBe(false)
    }
  })
})
