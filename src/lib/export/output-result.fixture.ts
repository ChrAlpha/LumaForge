import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'

export function createMemoryFileBackedOutputResult(input: {
  exportId: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): FileBackedOutputResult {
  const bytes = new Uint8Array(input.bytes)
  const openBlob = async () => {
    const byteBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const blob = new Blob([byteBuffer], { type: input.mimeType })
    return blob
  }

  return {
    kind: 'file-backed',
    exportId: input.exportId,
    filename: input.filename,
    byteLength: bytes.byteLength,
    mimeType: input.mimeType,
    openBlob,
  }
}
