import type { MessageKey } from '~/lib/i18n'

import type { OnlineLUTSourceIssue } from '../../../services/look/online-lut-sources'

// Online LUT issues arrive as a finite set of machine codes from the source-url
// parser, the catalog parser, and the fetch layer. We map each code to a
// concise, translatable line instead of surfacing raw runtime strings (which
// embed full URLs and never get localized). The owning source row already names
// which source failed, so the message stays about the "why".
const ISSUE_MESSAGE_KEYS: Record<string, MessageKey> = {
  // fetch layer
  network: 'raw.lutSource.issues.network',
  'size-limit': 'raw.lutSource.issues.sizeLimit',
  'invalid-json': 'raw.lutSource.issues.invalidJson',
  'hash-mismatch': 'raw.lutSource.issues.hashMismatch',
  'unsupported-crypto': 'raw.lutSource.issues.unsupportedCrypto',
  // source URL parser
  'empty-url': 'raw.lutSource.issues.emptyUrl',
  'invalid-url': 'raw.lutSource.issues.invalidUrl',
  'unsupported-scheme': 'raw.lutSource.issues.unsupportedScheme',
  'credentialed-url': 'raw.lutSource.issues.credentialedUrl',
  'unsupported-resource': 'raw.lutSource.issues.unsupportedResource',
  // catalog/entry parser
  'invalid-catalog': 'raw.lutSource.issues.invalidCatalog',
  'invalid-entry': 'raw.lutSource.issues.invalidEntry',
  'unsupported-entry': 'raw.lutSource.issues.unsupportedEntry',
  'unsupported-asset': 'raw.lutSource.issues.unsupportedAsset',
  'missing-sha256': 'raw.lutSource.issues.missingSha256',
  'unsupported-contract': 'raw.lutSource.issues.unsupportedContract',
}

const GENERIC_MESSAGE_KEY: MessageKey = 'raw.lutSource.issues.generic'

export function lutIssueMessageKey(code: string): MessageKey {
  return ISSUE_MESSAGE_KEYS[code] ?? GENERIC_MESSAGE_KEY
}

export interface LutIssueSummary {
  code: string
  messageKey: MessageKey
  /** Total number of issues collapsed into this summary (>= 1). */
  count: number
}

// Collapse a source's issues into a single demoted line: lead with the first
// issue's reason and keep a count so a noisy catalog reads as one warning with
// "+N more" rather than a tall stack of chips.
export function summarizeLutIssues(
  issues: readonly OnlineLUTSourceIssue[],
): LutIssueSummary | null {
  const [primary] = issues
  if (!primary) return null

  return {
    code: primary.code,
    messageKey: lutIssueMessageKey(primary.code),
    count: issues.length,
  }
}
