import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const inputSource = readFileSync(
  resolve(process.cwd(), 'src/components/ui/input/Input.tsx'),
  'utf8',
)

describe('raw route bootstrap paint', () => {
  it('paints /raw with a darkroom substrate before the app bundle mounts', () => {
    expect(indexHtml).toContain('dataset.lumaRoute')
    expect(indexHtml).toContain('luma-route-raw')
    expect(indexHtml).toContain("meta[name='theme-color']")
    // Stage base slate, not the retired warm oklch(0.16 0.02 76) that
    // flashed before the slate UI mounted.
    expect(indexHtml).toMatch(
      /html\.luma-route-raw #root \{[^}]*background: #010102;\s*background: oklch\(0\.064 0\.006 255\);/,
    )
    expect(indexHtml).not.toContain('#1d1914')
    expect(indexHtml).not.toContain('oklch(0.16 0.02 76)')
  })

  it('renders a visible /raw boot shell inside the root before React mounts', () => {
    expect(indexHtml).toContain('data-lf-raw-boot')
    expect(indexHtml).toContain('data-lf-raw-boot-title')
    expect(indexHtml).toContain('Finish a RAW with a LUT')
    expect(indexHtml).toContain(
      'html:not(.luma-route-raw) #root > [data-lf-raw-boot]',
    )
    expect(indexHtml).toContain(
      'html.luma-route-raw #root > [data-lf-raw-boot]',
    )
  })

  it('keeps the /raw boot shell paint path simple and stable', () => {
    // The static darkroom radial-gradient substrate is an intentional part of
    // the boot shell (mobile boot redesign). What must stay out of the critical
    // inline paint path is viewport-derived sizing math that can reflow the
    // first paint, so the title scales via fixed sizes + one media query rather
    // than clamp().
    expect(indexHtml).not.toContain('clamp(')
  })

  it('keeps the first-paint input icon path off the full Remix icon barrel', () => {
    expect(inputSource).not.toContain('@remixicon/react')
  })
})
