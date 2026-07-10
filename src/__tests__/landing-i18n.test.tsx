import { render, screen } from '@testing-library/react'
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

function expectRawLabLinks(name: string, count: number) {
  const links = screen.getAllByRole('link', { name })
  expect(links).toHaveLength(count)
  for (const link of links) {
    expect(link).toHaveAttribute('href', '/raw')
  }
}

describe('landing page i18n', () => {
  beforeEach(() => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders representative Chinese hero and workflow copy', () => {
    renderLanding()

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: '从 RAW 到成片，不必搬进调色工作站。',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '先看见相机文件，再调整影调、颜色与 HSL，检查直方图、对比原片；管线可复现时才导出全分辨率 JPEG。LUT 可用，但不是必需。RAW 留在你的设备上。',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: '一张文件，走完整条判断路径。',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '调整色温、色调、饱和度、自然饱和度与八色 HSL；想要特定风格时，再带上已声明合同的 `.cube` LUT。',
      ),
    ).toBeInTheDocument()

    expectRawLabLinks('进入 RAW Lab', 2)
    expectRawLabLinks('打开 RAW Lab', 1)
  })

  it('switches to representative English hero and workflow copy', async () => {
    const user = userEvent.setup()
    renderLanding()

    await user.click(screen.getByRole('button', { name: 'Switch to English' }))

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'A complete RAW finish, without the editing cockpit.',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Preview the camera file, shape tone and color, inspect the histogram, compare the original, then export a full-resolution JPEG when the pipeline can be reproduced. A LUT is optional. The RAW stays on your device.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'One file. The whole decision path.',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Adjust temperature, tint, saturation, vibrance, and eight-band HSL. Bring a declared `.cube` LUT only when you want one.',
      ),
    ).toBeInTheDocument()

    expectRawLabLinks('Open RAW lab', 3)
  })
})
