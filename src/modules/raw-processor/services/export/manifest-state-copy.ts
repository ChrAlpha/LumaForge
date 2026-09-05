import type { MessageKey } from '~/lib/i18n'

import type {
  ExportManifestState,
  ExportManifestUnavailableReason,
} from '../../model/export-result'

const MANIFEST_UNAVAILABLE_KEYS: Record<
  ExportManifestUnavailableReason,
  MessageKey
> = {
  'lut-unconfirmed': 'raw.export.manifestUnavailableLutUnconfirmed',
  'lut-unhashed': 'raw.export.manifestUnavailableLutUnhashed',
  'output-unhashed': 'raw.export.manifestUnavailableOutputUnhashed',
  internal: 'raw.export.manifestUnavailableInternal',
}

/** i18n key for the Manifest action's title (desktop) or accessible name (mobile). */
export function manifestActionTitleKey(state: ExportManifestState): MessageKey {
  switch (state.status) {
    case 'ready': {
      return 'raw.export.downloadManifestTitle'
    }
    case 'sealing': {
      return 'raw.export.manifestSealing'
    }
    case 'unavailable': {
      return MANIFEST_UNAVAILABLE_KEYS[state.reason]
    }
  }
}
