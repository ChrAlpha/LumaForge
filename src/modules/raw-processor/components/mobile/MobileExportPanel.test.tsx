import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createBlobOutputResult } from '~/lib/export/output-sink'

import type { ExportResult } from '../../model/export-result'
import { MobileExportPanel } from './MobileExportPanel'

type MobileExportPanelProps = Parameters<typeof MobileExportPanel>[0] & {
  canPreviewExport?: boolean
  previewExportDisabledReason?: string
  onPreviewExport?: () => void | Promise<void>
}

function renderPanel(overrides: Partial<MobileExportPanelProps> = {}) {
  render(
    <MobileExportPanel
      canExport
      isProcessing={false}
      onExport={vi.fn()}
      exportResult={null}
      exportShareCapability={{
        available: false,
        reason: 'Export a JPEG before sharing.',
      }}
      recovery={{ status: 'none' }}
      onShareExport={vi.fn()}
      onDownloadExport={vi.fn()}
      onCopyExport={vi.fn()}
      {...overrides}
    />,
  )
}

function createResult(overrides: Partial<ExportResult> = {}): ExportResult {
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

  return {
    kind: 'hq-preview',
    output: createBlobOutputResult({
      blob,
      filename: 'frame_neutral_hq-preview.jpg',
    }),
    filename: 'frame_neutral_hq-preview.jpg',
    width: 4000,
    height: 3000,
    size: blob.size,
    createdAt: 123,
    copyCapability: {
      mode: 'preview-size',
      label: 'Copy preview-size image',
      reason: 'This browser cannot copy full-resolution JPEG files.',
    },
    ...overrides,
  }
}

