import type { LUTData } from '@lumaforge/luma-color-runtime'

const recordKeys = new WeakMap<LUTData, string>()
let lastRecord = 0

/**
 * The key preview work drawn through a LUT is cached and compared under. The
 * store holds one object per LUT record, and a load or a contract choice
 * stores a new one, so the object names the record: its key is minted the
 * first time it is asked for and lasts as long as the record. It tells
 * records apart on this page only and is never a content hash.
 */
export function lutRecordKey(lut: LUTData | null): string {
  if (!lut) return 'no-lut'
  let key = recordKeys.get(lut)
  if (key === undefined) {
    lastRecord += 1
    key = `lut-${lastRecord}`
    recordKeys.set(lut, key)
  }
  return key
}
