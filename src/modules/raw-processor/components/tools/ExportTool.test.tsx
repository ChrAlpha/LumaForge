import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'

import type { ExportResult } from '../../model/export-result'
import { createMockExportResultIdentity } from '../../model/export-result.fixture'
import { setProgress } from '../../state/workflow.atoms'
import type { ExportInterruptionNote } from '../RawWorkflowContext'
import { ExportTool } from './ExportTool'

const INTERRUPTED_NOTE: ExportInterruptionNote = { kind: 'interrupted' }

const INTERRUPTED_HINT =
  'The previous export was interrupted. The next export you start uses the current RAW and adjustments with a safer setting.'

function buttonNames() {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
}

type ExportToolProps = ComponentProps<typeof ExportTool>

function createResult(overrides: Partial<ExportResult> = {}): ExportResult {
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
  const kind = overrides.kind ?? 'full-resolution'

  return {
    kind,
    identity: createMockExportResultIdentity({ resultKind: kind }),
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
      reasonCode: 'full-resolution-copy-unsupported',
    },
    ...overrides,
  }
}

describe('exportTool', () => {
  it('says why HQ preview is refused while full resolution stays available', () => {
    render(
      <ExportTool
        canExport
        canPreviewExport={false}
        previewExportDisabledReason={{
          source: 'surface',
          code: 'transform-hq-export',
        }}
        onPreviewExport={vi.fn()}
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: /export full-resolution jpeg/i }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /export hq preview jpeg/i }),
    ).toBeDisabled()
    // A disabled control with no reason is the state this whole panel exists
    // to avoid; the refusal has to be readable, not just encoded in opacity.
    expect(
      screen.getByText(
        'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.',
      ),
    ).toBeVisible()
  })

  it('does not repeat the full-resolution reason under the HQ preview button', () => {
    render(
      <ExportTool
        canExport={false}
        disabledReason={{ source: 'surface', code: 'no-source' }}
        canPreviewExport={false}
        previewExportDisabledReason={{ source: 'surface', code: 'no-source' }}
        onPreviewExport={vi.fn()}
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    expect(screen.getAllByText('No image loaded')).toHaveLength(1)
  })

  it('starts export from the ready-to-process state', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()

    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={onExport}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
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

    expect(onExport).toHaveBeenCalledExactlyOnceWith()
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
      disabledReason: {
        source: 'workflow',
        reason: { code: 'cannot-safely-complete' },
      },
      canPreviewExport: true,
      isProcessing: false,
      onExport,
      onPreviewExport,
      exportResult: null,
      exportShareCapability: { available: false, reasonCode: 'no-result' },
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
          reasonCode: 'share-unsupported',
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

  it('asks to keep the tab open for an ios-safe low-memory export without blaming the browser', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
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
      />,
    )

    expect(screen.getByText(/low-memory export mode/i)).toHaveTextContent(
      /keep the tab open while the jpeg is being written/i,
    )
    expect(
      screen.queryByText(/cannot store export progress/i),
    ).not.toBeInTheDocument()
  })

  it('asks to keep the tab open for a mobile-balanced low-memory export without blaming the browser', () => {
    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
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
      />,
    )

    expect(screen.getByText(/low-memory export mode/i)).toHaveTextContent(
      /keep the tab open while the jpeg is being written/i,
    )
    expect(
      screen.queryByText(/cannot store export progress/i),
    ).not.toBeInTheDocument()
  })

  it('presents an interrupted export as a hint for the next export the user starts', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const props: ExportToolProps = {
      canExport: false,
      isProcessing: false,
      onExport,
      exportResult: null,
      exportShareCapability: { available: false, reasonCode: 'no-result' },
      onShareExport: vi.fn(),
      onDownloadExport: vi.fn(),
      onCopyExport: vi.fn(),
      interruptionNote: INTERRUPTED_NOTE,
    }

    const { container, rerender } = render(<ExportTool {...props} />)

    expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
    // Nothing here promises the old settings, bytes or strips come back.
    expect(container).not.toHaveTextContent(/reselect|resum|restor|continu/i)
    // The hint is not an action: the panel still offers only its two exports.
    expect(buttonNames()).toEqual([
      'Export full-resolution JPEG',
      'Export HQ preview JPEG',
    ])

    // Readiness arriving starts nothing on its own.
    rerender(<ExportTool {...props} canExport />)
    expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
    expect(onExport).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: /export full-resolution jpeg/i }),
    )

    // The export command takes no choices.
    expect(onExport).toHaveBeenCalledExactlyOnceWith()
  })

  it('shows no interruption hint without one, or while an export is running', () => {
    const props: ExportToolProps = {
      canExport: true,
      isProcessing: false,
      onExport: vi.fn(),
      exportResult: null,
      exportShareCapability: { available: false, reasonCode: 'no-result' },
      onShareExport: vi.fn(),
      onDownloadExport: vi.fn(),
      onCopyExport: vi.fn(),
      interruptionNote: null,
    }
    const { rerender } = render(<ExportTool {...props} />)
    expect(screen.queryByText(INTERRUPTED_HINT)).toBeNull()

    rerender(
      <ExportTool
        {...props}
        isProcessing
        interruptionNote={INTERRUPTED_NOTE}
      />,
    )
    expect(screen.queryByText(INTERRUPTED_HINT)).toBeNull()
  })

  it('keeps the result actions of a finished export beside an interruption', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onShareExport = vi.fn()
    const onDownloadExport = vi.fn()
    const onDownloadExportManifest = vi.fn()
    const onCopyExport = vi.fn()

    render(
      <ExportTool
        canExport
        isProcessing={false}
        onExport={onExport}
        exportResult={createResult({ manifestState: { status: 'ready' } })}
        exportShareCapability={{ available: true }}
        onShareExport={onShareExport}
        onDownloadExport={onDownloadExport}
        onDownloadExportManifest={onDownloadExportManifest}
        onCopyExport={onCopyExport}
        interruptionNote={INTERRUPTED_NOTE}
      />,
    )

    expect(screen.getByText('JPEG ready')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: /manifest/i }))
    await user.click(
      screen.getByRole('button', { name: 'Copy preview-size image' }),
    )

    expect(onShareExport).toHaveBeenCalledOnce()
    expect(onDownloadExport).toHaveBeenCalledOnce()
    expect(onDownloadExportManifest).toHaveBeenCalledOnce()
    expect(onCopyExport).toHaveBeenCalledOnce()
    expect(onExport).not.toHaveBeenCalled()
  })
})