describe('mobileExportPanel', () => {
  it('recaps what the export will write before the export button', () => {
    renderPanel({
      recap: {
        size: { width: 9728, height: 6656 },
        look: { name: 'ARRI 3110 Film A', strength: 'standard', percent: 70 },
        adjustments: 3,
        transformApplied: true,
      },
    })
    const recap = document.querySelector<HTMLElement>('[data-export-recap]')!
    expect(recap).toHaveTextContent('Full-resolution JPEG · 9728×6656')
    expect(recap).toHaveTextContent(
      'Look: ARRI 3110 Film A · 70% · 3 adjustments · Transform applied',
    )
    // Quiet: body ink at the 68 step, small, tabular.
    expect(recap).toHaveClass(
      'text-[0.72rem]',
      'text-lf-on-photo-ink/68',
      'tabular-nums',
    )
    // It sits before the primary action.
    const run = screen.getByRole('button', {
      name: 'Export full-resolution JPEG',
    })
    expect(
      recap.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('never states what is not in state', () => {
    renderPanel({
      recap: {
        size: null,
        look: null,
        adjustments: 0,
        transformApplied: false,
      },
    })
    const recap = document.querySelector<HTMLElement>('[data-export-recap]')!
    // No size known: none claimed. No LUT, no adjustments, no Transform.
    expect(recap.textContent).toBe('Full-resolution JPEGNo LUT')
    expect(recap).not.toHaveTextContent(/×|adjustment|Transform/)
  })

  it('names one adjustment in the singular and an Off strength in words', () => {
    renderPanel({
      recap: {
        size: null,
        look: { name: 'Kodak 2383', strength: 'off', percent: 0 },
        adjustments: 1,
        transformApplied: false,
      },
    })
    expect(document.querySelector('[data-export-recap]')).toHaveTextContent(
      'Look: Kodak 2383 · Off · 1 adjustment',
    )
  })

  it('keeps full-resolution export primary and shows HQ preview export as secondary', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onPreviewExport = vi.fn()

    renderPanel({
      canExport: true,
      canPreviewExport: true,
      onExport,
      onPreviewExport,
    })

    const fullResolutionButton = screen.getByRole('button', {
      name: /export full-resolution jpeg/i,
    })
    const previewButton = screen.getByRole('button', {
      name: /export hq preview jpeg/i,
    })

    // Stacked full-width on the narrow mobile sheet so the shared descriptive
    // labels render on one line instead of wrapping inside half-width columns.
    const exportRow = fullResolutionButton.parentElement
    expect(exportRow).toHaveClass('grid')
    expect(exportRow).not.toHaveClass('grid-cols-2')
    expect(exportRow?.firstElementChild).toBe(fullResolutionButton)
    expect(fullResolutionButton).toHaveClass('bg-lf-green')
    expect(previewButton).not.toHaveClass('bg-lf-green')

    await user.click(fullResolutionButton)
    await user.click(previewButton)

    expect(onExport).toHaveBeenCalledWith({
      quality: 'high',
      fidelity: 'balanced',
    })
    expect(onPreviewExport).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(/smaller 8-12mp preview-rendered jpeg/i),
    ).not.toBeInTheDocument()
  })

  it('names why the HQ preview export is disabled under the button', () => {
    const reason =
      'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.'
    renderPanel({
      canPreviewExport: false,
      previewExportDisabledReason: reason,
      onPreviewExport: vi.fn(),
    })

    const previewButton = screen.getByRole('button', {
      name: /export hq preview jpeg/i,
    })
    expect(previewButton).toBeDisabled()
    const note = screen.getByText(reason)
    expect(previewButton).toHaveAttribute('aria-describedby', note.id)
    expect(previewButton.nextElementSibling).toBe(note)
  })

  it('does not repeat an HQ reason the full-resolution box already states', () => {
    const reason = 'Loading export source'
    renderPanel({
      canExport: false,
      disabledReason: reason,
      canPreviewExport: false,
      previewExportDisabledReason: reason,
      onPreviewExport: vi.fn(),
    })

    expect(screen.getAllByText(reason)).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: /export hq preview jpeg/i }),
    ).not.toHaveAttribute('aria-describedby')
  })

  it('explains a blocked full-resolution export in a neutral well, not destructive rose', () => {
    const { container } = render(
      <MobileExportPanel
        canExport={false}
        disabledReason="The LUT contract is not confirmed."
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: '' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    const box = container.querySelector('[data-export-unavailable-reason]')!
    expect(box).toHaveTextContent('The LUT contract is not confirmed.')
    expect(box).toHaveClass('bg-[oklch(0.96_0.006_255/0.05)]')
    expect(box.outerHTML).not.toMatch(/lf-rose/)
    expect(box.querySelector('svg')).not.toBeNull()
  })

  it('does not show a blocked export error while export progress is already visible', () => {
    renderPanel({
      canExport: false,
      disabledReason: 'Full-resolution export is already running.',
      isProcessing: true,
    })

    expect(
      screen.getByRole('button', { name: /preparing jpeg/i }),
    ).toBeDisabled()
    expect(screen.queryByText(/color contract failed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/already running/i)).not.toBeInTheDocument()
  })

  it('keeps the ready result compact without secondary helper copy', () => {
    renderPanel({
      exportResult: createResult(),
      exportShareCapability: {
        available: false,
        reason: 'Export a JPEG before sharing.',
      },
    })

    expect(screen.getByText('HQ preview JPEG ready')).toBeInTheDocument()
    expect(screen.getByText('4000 x 3000 · 4 B')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /copy preview-size image/i }),
    ).toBeEnabled()
    expect(
      screen.queryByText(/use full-resolution export for archival output/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/export a jpeg before sharing/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/cannot copy full-resolution jpeg files/i),
    ).not.toBeInTheDocument()
  })
  it('names the delivered file in the full-resolution ready title', () => {
    renderPanel({
      exportResult: createResult({
        kind: 'full-resolution',
        filename: 'DSC09142.jpg',
      }),
    })

    expect(
      screen.getByRole('heading', { name: 'DSC09142.jpg ready' }),
    ).toBeInTheDocument()
  })

  it('adds a manifest action to the ready result when a manifest is attached', async () => {
    const user = userEvent.setup()
    const onDownloadExportManifest = vi.fn()
    const manifest = {
      manifest_version: 1,
      kind: 'export',
      manifest_sha256: 'd'.repeat(64),
    } as unknown as RenderManifest

    renderPanel({
      exportResult: createResult({
        kind: 'full-resolution',
        manifest,
        manifestState: { status: 'ready' },
      }),
      onDownloadExportManifest,
    })

    const button = screen.getByRole('button', { name: /manifest/i })
    await user.click(button)

    expect(onDownloadExportManifest).toHaveBeenCalledTimes(1)
  })

  it('hides the manifest action while no manifest is attached', () => {
    renderPanel({
      exportResult: createResult(),
      onDownloadExportManifest: vi.fn(),
    })

    expect(
      screen.queryByRole('button', { name: /manifest/i }),
    ).not.toBeInTheDocument()
  })
  it('keeps a disabled manifest slot while the manifest is still sealing', () => {
    renderPanel({
      exportResult: createResult({
        kind: 'full-resolution',
        manifestState: { status: 'sealing' },
      }),
      onDownloadExportManifest: vi.fn(),
    })

    const button = screen.getByRole('button', {
      name: /sealing the render manifest/i,
    })
    expect(button).toBeDisabled()
  })
  it('titles the panel by export state in a labelled region', () => {
    const { unmount } = render(
      <MobileExportPanel
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: '' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )
    const region = screen.getByRole('region', { name: 'Export' })
    expect(region).toHaveAttribute('data-mobile-export-panel')
    unmount()

    renderPanel({ isProcessing: true, isExporting: true, progress: 41.6 })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Exporting42%',
    )
  })

  it('titles a finished export and keeps the result card naming the file', () => {
    renderPanel({
      exportResult: createResult({
        kind: 'full-resolution',
        filename: 'DSC09142.jpg',
      }),
    })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Exported' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'DSC09142.jpg ready' }),
    ).toBeInTheDocument()
  })

  it('closes from a 44px header button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderPanel({ onClose })
    const close = screen.getByRole('button', { name: 'Close export' })
    expect(close).toHaveClass('size-11')
    expect(close).toHaveClass('focus-visible:outline-lf-green/80')
    await user.click(close)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('omits the close button when nothing can take the deck back', () => {
    renderPanel()
    expect(
      screen.queryByRole('button', { name: 'Close export' }),
    ).not.toBeInTheDocument()
  })
})
