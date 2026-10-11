import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import { materializeOutputBlob } from '@lumaforge/render-engine/export'

import type {
  ExportCopyCapability,
  ExportCopyReasonCode,
  ExportResult,
  ExportResultIdentity,
  ExportShareCapability,
  ExportShareReasonCode,
} from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import { deriveTransformExportRefusalReason } from './export-readiness'
import {
  captureExportResultIdentity,
  isSameExportResult,
  isSameExportResultInput,
} from './export-result-identity'

type ClipboardEnvironment = {
  navigator?: {
    clipboard?: {
      write?: (items: ClipboardItem[]) => Promise<void>
    }
  }
  ClipboardItem?: {
    new (items: Record<string, Blob>): ClipboardItem
    supports?: (type: string) => boolean
  }
}

export type ExportOutputMaterializationAction =
  | 'download'
  | 'share'
  | 'copy'
  | 'manifest'

export type ExportOutputMaterializationEvent = {
  action: ExportOutputMaterializationAction
  outputKind: ExportResult['output']['kind']
  filename: string
  byteLength: number
  materializedAt: string
  cleanup: 'scheduled' | 'not-needed' | 'completed'
}

type MaterializationDiagnostics = {
  onMaterialize?: (event: ExportOutputMaterializationEvent) => void
  now?: () => string
}

/** Why a copy or share cannot run. */
export type ExportActionReasonCode =
  | ExportCopyReasonCode
  | ExportShareReasonCode

type ExportCopyUnavailable = Extract<
  ExportCopyCapability,
  { mode: 'unavailable' }
>
type ExportShareUnavailable = Extract<
  ExportShareCapability,
  { available: false }
>

/** A copy that cannot run, named by its code. */
export function unavailableExportCopy(
  reasonCode: ExportCopyReasonCode,
): ExportCopyUnavailable {
  return { mode: 'unavailable', reasonCode }
}

/** A share that cannot run, named by its code. */
export function unavailableExportShare(
  reasonCode: ExportShareReasonCode,
): ExportShareUnavailable {
  return { available: false, reasonCode }
}

/**
 * Thrown by a copy or share the browser or the result cannot carry out. The
 * code is the failure, and the message is the code: its copy is chosen where
 * the failure is shown.
 */
export class ExportActionUnavailableError extends Error {
  readonly reasonCode: ExportActionReasonCode

  constructor(refusal: ExportCopyUnavailable | ExportShareUnavailable) {
    super(refusal.reasonCode)
    this.name = 'ExportActionUnavailableError'
    this.reasonCode = refusal.reasonCode
  }
}

/** Why a completed result may not be delivered now. */
export type ExportDeliveryRefusal =
  | 'unmounted'
  | 'unidentified'
  | 'session-changed'
  | 'result-replaced'
  | 'attempt-replaced'
  | 'graph-changed'
  | 'transform-pending'
  | 'input-changed'

/** The workflow as it stands, read afresh at every check. */
export type ExportDeliveryLiveState = {
  mounted: boolean
  session: ImageSession | null
  /** The export graph generation; every edit of a render input moves it. */
  graphVersion: number
  /**
   * The attempt the export slot answers to: the one holding it, or the last
   * one it was given once it is empty. Null when no claim vouches for it.
   */
  exportAttempt: string | null
  /** The color intent the workflow holds; view fields are not read. */
  intent: ColorGraphIntent
  /** The LUT the workflow holds. */
  lut: LUTData | null
}

/**
 * One delivery of one result, fixed when the user asks for it: the result's
 * identity, which names the attempt that produced it, and the graph
 * generation it was asked under.
 */
export type ExportDeliveryTicket = Readonly<{
  identity: ExportResultIdentity
  graphVersion: number
}>

/**
 * Thrown by a delivery step that finds its result no longer current. The
 * delivery has had no side effect, and nothing the result owns is released.
 */
export class ExportDeliveryStaleError extends Error {
  readonly refusal: ExportDeliveryRefusal

