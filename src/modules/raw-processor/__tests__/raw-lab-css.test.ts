import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const rawLabCss = readFileSync(
  resolve(process.cwd(), 'src/modules/raw-processor/raw-lab.css'),
  'utf8',
)

const rawLabEffectsCss = readFileSync(
  resolve(process.cwd(), 'src/modules/raw-processor/raw-lab.effects.css'),
  'utf8',
)

function extractRuleBody(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)

  const bodyStart = css.indexOf('{', start) + 1
  let depth = 1
  for (let index = bodyStart; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') {
      depth += 1
    }
    if (char === '}') {
      depth -= 1
    }
    if (depth === 0) {
      return css.slice(bodyStart, index)
    }
  }

  throw new Error(`Could not find end of rule for ${selector}`)
}

function extractCustomProperties(ruleBody: string) {
  const entries: Array<[string, string]> = []

  for (const line of ruleBody.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('--')) {
      continue
    }

    const separator = trimmed.indexOf(':')
    if (separator === -1) {
      continue
    }

    const name = trimmed.slice(0, separator)
    const value = trimmed
      .slice(separator + 1)
      .replace(/;$/, '')
      .trim()
    entries.push([name, value])
  }

  return Object.fromEntries(entries)
}

describe('raw lab css tokens', () => {
  it('keeps desktop and mobile preview mats on their own design languages', () => {
    const desktopTokens = extractCustomProperties(
      extractRuleBody(rawLabCss, '.raw-lab'),
    )
    const mobileMedia = extractRuleBody(rawLabCss, '@media (max-width: 640px)')
    const mobileTokens = extractCustomProperties(
      extractRuleBody(mobileMedia, '.raw-lab'),
    )

    expect(desktopTokens['--color-preview-mat']).toBe('oklch(0.9 0.024 86)')
    expect(desktopTokens['--color-preview-mat-edge']).toBe(
      'oklch(0.82 0.026 82)',
    )
    expect(mobileTokens['--color-preview-mat']).toBe(
      'var(--color-stage-background)',
    )
    expect(mobileTokens['--color-preview-mat-edge']).toBe('var(--color-fill)')
    expect(mobileTokens['--color-preview-border']).toBe('transparent')
  })

  it('reserves stable mobile runtime-readiness space to avoid empty-state CLS', () => {
    // .raw-mobile-empty-readiness was relocated to raw-lab.effects.css
    const readinessRule = extractRuleBody(
      rawLabEffectsCss,
      '.raw-mobile-empty-readiness',
    )

    expect(readinessRule).toContain('width: min(320px, 100%);')
    expect(readinessRule).toContain('min-height: 64px;')
  })

  it('keeps the mobile empty-state onboarding copy centered as a block', () => {
    const copyBlockRule = extractRuleBody(
      rawLabEffectsCss,
      '.raw-mobile-empty-copy-block',
    )

    expect(copyBlockRule).toContain('display: grid;')
    expect(copyBlockRule).toContain('justify-items: center;')
    expect(copyBlockRule).toContain('width: min(280px, 100%);')
  })
})

describe('compare handle interaction contract', () => {
  it('clips the split line to the published photo box instead of the frame', () => {
    const rule = extractRuleBody(
      rawLabEffectsCss,
      '.raw-lab-compare-handle::before',
    )
    expect(rule).toContain('var(--raw-compare-track-top, 0px)')
    expect(rule).toContain('var(--raw-compare-track-height, 100%)')
  })

  it('gives both viewports the same accent while the handle is dragged', () => {
    const rule = extractRuleBody(
      rawLabEffectsCss,
      '[data-raw-compare-dragging] .raw-lab-compare-handle span',
    )
    expect(rule).toContain('var(--color-lf-green)')
    expect(rule).toContain('scale(1.06)')
    // The shared rule must sit outside the desktop-only media block.
    const desktopBlockEnd = rawLabEffectsCss.indexOf(
      '/* Histogram visuals (relocated from raw-lab.css). */',
    )
    expect(
      rawLabEffectsCss.indexOf(
        '[data-raw-compare-dragging] .raw-lab-compare-handle span',
      ),
    ).toBeGreaterThan(desktopBlockEnd)
  })

  it('answers a press on the mobile chrome the way desktop does', () => {
    const mobileMedia = extractRuleBody(
      rawLabEffectsCss,
      '@media (max-width: 640px)',
    )
    // `translate`, not `transform`: motion components write transform inline.
    expect(mobileMedia).toContain('translate: 0 0.5px')
    expect(mobileMedia).toContain('[data-mobile-topbar] button')
    expect(mobileMedia).toContain('[data-adjust-section-chrome] button')
  })
})

describe('fixed workspace frames never scroll', () => {
  it('clips the shell, stage, and tool rail instead of hiding overflow', () => {
    const surfaceCss = readFileSync(
      resolve(process.cwd(), 'src/modules/raw-processor/raw-lab.surface.css'),
      'utf8',
    )
    const rule = extractRuleBody(
      surfaceCss,
      '.raw-lab,\n.raw-lab-shell,\n.raw-lab-stage,\n.raw-tool-surface',
    )
    // `hidden` first as the fallback, `clip` to remove the scroll container
    // so a focus scroll cannot displace the workspace permanently.
    expect(rule).toContain('overflow: hidden')
    expect(rule).toContain('overflow: clip')
  })
})
