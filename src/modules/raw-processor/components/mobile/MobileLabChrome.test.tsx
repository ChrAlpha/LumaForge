import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createStore, Provider as JotaiProvider } from 'jotai'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { mobileHistogramShownAtom } from '../../state/histogram.atoms'
import type { RawToolCommands } from '../RawWorkflowContext'
import { RawToolCommandsContext } from '../RawWorkflowContext'
import { transformFeatureFixture } from '../shared/transform-feature.fixture'
import { mobileAvailabilityFixture } from '../tool-availability.fixture'
import { MobileLabChrome as Chrome } from './MobileLabChrome'
import type { MobileLookControls } from './MobileLookDeck'
import { MobileMoreSheet } from './MobileMoreSheet'

type ChromeProps = ComponentProps<typeof Chrome>
type Props = Omit<ChromeProps, 'availability'> &
  Partial<Pick<ChromeProps, 'availability'>>

/** The chrome with the availability its surface would hand it. */
function MobileLabChrome(props: Props) {
  return (
    <RawToolCommandsContext value={adjustCommands}>
      <Chrome availability={mobileAvailabilityFixture(props)} {...props} />
    </RawToolCommandsContext>
  )
}

const adjustCommands = {
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onColorChange: vi.fn(),
  onColorReset: vi.fn(),
  onSelectiveColorChange: vi.fn(),
  onSelectiveColorReset: vi.fn(),
} as unknown as RawToolCommands

const base = {
  hasImage: true,
  viewMode: 'processed' as const,
  onViewModeChange: vi.fn(),
  fileName: 'DSC09142.ARW',
  fileMeta: 'Sony α7 IV · Experimental support',
  onReplaceFile: vi.fn(),
  onResetSession: vi.fn(),
  isProcessing: false,
  lutBrowser: {
    currentLutName: null,
    disabled: false,
    onLutLoad: vi.fn(),
    onLutClear: vi.fn(),
    lutProfileSelection: null,
    lutProfileResolution: null,
    onLutProfileSelect: vi.fn(),
    onlineLutSources: undefined,
  } as MobileLookControls,
  exportPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      export panel
      <button type="button" onClick={onClose}>
        Close export
      </button>
    </div>
  ),
  moreSheet: (controls: { open: boolean; onClose: () => void }) => (
    <MobileMoreSheet
      {...controls}
      pipelineSteps={[]}
      lutRows={[]}
      fileRows={[]}
    />
  ),
}

/** A user LUT whose contract is confirmed, so its footer edits it. */
const confirmedLook: MobileLookControls = {
  ...base.lutBrowser,
  currentLutName: 'client-look.cube',
  lutProfileSelection: {
    status: 'confirmed',
    fingerprint: 'lut-fingerprint',
    profileId: 'sony-sgamut3cine-slog3',
    confidence: 'metadata',
  },
  lutProfileResolution: {
    kind: 'confirmed',
    profile: {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      outputRange: 'full',
    },
    confidence: 'metadata',
  },
}

const dock = () => screen.getByRole('tablist', { name: /lab modes/i })
const tab = (name: RegExp) => within(dock()).getByRole('tab', { name })
const title = () => screen.queryByRole('heading', { name: 'DSC09142.ARW' })
const lookSources = () => screen.queryByRole('button', { name: /lut sources/i })
const sourcesSheet = () =>
  screen.queryByRole('dialog', { name: /lut sources/i })
const exportAction = () =>
  document.querySelector<HTMLButtonElement>('[data-mobile-export-action]')
const lens = () =>
  document.querySelector<HTMLElement>('[data-mobile-compare-lens]')
const scrubHud = () => document.querySelector('[data-scrub-value-hud]')
const deckPanel = () =>
  document.querySelector<HTMLElement>('[data-mobile-dock-panel]')
const scrubRow = (slider: string) =>
  screen
    .getByRole('slider', { name: slider })
    .closest('[data-testid="adjust-slider-row-scrub"]')!
