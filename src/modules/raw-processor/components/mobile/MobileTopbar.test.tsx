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

  it('shows the file title with only More and the export action beside it', () => {
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV · 47.8 MB',
      supportLevel: 'official',
      moreMenuItems: [],
      exportAction: <button type="button">Export</button>,
    })
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // The histogram toggle and file details live in the More menu; the
    // topbar keeps one filled action, export, at the far right.
    expect(
      screen.queryByRole('button', { name: /histogram/i }),
    ).not.toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['', 'Export'])
    expect(buttons[0]).toHaveAccessibleName(/more actions/i)
  })

  it('opens the more menu and invokes an item', async () => {
    const onSelect = vi.fn()
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'experimental',
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
      moreMenuItems: [],
    })

    expect(
      screen.queryByRole('button', { name: /switch to (english|chinese)/i }),
    ).not.toBeInTheDocument()
    // Only the More trigger competes with the meta line for width.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('renders trailing detail text on a More menu item', async () => {
    renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'official',
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
    // The solid plate on the header itself stays: that is what backs the
    // HUD readout.
    expect(scrubbingHeader).toHaveClass('bg-[oklch(0.064_0.006_255)]')
  })

  it('sits on a solid stage-base plate no taller than its 44px row', () => {
    const { container } = renderMobileTopbar({
      hasImage: true,
      fileName: 'DSC09142.ARW',
      fileMeta: 'Sony α7 IV',
      supportLevel: 'official',
      moreMenuItems: [],
    })
    const header = container.querySelector('[data-mobile-topbar]')!
    // The photo is anchored below the topbar, so nothing reads through it.
    expect(header).toHaveClass(
      'bg-[oklch(0.064_0.006_255)]',
      'pt-safe-offset-3',
      'auto-rows-[minmax(2.75rem,auto)]',
    )
    expect(header.className).not.toMatch(/gradient|pb-5|backdrop-blur/)
  })

  it('keeps no histogram slot before a RAW is loaded', () => {
    const { container } = renderMobileTopbar({
      hasImage: false,
      fileName: '',
      fileMeta: '',
      supportLevel: 'experimental',
      moreMenuItems: [],
    })

    expect(
      container.querySelector('[data-mobile-histogram-slot]'),
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
