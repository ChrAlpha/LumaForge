import { useMemo } from 'react'

import type { ImageMetadata } from '~/lib/raw/decoder'

import { deriveCanEdit } from '../../../model/derive-session'
import type {
  DisplaySource,
  ImageSession,
  SupportLevel,
} from '../../../model/session'
import { toAppSupportLevel } from '../../../model/session-factory'
import type { ProcessingStatus } from '../../../model/workflow'
import { getProgressRecoveryHint } from '../../../services/ingest/workflow-status'

type UseRawSourceStateInput = {
  session: ImageSession | null
  status: ProcessingStatus
}

type LoadedImage = {
  file: File | null
  metadata: ImageMetadata | null
}

export function useRawSourceState({ session, status }: UseRawSourceStateInput) {
  const loadedImage = useMemo<LoadedImage>(
    () => ({
      file: session?.sourceFile.file ?? null,
      metadata: session?.sourceFile.metadata ?? null,
    }),
    [session?.sourceFile.file, session?.sourceFile.metadata],
  )

  const hasImage = session ? deriveCanEdit(session) : false
  const sourceFileName =
    session?.sourceFile.name || loadedImage.file?.name || 'RAW photo'
  const supportLevel: SupportLevel = toAppSupportLevel(
    session?.sourceFile.supportLevel ?? 'experimental',
  )
  const progressRecoveryHint = getProgressRecoveryHint(status)
  const embeddedPreviewUrl =
    session?.previewBundle.embeddedPreview.objectUrl || null
  const displaySource: DisplaySource =
    session?.previewBundle.displaySource || 'none'

  return {
    hasImage,
    loadedImage,
    sourceFileName,
    supportLevel,
    progressRecoveryHint,
    embeddedPreviewUrl,
    displaySource,
  }
}
