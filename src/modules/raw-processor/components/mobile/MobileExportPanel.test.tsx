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

  it('omits secondary HQ preview helper copy while the preview export is not ready', () => {
    renderPanel({
      canPreviewExport: false,
      previewExportDisabledReason:
        'HQ preview export is available after the bounded HQ preview finishes.',
    })

    expect(
      screen.getByRole('button', { name: /export hq preview jpeg/i }),
    ).toBeDisabled()
    expect(
      screen.queryByText(/hq preview export is available after/i),
    ).not.toBeInTheDocument()
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
})
