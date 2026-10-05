import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Toaster as Sonner } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RAW_MOBILE_TOAST_TOP, Toaster } from './sonner'

const viewport = vi.hoisted(() => ({ w: 1280 }))

vi.mock('~/hooks/common', () => ({
  useThemeAtomValue: () => 'dark',
  useViewport: <T,>(selector: (value: { w: number }) => T) =>
    selector({ w: viewport.w }),
}))

vi.mock('sonner', () => ({
  Toaster: vi.fn(() => null),
}))

describe('toaster', () => {
  afterEach(() => {
    vi.clearAllMocks()
    viewport.w = 1280
  })

  it('drops mobile /raw toasts below the topbar and leaves every other case alone', () => {
    const lastProps = () => vi.mocked(Sonner).mock.calls.at(-1)?.[0]

    viewport.w = 393
    render(
      <MemoryRouter initialEntries={['/raw']}>
        <Toaster />
      </MemoryRouter>,
    )
    // Both offsets: sonner reads `mobileOffset` only below 600px, and the
    // mobile /raw surface runs to 640px.
    for (const offset of [lastProps()?.offset, lastProps()?.mobileOffset]) {
      expect(offset).toEqual({
        top: RAW_MOBILE_TOAST_TOP,
        right: '16px',
        bottom: '16px',
        left: '16px',
      })
    }
    expect(RAW_MOBILE_TOAST_TOP).toBe('calc(env(safe-area-inset-top) + 64px)')
    expect(lastProps()?.position).toBe('top-center')
    // A top toast enters and leaves through a full toast height above its
    // slot; clipped at the topbar's bottom edge, it never crosses the bar.
    expect(lastProps()?.className).toContain(
      '[clip-path:inset(-8px_-100vw_-100vh_-100vw)]',
    )

    // Another route on a phone keeps the default edge offset.
    render(
      <MemoryRouter initialEntries={['/']}>
        <Toaster />
      </MemoryRouter>,
    )
    expect(lastProps()?.offset).toBe('16px')
    expect(lastProps()?.mobileOffset).toBe('16px')
    expect(lastProps()?.className).toBe('toaster group')

    // Desktop /raw has no mobile topbar.
    viewport.w = 1280
    render(
      <MemoryRouter initialEntries={['/raw']}>
        <Toaster />
      </MemoryRouter>,
    )
    expect(lastProps()?.offset).toBe('16px')
  })

  it('keeps app toast defaults while adding raw-route darkroom chrome overrides', () => {
    render(<Toaster />)

    const props = vi.mocked(Sonner).mock.calls[0]?.[0]
    const classNames = props?.toastOptions?.classNames

    expect(classNames?.toast).toContain('bg-background/80')
    expect(classNames?.toast).toContain(
      '[.luma-route-raw_&]:!bg-lf-on-photo-bg-strong',
    )
    expect(classNames?.toast).toContain(
      '[.luma-route-raw_&]:!border-lf-on-photo-bord-soft',
    )
    expect(classNames?.title).toContain(
      '[.luma-route-raw_&]:!text-lf-on-photo-ink',
    )
    expect(classNames?.description).toContain(
      '[.luma-route-raw_&]:!text-lf-on-photo-ink/68',
    )
    expect(classNames?.actionButton).toContain(
      '[.luma-route-raw_&]:!bg-lf-green',
    )
    expect(classNames?.closeButton).toContain(
      '[.luma-route-raw_&]:!text-lf-on-photo-ink/64',
    )
    expect(classNames?.closeButton).toContain('[.luma-route-raw_&]:!size-7')
    expect(classNames?.closeButton).toContain('[.luma-route-raw_&]:!rounded-md')
  })
})
