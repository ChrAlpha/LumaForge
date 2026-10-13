import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { Provider as JotaiProvider } from 'jotai'
import { RESET } from 'jotai/utils'
import type { ReactNode } from 'react'
import { memo } from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'

import { viewportWidthAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import type { ExportResult } from '../model/export-result'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import type {
  ActionAvailability,
  ToolAvailability,
  ToolSurface,
} from '../services/surface/derive-tool-availability'
import { previewHistogramStateAtom } from '../state/histogram.atoms'
import { setCurrentSession } from '../state/session.atoms'
import { toolCardOpenAtom } from '../state/tool-card.atoms'
import {
  DEFAULT_COLOR_INTENT,
  getProcessingParams,
  setPipelineStats,
  setProcessingParams,
  setProcessingStatus,
  setProgress,
} from '../state/workflow.atoms'
import { resetToDefaults } from '../test-support/workflow-store'
import { RawToolSurface } from './RawToolSurface'
import type { RawToolCommands } from './RawWorkflowContext'
import {
  useRawPreviewHistogram,
  useRawPreviewStats,
  useRawToolCommands,
  useRawWorkflowContext,
} from './RawWorkflowContext'
import { RawWorkflowToolProvider } from './RawWorkflowToolProvider'
import type { TransformPreviewState } from './shared/transform-feature.fixture'
import {
  transformFeatureFixture,
  transformPreviewOf,
  withTransformPreview,
} from './shared/transform-feature.fixture'

const noop = () => {}
const delivered = {
  kind: 'full-resolution',
  filename: 'current.jpg',
} as ExportResult

/** A loaded, exportable workflow whose every command is a fresh spy. */
function workflowFixture(overrides: Record<string, unknown> = {}) {
  return {
    params: { ...DEFAULT_COLOR_INTENT },
    lutData: null,
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    supportLevel: 'experimental',
    decodedImageRef: { current: null },
    loadedImage: { file: null, metadata: null },
    viewMode: 'compare',
    previewSuspended: false,
    exportResult: null,
    exportShareCapability: { available: false, reasonCode: 'no-result' },
    canExport: true,
    canPreviewExport: true,
    setIntensity: vi.fn(),
    setToneParams: vi.fn(),
    resetTone: vi.fn(),
    setColorParams: vi.fn(),
    resetColor: vi.fn(),
    setSelectiveColorBand: vi.fn(),
    resetSelectiveColor: vi.fn(),
    clearLUT: vi.fn(),
    selectLUTProfile: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    exportPreviewImage: vi.fn(),
    shareExportResult: vi.fn(),
    downloadExportResult: vi.fn(),
    downloadExportManifest: vi.fn(),
    copyExportResult: vi.fn(),
    ...overrides,
  } as unknown as UseRawWorkflowReturn
}

function onlineLutSourcesFixture() {
  return {
    state: {
      resources: [],
      entries: [],
      issues: [],
      activeResourceId: null,
      isLoading: false,
    },
    sourceUrlInput: '',
    setSourceUrlInput: vi.fn(),
    addSourceFromInput: vi.fn(),
    refreshSource: vi.fn(),
    removeSource: vi.fn(),
    loadEntry: vi.fn(async (): Promise<LutLoadOutcome> => 'loaded'),
    loadingEntryId: null,
    failedEntryId: null,
    entryLoadProgress: null,
    cancelEntryLoad: vi.fn(),
    loadedEntry: null,
    activateCatalogs: vi.fn(),
    resourceActivation: {},
    catalogActivation: 'inactive',
    share: { enabled: false, url: null, copy: vi.fn() },
  } as unknown as UseOnlineLutSourcesResult
}

/** The provider inputs a test moves; the rest stay fixed. */
interface HarnessProps {
  workflow: UseRawWorkflowReturn
  transform?: RawTransformFeature
  onlineLutSources: UseOnlineLutSourcesResult
  isCpuMode: boolean
  previewFrameEl: HTMLDivElement | null
  onExport: () => void
  onCompareReset: () => void
  onLutDrop: (files: File[]) => void
}

function harnessProps(patch: Partial<HarnessProps> = {}): HarnessProps {
  return {
    workflow: workflowFixture(),
    transform: transformFeatureFixture({ hasImage: true }),
    onlineLutSources: onlineLutSourcesFixture(),
    isCpuMode: false,
    previewFrameEl: null,
    onExport: vi.fn(),
    onCompareReset: vi.fn(),
    onLutDrop: vi.fn(),
    ...patch,
  }
}

function Harness({
  children,
  ...props
}: HarnessProps & { children: ReactNode }) {
  return (
    <RawWorkflowToolProvider
      {...props}
      isProcessing={props.workflow.status !== 'ready'}
      runtimeReadinessState="ready"
      onReplaceFile={noop}
      onResetSession={noop}
      onPrepareRuntime={noop}
    >
      {children}
    </RawWorkflowToolProvider>
  )
}

/** What a surface reads from the provider. */
function useBoundary() {
  return {
    surface: useRawWorkflowContext(),
    commands: useRawToolCommands(),
    histogram: useRawPreviewHistogram(),
    stats: useRawPreviewStats(),
  }
}

function renderProvider(patch: Partial<HarnessProps> = {}) {
  let props = harnessProps(patch)
  const hook = renderHook(useBoundary, {
    wrapper: ({ children }) => <Harness {...props}>{children}</Harness>,
  })
  return {
    result: hook.result,
    get props() {
      return props
    },
    update(next: Partial<HarnessProps>) {
      props = { ...props, ...next }
      hook.rerender()
    },
    updateWorkflow(next: Record<string, unknown>) {
      props = {
        ...props,
        workflow: { ...props.workflow, ...next } as UseRawWorkflowReturn,
      }
      hook.rerender()
    },
  }
}

/** Every edit a tool command makes: Adjust, Look and its contract. */
function editThroughCommands(commands: RawToolCommands) {
  commands.onToneChange({ userExposureEv: 1 })
  commands.onToneReset()
  commands.onColorChange({ userSaturation: 20 })
  commands.onColorReset()
  commands.onSelectiveColorChange('red', { hue: 10 })
  commands.onSelectiveColorReset()
  commands.onIntensityChange(0.4)
  void commands.onLutLoad([new File(['LUT_3D_SIZE 2'], 'look.cube')])
  commands.onLutClear()
  commands.onLutProfileSelect({ id: 'slog3' } as unknown as LUTColorProfile)
}

/** What `editThroughCommands` reaches when nothing refuses it. */
function commandEdits({ workflow, onLutDrop }: HarnessProps) {
  return [
    workflow.setToneParams,
    workflow.resetTone,
    workflow.setColorParams,
    workflow.resetColor,
    workflow.setSelectiveColorBand,
    workflow.resetSelectiveColor,
    workflow.setIntensity,
    onLutDrop,
    workflow.clearLUT,
    workflow.selectLUTProfile,
  ]
}

describe('rawWorkflowToolProvider export decisions', () => {
  it('keeps full resolution under a committed Transform, and drops what only the untransformed preview shows', () => {
    const frame = document.createElement('div')
    const measured = jotaiStore.get(previewHistogramStateAtom)
    const view = renderProvider({
      transform: transformFeatureFixture({ hasImage: true, active: true }),
      previewFrameEl: frame,
    })
    const { workflow, onExport } = view.props
    // The surfaces read the feature itself; only its edits are wrapped.
    expect(transformPreviewOf(view.result.current.surface.transform!)).toBe(
      transformPreviewOf(view.props.transform!),
    )
    expect(view.result.current.surface).toMatchObject({
      canExport: true,
      disabledReason: undefined,
      canPreviewExport: false,
      previewExportDisabledReason: {
        source: 'surface',
        code: 'transform-hq-export',
      },
      viewMode: 'processed',
      previewFrameEl: null,
    })
    expect(view.result.current.surface.toolAvailability.mobile.split).toEqual({
      available: false,
      reason: 'transform-compare',
    })
    expect(view.result.current.histogram).toEqual({
      state: 'unsupported',
      reason: 'Histogram is unavailable for the transformed preview.',
    })
    view.result.current.commands.onExport()
    void view.result.current.commands.onPreviewExport()
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()

    view.update({ transform: transformFeatureFixture({ hasImage: true }) })
    expect(view.result.current.surface).toMatchObject({
      canPreviewExport: true,
      viewMode: 'compare',
      previewFrameEl: frame,
    })
    expect(view.result.current.histogram).toBe(measured)
    void view.result.current.commands.onPreviewExport()
    expect(workflow.exportPreviewImage).toHaveBeenCalledOnce()
  })

  it.each(['pending', 'invalid', 'unavailable'] as const)(
    'refuses both exports while Transform is %s, through the commands a surface already holds',
    (block) => {
      const view = renderProvider()
      const { workflow, onExport } = view.props
      const held = view.result.current.commands

      view.update({
        transform: transformFeatureFixture({
          hasImage: true,
          exportBlock: block,
        }),
      })
      expect(view.result.current.commands).toBe(held)
      expect(view.result.current.surface).toMatchObject({
        canExport: false,
        disabledReason: { source: 'surface', code: `transform-${block}` },
        canPreviewExport: false,
      })
      held.onExport()
      void held.onPreviewExport()
      expect(onExport).not.toHaveBeenCalled()
      expect(workflow.exportPreviewImage).not.toHaveBeenCalled()

      // Answered, the geometry is committed and full resolution reproduces it.
      view.update({
        transform: transformFeatureFixture({ hasImage: true, active: true }),
      })
      held.onExport()
      expect(onExport).toHaveBeenCalledOnce()
    },
  )

  const unresolvedLut = {
    canExport: false,
    exportRefusal: { code: 'lut-input-unconfirmed' },
    activeStyle: {
      kind: 'custom',
      name: 'Unknown',
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
      lutAsset: {
        format: 'cube',
        dimension: 33,
        profileResolution: { kind: 'unknown' },
      },
    },
  }
  it.each([
    {
      name: 'an earlier workflow refusal over a Transform block',
      workflow: {
        canExport: false,
        exportRefusal: { code: 'capability-probing' },
      },
      block: 'pending',
      reason: { source: 'workflow', reason: { code: 'capability-probing' } },
      routesToContract: false,
    },
    {
      name: 'a Transform block over the LUT contract',
      workflow: unresolvedLut,
      block: 'pending',
      reason: { source: 'surface', code: 'transform-pending' },
      routesToContract: false,
    },
    {
      name: 'the LUT contract alone',
      workflow: unresolvedLut,
      block: null,
      reason: { source: 'workflow', reason: { code: 'lut-input-unconfirmed' } },
      routesToContract: true,
    },
    {
      name: 'an earlier gate beside an unresolved contract',
      workflow: {
        ...unresolvedLut,
        exportRefusal: { code: 'quick-preview-pending' },
      },
      block: null,
      reason: { source: 'workflow', reason: { code: 'quick-preview-pending' } },
      routesToContract: false,
    },
  ] as const)(
    'states $name as why export is refused',
    ({ workflow, block, reason, routesToContract }) => {
      const view = renderProvider({
        workflow: workflowFixture(workflow),
        transform: transformFeatureFixture({
          hasImage: true,
          exportBlock: block,
        }),
      })
      expect(view.result.current.surface).toMatchObject({
        canExport: false,
        disabledReason: reason,
        // Choosing a contract is offered only where it would unblock export.
        exportBlockedByLutContract: routesToContract,
      })
    },
  )
})

describe('rawWorkflowToolProvider stage facts', () => {
  it('shows the original but never the split in the CPU preview, and sends every compare command on', () => {
    const view = renderProvider({ isCpuMode: true })
    const { workflow, onCompareReset } = view.props
    // A split left over from the GPU path reads as the processed photo.
    expect(view.result.current.surface).toMatchObject({
      viewMode: 'processed',
      compareSupported: false,
    })
    expect(view.result.current.histogram.state).toBe('unsupported')
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = view.result.current.surface.toolAvailability[surface]
      expect(actions.originalView.available).toBe(true)
      expect(actions.split).toEqual({ available: false, reason: 'cpu-preview' })
    }

    // The workflow's own guard refuses what the stage cannot show: the
    // provider swaps no command for another and drops none, in the CPU
    // preview or under a committed Transform.
    for (const patch of [
      {},
      {
        isCpuMode: false,
        transform: transformFeatureFixture({ hasImage: true, active: true }),
      },
    ]) {
      view.update(patch)
      const { commands } = view.result.current
      commands.onViewModeChange('original')
      commands.onCompareSplitChange(0.4)
      commands.onCompareReset()
    }
    expect(workflow.setViewMode).toHaveBeenCalledTimes(2)
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledTimes(2)
    expect(workflow.setCompareSplit).toHaveBeenLastCalledWith(0.4)
    expect(onCompareReset).toHaveBeenCalledTimes(2)
  })

  it('reports the aspect the stage displays: the decoded preview, or the Transform frame drawn over it', () => {
    const view = renderProvider({
      workflow: workflowFixture({
        decodedImageRef: { current: { width: 6000, height: 4000 } },
      }),
    })
    expect(view.result.current.surface.previewAspect).toBe(1.5)

    view.update({
      transform: withTransformPreview(
        transformFeatureFixture({ hasImage: true, showOverlay: true }),
        {
          result: {
            frame: { width: 800, height: 1000 },
          } as NonNullable<TransformPreviewState['result']>,
        },
      ),
    })
    expect(view.result.current.surface.previewAspect).toBe(0.8)

    // Export releases the decoded preview; the aspect is unknown until the
    // preview is restored.
    view.update({ transform: transformFeatureFixture({ hasImage: true }) })
    view.updateWorkflow({ decodedImageRef: { current: null } })
    expect(view.result.current.surface.previewAspect).toBeNull()
  })

  it("shows the decoded preview size over the renderer's own, apart from the source size", () => {
    onTestFinished(() => act(() => setPipelineStats(null)))
    act(() =>
      setPipelineStats({
        processTime: 18,
        inputSize: { width: 4000, height: 2666 },
        previewSize: { width: 1200, height: 800 },
      }),
    )
    const view = renderProvider({
      workflow: workflowFixture({
        decodedImageRef: { current: { width: 4000, height: 2666 } },
      }),
    })
    expect(view.result.current.stats).toEqual({
      processTime: 18,
      inputSize: { width: 4000, height: 2666 },
      previewSize: { width: 4000, height: 2666 },
    })
  })

  it('hands on the applied LUT, the delivered size and the interruption note as the workflow reports them', () => {
    const view = renderProvider()
    expect(view.result.current.surface).toMatchObject({
      appliedLut: null,
      deliveredExportSize: null,
      interruptionNote: null,
    })

    view.updateWorkflow({
      activeStyle: {
        kind: 'custom',
        name: 'Kodak 2383',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
        lutAsset: {
          format: 'cube',
          dimension: 33,
          sha256: 'a'.repeat(64),
          sourceName: 'kodak-2383.cube',
        },
      },
      deliveredExportSize: { width: 9728, height: 6656 },
      exportInterrupted: true,
    })
    // The Look strip matches the applied LUT by its cube hash.
    expect(view.result.current.surface.appliedLut).toEqual({
      name: 'Kodak 2383',
      sha256: 'a'.repeat(64),
      sourceName: 'kodak-2383.cube',
    })
    expect(view.result.current.surface.deliveredExportSize).toEqual({
      width: 9728,
      height: 6656,
    })
    // A hint for the next export that names no source; nothing exports on
    // its own.
    expect(view.result.current.surface.interruptionNote).toEqual({
      kind: 'interrupted',
    })
    expect(view.props.onExport).not.toHaveBeenCalled()
  })
})

