import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { createBlobOutputResult } from '~/lib/export/output-sink'

import type { ExportResult } from '../../model/export-result'
import { ExportTool } from './ExportTool'

type ExportToolProps = Parameters<typeof ExportTool>[0] & {
  canPreviewExport?: boolean
  previewExportDisabledReason?: string
  onPreviewExport?: () => void | Promise<void>
}

function createResult(overrides: Partial<ExportResult> = {}): ExportResult {
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

  return {
    output: createBlobOutputResult({
      blob,
      filename: 'frame_neutral_fullres.jpg',
    }),
    filename: 'frame_neutral_fullres.jpg',
    width: 6048,
    height: 4024,
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

function createCheckpointManifest(): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-1',
    sourceFingerprint: {
      name: 'frame.RAF',
      size: 3,
      lastModified: 123,
      hashPrefixHex: 'abc',
    },
    fileName: 'frame.RAF',
    sourceSize: 3,
    sourceLastModified: 123,
    outputWidth: 11662,
    outputHeight: 8746,
    graphFingerprint: 'graph-1',
    profile: 'ios-safe',
    attempt: 1,
    preferredRows: 64,
    totalRows: 8746,
    recoveryMode: 'safe-retry',
    outputSink: 'opfs-file',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 64,
    jpegState: 'restart-required',
    updatedAt: '2026-05-01T00:00:00.000Z',
  }
}

