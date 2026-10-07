import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { shouldShowAppFooter, syncRouteSubstrate } from './App'

vi.mock('./components/common/Footer', () => ({
  Footer: () => null,
}))

afterEach(() => {
  document.documentElement.classList.remove('luma-route-raw')
  document.documentElement.classList.remove('luma-route-landing')
  document.documentElement.removeAttribute('data-luma-route')
  document.head.innerHTML = ''
})

vi.mock('./providers/root-providers', () => ({
  RootProviders: ({ children }: { children: ReactNode }) => children,
}))

describe('shouldShowAppFooter', () => {
  it('hides the footer on the root route', () => {
    expect(shouldShowAppFooter('/')).toBe(false)
  })

  it('hides the footer on the RAW route', () => {
    expect(shouldShowAppFooter('/raw')).toBe(false)
  })

  it('hides the footer on the trailing-slash RAW route', () => {
    expect(shouldShowAppFooter('/raw/')).toBe(false)
  })

  it('hides the footer on the trailing-slash root route', () => {
    expect(shouldShowAppFooter('//')).toBe(false)
  })

  it('shows the footer below RAW subpaths', () => {
    expect(shouldShowAppFooter('/raw/unknown')).toBe(true)
  })

  it('treats the retired transform demo path as an ordinary app path', () => {
    expect(shouldShowAppFooter('/transform-demo')).toBe(true)
    expect(shouldShowAppFooter('/transform-demo/')).toBe(true)
  })

  it('shows the footer on the profiles route', () => {
    expect(shouldShowAppFooter('/profiles')).toBe(true)
  })

  it('shows the footer on the about route', () => {
    expect(shouldShowAppFooter('/about')).toBe(true)
  })
})

describe('syncRouteSubstrate', () => {
  it('sets the dark RAW route substrate before the route paints', () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="oklch(0.964 0.018 86)" />'

    syncRouteSubstrate('/raw/')

    expect(document.documentElement).toHaveClass('luma-route-raw')
    expect(document.documentElement.dataset.lumaRoute).toBe('raw')
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe('oklch(0.064 0.006 255)')
  })

  it('sets a dark landing substrate on the root route', () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="oklch(0.964 0.018 86)" />'

    syncRouteSubstrate('/')

    expect(document.documentElement).toHaveClass('luma-route-landing')
    expect(document.documentElement).not.toHaveClass('luma-route-raw')
    expect(document.documentElement.dataset.lumaRoute).toBe('landing')
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe('oklch(0.075 0.006 255)')
  })

  it('restores the app substrate outside the RAW and landing routes', () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="oklch(0.064 0.006 255)" />'
    document.documentElement.classList.add('luma-route-raw')
    document.documentElement.classList.add('luma-route-landing')
    document.documentElement.dataset.lumaRoute = 'raw'

    syncRouteSubstrate('/profiles')

    expect(document.documentElement).not.toHaveClass('luma-route-raw')
    expect(document.documentElement).not.toHaveClass('luma-route-landing')
    expect(document.documentElement.dataset.lumaRoute).toBe('app')
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe('oklch(0.964 0.018 86)')
  })

  it('paints the retired transform demo path with the app substrate', () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="oklch(0.064 0.006 255)" />'

    syncRouteSubstrate('/transform-demo/')

    const root = document.documentElement
    expect(root.dataset.lumaRoute).toBe('app')
    expect(root).not.toHaveClass('luma-route-raw')
    expect(root).not.toHaveClass('luma-route-landing')
    expect(
      [...root.classList].filter((name) => name.startsWith('luma-route-')),
    ).toEqual([])
    expect(
      document.head
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe('oklch(0.964 0.018 86)')
  })

  it('keeps the pre-paint substrate script on the same routes as the app', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    expect(indexHtml).toContain(
      "root.classList.toggle('luma-route-raw', rawPath)",
    )
    expect(indexHtml).toContain(
      "root.classList.toggle('luma-route-landing', landingPath)",
    )
    expect(indexHtml).not.toContain('/transform-demo')
    expect(indexHtml).not.toContain('luma-route-transform')
  })
})
