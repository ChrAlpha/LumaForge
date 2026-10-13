import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'

/**
 * The decode stage a frame came from. `unknown` is a frame whose decoder named
 * no stage: it is never taken for a quick frame.
 */
export type DecodedPreviewFrameStage = 'quick' | 'bounded-hq' | 'unknown'

/**
 * Where the frame's RAW render exposure comes from. `source-pin` is the
 * source's pinned exposure, which the frame carries in place of its own
 * estimate; `unpinned` says no pin existed when the frame was accepted, so the
 * frame keeps the exposure it estimated from its own pixels.
 */
export type DecodedPreviewFrameExposure =
  | {
      readonly kind: 'source-pin'
      readonly value: Readonly<RawRenderExposure>
    }
  | {
      readonly kind: 'unpinned'
      readonly value: Readonly<RawRenderExposure>
    }

/**
 * One decoded preview frame as the workflow accepted it. Every consumer of
 * decoded pixels (GPU and CPU preview, histogram, original reference,
 * Transform) keys its work by this descriptor; only the frame's producer mints
 * one, once per accepted frame, and nothing rebuilds an identity from
 * dimensions, version counters, or byte lengths. It names the pixels without
 * holding them, and it carries no view, color intent, or executor state.
 */
export interface DecodedPreviewFrame {
  /**
   * The source session the frame was decoded for. A replaced or reset source
   * starts a new session, so two sources never share one, however alike
   * their frames are.
   */
  readonly sessionId: string
  /**
   * Unique per accepted frame, supplied by the producer. A frame decoded
   * again for the same source, a restored frame included, gets a new one.
   */
  readonly frameId: string
  readonly stage: DecodedPreviewFrameStage
  readonly width: number
  readonly height: number
  readonly exposure: DecodedPreviewFrameExposure
  /**
   * The quick frame of the same session whose drawn output may stand in for
   * this bounded-HQ frame until it draws, as the producer named it; null when
   * there is none.
   */
  readonly quickPredecessorFrameId: string | null
}

/**
 * The key work done for one accepted frame is cached and compared under. Two
 * descriptors of one frame share it; no frame has a key of its own.
 */
export function decodedPreviewFrameKey(
  frame: Pick<DecodedPreviewFrame, 'sessionId' | 'frameId'> | null,
): string {
  return JSON.stringify(frame ? [frame.sessionId, frame.frameId] : null)
}

/** Both descriptors name one frame. A missing descriptor names none. */
export function isSameDecodedPreviewFrame(
  a: DecodedPreviewFrame | null,
  b: DecodedPreviewFrame | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.sessionId === b.sessionId &&
    a.frameId === b.frameId
  )
}

/**
 * The quick frame's output may bridge to the successor only when the
 * successor is a bounded-HQ frame of the same source that names this quick
 * frame as its predecessor. Equal dimensions or exposure never qualify a
 * frame, and a frame of unknown stage neither bridges nor is bridged.
 */
export function isEligibleQuickPredecessor(
  predecessor: DecodedPreviewFrame | null,
  successor: DecodedPreviewFrame | null,
): boolean {
  return (
    predecessor !== null &&
    successor !== null &&
    predecessor.stage === 'quick' &&
    successor.stage === 'bounded-hq' &&
    predecessor.sessionId === successor.sessionId &&
    predecessor.frameId !== successor.frameId &&
    successor.quickPredecessorFrameId === predecessor.frameId
  )
}
