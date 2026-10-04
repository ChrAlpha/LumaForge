import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MobileModeDock } from './MobileModeDock'

describe('mobileModeDock', () => {
  it('renders the tool tabs only and switches tool when expanded', async () => {
    const onModeChange = vi.fn()
    const onOpenMore = vi.fn()
    render(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={onModeChange}
        onCollapse={vi.fn()}
        onOpenMore={onOpenMore}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    expect(screen.getByTestId('panel')).toHaveTextContent('tone-panel')
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Look', 'Adjust'])
    // Compare is a lens over the photo and Export a topbar action: neither
    // is a tool, so neither takes a tab.
    expect(
      screen.queryByRole('tab', { name: /compare/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /export/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /more/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /strength/i }),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /look/i }))
    expect(onModeChange).toHaveBeenCalledWith('look')
    expect(onOpenMore).not.toHaveBeenCalled()
  })

  it('adds Transform as the third tool when the feature exists', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        showTransform
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        panel={<div>x</div>}
      />,
    )
    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Look',
      'Adjust',
      'Transform',
    ])
    expect(tablist).toHaveClass('grid-cols-3')
  })

  it('marks no tab while the export panel holds the deck, and a tap hands it back', async () => {
    const onModeChange = vi.fn()
    const onCollapse = vi.fn()
    render(
      <MobileModeDock
        mode="tone"
        expanded
        exportOpen
        onModeChange={onModeChange}
        onCollapse={onCollapse}
        panel={<div data-testid="panel">export-panel</div>}
      />,
    )
    expect(screen.getByTestId('panel')).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { selected: true }),
    ).not.toBeInTheDocument()

    // The last tool is not "active" while export is open, so tapping it
    // returns to it instead of collapsing the deck.
    await userEvent.click(screen.getByRole('tab', { name: /adjust/i }))
    expect(onModeChange).toHaveBeenCalledWith('tone')
    expect(onCollapse).not.toHaveBeenCalled()
  })

  it('carries no export readiness mark: readiness lives on the export action', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        panel={<div>x</div>}
      />,
    )
    expect(screen.getByRole('tablist').innerHTML).not.toMatch(/lf-green/)
  })

  it('keeps the deck on screen while disabled only when asked to', () => {
    const common = {
      mode: 'look' as const,
      expanded: true,
      disabled: true,
      exportOpen: true,
      onModeChange: vi.fn(),
      onCollapse: vi.fn(),
      panel: <div data-testid="panel">export-progress</div>,
    }
    const { rerender } = render(<MobileModeDock {...common} />)
    expect(screen.queryByTestId('panel')).toBeNull()

    rerender(<MobileModeDock {...common} panelVisibleWhileDisabled />)
    expect(screen.getByTestId('panel')).toBeInTheDocument()
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled()
  })

  it('keeps the bottom dock close to the visible mobile viewport edge', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div>look-panel</div>}
      />,
    )

    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    const dock = tablist.parentElement

    expect(dock).toHaveClass(
      'pb-[max(8px,calc(env(safe-area-inset-bottom)-24px))]',
    )
    expect(dock).not.toHaveClass('pb-safe-offset-3')
    // 48px tabs with 4px above and below: a ~64px bar with the dock's 8px.
    expect(tablist).toHaveClass('py-1')
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('min-h-12')
    }
  })

  it('paints the tab bar and deck as solid surfaces with inset seams', () => {
    render(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    const dock = tablist.parentElement!
    expect(dock).toHaveClass(
      'bg-[oklch(0.085_0.006_255)]',
      'shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.05)]',
    )
    expect(tablist.className).not.toMatch(/border-t/)
    expect(dock.className).not.toMatch(/gradient/)

    const deck = screen
      .getByTestId('panel')
      .closest('[data-mobile-dock-panel]')!
    expect(deck).toHaveClass(
      'before:bg-[oklch(0.085_0.006_255)]',
      'before:shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.08)]',
    )
    expect(deck.className).not.toMatch(/gradient/)
  })

  it('takes its height from the stage layout and anchors natural content to the bottom', () => {
    const { rerender } = render(
      <MobileModeDock
        mode="look"
        exportOpen
        expanded
        deckHeight={212}
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div data-testid="panel">export-panel</div>}
      />,
    )

    const deck = () =>
      screen
        .getByTestId('panel')
        .closest<HTMLElement>('[data-mobile-dock-panel]')!
    expect(deck().style.height).toBe('212px')
    expect(deck()).toHaveClass('overflow-y-auto', 'flex', 'flex-col')
    expect(deck()).not.toHaveAttribute('data-deck-fill')
    expect(deck()).toHaveClass('pt-3.5')
    // Export and Look size the deck: their content sits at its natural
    // height, pushed to the bottom of the deck near the thumb.
    expect(screen.getByTestId('panel').parentElement).toHaveClass(
      'mt-auto',
      'shrink-0',
    )

    rerender(
      <MobileModeDock
        mode="tone"
        expanded
        deckHeight={250}
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )

    // List tools fill the deck so the panel can run its own internal scroll
    // with the section chrome held still.
    expect(deck().style.height).toBe('250px')
    expect(deck()).toHaveAttribute('data-deck-fill', 'true')
    // The list's section chrome is the deck's top edge: no empty band
    // between the deck hairline and the sub-tabs.
    expect(deck()).toHaveClass('pt-0')
    expect(deck()).not.toHaveClass('pt-3.5')
    expect(screen.getByTestId('panel').parentElement).toHaveClass('h-full')
    expect(deck().className).not.toMatch(/vh/)
  })

  it('moves the deck height on the stage curve, and not under reduced motion', () => {
    render(
      <MobileModeDock
        mode="tone"
        expanded
        deckHeight={250}
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const deck = screen.getByTestId('panel').closest('[data-mobile-dock-panel]')
    expect(deck).toHaveClass(
      'transition-[height]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.22,1,0.36,1)]',
      'motion-reduce:transition-none',
    )
  })

  it('dims the mode tabs while a slider scrub is active', () => {
    render(
      <MobileModeDock
        mode="tone"
        expanded
        scrubbing
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div>tone-panel</div>}
      />,
    )

    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    expect(tablist).toHaveAttribute('data-scrubbing', 'true')
    expect(tablist).toHaveClass('opacity-45')
  })

  it('fades the dock panel backdrop while scrubbing so the photo dominates', () => {
    const { rerender } = render(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const panelFrame = screen
      .getByTestId('panel')
      .closest('[data-mobile-dock-panel]')
    expect(panelFrame).not.toHaveAttribute('data-scrubbing')
    expect(panelFrame).not.toHaveClass('before:opacity-10')

    rerender(
      <MobileModeDock
        mode="tone"
        expanded
        scrubbing
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const scrubbingPanelFrame = screen
      .getByTestId('panel')
      .closest('[data-mobile-dock-panel]')
    expect(scrubbingPanelFrame).toHaveAttribute('data-scrubbing', 'true')
    expect(scrubbingPanelFrame).toHaveClass('before:opacity-10')
  })

  it('overlays the expanded panel above the dock without growing the dock box', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div data-testid="panel">look-panel</div>}
      />,
    )

    const panelFrame = screen
      .getByTestId('panel')
      .closest('[data-mobile-dock-panel]')
    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    const dock = tablist.parentElement

    expect(dock).toHaveClass('absolute')
    expect(panelFrame).toHaveAttribute('data-mobile-dock-panel', 'true')
    expect(panelFrame).toHaveClass('absolute')
    expect(panelFrame).toHaveClass('bottom-full')
  })

  it('hides the panel when collapsed and toggles on tab tap', async () => {
    const onModeChange = vi.fn()
    const onCollapse = vi.fn()
    const { rerender } = render(
      <MobileModeDock
        mode="tone"
        expanded={false}
        onModeChange={onModeChange}
        onCollapse={onCollapse}
        onOpenMore={vi.fn()}
        panel={<div data-testid="p">x</div>}
      />,
    )
    expect(screen.queryByTestId('p')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: /adjust/i }))
    expect(onModeChange).toHaveBeenCalledWith('tone')

    rerender(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={onModeChange}
        onCollapse={onCollapse}
        onOpenMore={vi.fn()}
        panel={<div data-testid="p">x</div>}
      />,
    )
    expect(screen.getByTestId('p')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /adjust/i }))
    expect(onCollapse).toHaveBeenCalled()
  })

  it('reads no tab as active while collapsed, only when expanded', () => {
    const common = {
      mode: 'tone' as const,
      onModeChange: vi.fn(),
      onCollapse: vi.fn(),
      onOpenMore: vi.fn(),
      panel: <div>x</div>,
    }
    const { rerender } = render(<MobileModeDock {...common} expanded={false} />)
    expect(
      screen.queryByRole('tab', { selected: true }),
    ).not.toBeInTheDocument()

    rerender(<MobileModeDock {...common} expanded />)
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(
      /adjust/i,
    )
  })

  it('marks the selected tab with the cool lift bar, not amber', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div>x</div>}
      />,
    )

    const selected = screen.getByRole('tab', { selected: true })
    const bar = selected.querySelector(':scope > span:last-child')
    expect(bar).toHaveClass('bg-[oklch(0.96_0.006_255/0.85)]')
    expect(screen.getByRole('tablist').innerHTML).not.toMatch(/amber/)
  })

  it('sets tab labels in sentence case', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        showTransform
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        panel={<div>x</div>}
      />,
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    for (const tab of tabs) {
      expect(tab).toHaveClass('text-[0.7rem]', 'font-semibold')
      expect(tab).not.toHaveClass('uppercase')
      expect(tab).not.toHaveClass('tracking-wide')
    }
  })
})

