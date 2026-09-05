import { materializeOutputBlob } from '~/lib/export/output-sink'

import type {
  ExportCopyCapability,
  ExportResult,
  ExportShareCapability,
} from '../../model/export-result'

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

async function createShareFile(result: ExportResult) {
  const blob = await materializeOutputBlob(result.output)
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

  return {
    available: false,
    reason: 'This browser cannot share JPEG files.',
  }
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

  return {
    available: false,
    reason: 'This browser cannot share JPEG files.',
  }
}

export async function shareExportResult(
  result: ExportResult,
  navigatorLike: Navigator = navigator,
  diagnostics?: MaterializationDiagnostics,
) {
  const capability = resolveExportShareCapability(result, navigatorLike)
  if (!capability.available) {
    throw new Error(capability.reason)
  }

  const file = await createShareFile(result)
  reportMaterialized(result, 'share', file.size, diagnostics, 'not-needed')
  await navigatorLike.share({
    files: [file],
    title: result.filename,
  })
}

export async function downloadExportResult(
  result: ExportResult,
  environment: {
    document?: Document
    URL?: typeof URL
  } & MaterializationDiagnostics = {},
) {
  const documentLike = environment.document ?? document
  const urlLike = environment.URL ?? URL
  const blob = await materializeOutputBlob(result.output)
  reportMaterialized(result, 'download', blob.size, environment, 'scheduled')
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
    return {
      mode: 'unavailable',
      reason: 'Clipboard image copy is not supported in this browser.',
    }
  }

  if (ClipboardItemCtor.supports?.('image/jpeg')) {
    return {
      mode: 'full-resolution',
      label: 'Copy full-resolution image',
    }
  }

  if (ClipboardItemCtor.supports?.('image/png')) {
    return {
      mode: 'preview-size',
      label: 'Copy preview-size image',
      reason: 'This browser cannot copy full-resolution JPEG files.',
    }
  }

  return {
    mode: 'unavailable',
    reason: 'Clipboard image copy is not supported in this browser.',
  }
}

export async function copyBlobToClipboard(
  blob: Blob,
  environment: ClipboardEnvironment = globalThis,
) {
  const clipboard = environment.navigator?.clipboard
  const ClipboardItemCtor = environment.ClipboardItem

  if (typeof clipboard?.write !== 'function' || !ClipboardItemCtor) {
    throw new Error('Clipboard image copy is not supported in this browser.')
  }

  const type = blob.type || 'image/jpeg'
  await clipboard.write([new ClipboardItemCtor({ [type]: blob })])
}

export async function copyExportResultToClipboard(
  result: ExportResult,
  environment: ClipboardEnvironment = globalThis,
  diagnostics?: MaterializationDiagnostics,
) {
  const blob = await materializeOutputBlob(result.output)
  reportMaterialized(result, 'copy', blob.size, diagnostics, 'not-needed')
  await copyBlobToClipboard(blob, environment)
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Preview image copy failed.'))
        return
      }

      resolve(blob)
    }, type)
  })
}

export async function copyCanvasToClipboard(
  canvas: HTMLCanvasElement,
  environment: ClipboardEnvironment = globalThis,
) {
  const blob = await canvasToBlob(canvas, 'image/png')
  const pngBlob =
    blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })

  await copyBlobToClipboard(pngBlob, environment)
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
  environment: {
    document?: Document
    URL?: typeof URL
  } & MaterializationDiagnostics = {},
) {
  if (!result.manifest) {
    throw new Error('EXPORT_MANIFEST_UNAVAILABLE')
  }
  const documentLike = environment.document ?? document
  const urlLike = environment.URL ?? URL
  const blob = new Blob([JSON.stringify(result.manifest, null, 2)], {
    type: 'application/json',
  })
  reportMaterialized(result, 'manifest', blob.size, environment, 'scheduled')
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
