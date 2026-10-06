import type {
  ColorGraphIntentSource,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewFailureReason,
  CpuPreviewFrame,
  CpuPreviewVariant,
  PreviewColorPlan,
} from '@lumaforge/render-engine/preview'
import {
  CpuPreviewClient,
  resolvePreviewColorPlan,
} from '@lumaforge/render-engine/preview'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'

import { createCpuRecoverySource } from '../services/preview/cpu-recovery-source'

// ---------------------------------------------------------------------------
// Public param type
// ---------------------------------------------------------------------------

/** The color intent plus what the CPU graph needs besides it. */
export type CpuPreviewParams = ColorGraphIntentSource & {
  lut: LUTData | null
  rawRenderExposure: RawRenderExposure
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
 * What the CPU preview draws for a variant, read from the shared preview
 * color policy. A custom LUT draws only when export would run it; otherwise,
 * and for built-in presets (no TS executor draws one), the look is dropped and
 * the user's tone and color stay. The neutral variant draws no look and
 * neutral user color. Both keep the RAW render exposure.
 */
export function resolveCpuPreviewPlan(
  params: CpuPreviewParams,
  variant: CpuPreviewVariant,
): PreviewColorPlan {
  return resolvePreviewColorPlan({
    intent: params,
    lut: params.lut,
    rawRenderExposure: params.rawRenderExposure,
    executor: 'cpu',
    variant,
  })
}

/** The colour graph the CPU preview worker draws for a variant. */
export function buildCpuPreviewGraph(
  params: CpuPreviewParams,
  variant: CpuPreviewVariant,
): SupportedExportColorGraphDescriptor | { unsupportedReason: string } {
  try {
    const { graph } = resolveCpuPreviewPlan(params, variant)
    if (graph) return graph
  } catch (error) {
    if (error instanceof Error) return { unsupportedReason: error.message }
  }
  return { unsupportedReason: 'The CPU preview resolved no color graph.' }
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

  // Ref so the once-created onFrame handler reads the current variant rather
  // than the stale closure captured when the client was first constructed.
  const variantRef = useRef(variant)
  variantRef.current = variant

  // Renders whose frames may still be shown, with the neutral cache key each
  // was requested under (null for processed). A frame is judged by the request
  // it answers, not by the variant selected when it lands: a request can wait
  // behind a render of the other variant. Replacing the map drops every
  // render still outstanding.
  const liveRendersRef = useRef(new WeakMap<object, string | null>())

  // The render the current params asked for last. Only its frame settles the
  // preview: an older frame of the selected variant may stand in on screen
  // while the newer render is still on the worker, but it is not the photo
  // the params describe, so nothing downstream may take it as finished.
  const latestRequestRef = useRef<object | null>(null)

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
      client.onFrame((f, request) => {
        const neutralKey = liveRendersRef.current.get(request)
        // A cached original replaced this render: neither show nor cache it.
        if (neutralKey === undefined) return
        if (neutralKey !== null) {
          neutralCacheRef.current.set(neutralKey, f)
        }
        // A frame of the other variant leaves the photo on screen; the render
        // for the selected variant is queued behind it.
        if (request.variant !== variantRef.current) return
        setFrame(f)
        if (request === latestRequestRef.current) setInFlight(false)
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
      latestRequestRef.current = null
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
        // The cached original replaces whatever is still rendering, and the
        // next processed request has to render again rather than match the
        // render it would otherwise duplicate.
        liveRendersRef.current = new WeakMap()
        lastRenderKeyRef.current = null
        latestRequestRef.current = null
        setInFlight(false)
        return
      }
    }

    // The shared preview color policy decides what the CPU draws: a look
    // export would refuse is dropped, keeping user tone and colour, so the
    // photo never blanks. The authoritative export path stays fail-closed.
    let plan: PreviewColorPlan | null = null
    try {
      plan = resolveCpuPreviewPlan(params, variant)
    } catch {
      plan = null
    }
    if (!plan?.graph) {
      // Even the look-stripped graph is unsupported — surface a real failure
      // instead of leaving the in-flight spinner armed forever.
      lastRenderKeyRef.current = null
      setFailureReason('render-failed')
      setInFlight(false)
      return
    }
    const { graph } = plan

    // Key the dedup signature on what the plan draws, so a look the preview
    // drops (a refused or unloaded LUT, its strength, a builtin preset) and
    // edits the original does not draw do not re-request an identical
    // render. The drawn LUT is compared by identity: a new contract on the
    // same bytes is a new LUT.
    const renderSig = [
      sourceId,
      variant,
      params.rawRenderExposure.ev,
      params.rawRenderExposure.multiplier,
      colorGraphIntentSignature(plan.effectiveIntent),
    ].join('|')
    const effectiveLut = plan.lut
    const prevKey = lastRenderKeyRef.current
    if (prevKey && prevKey.sig === renderSig && prevKey.lut === effectiveLut) {
      return
    }
    lastRenderKeyRef.current = { sig: renderSig, lut: effectiveLut }

    const request = { variant, graph }
    liveRendersRef.current.set(
      request,
      variant === 'neutral'
        ? neutralFrameCacheKey(sourceId, params.rawRenderExposure.ev)
        : null,
    )
    latestRequestRef.current = request
    setInFlight(true)
    getClient().requestRender(request)
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