  constructor(refusal: ExportDeliveryRefusal) {
    super('EXPORT_RESULT_STALE')
    this.name = 'ExportDeliveryStaleError'
    this.refusal = refusal
  }
}

/** Asked after every await of a delivery and right before its side effect. */
export type ExportDeliveryGuard = {
  assertCurrent: () => void
}

function sameGeometry(
  live: ImageSession['exportGeometry'],
  recorded: ExportResultIdentity['geometry'],
) {
  if (!live || !recorded) return !live && !recorded
  return (
    live.constrainCrop === recorded.constrainCrop &&
    live.matrix.length === recorded.matrix.length &&
    live.matrix.every((value, index) =>
      Object.is(value, recorded.matrix[index]),
    )
  )
}

/**
 * Whether the workflow still asks for exactly what this identity answers:
 * the same session and source, the same color intent and LUT, the same
 * committed geometry, and a Transform status the result's kind accepts. The
 * RAW render exposure is pinned per source, so the source covers it. View,
 * split, zoom and pan are never read.
 */
function resolveLiveInputRefusal(
  identity: ExportResultIdentity,
  live: ExportDeliveryLiveState,
): ExportDeliveryRefusal | null {
  const session = live.session
  if (!session || session.id !== identity.sessionId) return 'session-changed'
  const sourceFile = session.sourceFile.file
  if (!sourceFile) return 'session-changed'
  if (deriveTransformExportRefusalReason(session, identity.resultKind)) {
    return 'transform-pending'
  }
  if (!sameGeometry(session.exportGeometry, identity.geometry)) {
    return 'input-changed'
  }
  const current = captureExportResultIdentity({
    resultKind: identity.resultKind,
    attemptId: identity.attemptId,
    sessionId: session.id,
    sourceFile,
    intent: live.intent,
    lut: live.lut,
    rawRenderExposure: identity.rawRenderExposure,
    geometry: session.exportGeometry ?? null,
  })
  return isSameExportResultInput(current, identity) ? null : 'input-changed'
}

/**
 * Open a delivery of the result the session holds now. A result without an
 * identity, or one the workflow has moved on from, is never delivered.
 */
export function openExportDelivery(
  result: ExportResult | undefined,
  live: ExportDeliveryLiveState,
):
  | { kind: 'open'; ticket: ExportDeliveryTicket }
  | { kind: 'refused'; refusal: ExportDeliveryRefusal } {
  if (!live.mounted) return { kind: 'refused', refusal: 'unmounted' }
  const identity = result?.identity
  if (!result || !identity || identity.resultKind !== result.kind) {
    return { kind: 'refused', refusal: 'unidentified' }
  }
  const held = live.session?.exportState.result?.identity
  if (!held || !isSameExportResult(held, identity)) {
    return { kind: 'refused', refusal: 'result-replaced' }
  }
  if (live.exportAttempt !== identity.attemptId) {
    return { kind: 'refused', refusal: 'attempt-replaced' }
  }
  const refusal = resolveLiveInputRefusal(identity, live)
  if (refusal) return { kind: 'refused', refusal }
  return {
    kind: 'open',
    ticket: Object.freeze({ identity, graphVersion: live.graphVersion }),
  }
}

/**
 * Whether the delivery is still current: nothing has invalidated the graph,
 * the export slot still answers to the attempt that produced the result, the
 * session still holds this very result, and the live inputs still name its
 * request. A slot that attempt released still answers to it; one a later
 * attempt claimed never does again, even after that attempt ends.
 */
export function checkExportDelivery(
  ticket: ExportDeliveryTicket,
  live: ExportDeliveryLiveState,
): ExportDeliveryRefusal | null {
  if (!live.mounted) return 'unmounted'
  if (live.graphVersion !== ticket.graphVersion) return 'graph-changed'
  if (live.exportAttempt !== ticket.identity.attemptId) {
    return 'attempt-replaced'
  }
  const held = live.session?.exportState.result?.identity
  if (!live.session || live.session.id !== ticket.identity.sessionId) {
    return 'session-changed'
  }
  if (!held || !isSameExportResult(held, ticket.identity)) {
    return 'result-replaced'
  }
  return resolveLiveInputRefusal(ticket.identity, live)
}