const editContract = () =>
  screen.getByRole('button', {
    name: /edit color contract for sony s-gamut3\.cine \/ s-log3/i,
  })
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('mobileLabChrome', () => {
  let previewFrameEl: HTMLDivElement
  const pressPhoto = (type: 'pointerdown' | 'pointerup') =>
    act(() => {
      previewFrameEl.dispatchEvent(new Event(type, { bubbles: true }))
    })
  const tapPhoto = () => {
    pressPhoto('pointerdown')
    pressPhoto('pointerup')
  }

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
    previewFrameEl = document.createElement('div')
    previewFrameEl.setAttribute('data-raw-preview-frame', '')
    document.body.appendChild(previewFrameEl)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    previewFrameEl.remove()
  })

  it('mounts the dock, the export action and the lens only while a RAW is open', async () => {
    const onReplaceFile = vi.fn()
    const { rerender } = render(
      <MobileLabChrome
        {...base}
        hasImage={false}
        onReplaceFile={onReplaceFile}
        runtimeReadinessState="pending"
      />,
    )
    // Nothing for a tool to act on yet: no tab bar at all, not disabled tabs.
    expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()
    expect(exportAction()).toBeNull()
    expect(lens()).toBeNull()
    expect(screen.getByText('Waking RAW engine')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /browse raw files/i }),
    )
    expect(onReplaceFile).toHaveBeenCalledOnce()

    rerender(<MobileLabChrome {...base} />)
    await userEvent.click(tab(/adjust/i))
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()

    // Clearing the RAW takes the open tool with the dock.
    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(screen.queryByRole('group', { name: /tone sliders/i })).toBeNull()
    expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()
    expect(
      screen.getByRole('button', { name: /browse raw files/i }),
    ).toBeInTheDocument()
  })

  it('spans the CPU preview notice over the empty state until dismissed', () => {
    const onDismiss = vi.fn()
    const notice = { reason: 'webgpu-unavailable' as const, onDismiss }
    const banner = () =>
      document.querySelector<HTMLElement>('[data-cpu-preview-banner]')
    const { rerender } = render(
      <MobileLabChrome {...base} hasImage={false} cpuPreviewNotice={notice} />,
    )
    // No lens before a RAW is open: the notice spans the photo rect.
    expect(banner()).toHaveAttribute('data-placement', 'full')
    fireEvent.click(within(banner()!).getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()

    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(banner()).toBeNull()
  })

  it.each([
    { handoff: 'processing', facts: { isProcessing: true } },
    {
      handoff: 'the preview released after export',
      facts: { previewSuspended: true },
    },
  ])(
    'keeps the topbar and the locked dock through $handoff, closing the sheet and the lens',
    async ({ facts }) => {
      const { rerender } = render(<MobileLabChrome {...base} />)
      await userEvent.click(lookSources()!)
      expect(sourcesSheet()).toBeInTheDocument()
      expect(lens()).not.toBeNull()

      rerender(<MobileLabChrome {...base} {...facts} />)
      expect(sourcesSheet()).toBeNull()
      await waitFor(() => expect(lens()).toBeNull())
      expect(screen.getByRole('banner')).toBeInTheDocument()
      for (const toolTab of within(dock()).getAllByRole('tab')) {
        expect(toolTab).toBeDisabled()
      }
    },
  )

  describe('while the preview is released after export', () => {
    const props = {
      ...base,
      transform: transformFeatureFixture({ hasImage: true }),
      lutBrowser: confirmedLook,
      exportResultKind: 'full-resolution' as const,
    }

    it.each([
      {
        tool: 'the Look strip',
        open: async () => {},
        shown: () => screen.queryByRole('group', { name: 'Looks' }),
      },
      {
        tool: 'the inline LUT contract',
        open: () => userEvent.click(editContract()),
        shown: () =>
          screen.queryByRole('region', { name: 'client-look.cube: input' }),
      },
      {
        tool: 'an Adjust scrub',
        open: async () => {
          await userEvent.click(tab(/adjust/i))
          fireEvent.pointerDown(scrubRow('Exposure'))
        },
        shown: scrubHud,
      },
    ])(
      'takes $tool off screen and locks every tool',
      async ({ open, shown }) => {
        const { rerender } = render(<MobileLabChrome {...props} />)
        await open()
        expect(shown()).not.toBeNull()

        rerender(<MobileLabChrome {...props} previewSuspended />)
        await waitFor(() => expect(shown()).toBeNull())
        expect(deckPanel()).toBeNull()
        for (const name of [/look/i, /adjust/i, /transform/i]) {
          expect(tab(name)).toBeDisabled()
        }
        // The result stays one tap away from the topbar.
        expect(exportAction()).toBeEnabled()
      },
    )

    it('closes the delivered result, reopens it from the topbar, and unlocks on Restore', async () => {
      const { rerender } = render(
        <MobileLabChrome {...props} previewSuspended preferExportMode />,
      )
      expect(await screen.findByText('export panel')).toBeInTheDocument()

      await userEvent.click(
        screen.getByRole('button', { name: 'Close export' }),
      )
      expect(screen.queryByText('export panel')).toBeNull()
      await userEvent.click(exportAction()!)
      expect(screen.getByText('export panel')).toBeInTheDocument()
      expect(exportAction()).toHaveAttribute('aria-expanded', 'true')

      // Restore brings the preview back, and the tools with it.
      rerender(<MobileLabChrome {...props} />)
      await userEvent.click(tab(/adjust/i))
      expect(
        screen.getByRole('group', { name: /tone sliders/i }),
      ).toBeInTheDocument()
    })
  })

  it('routes a LUT-contract export block to the Look contract, focused, and hands Look its strip back after', async () => {
    render(
      <MobileLabChrome
        {...base}
        lutBrowser={{
          ...base.lutBrowser,
          currentLutName: 'unknown-look.cube',
          lutProfileResolution: { kind: 'unknown' },
        }}
        exportPanel={({ onChooseLutContract }) => (
          <button type="button" onClick={onChooseLutContract}>
            Choose LUT contract
          </button>
        )}
      />,
    )
    await userEvent.click(exportAction()!)
    await userEvent.click(
      screen.getByRole('button', { name: 'Choose LUT contract' }),
    )
    expect(tab(/look/i)).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('region', { name: 'unknown-look.cube: input' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to looks' })).toHaveFocus()

    await userEvent.click(tab(/adjust/i))
    await userEvent.click(tab(/look/i))
    expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
  })

  it.each([
    { facts: {}, name: 'Export blocked: open details' },
    { facts: { canExport: true }, name: 'Export ready: open options' },
    {
      facts: { isProcessing: true, isExporting: true, exportProgress: 42.4 },
      name: 'Exporting 42%',
    },
    {
      facts: { exportResultKind: 'full-resolution' as const },
      name: 'Exported: open result',
    },
    {
      facts: { exportResultKind: 'hq-preview' as const },
      name: 'HQ preview JPEG ready: open result',
    },
  ])('states the pipeline on the topbar Export: $name', ({ facts, name }) => {
    render(<MobileLabChrome {...base} {...facts} />)
    expect(exportAction()).toHaveAccessibleName(name)
    expect(exportAction()).toBeEnabled()
  })

  it('opens the export panel in the deck from the topbar and hands the deck and focus back on close', async () => {
    render(<MobileLabChrome {...base} />)
    await userEvent.click(tab(/adjust/i))
    const action = exportAction()!
    expect(action).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(action)
    expect(screen.getByText('export panel')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /tone sliders/i })).toBeNull()
    expect(action).toHaveAttribute('aria-expanded', 'true')
    // Export borrows the deck; no tool tab claims it.
    expect(screen.queryByRole('tab', { selected: true })).toBeNull()

    // The action closes what it opened.
    await userEvent.click(action)
    expect(screen.queryByText('export panel')).toBeNull()
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()

    await userEvent.click(action)
    await userEvent.click(screen.getByRole('button', { name: 'Close export' }))
    expect(screen.queryByText('export panel')).toBeNull()
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()
    expect(action).toHaveAttribute('aria-expanded', 'false')
    expect(action).toHaveFocus()
  })

  it('draws the dock, the lens and the topbar Export from the availability it is handed', () => {
    // Facts that would leave everything open, and a policy that refuses
    // them: the policy is what the chrome draws.
    const refused = {
      available: false as const,
      reason: 'export-running' as const,
    }
    render(
      <MobileLabChrome
        {...base}
        availability={{
          ...mobileAvailabilityFixture({ hasImage: true }),
          edit: refused,
          originalView: refused,
          exportEntry: refused,
        }}
      />,
    )
    for (const toolTab of within(dock()).getAllByRole('tab')) {
      expect(toolTab).toBeDisabled()
    }
    expect(lens()).toHaveAttribute('aria-disabled', 'true')
    expect(exportAction()).toBeDisabled()
  })

  it('hands the topbar band to the scrub HUD and takes the lens away while a slider is dragged', async () => {
    const { container } = render(<MobileLabChrome {...base} />)
    const chrome = container.querySelector('[data-mobile-lab-chrome]')
    await userEvent.click(tab(/adjust/i))
    expect(chrome).toHaveAttribute('data-focus', 'false')

    fireEvent.pointerDown(scrubRow('Exposure'))
    expect(scrubHud()).toBeInTheDocument()
    expect(chrome).toHaveAttribute('data-focus', 'true')
    await waitFor(() => expect(lens()).toBeNull())

    fireEvent.pointerUp(scrubRow('Exposure'))
    await waitFor(() => expect(scrubHud()).toBeNull())
    expect(chrome).toHaveAttribute('data-focus', 'false')
    await waitFor(() => expect(lens()).not.toBeNull())
  })

  it('collapses the panel before receding into immersive, and restores it on the way out', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    const showControls = () =>
      screen.getByRole('button', { name: /show controls/i })

    tapPhoto()
    expect(lookSources()).toBeNull()
    expect(title()).toBeInTheDocument()
    advance(160)
    expect(title()).toBeNull()
    expect(lens()).toBeNull()

    // The chrome returns at once; the panel re-expands after the stagger.
    fireEvent.click(showControls())
    expect(title()).toBeInTheDocument()
    expect(lookSources()).toBeNull()
    advance(160)
    expect(lookSources()).toBeInTheDocument()

    // A second tap inside the stagger goes immersive at once and still
    // keeps the panel to restore.
    tapPhoto()
    tapPhoto()
    expect(title()).toBeNull()
    fireEvent.click(showControls())
    advance(160)
    expect(lookSources()).toBeInTheDocument()
  })

  it('lets a tap on the photo close an open sheet, without a peek or immersive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    fireEvent.click(lookSources()!)
    expect(sourcesSheet()).toBeInTheDocument()

    // A hold over an open sheet is consumed: no peek, and not a tap.
    pressPhoto('pointerdown')
    advance(400)
    pressPhoto('pointerup')
    expect(onViewModeChange).not.toHaveBeenCalledWith('original')
    expect(sourcesSheet()).toBeInTheDocument()

    tapPhoto()
    await waitFor(() => expect(sourcesSheet()).toBeNull())
    expect(title()).toBeInTheDocument()
  })

  it('peeks the unprocessed RAW while the photo is held', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    pressPhoto('pointerdown')
    advance(260)
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    pressPhoto('pointerup')
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
  })

  it.each([
    {
      preview: 'the WebGPU preview',
      compareSupported: true,
      name: 'Split compare',
      tapped: 'compare',
    },
    {
      preview: 'the CPU preview',
      compareSupported: false,
      name: 'Show original',
      tapped: 'original',
    },
  ] as const)(
    'toggles $tapped from the lens under $preview, and a hold peeks the RAW then hands that view back',
    ({ compareSupported, name, tapped }) => {
      vi.useFakeTimers()
      const onViewModeChange = vi.fn()
      render(
        <MobileLabChrome
          {...base}
          compareSupported={compareSupported}
          onViewModeChange={onViewModeChange}
        />,
      )
      const el = lens()!
      expect(el).toHaveAccessibleName(name)
      const hold = () => {
        fireEvent.pointerDown(el)
        advance(260)
        expect(onViewModeChange).toHaveBeenLastCalledWith('original')
        expect(screen.getByText('Showing unprocessed RAW')).toBeInTheDocument()
        fireEvent.pointerUp(el)
        // The click that follows a hold is not a tap.
        fireEvent.click(el)
      }

      hold()
      expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
      expect(el).toHaveAttribute('aria-pressed', 'false')

      fireEvent.click(el)
      expect(onViewModeChange).toHaveBeenLastCalledWith(tapped)
      expect(el).toHaveAttribute('aria-pressed', 'true')
      hold()
      expect(onViewModeChange).toHaveBeenLastCalledWith(tapped)
      expect(el).toHaveAttribute('aria-pressed', 'true')
    },
  )

  it('tells the view whether the phone shows the histogram, so it runs only then', async () => {
    const store = createStore()
    const { unmount } = render(
      <JotaiProvider store={store}>
        <MobileLabChrome {...base} />
      </JotaiProvider>,
    )
    expect(store.get(mobileHistogramShownAtom)).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    await userEvent.click(
      await screen.findByRole('menuitemcheckbox', { name: /histogram/i }),
    )
    expect(store.get(mobileHistogramShownAtom)).toBe(true)

    // Leaving the mobile surface takes its histogram with it.
    unmount()
    expect(store.get(mobileHistogramShownAtom)).toBe(false)
  })

  describe('stage layout', () => {
    const restore: Array<() => void> = []

    beforeEach(() => {
      const heights: Record<string, number> = {
        '[data-mobile-topbar]': 56,
        '[data-mobile-dock]': 64,
        // Look's content; the deck adds 24px of padding.
        '[data-mobile-deck-content]': 116,
      }
      const shellSize = (el: HTMLElement, size: number) =>
        el.hasAttribute('data-raw-lab-shell') ? size : 0
      for (const [prop, read] of [
        ['clientWidth', (el: HTMLElement) => shellSize(el, 393)],
        ['clientHeight', (el: HTMLElement) => shellSize(el, 660)],
        [
          'offsetHeight',
          (el: HTMLElement) =>
            Object.entries(heights).find(([selector]) =>
              el.matches(selector),
            )?.[1] ?? 0,
        ],
      ] as const) {
        // clientWidth and clientHeight live on Element: shadow, then delete.
        const original = Object.getOwnPropertyDescriptor(
          HTMLElement.prototype,
          prop,
        )
        Object.defineProperty(HTMLElement.prototype, prop, {
          configurable: true,
          get(this: HTMLElement) {
            return read(this)
          },
        })
        restore.push(() => {
          if (original) {
            Object.defineProperty(HTMLElement.prototype, prop, original)
          } else {
            Reflect.deleteProperty(HTMLElement.prototype, prop)
          }
        })
      }
    })
    afterEach(() => {
      while (restore.length) restore.pop()!()
    })

    function renderInShell(props: Partial<Props>) {
      const inShell = (next: Partial<Props>) => (
        <div data-raw-lab-shell="viewport">
          <MobileLabChrome {...base} {...props} {...next} />
        </div>
      )
      const result = render(inShell({}))
      const shell = result.container.querySelector<HTMLElement>(
        '[data-raw-lab-shell]',
      )!
      const px = (name: string) =>
        Number.parseFloat(shell.style.getPropertyValue(name))
      return {
        ...result,
        shell,
        px,
        rerenderInShell: (next: Partial<Props>) =>
          result.rerender(inShell(next)),
      }
    }
    const deckHeight = () => Number.parseFloat(deckPanel()!.style.height)

    it('anchors a landscape photo under the topbar while list tools and the inline contract size the deck', async () => {
      const { px } = renderInShell({
        photoAspect: 3 / 2,
        lutBrowser: confirmedLook,
      })
      const expectAnchoredPhoto = () => {
        expect(px('--raw-stage-inset-top')).toBe(56)
        expect(px('--raw-photo-top')).toBe(56)
        expect(px('--raw-photo-width')).toBeCloseTo(393)
        expect(px('--raw-photo-height')).toBeCloseTo(262)
        expect(px('--raw-stage-inset-bottom')).toBeCloseTo(660 - 56 - 262)
      }
      expectAnchoredPhoto()
      expect(deckHeight()).toBe(140)

      // The contract chosen inline takes list sizing, with the photo kept.
      await userEvent.click(editContract())
      expect(deckHeight()).toBeCloseTo(250.8)
      expectAnchoredPhoto()
      await userEvent.click(
        screen.getByRole('button', { name: 'Back to looks' }),
      )
      expect(deckHeight()).toBe(140)

      await userEvent.click(tab(/adjust/i))
      expect(deckHeight()).toBeCloseTo(250.8)
      expectAnchoredPhoto()
    })

    it('trades height between a portrait photo and the deck, but never on a scrub', async () => {
      const { px } = renderInShell({ photoAspect: 2 / 3 })
      // Look: 660 - 56 - 64 - 140 = 400px of photo, ~267px wide, centred.
      expect(px('--raw-photo-height')).toBeCloseTo(400)
      expect(px('--raw-photo-left')).toBeCloseTo(63.17, 1)
      expect(px('--raw-photo-right')).toBeCloseTo(63.17, 1)

      // Tapping the active tool collapses the deck and gives the photo room.
      await userEvent.click(tab(/look/i))
      expect(px('--raw-photo-height')).toBeCloseTo(540)
      expect(px('--raw-stage-inset-bottom')).toBeCloseTo(64)

      await userEvent.click(tab(/adjust/i))
      expect(deckHeight()).toBe(200)
      expect(px('--raw-photo-height')).toBeCloseTo(340)
      fireEvent.pointerDown(scrubRow('Exposure'))
      expect(scrubHud()).toBeInTheDocument()
      expect(deckHeight()).toBe(200)
      expect(px('--raw-photo-height')).toBeCloseTo(340)
      fireEvent.pointerUp(scrubRow('Exposure'))
    })

    it('keeps the deck a running export and its released result show, and gives the photo the room once closed', async () => {
      const { px, rerenderInShell } = renderInShell({ photoAspect: 2 / 3 })
      await userEvent.click(exportAction()!)
      // Look's deck and the export panel both measure 140px here.
      expect(px('--raw-photo-height')).toBeCloseTo(400)

      rerenderInShell({
        isProcessing: true,
        isExporting: true,
        previewSuspended: true,
      })
      expect(screen.getByText('export panel')).toBeInTheDocument()
      expect(px('--raw-photo-height')).toBeCloseTo(400)

      rerenderInShell({
        previewSuspended: true,
        exportResultKind: 'full-resolution',
      })
      expect(screen.getByText('export panel')).toBeInTheDocument()
      expect(px('--raw-photo-height')).toBeCloseTo(400)

      // Closing it leaves the deck empty rather than hand it to a tool.
      await userEvent.click(
        screen.getByRole('button', { name: 'Close export' }),
      )
      expect(deckPanel()).toBeNull()
      expect(px('--raw-photo-height')).toBeCloseTo(540)
    })

    it.each([
      {
        photo: 'a landscape photo',
        aspect: 3 / 2,
        hint: 'side',
        notice: 'side',
        pill: 'row',
      },
      {
        photo: 'a narrow portrait photo',
        aspect: 1 / 3,
        hint: 'below',
        notice: 'below',
        pill: 'below',
      },
    ])(
      'keeps the lens hint, the CPU notice and the peek pill clear of the lens on $photo',
      ({ aspect, hint, notice, pill }) => {
        vi.useFakeTimers()
        renderInShell({
          photoAspect: aspect,
          cpuPreviewNotice: {
            reason: 'webgpu-unavailable',
            onDismiss: vi.fn(),
          },
        })
        expect(
          document.querySelector('[data-mobile-compare-lens-hint-slot]'),
        ).toHaveAttribute('data-mobile-compare-lens-hint-slot', hint)
        expect(
          document.querySelector('[data-cpu-preview-banner]'),
        ).toHaveAttribute('data-placement', notice)

        fireEvent.pointerDown(lens()!)
        advance(260)
        expect(
          document.querySelector('[data-mobile-peek-hint]'),
        ).toHaveAttribute('data-mobile-peek-hint', pill)
        fireEvent.pointerUp(lens()!)
      },
    )

    it('returns the stage to full bleed without an image and clears its variables on unmount', () => {
      const { px, shell, unmount } = renderInShell({
        hasImage: false,
        photoAspect: null,
      })
      expect(px('--raw-stage-inset-top')).toBe(0)
      expect(px('--raw-stage-inset-bottom')).toBe(0)
      unmount()
      expect(shell.style.getPropertyValue('--raw-stage-inset-bottom')).toBe('')
      expect(shell.style.getPropertyValue('--raw-photo-top')).toBe('')
    })
  })

  describe('catalog activation', () => {
    function renderWithSources(
      props: Partial<Props> = {},
      lutBrowser: MobileLookControls = base.lutBrowser,
    ) {
      const activateCatalogs = vi.fn()
      const onlineLutSources = {
        state: { resources: [], entries: [], issues: [], isLoading: false },
        activateCatalogs,
      } as unknown as UseOnlineLutSourcesResult
      const element = (next: Partial<Props>) => (
        <MobileLabChrome
          {...base}
          {...next}
          lutBrowser={{ ...lutBrowser, onlineLutSources }}
        />
      )
      const view = render(element(props))
      return {
        activateCatalogs,
        rerenderChrome: (next: Partial<Props> = {}) =>
          view.rerender(element(next)),
      }
    }

    it('activates the catalogs once the Look strip of a ready RAW is on screen', () => {
      const { activateCatalogs, rerenderChrome } = renderWithSources({
        hasImage: false,
      })
      expect(activateCatalogs).not.toHaveBeenCalled()

      rerenderChrome({ isProcessing: true })
      expect(activateCatalogs).not.toHaveBeenCalled()

      rerenderChrome()
      expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
      expect(activateCatalogs).toHaveBeenCalledOnce()
      expect(activateCatalogs).toHaveBeenCalledWith()
    })

    it.each([
      {
        away: 'a collapsed deck',
        leave: () => userEvent.click(tab(/look/i)),
        back: () => userEvent.click(tab(/look/i)),
      },
      {
        away: 'another tool',
        leave: () => userEvent.click(tab(/adjust/i)),
        back: () => userEvent.click(tab(/look/i)),
      },
      {
        away: 'the deck export borrows',
        leave: () => userEvent.click(exportAction()!),
        back: () =>
          userEvent.click(screen.getByRole('button', { name: 'Close export' })),
      },
      {
        away: 'the inline LUT contract',
        leave: () => userEvent.click(editContract()),
        back: () =>
          userEvent.click(
            screen.getByRole('button', { name: 'Back to looks' }),
          ),
      },
    ])('does not count $away as the strip', async ({ leave, back }) => {
      const { activateCatalogs } = renderWithSources({}, confirmedLook)
      activateCatalogs.mockClear()

      await leave()
      expect(screen.queryByRole('group', { name: 'Looks' })).toBeNull()
      expect(activateCatalogs).not.toHaveBeenCalled()

      await back()
      expect(activateCatalogs).toHaveBeenCalledOnce()
    })

    it('does not count a strip receded into immersive', () => {
      vi.useFakeTimers()
      const { activateCatalogs } = renderWithSources({ previewFrameEl })
      activateCatalogs.mockClear()

      tapPhoto()
      advance(160)
      expect(title()).toBeNull()
      expect(activateCatalogs).not.toHaveBeenCalled()
    })
  })
})
