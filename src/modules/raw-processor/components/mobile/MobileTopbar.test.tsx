import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'

import { MobileTopbar } from './MobileTopbar'

function renderTopbar(
  overrides: Partial<React.ComponentProps<typeof MobileTopbar>> = {},
) {
  const props: React.ComponentProps<typeof MobileTopbar> = {
    hasImage: true,
    fileName: 'DSC09142.ARW',
    fileMeta: 'Experimental support · Sony ILCE-7M4',
    histogramShown: false,
    onToggleHistogram: vi.fn(),
    onReplaceFile: vi.fn(),
    onOpenFileDetails: vi.fn(),
    onResetSession: vi.fn(),
    ...overrides,
  }
  const view = render(
    <I18nProvider>
      <MobileTopbar {...props} />
    </I18nProvider>,
  )
  return {
    ...view,
    rerenderWith: (next: Partial<React.ComponentProps<typeof MobileTopbar>>) =>
      view.rerender(
        <I18nProvider>
          <MobileTopbar {...props} {...next} />
        </I18nProvider>,
      ),
  }
}

describe('mobileTopbar', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('shows the file title with only More and the export action beside it', () => {
    renderTopbar({ exportAction: <button type="button">Export</button> })
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // The histogram toggle, the locale switch and file details live in the
    // More menu; the topbar keeps one filled action, export, at the far right.
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['', 'Export'])
    expect(buttons[0]).toHaveAccessibleName(/more actions/i)
  })

  it('yields its content to the scrub HUD while scrubbing', () => {
    const { container, rerenderWith } = renderTopbar()
    const header = container.querySelector('[data-mobile-topbar]')!
    expect(header).not.toHaveAttribute('data-scrubbing')

    rerenderWith({ scrubbing: true })
    expect(header).toHaveAttribute('data-scrubbing', 'true')
  })

  it('lists only real actions in the More menu, reset last', async () => {
    localStorage.setItem('lumaforge.locale', 'en')
    renderTopbar()
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))

    const menu = await screen.findByRole('menu')
    const rows = Array.from(
      menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
    )
    for (const row of rows) expect(row).toBeEnabled()
    expect(rows.map((row) => row.textContent)).toEqual([
      'Replace RAW',
      'File & pipeline details',
      'Histogram',
      'LanguageEnglish',
      'Reset session',
    ])
    // LUT import lives in the Look tool, not in the menu.
    expect(screen.queryByText(/add \.cube lut/i)).not.toBeInTheDocument()
    // The old disabled pseudo-items claimed "Official RAW support" even for
    // an experimental file.
    expect(screen.queryByText(/official raw support/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no upload/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /reset session/i }),
    ).toHaveAttribute('data-tone', 'destructive')
  })

  it('toggles the histogram from a checkable menu item', async () => {
    localStorage.setItem('lumaforge.locale', 'en')
    const onToggleHistogram = vi.fn()
    renderTopbar({ histogramShown: true, onToggleHistogram })
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))

    const histogram = await screen.findByRole('menuitemcheckbox', {
      name: /histogram/i,
    })
    expect(histogram).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(histogram)
    expect(onToggleHistogram).toHaveBeenCalledTimes(1)
    // Selecting an item closes the menu.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers only the language switch before a RAW is loaded', async () => {
    localStorage.setItem('lumaforge.locale', 'en')
    renderTopbar({ hasImage: false })
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))

    const menu = await screen.findByRole('menu')
    const rows = Array.from(
      menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
    )
    expect(rows.map((row) => row.textContent)).toEqual(['LanguageEnglish'])
  })

  it('switches language from the More menu', async () => {
    localStorage.setItem('lumaforge.locale', 'en')
    renderTopbar()
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /language/i }),
    )

    expect(localStorage.getItem('lumaforge.locale')).toBe('zh-CN')
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    const language = await screen.findByRole('menuitem', { name: /语言/ })
    expect(language).toHaveTextContent('语言中文')
    await userEvent.click(language)
    expect(localStorage.getItem('lumaforge.locale')).toBe('en')
  })
})