/** A guard that reads the live state afresh each time it is asked. */
export function createExportDeliveryGuard(
  ticket: ExportDeliveryTicket,
  readLive: () => ExportDeliveryLiveState,
): ExportDeliveryGuard {
  return {
    assertCurrent() {
      const refusal = checkExportDelivery(ticket, readLive())
      if (refusal) throw new ExportDeliveryStaleError(refusal)
    },
  }
}

function reportMaterialized(
  result: ExportResult,
  action: ExportOutputMaterializationAction,
  byteLength: number,
  diagnostics: MaterializationDiagnostics | undefined,
  cleanup: ExportOutputMaterializationEvent['cleanup'],
) {
  try {
    diagnostics?.onMaterialize?.({
      action,
      outputKind: result.output.kind,
      filename: result.filename,
      byteLength,
      materializedAt: diagnostics.now?.() ?? new Date().toISOString(),
      cleanup,
    })
  } catch {
    // Materialization diagnostics must not affect user actions.
  }
}

function createShareProbeFile(result: ExportResult) {
  return new File([], result.filename, {
    type: result.output.mimeType || 'image/jpeg',
    lastModified: result.createdAt,
  })
}

async function createShareFile(
  result: ExportResult,
  guard: ExportDeliveryGuard | undefined,
) {
  const blob = await materializeOutputBlob(result.output)
  guard?.assertCurrent()
  return new File([blob], result.filename, {
    type: blob.type || result.output.mimeType || 'image/jpeg',
    lastModified: result.createdAt,
  })
}

export function resolveExportShareCapability(
  result: ExportResult,
  navigatorLike: Navigator = navigator,
): ExportShareCapability {
  if (
    typeof navigatorLike.canShare === 'function' &&
    typeof navigatorLike.share === 'function' &&
    navigatorLike.canShare({ files: [createShareProbeFile(result)] })
  ) {
    return { available: true }
  }

  return unavailableExportShare('share-unsupported')
}

export function resolveExportShareButtonCapability(
  navigatorLike: Pick<Navigator, 'canShare' | 'share'> = navigator,
): ExportShareCapability {
  if (
    typeof navigatorLike.canShare === 'function' &&
    typeof navigatorLike.share === 'function'
  ) {
    return { available: true }
  }

  return unavailableExportShare('share-unsupported')
}

export async function shareExportResult(
  result: ExportResult,
  navigatorLike: Navigator = navigator,
  diagnostics?: MaterializationDiagnostics,
  guard?: ExportDeliveryGuard,
) {
  guard?.assertCurrent()
  const capability = resolveExportShareCapability(result, navigatorLike)
  if (!capability.available) {
    throw new ExportActionUnavailableError(capability)
  }

  const file = await createShareFile(result, guard)
  reportMaterialized(result, 'share', file.size, diagnostics, 'not-needed')
  guard?.assertCurrent()
  await navigatorLike.share({
    files: [file],
    title: result.filename,
  })
}

type DeliveryEnvironment = {
  document?: Document
  URL?: typeof URL
  /** Asked before each side effect; the workflow always passes one. */
  guard?: ExportDeliveryGuard
} & MaterializationDiagnostics

export async function downloadExportResult(
  result: ExportResult,
  environment: DeliveryEnvironment = {},
) {
  const documentLike = environment.document ?? document
  const urlLike = environment.URL ?? URL
  environment.guard?.assertCurrent()
  const blob = await materializeOutputBlob(result.output)
  environment.guard?.assertCurrent()
  reportMaterialized(result, 'download', blob.size, environment, 'scheduled')
  // The diagnostics run caller code, which may move the workflow on.
  environment.guard?.assertCurrent()
  const url = urlLike.createObjectURL(blob)
  const link = documentLike.createElement('a')

  link.href = url
  link.download = result.filename
  documentLike.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => {
    urlLike.revokeObjectURL(url)
  }, 0)
}

