import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CpuPreviewBanner } from '../components/CpuPreviewBanner'
import { MobileEmptyState } from '../components/mobile/MobileEmptyState'
import { MobileExportAction } from '../components/mobile/MobileExportAction'
import { MobileExportPanel } from '../components/mobile/MobileExportPanel'
import { MobileLookDeck } from '../components/mobile/MobileLookDeck'
import { MobileModeDock } from '../components/mobile/MobileModeDock'

// The one guard on the RAW Lab colour grammar (DESIGN.md): Lab Green marks
// ready / focus / committed, amber explains a colour contract, rose is for
// destructive actions only, structural lifts stay on the cool Lift Wash
// Ladder, and no neutral is pure black or white. Component tests assert
// behaviour; the colours are held here, once.

const RAW_ROOT = resolve(process.cwd(), 'src/modules/raw-processor')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (/\.test\.|\.fixture\./.test(entry.name)) return []
    return /\.(?:tsx?|css)$/.test(entry.name) ? [path] : []
  })
}

const chromeSources = [
  ...sourceFiles(join(RAW_ROOT, 'components')),
  join(RAW_ROOT, 'RawProcessorView.tsx'),
  join(RAW_ROOT, 'raw-lab.css'),
  join(RAW_ROOT, 'raw-lab.surface.css'),
  join(RAW_ROOT, 'raw-lab.effects.css'),
].map((path) => ({
  file: relative(RAW_ROOT, path),
  source: readFileSync(path, 'utf8'),
}))

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

function exportPanel(
  overrides: Partial<ComponentProps<typeof MobileExportPanel>> = {},
) {
  return (
    <MobileExportPanel
      canExport
      canPreviewExport
      onPreviewExport={vi.fn()}
      isProcessing={false}
      onExport={vi.fn()}
      exportResult={null}
      exportShareCapability={{ available: false, reasonCode: 'no-result' }}
      onShareExport={vi.fn()}
      onDownloadExport={vi.fn()}
      onCopyExport={vi.fn()}
      {...overrides}
    />
  )
}

function exportPill(state: ComponentProps<typeof MobileExportAction>['state']) {
  render(
    <MobileExportAction state={state} expanded={false} onClick={vi.fn()} />,
  )
  const pill = screen.getByRole('button').outerHTML
  cleanup()
  return pill
}

