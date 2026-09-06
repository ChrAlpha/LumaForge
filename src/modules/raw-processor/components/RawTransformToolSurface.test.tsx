import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const base: RawToolSurfaceProps = {
  activeIntensity: 'standard',
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
  onIntensitySelect: vi.fn(),
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Transform', exact: true }),
    )
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Compare', exact: true }),
    )
    expect(
      screen.getByRole('button', { name: 'Reset compare view' }),
    ).toBeDisabled()
  })

  it('keeps prior surfaces valid without an optional Transform feature', () => {
    render(<RawToolSurface {...base} />)
    expect(
      screen.queryByRole('button', { name: 'Transform', exact: true }),
    ).toBeNull()
  })
})
