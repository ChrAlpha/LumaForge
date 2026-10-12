import type {
  NormalizedSelectiveColorBands,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import {
  generateIdentityLUT,
  NEUTRAL_SELECTIVE_COLOR,
} from '@lumaforge/luma-color-runtime'
import type { RenderResult } from '@testing-library/react'
import { act, render } from '@testing-library/react'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { onTestFinished } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import type { ProcessingStatus } from '../model/workflow'
import { DEFAULT_LOOK_INTENSITY } from '../services/look/style-system'
import { setCurrentSession } from '../state/session.atoms'
import {
  getProcessingParams,
  resetToDefaults,
  setLut,
  setProcessingParams,
  setProcessingStatus,
  setProgress,
} from '../state/workflow.atoms'
import type { ColorValue } from './color-fields'
import { COLOR_NEUTRAL } from './color-fields'
import { RawToolSurface } from './RawToolSurface'
import type { RawToolCommands, RawToolSurfaceProps } from './RawWorkflowContext'
import {
  RawPreviewHistogramProvider,
  RawToolCommandsProvider,
  RawWorkflowProvider,
} from './RawWorkflowContext'
import type { ToneValue } from './tone-fields'
import { TONE_NEUTRAL } from './tone-fields'
import { toolAvailabilityFixture } from './tool-availability.fixture'

/**
 * The facts a surface reads from the production store, seeded there before
 * the surface renders: the stored intent (adjustments and look strength),
 * the workflow stage and its progress.
 */
interface RawToolStoreFacts {
  /** Needs an applied LUT (`currentLutName`) unless it is the default. */
  activeIntensity?: number
  tone?: Partial<ToneValue>
  color?: Partial<ColorValue>
  selectiveColor?: NormalizedSelectiveColorBands
  /** The stage is `exporting`; otherwise `processing` or `ready`. */
  isExporting?: boolean
  progress?: number
}

/**
 * What a surface test states, as flat facts. The fixture splits them the
 * way production does: store facts into the production store, commands into
 * the commands provider, and the rest into the workflow context. A command
 * the test leaves out does nothing.
 */
export type RawToolSurfaceFixtureProps = RawToolStoreFacts &
  Partial<RawToolCommands> &
  Partial<RawToolSurfaceProps> & {
    /** The preview histogram, through its own provider. */
    histogram?: PreviewHistogramState
  }

const CONTEXT_DEFAULTS: Omit<RawToolSurfaceProps, 'toolAvailability'> = {
  viewMode: 'processed',
  compareSplit: 0.5,
  canExport: false,
  isProcessing: false,
  exportResult: null,
  exportShareCapability: { available: false, reasonCode: 'no-result' },
  hasImage: false,
  fileName: '',
  supportLevel: 'experimental',
  metadata: null,
  stats: null,
}

/** The stage the store holds for the facts, as the availability reads it. */
function statusFor(props: RawToolSurfaceFixtureProps): ProcessingStatus {
  if (props.isExporting) return 'exporting'
  return props.isProcessing ? 'processing' : 'ready'
}

function resetToolStore() {
  setCurrentSession(null)
  resetToDefaults()
}

/**
 * Write the store facts the way the workflow holds them before a session:
 * the stored intent and, for an applied LUT, the detached look the strength
 * resolves through.
 */
function seedToolStore(props: RawToolSurfaceFixtureProps) {
  resetToolStore()
  const intensity = props.activeIntensity ?? DEFAULT_LOOK_INTENSITY
  const lutName = props.currentLutName
  if (!lutName && intensity !== DEFAULT_LOOK_INTENSITY) {
    throw new Error('A look strength needs an applied LUT (currentLutName)')
  }
  setProcessingParams({
    ...getProcessingParams(),
    ...TONE_NEUTRAL,
    ...props.tone,
    ...COLOR_NEUTRAL,
    ...props.color,
    selectiveColor: props.selectiveColor ?? NEUTRAL_SELECTIVE_COLOR,
    ...(lutName
      ? { styleKind: 'custom' as const, builtinPreset: null, intensity }
      : {}),
  })
  setLut(lutName ? { ...generateIdentityLUT(2), title: lutName } : null)
  setProcessingStatus(statusFor(props))
  setProgress(props.progress ?? 0)
}

/**
 * Commands that keep their identity while the surface stays mounted, each
 * reaching the callback the test rendered last.
 */
function createFixtureCommands(latest: {
  readonly current: RawToolSurfaceFixtureProps
}): RawToolCommands {
  return {
    onIntensityChange: (value) => latest.current.onIntensityChange?.(value),
    onToneChange: (value) => latest.current.onToneChange?.(value),
    onToneReset: () => latest.current.onToneReset?.(),
    onColorChange: (value) => latest.current.onColorChange?.(value),
    onColorReset: () => latest.current.onColorReset?.(),
    onSelectiveColorChange: (band, shift) =>
      latest.current.onSelectiveColorChange?.(band, shift),
    onSelectiveColorReset: () => latest.current.onSelectiveColorReset?.(),
    onLutLoad: (files) => latest.current.onLutLoad?.(files),
    onLutClear: () => latest.current.onLutClear?.(),
    onLutProfileSelect: (profile) =>
      latest.current.onLutProfileSelect?.(profile),
    onViewModeChange: (mode) => latest.current.onViewModeChange?.(mode),
    onCompareSplitChange: (split) =>
      latest.current.onCompareSplitChange?.(split),
    onCompareReset: () => latest.current.onCompareReset?.(),
    onExport: () => latest.current.onExport?.(),
    onPreviewExport: () => latest.current.onPreviewExport?.(),
    onShareExport: () => latest.current.onShareExport?.(),
    onDownloadExport: () => latest.current.onDownloadExport?.(),
    onDownloadExportManifest: () => latest.current.onDownloadExportManifest?.(),
    onCopyExport: () => latest.current.onCopyExport?.(),
    onReplaceFile: () => latest.current.onReplaceFile?.(),
    onResetSession: () => latest.current.onResetSession?.(),
    onPrepareRuntime: () => latest.current.onPrepareRuntime?.(),
  }
}

/**
 * The context facts the test stated: neither a store fact, which the
 * surfaces read back from the store, nor a command, which they call through
 * the commands provider.
 */
function contextFacts(
  props: RawToolSurfaceFixtureProps,
  commands: RawToolCommands,
): Partial<RawToolSurfaceProps> {
  const {
    activeIntensity: _activeIntensity,
    tone: _tone,
    color: _color,
    selectiveColor: _selectiveColor,
    isExporting: _isExporting,
    progress: _progress,
    histogram: _histogram,
    ...rest
  } = props
  return Object.fromEntries(
    Object.entries(rest).filter(([name]) => !(name in commands)),
  )
}

/**
 * The provider boundary the surfaces read: the workflow context with the
 * context facts, and the commands provider. The store facts are in the
 * production store, where the surfaces' slices read them.
 */
function FixtureToolProviders({
  props,
  children,
}: {
  props: RawToolSurfaceFixtureProps
  children: ReactNode
}) {
  const latest = useRef(props)
  latest.current = props
  const [commands] = useState(() => createFixtureCommands(latest))
  return (
    <RawWorkflowProvider
      value={{
        ...CONTEXT_DEFAULTS,
        ...contextFacts(props, commands),
        toolAvailability:
          props.toolAvailability ?? toolAvailabilityFixture(props),
      }}
    >
      <RawToolCommandsProvider commands={commands}>
        <RawPreviewHistogramProvider
          histogram={
            props.histogram ?? { state: 'unavailable', reason: 'no-image' }
          }
        >
          {children}
        </RawPreviewHistogramProvider>
      </RawToolCommandsProvider>
    </RawWorkflowProvider>
  )
}

function surfaceTree(props: RawToolSurfaceFixtureProps) {
  return (
    <Provider store={jotaiStore}>
      <FixtureToolProviders props={props}>
        <RawToolSurface />
      </FixtureToolProviders>
    </Provider>
  )
}

export type RawToolSurfaceRenderResult = Omit<RenderResult, 'rerender'> & {
  /** Seed the store with the new facts, then render them. */
  rerender: (props: RawToolSurfaceFixtureProps) => void
}

/**
 * Render the tool surface through the production store and its providers.
 * Unset availability is the provider's, derived from the same facts. The
 * store returns to its defaults when the test finishes.
 */
export function renderRawToolSurface(
  props: RawToolSurfaceFixtureProps = {},
): RawToolSurfaceRenderResult {
  onTestFinished(resetToolStore)
  act(() => seedToolStore(props))
  const result = render(surfaceTree(props))
  return {
    ...result,
    rerender: (next) => {
      act(() => seedToolStore(next))
      result.rerender(surfaceTree(next))
    },
  }
}
