import type {
  LumaColorSelectiveColorParams,
  LUTData,
  ProcessingParams,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewFailureReason,
  CpuPreviewFrame,
  CpuPreviewVariant,
} from '@lumaforge/render-engine/preview'
import { CpuPreviewClient } from '@lumaforge/render-engine/preview'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'

import { createCpuRecoverySource } from '../services/preview/cpu-recovery-source'

// ---------------------------------------------------------------------------
// Public param type
// ---------------------------------------------------------------------------

export type CpuPreviewParams = {
  styleKind: ProcessingParams['styleKind']
  intensity: number
  builtinPreset: ProcessingParams['builtinPreset']
  lut: LUTData | null
  rawRenderExposure: RawRenderExposure
  userExposureEv: number
  userContrast: number
  userHighlights: number
  userShadows: number
  userWhites: number
  userBlacks: number
  userTemperature: number
  userTint: number
  userSaturation: number
  userVibrance: number
  selectiveColor?: LumaColorSelectiveColorParams['selectiveColor']
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Stable memoisation key for a neutral (original) frame.
 * Only the source identity and the intrinsic render-exposure EV matter.
 */
export function neutralFrameCacheKey(
  sourceId: string,
  renderExposureEv: number,
): string {
  return `${sourceId}:${renderExposureEv}`
}

/**
 * Build a colour graph for the CPU preview worker.
 *
 * - 'processed': uses all params as-is.
 * - 'neutral': zeros every look + tone field (mirrors ORIGINAL_LAYER_PARAMS
 *   in OriginalWebglLayer.tsx) but keeps rawRenderExposure so the intrinsic
 *   camera exposure is preserved.
 */
export function buildCpuPreviewGraph(
  params: CpuPreviewParams,
  variant: CpuPreviewVariant,
): SupportedExportColorGraphDescriptor | { unsupportedReason: string } {
  const input =
    variant === 'neutral'
      ? {
          styleKind: 'none' as const,
          intensity: 0,
          builtinPreset: null,
          lut: null,
          rawRenderExposure: params.rawRenderExposure,
          userExposureEv: 0,
          userContrast: 0,
          userHighlights: 0,
          userShadows: 0,
          userWhites: 0,
          userBlacks: 0,
          userTemperature: 0,
          userTint: 0,
          userSaturation: 0,
          userVibrance: 0,
          selectiveColor: undefined,
        }
      : params

  const graph = resolveExportColorGraph(input)

  if (!graph.supported) {
    return { unsupportedReason: graph.reason }
  }

  return graph
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function deriveSourceId(image: DecodedImage, imageVersion: number): string {
  // Include imageVersion so two distinct decodes of identical dimensions get
  // distinct ids (prevents neutral-cache collisions across images).
  return `v${imageVersion}:${image.width}x${image.height}:${image.data.byteLength}`
}

function isQuickU16(image: DecodedImage): boolean {
  return (
    image.source === 'quick' &&
    image.data instanceof Uint16Array &&
    image.layout === 'rgb-u16'
  )
}

export type UseCpuPreviewOptions = {
  /** Whether the hook should actively drive the client. */
  enabled: boolean
  /** The decoded quick-preview image (or null when none is loaded). */
  image: DecodedImage | null
  /** Incremented whenever `image` is replaced with a new decode. */
  imageVersion: number
  /** Current processing params driving the colour graph. */
  params: CpuPreviewParams
  /** Which variant to render. */
  variant: CpuPreviewVariant
}

export type UseCpuPreviewReturn = {
  frame: CpuPreviewFrame | null
  inFlight: boolean
  failureReason: CpuPreviewFailureReason | null
}

export function useCpuPreview({
  enabled,
  image,
  imageVersion,
  params,
  variant,
}: UseCpuPreviewOptions): UseCpuPreviewReturn {
  const clientRef = useRef<CpuPreviewClient | null>(null)
  const [frame, setFrame] = useState<CpuPreviewFrame | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [failureReason, setFailureReason] =
    useState<CpuPreviewFailureReason | null>(null)

  // Cache neutral frames so toggling look doesn't recompute.
  const neutralCacheRef = useRef<Map<string, CpuPreviewFrame>>(new Map())

  // Track the last source id to detect image identity changes.
  const lastSourceIdRef = useRef<string | null>(null)

  // Refs so the once-created onFrame handler reads current values rather than
  // the stale closure captured when the client was first constructed.
  const variantRef = useRef(variant)
  variantRef.current = variant
  const rawRenderExposureEvRef = useRef(params.rawRenderExposure.ev)
  rawRenderExposureEvRef.current = params.rawRenderExposure.ev

  // Guard against re-requesting an identical render on every React re-render:
  // `params` is rebuilt as a fresh object upstream each render, so the render
  // effect's dep changes every render; without this guard the worker would be
  // driven in a perpetual loop.
  const lastRenderKeyRef = useRef<{
    sig: string
    lut: CpuPreviewParams['lut']
  } | null>(null)

  // Lazy-initialise the client on first use.
  function getClient(): CpuPreviewClient {
    if (!clientRef.current) {
      const client = new CpuPreviewClient()
      client.onFrame((f) => {
        setFrame(f)
        setInFlight(false)
        // Cache neutral frames by their source + exposure key.
        if (variantRef.current === 'neutral') {
          const key = neutralFrameCacheKey(
            f.sourceId,
            rawRenderExposureEvRef.current,
          )
          neutralCacheRef.current.set(key, f)
        }
      })
      client.onError((r) => {
        setFailureReason(r)
        setInFlight(false)
      })
      clientRef.current = client
    }

    return clientRef.current
  }

  // Load source when the image identity changes.

  useEffect(() => {
    if (!enabled || !image) {
      lastSourceIdRef.current = null
      lastRenderKeyRef.current = null
      setFrame(null)
      setInFlight(false)
      setFailureReason(null)
      clientRef.current?.dispose()
      clientRef.current = null
      return
    }

    // Keep an existing quick worker source across HQ upgrades. When CPU mode
    // mounts after GPU loss there is no quick source, so seed from bounded HQ.
    const source = isQuickU16(image)
      ? {
          width: image.width,
          height: image.height,
          data: image.data as Uint16Array,
        }
      : !lastSourceIdRef.current
        ? createCpuRecoverySource(image)
        : null
    if (!source) return

    const sourceId = deriveSourceId(image, imageVersion)
    if (sourceId === lastSourceIdRef.current) {
      return
    }

    lastSourceIdRef.current = sourceId
    lastRenderKeyRef.current = null
    setFrame(null)
    setInFlight(true)
    setFailureReason(null)

    const client = getClient()
    client.loadSource({
      sourceId,
      ...source,
    })
    // imageVersion drives the dep so a new decode is detected even when
    // width/height/byteLength happen to match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, imageVersion])

  // Request a render whenever params or variant change (and a source is loaded).
  useEffect(() => {
    const sourceId = lastSourceIdRef.current
    if (!enabled || !sourceId) {
      return
    }

    // Return a cached neutral frame immediately if available.
    if (variant === 'neutral') {
      const key = neutralFrameCacheKey(sourceId, params.rawRenderExposure.ev)
      const cached = neutralCacheRef.current.get(key)
      if (cached) {
        setFrame(cached)
        return
      }
    }

    // Resolve the colour graph for the requested variant. When the look
    // pipeline cannot run (unresolved LUT contract, builtin style), degrade to
    // a look-stripped graph that keeps user tone/colour — parity with the GPU
    // preview, which renders with the LUT disabled instead of blanking. The
    // authoritative export path stays fail-closed in resolveExportColorGraph.
    let graph = buildCpuPreviewGraph(params, variant)
    let lookDegraded = false
    if ('unsupportedReason' in graph) {
      lookDegraded = true
      graph = buildCpuPreviewGraph(
        { ...params, styleKind: 'none', builtinPreset: null, lut: null },
        variant,
      )
    }
    if ('unsupportedReason' in graph) {
      // Even the look-stripped graph is unsupported — surface a real failure
      // instead of leaving the in-flight spinner armed forever.
      lastRenderKeyRef.current = null
      setFailureReason('render-failed')
      setInFlight(false)
      return
    }

    // Key the dedup signature on the EFFECTIVE look inputs so unconfirmed LUT
    // identity churn does not re-request identical degraded renders.
    const effectiveStyleKind = lookDegraded ? 'none' : params.styleKind
    const effectiveIntensity = lookDegraded ? 0 : params.intensity
    const effectiveBuiltinPreset = lookDegraded
      ? ''
      : (params.builtinPreset ?? '')
    const effectiveLut = lookDegraded ? null : params.lut
    const selectiveColorSig =
      variant === 'neutral' || !params.selectiveColor
        ? ''
        : JSON.stringify(params.selectiveColor)
    const renderSig = `${sourceId}|${variant}|${lookDegraded ? 'degraded' : 'full'}|${effectiveStyleKind}|${effectiveIntensity}|${effectiveBuiltinPreset}|${params.rawRenderExposure.ev}|${params.rawRenderExposure.multiplier}|${params.userExposureEv}|${params.userContrast}|${params.userHighlights}|${params.userShadows}|${params.userWhites}|${params.userBlacks}|${params.userTemperature}|${params.userTint}|${params.userSaturation}|${params.userVibrance}|${selectiveColorSig}`
    const prevKey = lastRenderKeyRef.current
    if (prevKey && prevKey.sig === renderSig && prevKey.lut === effectiveLut) {
      return
    }
    lastRenderKeyRef.current = { sig: renderSig, lut: effectiveLut }

    setInFlight(true)
    getClient().requestRender({ variant, graph })
  }, [enabled, params, variant])

  // Memoise the return shape to avoid unnecessary re-renders downstream.
  const result = useMemo(
    () => ({ frame, inFlight, failureReason }),
    [frame, inFlight, failureReason],
  )

  // Dispose the client on unmount.
  useEffect(() => {
    return () => {
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [])

  if (!enabled || !lastSourceIdRef.current) {
    if (enabled && image && isQuickU16(image) && !failureReason) {
      return { frame: null, inFlight: true, failureReason: null }
    }

    return { frame: null, inFlight: false, failureReason: null }
  }

  return result
}
