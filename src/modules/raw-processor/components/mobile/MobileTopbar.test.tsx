import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'

import { MobileTopbar } from './MobileTopbar'

type MobileTopbarProps = React.ComponentProps<typeof MobileTopbar>

function renderMobileTopbar(props: MobileTopbarProps) {
  return render(
    <I18nProvider>
      <MobileTopbar {...props} />
    </I18nProvider>,
  )
}

describe('mobileTopbar', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('shows the file title and toggles the histogram (no file-details dupe)', async () => {
    const onToggleHistogram = vi.fn()
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV · 47.8 MB',
      supportLevel: 'official',
      histogramShown: false,
      onToggleHistogram,
      moreMenuItems: [],
    })
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // The standalone topbar control is the histogram toggle, not a second
    // "File details" entry point (that lives only in the More menu).
    expect(
      screen.queryByRole('button', { name: /file details/i }),
    ).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /show histogram/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(toggle)
    expect(onToggleHistogram).toHaveBeenCalledTimes(1)
  })

  it('reflects the histogram-shown state on the toggle', () => {
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'official',
      histogramShown: true,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [],
    })
    const toggle = screen.getByRole('button', { name: /hide histogram/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the more menu and invokes an item', async () => {
    const onSelect = vi.fn()
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'experimental',
      histogramShown: false,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [
        {
          kind: 'item',
          icon: () => null,
          label: 'Replace RAW',
          onSelect,
        },
      ],
    })
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /replace raw/i }),
    )
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the locale switch out of the topbar (it lives in the More menu)', () => {
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Official RAW support · Sony ILCE-7M4',
      supportLevel: 'official',
      histogramShown: false,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [],
    })

    expect(
      screen.queryByRole('button', { name: /switch to (english|chinese)/i }),
    ).not.toBeInTheDocument()
    // Only the histogram toggle and the More trigger compete with the meta
    // line for width.
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('renders trailing detail text on a More menu item', async () => {
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'official',
      histogramShown: false,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [
        {
          kind: 'item',
          icon: () => null,
          label: 'Language',
          detail: 'English',
          onSelect: vi.fn(),
        },
      ],
    })
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    const item = await screen.findByRole('menuitem', { name: /language/i })
    expect(item).toHaveTextContent('LanguageEnglish')
  })

  it('yields the safe-area slot to the scrub HUD by fading content while scrubbing', () => {
    const { container, rerender } = renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'official',
      histogramShown: false,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [],
    })

    const header = container.querySelector('[data-mobile-topbar]')!
    expect(header).not.toHaveAttribute('data-scrubbing')
    const idleChildren = Array.from(header.children) as HTMLElement[]
    for (const child of idleChildren) {
      expect(child).not.toHaveClass('opacity-0')
      expect(child).toHaveClass('pointer-events-auto')
    }

    rerender(
      <I18nProvider>
        <MobileTopbar
          hasImage
          fileName="DSC09142.ARW"
          fileMeta="Sony α7 IV"
          supportLevel="official"
          histogramShown={false}
          onToggleHistogram={vi.fn()}
          moreMenuItems={[]}
          scrubbing
        />
      </I18nProvider>,
    )

    const scrubbingHeader = container.querySelector('[data-mobile-topbar]')!
    expect(scrubbingHeader).toHaveAttribute('data-scrubbing', 'true')
    const scrubbingChildren = Array.from(
      scrubbingHeader.children,
    ) as HTMLElement[]
    expect(scrubbingChildren.length).toBeGreaterThan(0)
    for (const child of scrubbingChildren) {
      expect(child).toHaveClass('opacity-0')
      expect(child).toHaveClass('pointer-events-none')
      expect(child).not.toHaveClass('pointer-events-auto')
    }
    // The gradient backdrop on the header itself stays — that's what backs
    // the HUD readout.
    expect(scrubbingHeader).toHaveClass(
      'bg-gradient-to-b',
      'from-[oklch(0.064_0.006_255/0.82)]',
    )
  })

  it('reserves the histogram action slot before a RAW is loaded', () => {
    const { container } = renderMobileTopbar({
      hasImage: false,
      fileName: '',
      fileMeta: '',
      supportLevel: 'experimental',
      histogramShown: false,
      onToggleHistogram: vi.fn(),
      moreMenuItems: [],
    })

    expect(container.querySelector('[data-mobile-histogram-slot]')).toHaveClass(
      'size-11',
    )
    expect(
      screen.queryByRole('button', { name: /show histogram/i }),
    ).not.toBeInTheDocument()
  })
})