describe('rawWorkflowToolProvider action policy', () => {
  const open: ActionAvailability = { available: true, reason: null }
  const both = (availability: ActionAvailability) => ({
    desktop: availability,
    mobile: availability,
  })
  const ready = withTransformPreview(
    transformFeatureFixture({ hasImage: true, available: true, current: true }),
    { ready: true },
  )
  const released = {
    workflow: workflowFixture({
      previewSuspended: true,
      exportResult: delivered,
    }),
  }
  const rows: Array<{
    name: string
    patch: Partial<HarnessProps>
    action: keyof ToolAvailability
    expected: Record<ToolSurface, ActionAvailability>
  }> = [
    {
      name: 'a decoding stage, which only mobile waits out',
      patch: { workflow: workflowFixture({ status: 'decoding' }) },
      action: 'edit',
      expected: {
        desktop: open,
        mobile: { available: false, reason: 'preview-decoding' },
      },
    },
    {
      name: 'a released preview',
      patch: released,
      action: 'edit',
      expected: both({ available: false, reason: 'preview-released' }),
    },
    {
      name: 'a released preview holding its result',
      patch: released,
      action: 'delivery',
      expected: both(open),
    },
    {
      name: 'no applied LUT',
      patch: {},
      action: 'strength',
      expected: both({ available: false, reason: 'no-lut' }),
    },
    {
      name: 'an applied LUT',
      patch: { workflow: workflowFixture({ currentLutName: 'look.cube' }) },
      action: 'strength',
      expected: both(open),
    },
    {
      name: 'no Transform feature',
      patch: { transform: undefined },
      action: 'transformGeometry',
      expected: both({ available: false, reason: null }),
    },
    {
      name: 'no frame to capture',
      patch: {},
      action: 'transformGeometry',
      expected: both({ available: false, reason: 'transform-unavailable' }),
    },
    {
      name: 'a frame the Transform worker does not hold yet',
      patch: {
        transform: transformFeatureFixture({ hasImage: true, available: true }),
      },
      action: 'transformGeometry',
      expected: both({ available: false, reason: 'transform-pending' }),
    },
    {
      name: 'a frame the Transform worker answered on',
      patch: { transform: ready },
      action: 'transformGeometry',
      expected: both(open),
    },
    {
      name: 'a failed Transform capture',
      patch: { transform: { ...ready, captureError: true, current: false } },
      action: 'transformGeometry',
      expected: both({ available: false, reason: 'transform-unavailable' }),
    },
  ]

  it.each(rows)(
    'decides $action on each surface from $name',
    ({ patch, action, expected }) => {
      const { toolAvailability } = renderProvider(patch).result.current.surface
      expect({
        desktop: toolAvailability.desktop[action],
        mobile: toolAvailability.mobile[action],
      }).toEqual(expected)
    },
  )
})

