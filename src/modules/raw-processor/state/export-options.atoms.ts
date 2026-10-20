import { atom } from 'jotai'

import { createAtomHooks } from '~/lib/jotai'

/**
 * Whether a full-resolution export also writes the HDR gain map. An export
 * option, not color intent: it changes the file the export writes, never the
 * photo the preview or the SDR JPEG shows. The export reads it from the store
 * when it starts.
 */
const baseHdrExportAtom = atom<boolean>(false)

export const [, , useHdrExportValue, , getHdrExport, setHdrExport] =
  createAtomHooks(baseHdrExportAtom)
