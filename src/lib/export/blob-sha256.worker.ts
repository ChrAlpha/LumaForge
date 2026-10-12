import { sha256OfBlob } from './blob-sha256'

export interface BlobSha256Request {
  id: number
  blob: Blob
}

export type BlobSha256Response =
  | { id: number; ok: true; sha256: string }
  | { id: number; ok: false; message: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BlobSha256Request>) => void) | null
  postMessage: (msg: BlobSha256Response) => void
}

scope.onmessage = (event) => {
  const { id, blob } = event.data
  sha256OfBlob(blob).then(
    (sha256) => scope.postMessage({ id, ok: true, sha256 }),
    (error: unknown) =>
      scope.postMessage({
        id,
        ok: false,
        message: error instanceof Error ? error.message : 'Blob hash failed.',
      }),
  )
}