describe('rawWorkflowToolProvider tool commands', () => {
  it('keeps one set of commands across renders, each reaching the workflow as it now is', () => {
    const view = renderProvider()
    const first = view.props
    const held = view.result.current.commands

    // The workflow hands new targets; the surfaces keep the commands they hold.
    view.update({
      workflow: workflowFixture(),
      onLutDrop: vi.fn(),
      onExport: vi.fn(),
      onCompareReset: vi.fn(),
    })
    expect(view.result.current.commands).toBe(held)

    editThroughCommands(held)
    held.onViewModeChange('original')
    held.onCompareSplitChange(0.3)
    held.onCompareReset()
    held.onExport()
    void held.onPreviewExport()
    void held.onDownloadExport()
    void held.onDownloadExportManifest()
    void held.onShareExport()
    void held.onCopyExport()
    const { workflow, onExport, onCompareReset } = view.props
    for (const command of [
      ...commandEdits(view.props),
      workflow.exportPreviewImage,
      workflow.downloadExportResult,
      workflow.downloadExportManifest,
      workflow.shareExportResult,
      workflow.copyExportResult,
      onCompareReset,
      onExport,
    ]) {
      expect(command).toHaveBeenCalledOnce()
    }
    expect(workflow.setViewMode).toHaveBeenCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.3)
    for (const command of commandEdits(first)) {
      expect(command).not.toHaveBeenCalled()
    }
  })

  it('refuses every edit while the preview is released, through what a surface held before, and keeps delivery, Export and catalog listing', async () => {
    const view = renderProvider({
      transform: transformFeatureFixture({ hasImage: true, available: true }),
    })
    const { workflow, onExport, onlineLutSources } = view.props
    const transform = view.props.transform!
    const { commands: held, surface } = view.result.current
    const heldTransform = surface.transform!
    const heldSources = surface.onlineLutSources!
    const edits = [
      ...commandEdits(view.props),
      transform.setMode,
      transform.setManual,
      transform.setConstrainCrop,
      transform.reset,
      onlineLutSources.loadEntry,
    ]
    // A scrub, a section reset or a catalog tap from a panel still on
    // screen when the preview went.
    const editThroughEverything = () => {
      editThroughCommands(held)
      heldTransform.setMode('auto')
      heldTransform.setManual(NEUTRAL_TRANSFORM)
      heldTransform.setConstrainCrop(false)
      heldTransform.reset()
      return heldSources.loadEntry('kodak-2383')
    }

    // A catalog look applies on load, so one still downloading is cancelled.
    view.update({
      onlineLutSources: { ...onlineLutSources, loadingEntryId: 'kodak-2383' },
    })
    expect(onlineLutSources.cancelEntryLoad).not.toHaveBeenCalled()
    view.updateWorkflow({ previewSuspended: true, exportResult: delivered })
    expect(onlineLutSources.cancelEntryLoad).toHaveBeenCalledOnce()
    expect(view.result.current.commands).toBe(held)

    await expect(editThroughEverything()).resolves.toBe('aborted')
    for (const edit of edits) expect(edit).not.toHaveBeenCalled()
    // Listing a catalog is not an edit.
    view.result.current.surface.onlineLutSources!.activateCatalogs({
      resourceIds: ['profiles'],
    })
    expect(onlineLutSources.activateCatalogs).toHaveBeenCalledOnce()
    void held.onDownloadExport()
    void held.onDownloadExportManifest()
    void held.onShareExport()
    void held.onCopyExport()
    held.onExport()
    for (const command of [
      workflow.downloadExportResult,
      workflow.downloadExportManifest,
      workflow.shareExportResult,
      workflow.copyExportResult,
      onExport,
    ]) {
      expect(command).toHaveBeenCalledOnce()
    }

    view.update({
      onlineLutSources: { ...onlineLutSources, loadingEntryId: null },
    })
    view.updateWorkflow({ previewSuspended: false })
    expect(onlineLutSources.cancelEntryLoad).toHaveBeenCalledOnce()
    await expect(editThroughEverything()).resolves.toBe('loaded')
    for (const edit of edits) expect(edit).toHaveBeenCalledOnce()
  })
})

