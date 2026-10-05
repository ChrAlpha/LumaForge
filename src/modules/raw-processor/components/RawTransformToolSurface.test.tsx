import {
  cleanup,
  render as renderWithRoot,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { viewportAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'

import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../state/tool-card.atoms'
import { COLOR_NEUTRAL } from './color-fields'
import { RawToolSurface } from './RawToolSurface'
import type { RawToolSurfaceProps } from './RawWorkflowContext'
import { TONE_NEUTRAL } from './tone-fields'
import { transformFeatureFixture } from './tools/transform-feature.fixture'

function render(ui: ReactNode) {
  return renderWithRoot(ui, {
    wrapper: ({ children }) => (
      <Provider store={jotaiStore}>{children}</Provider>
    ),
  })
}

const base: RawToolSurfaceProps = {
  activeIntensity: 0.7,
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
  onIntensityChange: vi.fn(),
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onColorChange: vi.fn(),
  onColorReset: vi.fn(),
  onSelectiveColorChange: vi.fn(),
  onSelectiveColorReset: vi.fn(),
  onCompareReset: vi.fn(),
  viewMode: 'processed',
  onViewModeChange: vi.fn(),
  compareSplit: 0.5,
  onCompareSplitChange: vi.fn(),
  fileName: 'photo.NEF',
  onReplaceFile: vi.fn(),
  onResetSession: vi.fn(),
  onLutLoad: vi.fn(),
  onLutClear: vi.fn(),
  onLutProfileSelect: vi.fn(),
  onExport: vi.fn(),
  canExport: false,
  isProcessing: false,
  exportResult: null,
  exportShareCapability: {
    available: false,
    reason: 'Export a JPEG before sharing.',
  },
  histogram: { state: 'unavailable', reason: 'no-image' },
  onShareExport: vi.fn(),
  onDownloadExport: vi.fn(),
  onCopyExport: vi.fn(),
  hasImage: true,
  supportLevel: 'official',
  metadata: null,
  stats: null,
}

describe('raw Transform tool surfaces', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
    jotaiStore.set(viewportAtom, {
      ...jotaiStore.get(viewportAtom),
      w: 1280,
      h: 800,
    })
    jotaiStore.set(toolCardOpenAtom, [])
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS)
  })

  it('shows the desktop entry before a photo is loaded and captures only when it opens', async () => {
    const transform = transformFeatureFixture()
    render(<RawToolSurface {...base} hasImage={false} transform={transform} />)
    expect(transform.observe).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Transform' }))
    expect(
      screen.getByText('Open a RAW photo to adjust its perspective.'),
    ).toBeInTheDocument()
    expect(transform.observe).toHaveBeenCalledOnce()
    expect(transform.demo.loadSource).not.toHaveBeenCalled()
  })

  it('disables desktop Compare reset when Transform is active', async () => {
    render(
      <RawToolSurface
        {...base}
        transform={transformFeatureFixture({ active: true, hasImage: true })}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(
      screen.getByRole('button', { name: 'Reset compare view' }),
    ).toBeDisabled()
  })

  it('keeps prior surfaces valid without an optional Transform feature', () => {
    render(<RawToolSurface {...base} />)
    expect(screen.queryByRole('button', { name: 'Transform' })).toBeNull()
  })

  it('brings the three mobile tools in with the RAW photo, not before', () => {
    jotaiStore.set(viewportAtom, {
      ...jotaiStore.get(viewportAtom),
      w: 390,
      sm: false,
    })
    const { rerender } = render(
      <RawToolSurface
        {...base}
        hasImage={false}
        transform={transformFeatureFixture()}
      />,
    )
    // Nothing for a tool to act on yet: no dock, not a row of disabled tabs.
    expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()

    rerender(
      <RawToolSurface
        {...base}
        transform={transformFeatureFixture({ hasImage: true })}
      />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(
      within(dock)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Look', 'Adjust', 'Transform'])
  })

  it('opens Transform inside the mobile dock and releases observation when switching tools', async () => {
    jotaiStore.set(viewportAtom, {
      ...jotaiStore.get(viewportAtom),
      w: 390,
      sm: false,
    })
    const stop = vi.fn()
    const transform = transformFeatureFixture({
      hasImage: true,
      observe: vi.fn(() => stop),
    })
    const { container } = render(
      <RawToolSurface {...base} transform={transform} />,
    )
    expect(transform.observe).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', { name: 'Transform' }))
    expect(
      container.querySelector('[data-mobile-transform-panel]'),
    ).toHaveClass('h-full', 'flex-col')
    expect(container.querySelector('[data-transform-list-scroll]')).toHaveClass(
      'min-h-0',
      'overflow-y-auto',
    )
    // Transform is a list tool: it fills the deck the stage layout sizes.
    expect(container.querySelector('[data-mobile-dock-panel]')).toHaveAttribute(
      'data-deck-fill',
      'true',
    )
    expect(transform.observe).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Reset Upright' })).toBeDisabled()
    await userEvent.click(screen.getByRole('tab', { name: 'Look' }))
    expect(stop).toHaveBeenCalledOnce()
    expect(transform.reset).not.toHaveBeenCalled()
    expect(transform.demo.loadSource).not.toHaveBeenCalled()
  })

  it('keeps the open tool when Transform becomes active and after reset', async () => {
    jotaiStore.set(viewportAtom, {
      ...jotaiStore.get(viewportAtom),
      w: 390,
      sm: false,
    })
    const transform = transformFeatureFixture({ hasImage: true })
    const { rerender } = render(
      <RawToolSurface {...base} transform={transform} />,
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Adjust' }))
    // Compare is a stage lens now, so Transform no longer has a Compare tab
    // to evict: the open tool stays put either way.
    expect(screen.queryByRole('tab', { name: 'Compare' })).toBeNull()
    rerender(
      <RawToolSurface {...base} transform={{ ...transform, active: true }} />,
    )
    expect(screen.getByRole('tab', { name: 'Adjust' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    rerender(<RawToolSurface {...base} transform={transform} />)
    expect(screen.getByRole('tab', { name: 'Adjust' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
