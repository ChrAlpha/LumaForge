import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'

import { MobileLabTopbar } from './MobileLabTopbar'

function renderTopbar(
  overrides: Partial<React.ComponentProps<typeof MobileLabTopbar>> = {},
) {
  return render(
    <I18nProvider>
      <MobileLabTopbar
        hasImage
        fileName="DSC09142.ARW"
        fileMeta="Experimental support · Sony ILCE-7M4"
        supportLevel="experimental"
        histogramShown={false}
        onToggleHistogram={vi.fn()}
        onReplaceFile={vi.fn()}
        onOpenLutBrowser={vi.fn()}
        onOpenMore={vi.fn()}
        onResetSession={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  )
}

describe('mobileLabTopbar', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('lists only real actions in the More menu', async () => {
    localStorage.setItem('lumaforge.locale', 'en')
    renderTopbar()
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))

    const items = await screen.findAllByRole('menuitem')
    for (const item of items) expect(item).toBeEnabled()
    expect(items.map((item) => item.textContent)).toEqual([
      'Replace RAW',
      'Add .cube LUT',
      'File details',
      'Reset session',
      'LanguageEnglish',
    ])
    // The old disabled pseudo-items claimed "Official RAW support" even for
    // an experimental file.
    expect(screen.queryByText(/official raw support/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no upload/i)).not.toBeInTheDocument()
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