const renders = { context: 0, histogram: 0, stats: 0 }
const ContextReader = memo(() => {
  useRawWorkflowContext()
  renders.context++
  return null
})
const HistogramReader = memo(() => {
  useRawPreviewHistogram()
  renders.histogram++
  return null
})
const StatsReader = memo(() => {
  useRawPreviewStats()
  renders.stats++
  return null
})

describe('rawWorkflowToolProvider render isolation', () => {
  it('renders a reader only when what it reads moves', () => {
    Object.assign(renders, { context: 0, histogram: 0, stats: 0 })
    const measured = jotaiStore.get(previewHistogramStateAtom)
    onTestFinished(() =>
      act(() => {
        jotaiStore.set(previewHistogramStateAtom, measured)
        setPipelineStats(null)
      }),
    )
    let props = harnessProps()
    const tree = () => (
      <Harness {...props}>
        <ContextReader />
        <HistogramReader />
        <StatsReader />
      </Harness>
    )
    const { rerender } = render(tree())

    // A scrub moves the photo, not the decisions and facts the context holds.
    props = {
      ...props,
      workflow: {
        ...props.workflow,
        params: { ...props.workflow.params, userExposureEv: 1 },
      },
    }
    rerender(tree())
    expect(renders).toEqual({ context: 1, histogram: 1, stats: 1 })

    act(() =>
      jotaiStore.set(previewHistogramStateAtom, {
        state: 'unsupported',
        reason: 'measured again',
      }),
    )
    act(() =>
      setPipelineStats({
        processTime: 12,
        inputSize: { width: 4000, height: 2666 },
        previewSize: { width: 1200, height: 800 },
      }),
    )
    expect(renders).toEqual({ context: 1, histogram: 2, stats: 2 })
  })
})

