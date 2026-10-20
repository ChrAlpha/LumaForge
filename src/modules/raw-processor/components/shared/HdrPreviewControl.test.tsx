import { generateIdentityLUT } from '@lumaforge/luma-color-runtime'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { setHdrExport } from '../../state/export-options.atoms'
import {
  setHdrPreviewChoice,
  setPreviewExtendedRange,
} from '../../state/hdr-preview.atoms'
import {
  DEFAULT_COLOR_INTENT,
  setLut,
  setProcessingParams,
} from '../../state/workflow.atoms'
import { resetToDefaults } from '../../test-support/workflow-store'
import { HdrPreviewControl } from './HdrPreviewControl'

const SDR_HINT =
  'Full resolution only. HDR screens show highlights up to 1000 nits; other viewers and this preview show the SDR picture.'
const ABOVE_SDR_HINT =
  'Gray is at or below SDR white; amber to magenta rises toward the 1000-nit peak.'
const AVAILABLE = { available: true, reason: null } as const

function renderControl(
  props: Partial<Parameters<typeof HdrPreviewControl>[0]> = {},
) {
  onTestFinished(resetToDefaults)
  setHdrExport(true)
  return render(
    <HdrPreviewControl
      density="pointer"
      hasImage
      availability={AVAILABLE}
      hintId="hdr-hint"
      hintClassName=""
      {...props}
    />,
  )
}

function pressed() {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent)
}

describe('hdrPreviewControl', () => {
  it('offers the views any screen shows, opens on SDR, and says what each one shows', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderControl({ onSelect })

    const group = screen.getByRole('group', { name: 'HDR preview' })
    expect(group).toHaveAccessibleDescription(SDR_HINT)
    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['SDR', 'Above SDR', 'Stop down'])
    expect(pressed()).toEqual(['SDR'])

    await user.click(screen.getByRole('button', { name: 'Above SDR' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('above-sdr')

    act(() => setHdrPreviewChoice('above-sdr'))
    expect(pressed()).toEqual(['Above SDR'])
    expect(group).toHaveAccessibleDescription(ABOVE_SDR_HINT)
  })

  it('opens on the HDR picture where the canvas and the screen show it', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(dynamic-range: high)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    setPreviewExtendedRange(true)
    renderControl()

    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['HDR', 'SDR', 'Above SDR', 'Stop down'])
    expect(pressed()).toEqual(['HDR'])
  })

  it('shows SDR as drawn while the policy refuses the views, and names why', () => {
    setHdrPreviewChoice('stop-down')
    renderControl({
      availability: { available: false, reason: 'transform-hdr-preview' },
    })

    for (const button of screen.getAllByRole('button'))
      expect(button).toBeDisabled()
    expect(pressed()).toEqual(['SDR'])
    expect(screen.getByText(/^Full resolution only/)).toHaveTextContent(
      `${SDR_HINT} HDR preview views are unavailable while the Transform overlay is shown.`,
    )
  })

  it('offers no views without a photo or for a look with no HDR picture', () => {
    const { rerender } = renderControl({ hasImage: false })
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByText(SDR_HINT)).toBeVisible()

    act(() => {
      setProcessingParams({
        ...DEFAULT_COLOR_INTENT,
        styleKind: 'custom',
        intensity: 1,
      })
      setLut(generateIdentityLUT(2))
    })
    rerender(
      <HdrPreviewControl
        density="pointer"
        hasImage
        availability={AVAILABLE}
        hintId="hdr-hint"
        hintClassName=""
      />,
    )
    expect(screen.queryByRole('group')).toBeNull()
  })
})