describe('exportTool reason copy', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  const idle: ExportToolProps = {
    canExport: false,
    canPreviewExport: false,
    onPreviewExport: vi.fn(),
    isProcessing: false,
    onExport: vi.fn(),
    exportResult: null,
    exportShareCapability: { available: false, reasonCode: 'no-result' },
    onShareExport: vi.fn(),
    onDownloadExport: vi.fn(),
    onCopyExport: vi.fn(),
  }

  function renderIn(locale: 'en' | 'zh-CN', props: Partial<ExportToolProps>) {
    localStorage.setItem('lumaforge.locale', locale)
    return render(<ExportTool {...idle} {...props} />, {
      wrapper: I18nProvider,
    })
  }

  it('states each refusal from its code in the current locale', () => {
    const { rerender } = renderIn('zh-CN', {
      disabledReason: {
        source: 'workflow',
        reason: { code: 'quick-preview-pending' },
      },
      previewExportDisabledReason: {
        source: 'workflow',
        reason: 'preview-released',
      },
    })
    expect(screen.getByText('快速预览还在准备中。')).toBeVisible()
    expect(
      screen.getByText('请先恢复预览，再导出 HQ 预览 JPEG。'),
    ).toBeVisible()

    // A Transform block is the surface policy's to name, in its own words.
    rerender(
      <ExportTool
        {...idle}
        disabledReason={{ source: 'surface', code: 'transform-pending' }}
        previewExportDisabledReason={{
          source: 'surface',
          code: 'transform-hq-export',
        }}
      />,
    )
    expect(screen.getByText('正在准备当前照片…')).toBeVisible()
    expect(
      screen.getByText(
        '按全分辨率导出可保留变换；若要导出 HQ 预览 JPEG，请先重置变换。',
      ),
    ).toBeVisible()
  })

  it('shows diagnostic text as it came, in every locale', () => {
    const detail = 'LibRaw cannot open processed windows for this file.'
    renderIn('zh-CN', {
      disabledReason: {
        source: 'workflow',
        reason: { code: 'runtime-unsupported', detail },
      },
    })
    expect(screen.getByText(detail)).toBeVisible()
  })

  it('says in English what the panel said before', () => {
    renderIn('en', {
      disabledReason: {
        source: 'workflow',
        reason: { code: 'exposure-pending' },
      },
      previewExportDisabledReason: {
        source: 'workflow',
        reason: 'hq-preview-pending',
      },
    })
    expect(
      screen.getByText('RAW preview exposure is still being prepared.'),
    ).toBeVisible()
    expect(
      screen.getByText(
        'HQ preview export is available after the bounded HQ preview finishes.',
      ),
    ).toBeVisible()
  })

  it('falls back to the loading copy for a refusal that names no reason', () => {
    renderIn('zh-CN', {})
    expect(screen.getByText('全分辨率导出源还在加载。')).toBeVisible()
  })

  it('labels the Copy action from the copy mode in the current locale', () => {
    renderIn('zh-CN', {
      canExport: true,
      exportResult: createResult({
        copyCapability: {
          mode: 'full-resolution',
        },
      }),
      exportShareCapability: { available: true },
    })
    expect(
      screen.getByRole('button', { name: '复制全分辨率图像' }),
    ).toBeEnabled()
  })
})

