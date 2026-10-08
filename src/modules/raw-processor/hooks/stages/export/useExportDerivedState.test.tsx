import type {
  ColorGraphIntentSource,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportResult,
  HqPreviewExportReasonCode,
} from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import { useExportDerivedState } from './useExportDerivedState'

const NO_LOOK: ColorGraphIntentSource = {
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0,
  ...NEUTRAL_USER_COLOR_INTENT,
}

const CUSTOM_LOOK: ColorGraphIntentSource = {
  ...NO_LOOK,
  styleKind: 'custom',
  intensity: 0.8,
}

function lutProfile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-profile',
    label: 'Test profile',
    role: 'scene-creative',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function lutData(profileResolution: LUTContractResolution): LUTData {
  return {
    size: 2,
    data: new Float32Array(2 ** 3 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'v-log',
    profileResolution,
  }
}

/** Confirmed, but with a linear output export refuses. */
const LINEAR_OUTPUT_LUT = lutData({
  kind: 'confirmed',
  confidence: 'user',
  profile: lutProfile({ outputGamut: 'rec2020', outputTransfer: 'linear' }),
})
/** A recommended contract the user has not confirmed. */
const UNCONFIRMED_LUT = lutData({
  kind: 'recommended',
  recommendations: [lutProfile()],
})
const ACCEPTED_LUT = lutData({
  kind: 'confirmed',
  confidence: 'user',
  profile: lutProfile(),
})

function createExportResult(): ExportResult {
  return {
    kind: 'full-resolution',
    output: {
      kind: 'blob',
      filename: 'frame.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      byteLength: 4,
      mimeType: 'image/jpeg',
    },
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: 4,
    createdAt: 1,
    copyCapability: {
      mode: 'full-resolution',
    },
  }
}

function createSession(): ImageSession {
  return {
    id: 'session-export',
    createdAt: 1,
    sourceFile: {
      file: new File(['raw'], 'frame.dng'),
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready', lastRenderSource: 'bounded-hq' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 800, height: 600 },
      retryRecommended: false,
    },
  }
}

function createBoundedHqImage(): DecodedImage {
  return {
    width: 800,
    height: 600,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(800 * 600 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'bounded-hq',
    metadata: { width: 800, height: 600 },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

describe('useExportDerivedState', () => {
  it('keeps full-resolution export and refuses only HQ preview under geometry', () => {
    const session = { ...createSession(), exportGeometry: SAMPLE_GEOMETRY }
    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: createBoundedHqImage() },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        params: NO_LOOK,
        lutData: null,
        stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
      }),
    )

    expect(result.current.canExport).toBe(true)
    expect(result.current.exportRefusal).toBeUndefined()
    // The bounded HQ preview cannot reproduce the geometry, so it says so
    // instead of quietly delivering an ungeometried frame.
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportRefusal).toBe('transform-held')
  })

  it('enables HQ preview export for a ready bounded-HQ decoded preview', () => {
    const session = createSession()
    const stats = { inputSize: { width: 800, height: 600 } } as PipelineStats
    const decodedImageRef = { current: createBoundedHqImage() }

    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef,
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        params: NO_LOOK,
        lutData: null,
        stats,
      }),
    )

    expect(result.current.canExport).toBe(true)
    expect(result.current.exportRefusal).toBeUndefined()
    expect(result.current.previewSuspended).toBe(false)
    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.previewExportRefusal).toBeUndefined()
  })

  it('refuses HQ preview export while the WebGPU preview leaves out the selected LUT', () => {
    const session = createSession()
    for (const selectedLut of [LINEAR_OUTPUT_LUT, UNCONFIRMED_LUT, null]) {
      const { result } = renderHook(() =>
        useExportDerivedState({
          session,
          exportInterruption: null,
          decodedImageRef: { current: createBoundedHqImage() },
          embeddedPreviewUrl: null,
          status: 'ready',
          hasImage: true,
          displaySource: 'bounded-hq',
          sourceFile: session.sourceFile.file ?? null,
          rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
          params: CUSTOM_LOOK,
          lutData: selectedLut,
          stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
        }),
      )

      // The JPEG would carry no look while its name and recap claim one.
      expect(result.current.canPreviewExport).toBe(false)
      expect(result.current.previewExportRefusal).toBe('look-dropped')
    }
  })

  it('keeps HQ preview export for a LUT the preview draws', () => {
    const session = createSession()
    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: createBoundedHqImage() },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        params: CUSTOM_LOOK,
        lutData: ACCEPTED_LUT,
        stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
      }),
    )

    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.previewExportRefusal).toBeUndefined()
  })

  it('suspends HQ preview export while a ready full-res export owns the preview budget', () => {
    const session: ImageSession = {
      ...createSession(),
      exportState: {
        ...createSession().exportState,
        status: 'ready',
        result: createExportResult(),
        activePlan: {
          profileName: 'desktop-fast',
          preferredRows: 128,
          concurrency: 1,
          runtimeMemoryProfile: 'desktop',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
        },
      },
    }

    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: null },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'bounded-hq',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        params: NO_LOOK,
        lutData: null,
        stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
      }),
    )

    expect(result.current.exportResult).toBe(session.exportState.result)
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportRefusal).toBe('preview-released')
  })

  it('names each HQ preview refusal by code, in order', () => {
    const session = createSession()
    const ready = {
      session,
      exportInterruption: null,
      decodedImageRef: { current: createBoundedHqImage() },
      embeddedPreviewUrl: null,
      status: 'ready' as const,
      hasImage: true,
      displaySource: 'bounded-hq' as const,
      sourceFile: session.sourceFile.file ?? null,
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' as const },
      params: NO_LOOK,
      lutData: null,
      stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
    }
    const released: ImageSession = {
      ...session,
      exportState: {
        ...session.exportState,
        status: 'ready',
        result: createExportResult(),
        activePlan: {
          profileName: 'desktop-fast',
          preferredRows: 128,
          concurrency: 1,
          runtimeMemoryProfile: 'desktop',
          outputSink: 'blob-handoff',
          checkpointMode: 'safe-retry',
        },
      },
    }
    const cases: Array<
      readonly [
        Parameters<typeof useExportDerivedState>[0],
        HqPreviewExportReasonCode | undefined,
      ]
    > = [
      [
        // Geometry comes first, even before a source is loaded.
        {
          ...ready,
          session: { ...session, exportGeometry: SAMPLE_GEOMETRY },
          hasImage: false,
        },
        'transform-held',
      ],
      [{ ...ready, hasImage: false, params: CUSTOM_LOOK }, 'no-source'],
      [
        {
          ...ready,
          session: released,
          decodedImageRef: { current: null },
          params: CUSTOM_LOOK,
        },
        'preview-released',
      ],
      [
        { ...ready, params: CUSTOM_LOOK, displaySource: 'quick' },
        'look-dropped',
      ],
      [{ ...ready, displaySource: 'quick', stats: null }, 'hq-preview-pending'],
      [{ ...ready, stats: null }, 'not-ready'],
      [ready, undefined],
    ]
    for (const [input, code] of cases) {
      const { result } = renderHook(() => useExportDerivedState(input))
      expect(result.current.previewExportRefusal).toBe(code)
      expect(result.current.canPreviewExport).toBe(code === undefined)
    }
  })

  it('carries the full-resolution refusal as its code alone', () => {
    const session = createSession()
    const base = {
      session,
      exportInterruption: null,
      decodedImageRef: { current: createBoundedHqImage() },
      embeddedPreviewUrl: null,
      status: 'ready' as const,
      hasImage: true,
      displaySource: 'bounded-hq' as const,
      sourceFile: session.sourceFile.file ?? null,
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' as const },
      params: NO_LOOK,
      lutData: null,
      stats: { inputSize: { width: 800, height: 600 } } as PipelineStats,
    }

    const loading = renderHook(() =>
      useExportDerivedState({ ...base, sourceFile: null }),
    ).result.current
    expect(loading.exportRefusal).toEqual({ code: 'source-loading' })
    expect(loading).not.toHaveProperty('exportDisabledReason')

    // The runtime's reasons are shown as given and never decide anything.
    const unsupported = renderHook(() =>
      useExportDerivedState({
        ...base,
        session: {
          ...session,
          exportState: {
            ...session.exportState,
            fullResCapability: {
              status: 'unsupported',
              reason: 'Quick preview is still being prepared.',
            },
          },
        },
      }),
    ).result.current
    expect(unsupported.exportRefusal).toEqual({
      code: 'runtime-unsupported',
      detail: 'Quick preview is still being prepared.',
    })

    const ready = renderHook(() => useExportDerivedState(base)).result.current
    expect(ready.canExport).toBe(true)
    expect(ready.exportRefusal).toBeUndefined()
    expect(ready).not.toHaveProperty('previewExportDisabledReason')
  })

  it('refuses share by code until a JPEG exists', () => {
    const session = createSession()
    const { result } = renderHook(() =>
      useExportDerivedState({
        session,
        exportInterruption: null,
        decodedImageRef: { current: null },
        embeddedPreviewUrl: null,
        status: 'ready',
        hasImage: true,
        displaySource: 'quick',
        sourceFile: session.sourceFile.file ?? null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        params: NO_LOOK,
        lutData: null,
        stats: null,
      }),
    )

    expect(result.current.exportShareCapability).toEqual({
      available: false,
      reasonCode: 'no-result',
    })
  })

  it('notes an interruption only from the hint read for the loaded source', () => {
    const session = createSession()
    const sourceFile = session.sourceFile.file ?? null
    if (!sourceFile) throw new Error('Expected a session source file.')
    const exportInterruption = {
      source: encodeExportSourceHint(sourceFile) ?? '',
      hint: {
        previousCrashLikeInterruption: true,
        previousResourceFailure: false,
        attempts: ['attempt-a'],
      },
    }
    const render = (file: File | null) =>
      renderHook(() =>
        useExportDerivedState({
          session,
          exportInterruption,
          decodedImageRef: { current: null },
          embeddedPreviewUrl: null,
          status: 'ready',
          hasImage: true,
          displaySource: 'quick',
          sourceFile: file,
          rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
          params: NO_LOOK,
          lutData: null,
          stats: null,
        }),
      ).result.current.exportInterrupted

    expect(render(sourceFile)).toBe(true)
    expect(render(new File(['other'], 'other.dng', { lastModified: 1 }))).toBe(
      false,
    )
    expect(render(null)).toBe(false)
  })
})
