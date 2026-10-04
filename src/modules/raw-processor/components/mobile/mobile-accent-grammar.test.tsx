import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MobileExportPanel } from './MobileExportPanel'
import { MobileLookPanel } from './MobileLookPanel'

// DESIGN.md §6: Lab Green marks ready / focus / committed, amber explains
// colour contracts, and structural selection or hover uses the cool Lift Wash
// Ladder. These surfaces carry no contract state, so they carry no amber.

const lutBrowser = {
  currentLutName: null,
  disabled: false,
  onLutLoad: vi.fn(),
  onLutClear: vi.fn(),
  lutProfileSelection: null,
  lutProfileResolution: null,
  onLutProfileSelect: vi.fn(),
  onlineLutSources: undefined,
}

describe('mobile accent grammar', () => {
  it('keeps Export actions on the cool lift, not amber hover', () => {
    const { container } = render(
      <MobileExportPanel
        canExport
        canPreviewExport
        onPreviewExport={vi.fn()}
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: '' }}
        recovery={{ status: 'source-required' } as never}
        onRecoverExportSource={vi.fn()}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )
    expect(container.innerHTML).not.toMatch(/amber/)
  })

  it('paints Add LUT and Change LUT as neutral actions', () => {
    const { container, getByRole, rerender } = render(
      <MobileLookPanel
        lutBrowser={lutBrowser}
        onOpenLutBrowser={vi.fn()}
        onOpenLutContractBrowser={vi.fn()}
      />,
    )
    expect(getByRole('button', { name: 'LUT browser' }).className).not.toMatch(
      /amber/,
    )
    expect(container.innerHTML).not.toMatch(/amber/)

    const displayLook = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }
    rerender(
      <MobileLookPanel
        lutBrowser={{
          ...lutBrowser,
          currentLutName: 'Film.cube',
          lutProfileResolution: {
            kind: 'confirmed',
            profile: displayLook,
            confidence: 'user',
          },
        }}
        onOpenLutBrowser={vi.fn()}
        onOpenLutContractBrowser={vi.fn()}
      />,
    )
    // A confirmed contract needs no explanation, so nothing here is amber.
    expect(container.innerHTML).not.toMatch(/amber/)
  })

  it('keeps amber on a LUT contract that still needs a choice', () => {
    const { container } = render(
      <MobileLookPanel
        lutBrowser={{
          ...lutBrowser,
          currentLutName: 'Film.cube',
          lutProfileResolution: { kind: 'unknown' },
        }}
        onOpenLutBrowser={vi.fn()}
        onOpenLutContractBrowser={vi.fn()}
      />,
    )
    expect(container.innerHTML).toMatch(/lf-amber/)
  })
})
