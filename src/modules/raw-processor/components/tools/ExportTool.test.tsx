import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { createBlobOutputResult } from '~/lib/export/output-sink'

import type { ExportResult } from '../../model/export-result'
import { ExportTool } from './ExportTool'

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
    ).toHaveClass('bg-[color:--color-raw-green]')
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
    expect(screen.getByText('frame_neutral_fullres.jpg')).toBeInTheDocument()
    expect(screen.getByText('6048 x 4024')).toBeInTheDocument()
    expect(screen.getByText('4 B')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy preview-size image' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share' })).toHaveClass(
      'bg-[color:--color-raw-green]',
    )
    expect(screen.getByRole('button', { name: 'Download' })).toHaveClass(
      'bg-[color:oklch(0.936_0.028_84)]',
    )

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
      screen.getByText('This browser cannot share JPEG files.'),
    ).toBeInTheDocument()
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