describe('raw lab accent grammar', () => {
  beforeEach(() => {
    // The Look deck's Strength slider (Radix) measures its thumb.
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps Export actions on the cool lift, not amber hover', () => {
    const { container } = render(
      exportPanel({ interruptionNote: { kind: 'interrupted' } }),
    )
    expect(container.innerHTML).not.toMatch(/amber/)
  })

  it('explains a contract block in amber and any other block neutral, never rose', () => {
    const blocked = {
      canExport: false,
      disabledReason: {
        source: 'workflow' as const,
        reason: { code: 'lut-input-unconfirmed' as const },
      },
    }
    const { container, rerender } = render(
      exportPanel({ ...blocked, onChooseLutContract: vi.fn() }),
    )
    const reason = () =>
      container.querySelector('[data-export-unavailable-reason]')!.outerHTML
    expect(reason()).toMatch(/lf-amber/)
    expect(container.innerHTML).not.toMatch(/lf-rose/)

    // Without the route into the contract, the block is not its to paint.
    rerender(exportPanel(blocked))
    expect(reason()).not.toMatch(/amber|lf-rose/)
  })

  it('gives Lab Green to a full-resolution export only', () => {
    expect(exportPill('ready')).toMatch(/bg-lf-green\b(?!-)/)
    expect(exportPill('done')).toMatch(/bg-lf-green-deep/)
    // Blocked, and the bounded HQ preview compromise, stay on the lift;
    // green is left only to the focus ring.
    expect(exportPill('idle')).not.toMatch(/bg-lf-green/)
    expect(exportPill('preview-done')).not.toMatch(/bg-lf-green/)
  })

  it('lights the engine readiness dot Lab Green only once the engine is ready', () => {
    for (const state of ['ready', 'pending', 'idle', 'failed'] as const) {
      const { container } = render(
        <MobileEmptyState
          runtimeReadinessState={state}
          onReplaceFile={vi.fn()}
          onPrepareRuntime={vi.fn()}
        />,
      )
      const dot = container.querySelector('[data-mobile-empty-readiness-dot]')!
      if (state === 'ready') expect(dot.outerHTML).toMatch(/bg-lf-green/)
      else expect(dot.outerHTML, state).not.toMatch(/lf-green/)
      cleanup()
    }
  })

  it('states a degraded CPU preview in neutral ink, not as a colour contract', () => {
    const { container } = render(
      <CpuPreviewBanner
        reason="webgpu-unavailable"
        density="compact"
        onDismiss={vi.fn()}
      />,
    )
    expect(container.innerHTML).not.toMatch(/amber|color-progress/)
  })

  it('keeps amber and readiness green off the mode tabs', () => {
    render(
      <MobileModeDock
        mode="look"
        expanded
        onModeChange={vi.fn()}
        onCollapse={vi.fn()}
        panel={<div>x</div>}
      />,
    )
    // Readiness lives on the export action, never on a tool tab.
    expect(screen.getByRole('tablist').innerHTML).not.toMatch(/amber|lf-green/)
  })

  it('keeps the Look deck neutral without a LUT and with a confirmed contract', () => {
    const { container, getByRole, rerender } = render(
      <MobileLookDeck
        look={lutBrowser}
        onOpenSources={vi.fn()}
        view="strip"
        onViewChange={vi.fn()}
      />,
    )
    expect(getByRole('button', { name: /lut sources/i }).className).not.toMatch(
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
      <MobileLookDeck
        look={{
          ...lutBrowser,
          currentLutName: 'Film.cube',
          lutProfileResolution: {
            kind: 'confirmed',
            profile: displayLook,
            confidence: 'user',
          },
        }}
        onOpenSources={vi.fn()}
        view="strip"
        onViewChange={vi.fn()}
      />,
    )
    // A confirmed contract needs no explanation, so nothing here is amber.
    expect(container.innerHTML).not.toMatch(/amber/)
  })

  it('keeps amber on a LUT contract that still needs a choice', () => {
    const { container } = render(
      <MobileLookDeck
        look={{
          ...lutBrowser,
          currentLutName: 'Film.cube',
          lutProfileResolution: { kind: 'unknown' },
        }}
        onOpenSources={vi.fn()}
        view="strip"
        onViewChange={vi.fn()}
      />,
    )
    expect(container.innerHTML).toMatch(/lf-amber/)
  })

  it('gives rose to the reset actions only, and only on hover or focus before the confirmation', () => {
    const roseFiles = chromeSources.filter(({ source }) =>
      source.includes('lf-rose'),
    )
    expect(roseFiles.map(({ file }) => file).sort()).toEqual([
      'components/RawResetConfirmationDialog.tsx',
      'components/WorkspaceHeader.tsx',
      'components/mobile/MobileMoreMenu.tsx',
    ])
    for (const { file, source } of roseFiles) {
      if (file.endsWith('RawResetConfirmationDialog.tsx')) continue
      for (const token of source.match(/\S*lf-rose\S*/g) ?? []) {
        expect(token, file).toMatch(/(hover|focus-visible):/)
      }
    }
  })

  it('keeps pure black and white out of the chrome', () => {
    for (const { file, source } of chromeSources) {
      expect(source, file).not.toMatch(
        /\b(bg|text|border|ring|outline|from|via|to|fill|stroke|shadow)-(black|white)\b/,
      )
      // Mask gradients may use #000 as alpha; a painted colour may not.
      expect(source, file).not.toMatch(
        /\b(color|background(-color)?|border(-color)?|fill|stroke)\s*:\s*(#000|#fff|black|white)\b/i,
      )
    }
  })

  it('never lifts a structure from the warm hero ink', () => {
    for (const { file, source } of chromeSources) {
      expect(source, file).not.toMatch(/oklch\(from var\(--color-lf-hero-ink\)/)
    }
  })
})
