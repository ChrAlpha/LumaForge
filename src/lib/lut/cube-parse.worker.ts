import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import { parseCubeLUT } from '@lumaforge/luma-color-runtime'

// Workers have no localStorage: parse with the pure package parser and let the
// main thread restore persisted user contracts by fingerprint.

export interface CubeParseRequest {
  id: number
  source: string | Uint8Array
  sourceName?: string
}

export type CubeParseResponse =
  | { id: number; ok: true; parsed: ParsedLUT }
  | { id: number; ok: false; message: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CubeParseRequest>) => void) | null
  postMessage: (msg: CubeParseResponse, transfer?: Transferable[]) => void
}

scope.onmessage = (event) => {
  const { id, source, sourceName } = event.data

  try {
    const content =
      typeof source === 'string' ? source : new TextDecoder().decode(source)
    const parsed = parseCubeLUT(content, { sourceName })
    scope.postMessage({ id, ok: true, parsed }, [parsed.data.buffer])
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to parse LUT',
    })
  }
}
