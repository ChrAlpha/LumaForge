import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../../model/export-result'
import { createMockExportResultIdentity } from '../../model/export-result.fixture'
import type { ExportInterruptionNote } from '../RawWorkflowContext'
import { MobileExportPanel } from './MobileExportPanel'

const INTERRUPTED_NOTE: ExportInterruptionNote = { kind: 'interrupted' }

const INTERRUPTED_HINT =
  'The previous export was interrupted. The next export you start uses the current RAW and adjustments with a safer setting.'

function buttonNames() {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
}

type MobileExportPanelProps = ComponentProps<typeof MobileExportPanel>

function panel(overrides: Partial<MobileExportPanelProps> = {}) {
  return (
    <MobileExportPanel
      canExport
      isProcessing={false}
      onExport={vi.fn()}
      exportResult={null}
      exportShareCapability={{
        available: false,
        reasonCode: 'no-result',
      }}
      onShareExport={vi.fn()}
      onDownloadExport={vi.fn()}
      onCopyExport={vi.fn()}
      {...overrides}
    />
  )
}

function renderPanel(overrides: Partial<MobileExportPanelProps> = {}) {
  return render(panel(overrides))
}

function createResult(overrides: Partial<ExportResult> = {}): ExportResult {
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

  return {
    kind: 'hq-preview',
    identity: createMockExportResultIdentity({ resultKind: 'hq-preview' }),
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
      reasonCode: 'full-resolution-copy-unsupported',
    },
    ...overrides,
  }
}

