import { useEffect, useRef, useState } from 'react'

import type { PreviewFrame } from './preview-types'

export function usePreviewDownload(
  frame: PreviewFrame | undefined,
  name: string | undefined,
) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)
  const urlRef = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  async function download() {
    if (!frame) return
    setDownloading(true)
    setDownloadError(false)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = frame.width
      canvas.height = frame.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('canvas-unavailable')
      context.putImageData(
        new ImageData(
          new Uint8ClampedArray(frame.data),
          frame.width,
          frame.height,
        ),
        0,
        0,
      )
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error('encode-failed')),
          'image/jpeg',
          0.94,
        ),
      )
      if (!mounted.current) return
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = urlRef.current
      link.download = `${name?.replace(/\.[^.]+$/, '') ?? 'photo'}-transform-preview.jpg`
      document.body.append(link)
      link.click()
      link.remove()
    } catch {
      if (mounted.current) setDownloadError(true)
    } finally {
      if (mounted.current) setDownloading(false)
    }
  }
  return { download, downloading, downloadError }
}
