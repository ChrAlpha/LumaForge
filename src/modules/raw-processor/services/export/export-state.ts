import type {
  ColorGraphIntent,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  HSL_BAND_IDS,
  HSL_SHIFT_AXES,
  normalizeSelectiveColorParams,
} from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import { assessProcessedExport } from '@lumaforge/render-engine/export'

import { toExportRefusalReasons } from '~/lib/raw/luma-runtime-adapter'

import type {
  FullResExportCapabilityState,
  ImageSession,
} from '../../model/session'

const UNSUPPORTED_SOURCE_REASON =
  'This RAW source does not support full-resolution export in the current browser build.'

/**
 * The session's view of a probed export capability. It is supported only
 * when the export's own assessment admits it, with the dimensions that
 * assessment checked, so a capability the executor would refuse never reads
 * as supported. An unsupported capability keeps the runtime's own reasons
 * as it reported them, then the runtime reason of every other refusal the
 * assessment finds. The bare source refusal only restates the runtime's
 * verdict, so it adds nothing.
 */
export function toFullResCapabilityState(
  capability: LumaRawExportCapability,
): FullResExportCapabilityState {
  const assessment = assessProcessedExport(capability)
  if (assessment.exportable) {
    return {
      status: 'supported',
      width: assessment.width,
      height: assessment.height,
    }
  }

  const runtimeReasons: unknown = capability.reasons
  const reasons = new Set<string>(
    Array.isArray(runtimeReasons)
      ? runtimeReasons.filter(
          (reason): reason is string => typeof reason === 'string',
        )
      : [],
  )
  for (const reason of toExportRefusalReasons(
    assessment.reasons.filter((refusal) => refusal !== 'source-unsupported'),
  )) {
    reasons.add(reason)
  }

  return {
    status: 'unsupported',
    reason: [...reasons].join(', ') || UNSUPPORTED_SOURCE_REASON,
  }
}

/** An export owns the session: its abort handle is live or it is exporting. */
export function hasActiveExport(
  exportAbortController: AbortController | null,
  session: ImageSession | null,
): boolean {
  return (
    Boolean(exportAbortController && !exportAbortController.signal.aborted) ||
    session?.exportState.status === 'exporting'
  )
}

type ExportSlot = { current: AbortController | null }

/** One attempt's claim: its controller and the id its result carries. */
type ExportSlotClaim = { controller: AbortController; attemptId: string }

/** The last attempt each export slot was given, kept after it is released. */
const latestExportClaims = new WeakMap<ExportSlot, ExportSlotClaim>()

/**
 * Gives the export slot to a new attempt. The slot empties when an attempt
 * ends, but the claim stays recorded, so an attempt that has ended is still
 * known to be superseded once a later one has started.
 */
export function claimExportSlot(
  slot: ExportSlot,
  controller: AbortController,
  attemptId: string,
) {
  slot.current = controller
  latestExportClaims.set(slot, { controller, attemptId })
}

/**
 * Whether no attempt has started since this one claimed the slot: the slot
 * still holds it, or it ended and the slot is empty.
 */
export function isLatestExportClaim(
  slot: ExportSlot,
  controller: AbortController,
) {
  return (
    (slot.current === controller || slot.current === null) &&
    latestExportClaims.get(slot)?.controller === controller
  )
}

/**
 * The attempt the export slot answers to: the one holding it, or, once it is
 * empty, the last one it was given. Null when it was never claimed or is held
 * by a controller no claim gave it to, so no result can be vouched for.
 */
export function readExportSlotAttempt(slot: ExportSlot): string | null {
  const latest = latestExportClaims.get(slot)
  if (!latest) return null
  if (slot.current !== null && slot.current !== latest.controller) return null
  return latest.attemptId
}

export function clearExportResultState<T extends ImageSession | null>(
  session: T,
): T {
  if (
    !session?.exportState.result &&
    session?.exportState.status !== 'ready' &&
    session?.exportState.status !== 'exporting'
  ) {
    return session
  }

  return {
    ...session,
    exportState: {
      ...session.exportState,
      status:
        session.exportState.status === 'ready' ||
        session.exportState.status === 'exporting'
          ? 'idle'
          : session.exportState.status,
      result: undefined,
      lastProgress:
        session.exportState.status === 'exporting'
          ? undefined
          : session.exportState.lastProgress,
    },
  }
}

export function clearExportResultForActiveExport(
  session: ImageSession,
): ImageSession {
  return {
    ...session,
    exportState: {
      ...session.exportState,
      result: undefined,
      lastProgress: undefined,
      retryRecommended: false,
      recommendedRetryLevel: undefined,
    },
  }
}

export function hasSameRawRenderExposure(
  current: RawRenderExposure | null | undefined,
  next: RawRenderExposure | null | undefined,
) {
  if (!current || !next) {
    return current === next
  }

  return (
    current.ev === next.ev &&
    current.multiplier === next.multiplier &&
    current.source === next.source
  )
}

/**
 * Whether a params patch changes the color graph a ready export was rendered
 * from. Only the canonical color graph intent keys the patch carries are
 * compared. Scalars and the look are compared as written, so a non-detent
 * strength or an explicit undefined is a change. Selective color is compared
 * by its normalized bands, so explicitly undefined, partial and all-neutral
 * records are the same input.
 */
export function changesRenderGraphParams(
  current: ColorGraphIntent,
  next: Partial<ColorGraphIntent>,
) {
  return COLOR_GRAPH_INTENT_KEYS.some((key) => {
    if (!Object.hasOwn(next, key)) return false
    if (key === 'selectiveColor') {
      return changesSelectiveColor(current.selectiveColor, next.selectiveColor)
    }
    return next[key] !== current[key]
  })
}

function changesSelectiveColor(
  current: ColorGraphIntent['selectiveColor'],
  next: Partial<ColorGraphIntent>['selectiveColor'],
) {
  // The export color graph and the LUT bake read the normalized record, so
  // this compares the contract that actually feeds the renderer.
  const currentBands = normalizeSelectiveColorParams({
    selectiveColor: current,
  })
  const nextBands = normalizeSelectiveColorParams({ selectiveColor: next })
  return HSL_BAND_IDS.some((id) =>
    HSL_SHIFT_AXES.some(
      (axis) => currentBands[id][axis] !== nextBands[id][axis],
    ),
  )
}