describe('mobileExportPanel', () => {
  it('recaps what the export will write before the export button', () => {
    renderPanel({
      recap: {
        output: 'full-resolution',
        size: { width: 9728, height: 6656 },
        look: { name: 'ARRI 3110 Film A', percent: 70 },
        adjustments: 3,
        transformApplied: true,
      },
    })
    const recap = document.querySelector<HTMLElement>('[data-export-recap]')!
    expect(recap).toHaveTextContent('Full-resolution JPEG · 9728×6656')
    expect(recap).toHaveTextContent(
      'Look: ARRI 3110 Film A · 70% · 3 adjustments · Transform applied',
    )
    // Every part that opens on a separator keeps its leading space: a
    // flex item would drop it ("3110 Film A· 70%").
    const parts = Array.from(
      recap.querySelectorAll<HTMLElement>('span > span'),
    ).filter((part) => /^\s/.test(part.textContent ?? ''))
    expect(parts.map((part) => part.textContent)).toEqual([
      ' · 70%',
      ' · 3 adjustments · Transform applied',
    ])
    for (const part of parts) expect(part).toHaveClass('whitespace-pre')
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

  it('offers to choose the LUT contract when that is what blocks export', async () => {
    const onChooseLutContract = vi.fn()
    renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'lut-input-unconfirmed' },
      },
      onChooseLutContract,
    })
    expect(
      screen.getByText(
        'Choose a LUT input profile before full-resolution export.',
      ),
    ).toBeVisible()
    const action = screen.getByRole('button', { name: /choose lut contract/i })
    expect(action).toHaveClass('min-h-[44px]')
    // A contract block is the colour contract's to explain: amber, the
    // contract colour, on the reason and the route; never rose.
    expect(action).toHaveClass('text-lf-amber-soft', 'bg-lf-amber/10')
    const reason = document.querySelector('[data-export-unavailable-reason]')!
    expect(reason).toHaveAttribute('data-tone', 'contract')
    expect(reason).toHaveClass('bg-lf-amber/10')
    expect(reason.querySelector('svg')).toHaveClass('text-lf-amber')
    expect(document.body.innerHTML).not.toMatch(/lf-rose/)
    await userEvent.click(action)
    expect(onChooseLutContract).toHaveBeenCalledOnce()
  })

  it('offers no contract route for any other block', () => {
    renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'capability-unchecked' },
      },
    })
    expect(
      screen.queryByRole('button', { name: /choose lut contract/i }),
    ).toBeNull()
  })

  it('never states what is not in state', () => {
    renderPanel({
      recap: {
        output: 'full-resolution',
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

  it('recaps the HQ preview alone when full resolution cannot run', () => {
    renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: {
          code: 'runtime-unsupported',
          detail: 'Full-resolution export is not available for this file.',
        },
      },
      canPreviewExport: true,
      onPreviewExport: vi.fn(),
      recap: {
        output: 'hq-preview',
        size: null,
        look: null,
        adjustments: 0,
        transformApplied: false,
      },
    })
    const recap = document.querySelector<HTMLElement>('[data-export-recap]')!
    expect(recap).toHaveTextContent('HQ preview JPEG only')
    expect(recap).not.toHaveTextContent(/full-resolution/i)
  })

  it('names no output when nothing can be written', () => {
    renderPanel({
      canExport: false,
      recap: {
        output: null,
        size: null,
        look: null,
        adjustments: 0,
        transformApplied: false,
      },
    })
    const recap = document.querySelector<HTMLElement>('[data-export-recap]')!
    expect(recap.textContent).toBe('No LUT')
  })

  it('names one adjustment in the singular and an Off strength in words', () => {
    renderPanel({
      recap: {
        output: 'full-resolution',
        size: null,
        look: { name: 'Kodak 2383', percent: 0 },
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

    expect(onExport).toHaveBeenCalledExactlyOnceWith()
    expect(onPreviewExport).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(/smaller 8-12mp preview-rendered jpeg/i),
    ).not.toBeInTheDocument()
  })

  it('holds the export actions at the bottom of a deck too short for the panel', () => {
    renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'capability-probing' },
      },
      canPreviewExport: false,
      previewExportDisabledReason: { source: 'workflow', reason: 'not-ready' },
      onPreviewExport: vi.fn(),
    })
    const actions = document.querySelector<HTMLElement>(
      '[data-export-actions]',
    )!
    expect(actions).toContainElement(
      screen.getByRole('button', { name: /export full-resolution jpeg/i }),
    )
    // Sticky on the deck's own tone: the notes above scroll under it.
    expect(actions).toHaveClass('sticky', 'bottom-0')
    expect(actions.className).toContain('bg-[oklch(0.085_0.006_255)]')
  })

  it('names why the HQ preview export is disabled under the button', () => {
    const reason =
      'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.'
    renderPanel({
      canPreviewExport: false,
      previewExportDisabledReason: {
        source: 'surface',
        code: 'transform-hq-export',
      },
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

  it('explains a blocked full-resolution export in a neutral well, not destructive rose', () => {
    const { container } = render(
      <MobileExportPanel
        canExport={false}
        disabledReason={{
          source: 'workflow',
          reason: { code: 'lut-input-unconfirmed' },
        }}
        isProcessing={false}
        onExport={vi.fn()}
        exportResult={null}
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
        onShareExport={vi.fn()}
        onDownloadExport={vi.fn()}
        onCopyExport={vi.fn()}
      />,
    )

    const box = container.querySelector('[data-export-unavailable-reason]')!
    expect(box).toHaveTextContent(
      'Choose a LUT input profile before full-resolution export.',
    )
    // Without the contract route, the block is not the contract's to paint.
    expect(box).toHaveAttribute('data-tone', 'neutral')
    expect(box).toHaveClass('bg-[oklch(0.96_0.006_255/0.05)]')
    expect(box.outerHTML).not.toMatch(/amber/)
    expect(box.outerHTML).not.toMatch(/lf-rose/)
    expect(box.querySelector('svg')).not.toBeNull()
  })

  it('shows a running export on its button instead of a blocked export error', () => {
    const { container } = renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'export-running' },
      },
      isProcessing: true,
      isExporting: true,
      progress: 41.6,
    })

    const primary = screen.getByRole('button', {
      name: 'Export full-resolution JPEG',
    })
    expect(primary).toBeDisabled()
    expect(primary).toHaveAttribute('aria-busy', 'true')
    // The plate stays readable rather than fading as refused, and the
    // progress fills along its foot.
    expect(primary).toHaveClass('disabled:text-lf-on-photo-ink/85')
    const hairline = container.querySelector('[data-export-progress]')
    expect(primary).toContainElement(hairline as HTMLElement)
    expect(hairline).toHaveStyle({ transform: 'scaleX(0.42)' })
    expect(
      screen.getByRole('button', { name: 'Export HQ preview JPEG' }),
    ).not.toHaveAttribute('aria-busy')
    expect(screen.queryByText(/color contract failed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/already running/i)).not.toBeInTheDocument()
  })

  it('says what a busy stage is doing instead of naming an export', () => {
    renderPanel({
      canExport: false,
      canPreviewExport: false,
      disabledReason: { source: 'surface', code: 'preview-decoding' },
      previewExportDisabledReason: {
        source: 'surface',
        code: 'preview-decoding',
      },
      isProcessing: true,
    })

    expect(screen.getAllByText('Building the first preview...')).toHaveLength(1)
    const primary = screen.getByRole('button', {
      name: 'Export full-resolution JPEG',
    })
    expect(primary).toBeDisabled()
    expect(primary).not.toHaveAttribute('aria-busy')
    expect(document.querySelector('[data-export-progress]')).toBeNull()
    expect(screen.queryByText(/preparing jpeg/i)).toBeNull()
  })

  it('marks the HQ preview button as the running export when it started one', async () => {
    const user = userEvent.setup()
    const onPreviewExport = vi.fn()
    const props = {
      canExport: true,
      canPreviewExport: true,
      onPreviewExport,
    }
    const { rerender } = renderPanel(props)
    await user.click(
      screen.getByRole('button', { name: 'Export HQ preview JPEG' }),
    )
    expect(onPreviewExport).toHaveBeenCalledOnce()

    rerender(panel({ ...props, isProcessing: true, isExporting: true }))
    expect(
      screen.getByRole('button', { name: 'Export HQ preview JPEG' }),
    ).toHaveAttribute('aria-busy', 'true')
    expect(
      screen.getByRole('button', { name: 'Export full-resolution JPEG' }),
    ).not.toHaveAttribute('aria-busy')
  })

  it('keeps the ready result compact without secondary helper copy', () => {
    renderPanel({
      exportResult: createResult(),
      exportShareCapability: {
        available: false,
        reasonCode: 'no-result',
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
        exportShareCapability={{ available: false, reasonCode: 'no-result' }}
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

  it('titles an HQ preview result as a preview, never as Exported', () => {
    renderPanel({ exportResult: createResult({ kind: 'hq-preview' }) })
    expect(
      screen.getByRole('heading', { level: 2, name: 'HQ preview ready' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Exported' }),
    ).toBeNull()
    expect(
      screen.getByRole('heading', { level: 3, name: 'HQ preview JPEG ready' }),
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

  it('notes an interrupted export in the idle content as a hint for the next export', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onClose = vi.fn()
    const props: MobileExportPanelProps = {
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'source-loading' },
      },
      canPreviewExport: false,
      onPreviewExport: vi.fn(),
      isProcessing: false,
      onExport,
      exportResult: null,
      exportShareCapability: { available: false, reasonCode: 'no-result' },
      interruptionNote: INTERRUPTED_NOTE,
      onShareExport: vi.fn(),
      onDownloadExport: vi.fn(),
      onCopyExport: vi.fn(),
      onClose,
      recap: {
        output: 'full-resolution',
        size: { width: 9728, height: 6656 },
        look: { name: 'Kodak 2383', percent: 35 },
        adjustments: 2,
        transformApplied: false,
      },
    }

    const { container, rerender, unmount } = render(
      <MobileExportPanel {...props} />,
    )

    // The state title stays the panel's, and the hint lives in the idle
    // content: after any block, before the recap and the actions.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Export',
    )
    const hint = screen.getByText(INTERRUPTED_HINT)
    const recap = container.querySelector<HTMLElement>('[data-export-recap]')!
    const actions = container.querySelector<HTMLElement>(
      '[data-export-actions]',
    )!
    expect(
      container
        .querySelector('[data-export-unavailable-reason]')!
        .compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      hint.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(actions).not.toContainElement(hint)
    // The recap still describes what can be written now.
    expect(recap).toHaveTextContent('Full-resolution JPEG · 9728×6656')
    expect(recap).toHaveTextContent('Look: Kodak 2383 · 35% · 2 adjustments')
    // No promise to bring back the old settings, bytes or strips, no picker
    // and no extra export button.
    expect(container).not.toHaveTextContent(/reselect|resum|restor|continu/i)
    expect(buttonNames()).toEqual([
      'Close export',
      'Export full-resolution JPEG',
      'Export HQ preview JPEG',
    ])

    // Readiness arriving starts nothing on its own.
    rerender(
      <MobileExportPanel {...props} canExport disabledReason={undefined} />,
    )
    expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
    expect(onExport).not.toHaveBeenCalled()

    // Closing hands the deck back; reopening shows the hint again. Neither
    // starts an export or a picker.
    await user.click(screen.getByRole('button', { name: 'Close export' }))
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    render(
      <MobileExportPanel {...props} canExport disabledReason={undefined} />,
    )
    expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
    expect(onExport).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Export full-resolution JPEG' }),
    )
    // The export command takes no choices.
    expect(onExport).toHaveBeenCalledExactlyOnceWith()
  })

  it('keeps the LUT contract route beside an interruption hint', async () => {
    const onChooseLutContract = vi.fn()
    renderPanel({
      canExport: false,
      disabledReason: {
        source: 'workflow',
        reason: { code: 'lut-input-unconfirmed' },
      },
      onChooseLutContract,
      interruptionNote: INTERRUPTED_NOTE,
    })

    expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
    expect(
      document.querySelector('[data-export-unavailable-reason]'),
    ).toHaveAttribute('data-tone', 'contract')
    await userEvent.click(
      screen.getByRole('button', { name: /choose lut contract/i }),
    )
    expect(onChooseLutContract).toHaveBeenCalledOnce()
  })

  it('drops the interruption hint while an export runs and keeps its progress title', () => {
    renderPanel({
      isProcessing: true,
      isExporting: true,
      progress: 41.6,
      interruptionNote: INTERRUPTED_NOTE,
    })

    expect(screen.queryByText(INTERRUPTED_HINT)).toBeNull()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Exporting42%',
    )
  })

  it('keeps the result actions of a finished export beside an interruption', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const onShareExport = vi.fn()
    const onDownloadExport = vi.fn()
    const onDownloadExportManifest = vi.fn()
    const onCopyExport = vi.fn()
    renderPanel({
      onExport,
      exportResult: createResult({
        kind: 'full-resolution',
        filename: 'DSC09142.jpg',
        manifestState: { status: 'ready' },
      }),
      exportShareCapability: { available: true },
      onShareExport,
      onDownloadExport,
      onDownloadExportManifest,
      onCopyExport,
      interruptionNote: INTERRUPTED_NOTE,
    })

    expect(
      screen.getByRole('heading', { level: 2, name: 'Exported' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await user.click(screen.getByRole('button', { name: /copy preview-size/i }))
    await user.click(screen.getByRole('button', { name: /manifest/i }))

    expect(onShareExport).toHaveBeenCalledOnce()
    expect(onDownloadExport).toHaveBeenCalledOnce()
    expect(onCopyExport).toHaveBeenCalledOnce()
    expect(onDownloadExportManifest).toHaveBeenCalledOnce()
    expect(onExport).not.toHaveBeenCalled()
  })
})