describe('rawWorkflowToolProvider surfaces', () => {
  let previousViewport = jotaiStore.get(viewportWidthAtom)
  beforeEach(() => {
    previousViewport = jotaiStore.get(viewportWidthAtom)
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
    // Unmount the surface before restoring the viewport and the open tool
    // cards it reads, so the restore re-renders nothing outside act.
    cleanup()
    vi.unstubAllGlobals()
    jotaiStore.set(viewportWidthAtom, previousViewport)
    jotaiStore.set(toolCardOpenAtom, RESET)
  })

  /** The provider and the real surface for a viewport width. */
  function renderSurface(width: number, workflow = workflowFixture()) {
    onTestFinished(() => {
      setCurrentSession(null)
      resetToDefaults()
    })
    jotaiStore.set(viewportWidthAtom, width)
    return render(
      <JotaiProvider store={jotaiStore}>
        <Harness {...harnessProps({ workflow })}>
          <RawToolSurface />
        </Harness>
      </JotaiProvider>,
    )
  }

  it('shows the adjustments the store renders with on desktop, not a copy the workflow hands on', () => {
    setProcessingParams({ ...getProcessingParams(), userContrast: 12 })
    renderSurface(1280)
    expect(screen.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
      'aria-valuenow',
      '12',
    )
  })

  it('shows the export progress the store holds on the mobile topbar', () => {
    act(() => {
      setProcessingStatus('exporting')
      setProgress(42)
    })
    const { container } = renderSurface(
      390,
      workflowFixture({ status: 'exporting', progress: 0 }),
    )
    expect(
      container.querySelector('[data-mobile-export-action]'),
    ).toHaveTextContent('42%')
  })
})
