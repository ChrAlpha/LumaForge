import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MobileModeDock } from './MobileModeDock'

describe('mobileModeDock', () => {
  it('renders the handoff mode tabs and switches mode when expanded', async () => {
    const onModeChange = vi.fn()
    const onOpenMore = vi.fn()
    render(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={onModeChange}
        onCollapse={vi.fn()}
        onOpenMore={onOpenMore}
        canExport={false}
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    expect(screen.getByTestId('panel')).toHaveTextContent('tone-panel')
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Look',
      'Adjust',
      'Compare',
      'Export',
    ])
    expect(screen.queryByRole('tab', { name: /more/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /strength/i }),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /look/i }))
    expect(onModeChange).toHaveBeenCalledWith('look')
    await userEvent.click(screen.getByRole('tab', { name: /compare/i }))
    expect(onModeChange).toHaveBeenCalledWith('compare')
    expect(onOpenMore).not.toHaveBeenCalled()
  })

  it('keeps the bottom dock close to the visible mobile viewport edge', () => {
    render(
      <MobileModeDock
        mode="export"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        canExport
        panel={<div>export-panel</div>}
      />,
    )

    const tablist = screen.getByRole('tablist', { name: /lab modes/i })
    const dock = tablist.parentElement

    expect(dock).toHaveClass(
      'pb-[max(8px,calc(env(safe-area-inset-bottom)-24px))]',
    )
    expect(dock).not.toHaveClass('pb-safe-offset-3')
    expect(tablist).toHaveClass('pb-2')
    expect(tablist).not.toHaveClass('pb-3')
  })

  it('gives Export enough room while keeping non-editor modes compact', () => {
    const { rerender } = render(
      <MobileModeDock
        mode="export"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        canExport
        panel={<div data-testid="panel">export-panel</div>}
      />,
    )

    expect(screen.getByTestId('panel').parentElement).toHaveClass(
      'max-h-[min(32vh,260px)]',
    )
    expect(screen.getByTestId('panel').parentElement).toHaveClass(
      'overflow-y-auto',
    )
    expect(screen.getByTestId('panel').parentElement).toHaveClass('pb-4')

    rerender(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        canExport
        panel={<div data-testid="panel">look-panel</div>}
      />,
    )

    expect(screen.getByTestId('panel').parentElement).toHaveClass(
      'max-h-[24vh]',
    )

    rerender(
      <MobileModeDock
        mode="tone"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        onOpenMore={vi.fn()}
        canExport
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )

    // Tone locks to a fixed height (`h-[...]`, not `max-h`) so the panel can
    // run its own flex-column internal scroll — chrome stays put while the
    // slider list scrolls inside `[data-adjust-list-scroll]`.
    expect(screen.getByTestId('panel').parentElement).toHaveClass(
      'h-[min(38vh,264px)]',
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
        canExport
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
        canExport
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const panelFrame = screen.getByTestId('panel').parentElement
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
        canExport
        panel={<div data-testid="panel">tone-panel</div>}
      />,
    )
    const scrubbingPanelFrame = screen.getByTestId('panel').parentElement
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
        canExport
        panel={<div data-testid="panel">look-panel</div>}
      />,
    )

    const panelFrame = screen.getByTestId('panel').parentElement
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
        canExport
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
        canExport
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
      canExport: true,
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
})

describe('mobileModeDock stage inset', () => {
  it('reports tab bar height plus the expanded panel height, and drops the panel when collapsed', () => {
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
    try {
      const onInsetChange = vi.fn()
      const { rerender, container } = render(
        <MobileModeDock
          mode="tone"
          expanded
          onModeChange={vi.fn()}
          onCollapse={vi.fn()}
          onOpenMore={vi.fn()}
          canExport
          onInsetChange={onInsetChange}
          panel={<div>tone-panel</div>}
        />,
      )
      const dock = container.querySelector('[data-mobile-dock]')!
      const panel = container.querySelector('[data-mobile-dock-panel]')!
      heights.set(dock, 70)
      heights.set(panel, 264)
      act(() => {
        for (const o of observers) o.cb([], {} as ResizeObserver)
      })
      expect(onInsetChange).toHaveBeenLastCalledWith(334)

      rerender(
        <MobileModeDock
          mode="tone"
          expanded={false}
          onModeChange={vi.fn()}
          onCollapse={vi.fn()}
          onOpenMore={vi.fn()}
          canExport
          onInsetChange={onInsetChange}
          panel={<div>tone-panel</div>}
        />,
      )
      expect(onInsetChange).toHaveBeenLastCalledWith(70)
    } finally {
      vi.unstubAllGlobals()
      if (offsetHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetHeight',
          offsetHeight,
        )
      }
    }
  })
})