describe('mobileModeDock measurements', () => {
  function stubLayout() {
    const heights = new Map<Element, number>()
    const offsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetHeight',
    )
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return heights.get(this) ?? 0
      },
    })
    const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> =
      []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((cb: ResizeObserverCallback) => {
        const entry = { cb, targets: [] as Element[] }
        observers.push(entry)
        return {
          observe: (el: Element) => entry.targets.push(el),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        }
      }),
    )
    return {
      heights,
      flush: () =>
        act(() => {
          for (const o of observers) o.cb([], {} as ResizeObserver)
        }),
      restore: () => {
        vi.unstubAllGlobals()
        if (offsetHeight) {
          Object.defineProperty(
            HTMLElement.prototype,
            'offsetHeight',
            offsetHeight,
          )
        }
      },
    }
  }

  it('reports the tab bar alone, since the deck floats above it', () => {
    const layout = stubLayout()
    try {
      const onTabBarHeightChange = vi.fn()
      const { container } = render(
        <MobileModeDock
          mode="tone"
          expanded
          deckHeight={250}
          onModeChange={vi.fn()}
          onCollapse={vi.fn()}
          onTabBarHeightChange={onTabBarHeightChange}
          panel={<div>tone-panel</div>}
        />,
      )
      layout.heights.set(container.querySelector('[data-mobile-dock]')!, 64)
      layout.heights.set(
        container.querySelector('[data-mobile-dock-panel]')!,
        250,
      )
      layout.flush()
      expect(onTabBarHeightChange).toHaveBeenLastCalledWith(64)
    } finally {
      layout.restore()
    }
  })

  it('reports the natural content height plus deck padding for content that sizes the deck', () => {
    const layout = stubLayout()
    try {
      const onDeckNaturalHeightChange = vi.fn()
      const { container, rerender } = render(
        <MobileModeDock
          mode="look"
          expanded
          deckHeight={0}
          onModeChange={vi.fn()}
          onCollapse={vi.fn()}
          onDeckNaturalHeightChange={onDeckNaturalHeightChange}
          panel={<div>look-panel</div>}
        />,
      )
      layout.heights.set(
        container.querySelector('[data-mobile-deck-content]')!,
        116,
      )
      layout.flush()
      expect(onDeckNaturalHeightChange).toHaveBeenLastCalledWith(140)

      // A list tool fills the deck; its height is the layout's, not content's.
      onDeckNaturalHeightChange.mockClear()
      rerender(
        <MobileModeDock
          mode="tone"
          expanded
          deckHeight={250}
          onModeChange={vi.fn()}
          onCollapse={vi.fn()}
          onDeckNaturalHeightChange={onDeckNaturalHeightChange}
          panel={<div>tone-panel</div>}
        />,
      )
      expect(onDeckNaturalHeightChange).not.toHaveBeenCalled()
    } finally {
      layout.restore()
    }
  })
})