describe('exportTool', () => {
  it('starts export from the ready-to-process state', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()

    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={onExport}
        exportResult={null}
        exportShareCapability={{ available: false, reason: 'Export first.' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: /export full-resolution jpeg/i,
      }),
    )

    expect(onExport).toHaveBeenCalledWith({
      quality: 'high',
      fidelity: 'balanced',
    })
    expect(
      screen.getByRole('button', { name: /export full-resolution jpeg/i }),
    ).toBeEnabled()
    expect(
      screen.queryByText(/full-resolution processed-window path/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Export' })).toBeNull()
  })

  it('keeps full-resolution primary and exposes HQ preview export as a secondary fallback', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onPreviewExport = vi.fn()

    const props: ExportToolProps = {
      canExport: false,
      disabledReason:
        'This browser cannot safely complete this large local full-resolution export without durable file storage.',
      canPreviewExport: true,
      isProcessing: false,
      onExport,
      onPreviewExport,
      exportResult: null,
      exportShareCapability: { available: false, reason: 'Export first.' },
      onShareExport: vi.fn(),
      onDownloadExport: vi.fn(),
      onCopyExport: vi.fn(),
    }

    render(<ExportTool {...props} />)

    expect(
      screen.getByRole('button', {
        name: /export full-resolution jpeg/i,
      }),
    ).toBeDisabled()
    expect(
      screen.getByText(/large local full-resolution export/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/smaller 8-12mp preview-rendered jpeg/i),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: /export hq preview jpeg/i,
      }),
    )

    expect(onPreviewExport).toHaveBeenCalledTimes(1)
    expect(onExport).not.toHaveBeenCalled()
  })

  it('labels a completed HQ preview JPEG result without implying full-resolution output', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult({
          kind: 'hq-preview',
          filename: 'frame_neutral_hq-preview.jpg',
          width: 4000,
          height: 3000,
          copyCapability: {
            mode: 'hq-preview',
            label: 'Copy HQ preview image',
          },
        })}
        exportShareCapability={{ available: true }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    expect(screen.getByText('HQ preview JPEG ready')).toBeInTheDocument()
    expect(screen.getByText('frame_neutral_hq-preview.jpg')).toBeInTheDocument()
    expect(screen.getByText('4000 x 3000')).toBeInTheDocument()
    expect(
      screen.queryByText(/Use full-resolution export for archival output/i),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy HQ preview image' }),
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Copy full-resolution image' }),
    ).toBeNull()
  })

  it('renders ready result actions without reusing the export button as download', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onShareExport = vi.fn()
    const onDownloadExport = vi.fn()
    const onCopyExport = vi.fn()

    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={onExport}
        exportResult={createResult()}
        exportShareCapability={{ available: true }}
        onShareExport={onShareExport}
        onDownloadExport={onDownloadExport}
        onCopyExport={onCopyExport}
      />,
    )

    expect(screen.getByText('JPEG ready')).toBeInTheDocument()
    const filename = screen.getByText('frame_neutral_fullres.jpg')
    expect(filename).toBeInTheDocument()
    expect(filename).toHaveAttribute('title', 'frame_neutral_fullres.jpg')
    expect(filename).toHaveClass('min-w-0', 'truncate')
    expect(screen.getByText('6048 x 4024')).toBeInTheDocument()
    expect(screen.getByText('4 B')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy preview-size image' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/cannot copy full-resolution JPEG files/i),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await user.click(
      screen.getByRole('button', { name: 'Copy preview-size image' }),
    )

    expect(onShareExport).toHaveBeenCalledTimes(1)
    expect(onDownloadExport).toHaveBeenCalledTimes(1)
    expect(onCopyExport).toHaveBeenCalledTimes(1)
    expect(onExport).not.toHaveBeenCalled()
  })

  it('offers the manifest download only once a sealed manifest is attached', async () => {
    const user = userEvent.setup()
    const onDownloadExportManifest = vi.fn()
    const manifest = {
      manifest_version: 1,
      kind: 'export',
      manifest_sha256: 'c'.repeat(64),
    } as unknown as RenderManifest

    const { rerender } = render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult()}
        exportShareCapability={{ available: true }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onDownloadExportManifest={onDownloadExportManifest}
        onCopyExport={vi.fn()}
      />,
    )

    expect(
      screen.queryByRole('button', { name: /manifest/i }),
    ).not.toBeInTheDocument()

    rerender(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult({
          manifest,
          manifestState: { status: 'ready' },
        })}
        exportShareCapability={{ available: true }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onDownloadExportManifest={onDownloadExportManifest}
        onCopyExport={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: /manifest/i })
    expect(button).toHaveAttribute('title', 'Download render manifest (JSON)')
    await user.click(button)

    expect(onDownloadExportManifest).toHaveBeenCalledTimes(1)
  })

  it('reserves the manifest slot while sealing and explains why it is unavailable', () => {
    const { rerender } = render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult({ manifestState: { status: 'sealing' } })}
        exportShareCapability={{ available: true }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onDownloadExportManifest={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    const sealing = screen.getByRole('button', { name: /manifest/i })
    expect(sealing).toBeDisabled()
    expect(sealing).toHaveAttribute('title', 'Sealing the render manifest')

    rerender(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult({
          manifestState: { status: 'unavailable', reason: 'lut-unconfirmed' },
        })}
        exportShareCapability={{ available: true }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onDownloadExportManifest={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    const unavailable = screen.getByRole('button', { name: /manifest/i })
    expect(unavailable).toBeDisabled()
    expect(unavailable).toHaveAttribute(
      'title',
      'Manifest unavailable: confirm the LUT color contract first.',
    )
  })

  it('keeps download available when share is unsupported', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={createResult()}
        exportShareCapability={{
          available: false,
          reason: 'This browser cannot share JPEG files.',
        }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled()
    expect(
      screen.queryByText('This browser cannot share JPEG files.'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
  })

  it('shows low-memory and non-durable checkpoint copy for ios-safe export', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: 'Export first.' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
        activePlan={{
          profileName: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
        }}
        checkpointDurable={false}
        recovery={{ status: 'none' }}
      />,
    )

    expect(screen.getByText(/low-memory export mode/i)).toBeInTheDocument()
    expect(
      screen.getByText(/cannot store export progress/i),
    ).toBeInTheDocument()
  })

  it('shows low-memory and non-durable checkpoint copy for mobile-balanced export', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: 'Export first.' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
        activePlan={{
          profileName: 'mobile-balanced',
          preferredRows: 256,
          concurrency: 2,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'streaming',
          checkpointMode: 'safe-retry',
        }}
        checkpointDurable={false}
        recovery={{ status: 'none' }}
      />,
    )

    expect(screen.getByText(/low-memory export mode/i)).toBeInTheDocument()
    expect(
      screen.getByText(/cannot store export progress/i),
    ).toBeInTheDocument()
  })

  it('shows recovery source reselect action', async () => {
    const user = userEvent.setup()
    const onRecoverExportSource = vi.fn()

    render(
      <ExportTool
        canExport={false}
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reason: 'Export first.' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
        onRecoverExportSource={onRecoverExportSource}
        recovery={{
          status: 'source-required',
          exportId: 'export-1',
          expectedFileName: 'frame.RAF',
          manifest: createCheckpointManifest(),
          message:
            'The browser interrupted the previous export. Please reselect the same RAW file so LumaForge can retry with a safer setting.',
        }}
      />,
    )

    expect(screen.getByText(/reselect the same RAW file/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Reselect RAW and retry' }),
    )

    expect(onRecoverExportSource).toHaveBeenCalledTimes(1)
  })
})
