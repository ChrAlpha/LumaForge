// @vitest-environment node

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  LUMAFORGE_OG_IMAGE_HEIGHT,
  LUMAFORGE_OG_IMAGE_WIDTH,
  renderLumaForgeOgImage,
} from './og-image'

describe('lumaForge OG image', () => {
  it('renders a PNG social image from the page source component', async () => {
    const [fontData, heroImageData, logoData] = await Promise.all([
      readFile('src/assets/fonts/GeistVF.woff2'),
      readFile('public/landing-raw-finish.webp'),
      readFile('public/favicon.png'),
    ])
    const heroImageSrc = `data:image/webp;base64,${Buffer.from(
      heroImageData,
    ).toString('base64')}`
    const logoSrc = `data:image/png;base64,${Buffer.from(logoData).toString(
      'base64',
    )}`
    const image = await renderLumaForgeOgImage({
      fontData,
      heroImageSrc,
      logoSrc,
    })

    expect(LUMAFORGE_OG_IMAGE_WIDTH).toBe(1200)
    expect(LUMAFORGE_OG_IMAGE_HEIGHT).toBe(630)
    expect([...image.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ])
    expect(image.byteLength).toBeGreaterThan(10_000)
  })
})