describe('exportTool in progress', () => {
  afterEach(() => {
    setProgress(0)
  })

  const idleProps: ExportToolProps = {
    canExport: true,
    canPreviewExport: true,
    isProcessing: false,
    onExport: vi.fn(),
    onPreviewExport: vi.fn(),
    exportResult: null,
    exportShareCapability: { available: false, reasonCode: 'no-result' },
    onShareExport: vi.fn(),
    onDownloadExport: vi.fn(),
    onCopyExport: vi.fn(),
  }

  it('says what a busy stage is doing instead of naming an export', () => {
    render(
      <ExportTool
        {...idleProps}
        canExport={false}
        canPreviewExport={false}
        disabledReason={{ source: 'surface', code: 'preview-decoding' }}
        previewExportDisabledReason={{
          source: 'surface',
          code: 'preview-decoding',
        }}
        isProcessing
      />,
    )

    expect(screen.getAllByText('Building the first preview...')).toHaveLength(1)
    const primary = screen.getByRole('button', {
      name: 'Export full-resolution JPEG',
    })
    expect(primary).toBeDisabled()
    expect(primary).not.toHaveAttribute('aria-busy')
    expect(screen.queryByText(/exporting/i)).toBeNull()
  })

  it('places every note above both buttons', () => {
    render(
      <ExportTool
        {...idleProps}
        canPreviewExport={false}
        previewExportDisabledReason={{
          source: 'workflow',
          reason: 'hq-preview-pending',
        }}
      />,
    )

    const note = screen.getByText(
      'HQ preview export is available after the bounded HQ preview finishes.',
    )
    const primary = screen.getByRole('button', {
      name: 'Export full-resolution JPEG',
    })
    expect(
      note.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Export HQ preview JPEG' }),
    ).toHaveAccessibleDescription(
      'HQ preview export is available after the bounded HQ preview finishes.',
    )
  })

  it.each([
    [
      'full resolution',
      /export full-resolution jpeg/i,
      /export hq preview jpeg/i,
    ],
    ['HQ preview', /export hq preview jpeg/i, /export full-resolution jpeg/i],
  ])(
    'shows a %s export running on the button that started it',
    async (_kind, started, other) => {
      const user = userEvent.setup()
      const { rerender } = render(<ExportTool {...idleProps} />)

      await user.click(screen.getByRole('button', { name: started }))
      act(() => setProgress(41.6))
      rerender(<ExportTool {...idleProps} isProcessing isExporting />)

      const running = screen.getByRole('button', { name: 'Exporting 42%' })
      expect(running).toHaveAttribute('aria-busy', 'true')
      expect(running).toBeDisabled()
      expect(screen.getByRole('button', { name: other })).toBeDisabled()

      act(() => setProgress(90))
      expect(
        screen.getByRole('button', { name: 'Exporting 90%' }),
      ).toBeInTheDocument()

      rerender(<ExportTool {...idleProps} />)
      expect(screen.getByRole('button', { name: started })).toBeEnabled()
    },
  )

  it('holds a delivery busy until it settles, and ignores a second press', async () => {
    const user = userEvent.setup()
    let settle = () => {}
    const onCopyExport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    render(
      <ExportTool
        {...idleProps}
        exportResult={createResult()}
        exportShareCapability={{ available: true }}
        onCopyExport={onCopyExport}
      />,
    )

    const copy = screen.getByRole('button', { name: 'Copy preview-size image' })
    await user.click(copy)
    expect(copy).toHaveAttribute('aria-busy', 'true')
    await user.click(copy)
    await user.click(screen.getByRole('button', { name: 'Share' }))
    expect(onCopyExport).toHaveBeenCalledOnce()
    expect(idleProps.onShareExport).not.toHaveBeenCalled()

    await act(async () => settle())
    expect(copy).not.toHaveAttribute('aria-busy')
  })
})