export function resolveExportCopyCapability(
  environment: ClipboardEnvironment = globalThis,
): ExportCopyCapability {
  const write = environment.navigator?.clipboard?.write
  const ClipboardItemCtor = environment.ClipboardItem

  if (typeof write !== 'function' || !ClipboardItemCtor) {
    return unavailableExportCopy('clipboard-unsupported')
  }

  if (ClipboardItemCtor.supports?.('image/jpeg')) {
    return { mode: 'full-resolution' }
  }

  if (ClipboardItemCtor.supports?.('image/png')) {
    return {
      mode: 'preview-size',
      reasonCode: 'full-resolution-copy-unsupported',
    }
  }

  return unavailableExportCopy('clipboard-unsupported')
}

export async function copyBlobToClipboard(
  blob: Blob,
  environment: ClipboardEnvironment = globalThis,
  guard?: ExportDeliveryGuard,
) {
  const clipboard = environment.navigator?.clipboard
  const ClipboardItemCtor = environment.ClipboardItem

  if (typeof clipboard?.write !== 'function' || !ClipboardItemCtor) {
    throw new ExportActionUnavailableError(
      unavailableExportCopy('clipboard-unsupported'),
    )
  }

  const type = blob.type || 'image/jpeg'
  guard?.assertCurrent()
  await clipboard.write([new ClipboardItemCtor({ [type]: blob })])
}

export async function copyExportResultToClipboard(
  result: ExportResult,
  environment: ClipboardEnvironment = globalThis,
  diagnostics?: MaterializationDiagnostics,
  guard?: ExportDeliveryGuard,
) {
  guard?.assertCurrent()
  const blob = await materializeOutputBlob(result.output)
  guard?.assertCurrent()
  reportMaterialized(result, 'copy', blob.size, diagnostics, 'not-needed')
  await copyBlobToClipboard(blob, environment, guard)
}

/**
 * Thrown when the browser encodes no image from the preview canvas: its
 * `toBlob` hands back no blob and says nothing about why.
 */
export class PreviewCopyEncodeError extends Error {
  constructor() {
    super('Preview image copy failed.')
    this.name = 'PreviewCopyEncodeError'
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new PreviewCopyEncodeError())
        return
      }

      resolve(blob)
    }, type)
  })
}

export async function copyCanvasToClipboard(
  canvas: HTMLCanvasElement,
  environment: ClipboardEnvironment = globalThis,
  guard?: ExportDeliveryGuard,
) {
  guard?.assertCurrent()
  const blob = await canvasToBlob(canvas, 'image/png')
  guard?.assertCurrent()
  const pngBlob =
    blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })

  await copyBlobToClipboard(pngBlob, environment, guard)
}

export function exportManifestFilename(result: Pick<ExportResult, 'filename'>) {
  return `${result.filename.replace(/\.jpe?g$/i, '')}.manifest.json`
}

/**
 * Download the sealed render manifest as a JSON sidecar named after the JPEG
 * (`<name>.manifest.json`). Requires a result that carries a manifest.
 */
export async function downloadExportManifest(
  result: ExportResult,
  environment: DeliveryEnvironment = {},
) {
  if (!result.manifest) {
    throw new Error('EXPORT_MANIFEST_UNAVAILABLE')
  }
  environment.guard?.assertCurrent()
  const documentLike = environment.document ?? document
  const urlLike = environment.URL ?? URL
  const blob = new Blob([JSON.stringify(result.manifest, null, 2)], {
    type: 'application/json',
  })
  reportMaterialized(result, 'manifest', blob.size, environment, 'scheduled')
  environment.guard?.assertCurrent()
  const url = urlLike.createObjectURL(blob)
  const link = documentLike.createElement('a')

  link.href = url
  link.download = exportManifestFilename(result)
  documentLike.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => {
    urlLike.revokeObjectURL(url)
  }, 0)
}
