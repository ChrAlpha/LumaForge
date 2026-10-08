import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import { UnsupportedState } from './UnsupportedState'

afterEach(() => {
  localStorage.clear()
})

describe('unsupportedState', () => {
  it('shows the reason it is handed as given, never matching it to copy', () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    render(<UnsupportedState reason={enMessages['raw.unsupported.gpu']} />, {
      wrapper: I18nProvider,
    })

    expect(screen.getByText(zhMessages['raw.unsupported.title'])).toBeVisible()
    expect(screen.getByText(enMessages['raw.unsupported.gpu'])).toBeVisible()
    expect(screen.queryByText(zhMessages['raw.unsupported.gpu'])).toBeNull()
  })

  it('shows an already localized reason', () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    render(<UnsupportedState reason={zhMessages['raw.unsupported.coi']} />, {
      wrapper: I18nProvider,
    })

    expect(screen.getByText(zhMessages['raw.unsupported.coi'])).toBeVisible()
    expect(screen.getByText(zhMessages['raw.unsupported.copy'])).toBeVisible()
  })
})
