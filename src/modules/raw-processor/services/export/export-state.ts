import type {
  ColorGraphIntent,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import { assessProcessedExport } from '@lumaforge/render-engine/export'

import { toExportRefusalReasons } from '~/lib/raw/luma-runtime-adapter'

import type {
  FullResExportCapabilityState,
  ImageSession,
  TransformIntent,
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
 * One export attempt, fixed when it starts: the source it reads, the export
 * graph generation, the Transform intent it was admitted with, and its own
 * abort controller.
 */
export type ExportAttempt = Readonly<{
  sessionId: string
  graphVersion: number
  transformIntent: TransformIntent | undefined
  controller: AbortController
}>

type ExportAttemptRefs = {
  exportGraphVersionRef: { current: number }
  exportAbortControllerRef: ExportSlot
}

/**
 * Starts an attempt on `session`: ends any export still running, then gives
 * the export slot to a controller of the attempt's own.
 */
export function beginExportAttempt(
  session: ImageSession,
  attemptId: string,
  refs: ExportAttemptRefs & { abortExportWork: () => void },
): ExportAttempt {
  const graphVersion = refs.exportGraphVersionRef.current
  refs.abortExportWork()
  const attempt: ExportAttempt = Object.freeze({
    sessionId: session.id,
    graphVersion,
    transformIntent: session.transform?.intent,
    controller: new AbortController(),
  })
  claimExportSlot(refs.exportAbortControllerRef, attempt.controller, attemptId)
  return attempt
}

/**
 * Whether nothing has made an attempt obsolete: the view is mounted, its
 * signal is live, no later attempt has claimed the export slot (even one
 * that has since ended), the export graph has not moved, and the same source
 * still asks for the same Transform. Every edit makes a new intent, so asking
 * again for an earlier Transform does not make an attempt current again; an
 * event that asks for the same Transform keeps the intent. Whoever made an
 * attempt obsolete settles the workflow.
 */
export function isExportAttemptLive(
  attempt: ExportAttempt,
  live: ImageSession | null,
  refs: ExportAttemptRefs & { isMountedRef: { current: boolean } },
): live is ImageSession {
  return (
    refs.isMountedRef.current &&
    !attempt.controller.signal.aborted &&
    isLatestExportClaim(refs.exportAbortControllerRef, attempt.controller) &&
    refs.exportGraphVersionRef.current === attempt.graphVersion &&
    live?.id === attempt.sessionId &&
    live.transform?.intent === attempt.transformIntent
  )
}

/**
 * Writes `patch` over the export state of the session `sessionId` names; any
 * other session, or none, stays as it is.
 */
export function patchExportState(
  sessionId: string,
  patch: Partial<ImageSession['exportState']>,
) {
  return (prev: ImageSession | null): ImageSession | null =>
    prev?.id === sessionId
      ? { ...prev, exportState: { ...prev.exportState, ...patch } }
      : prev
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
 * from: the intent with the patch over it, read as the color graph reads it.
 */
export function changesRenderGraphParams(
  current: ColorGraphIntent,
  next: Partial<ColorGraphIntent>,
) {
  return (
    colorGraphIntentSignature(current) !==
    colorGraphIntentSignature({ ...current, ...next })
  )
}
