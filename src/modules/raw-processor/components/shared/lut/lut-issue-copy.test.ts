import { describe, expect, it } from 'vitest'

import type { OnlineLUTSourceIssue } from '../../../services/look/online-lut-sources'
import { lutIssueMessageKey, summarizeLutIssues } from './lut-issue-copy'

function issue(overrides: Partial<OnlineLUTSourceIssue>): OnlineLUTSourceIssue {
  return { code: 'network', message: 'raw', ...overrides }
}

describe('lutIssueMessageKey', () => {
  it('maps known codes to their translation key', () => {
    expect(lutIssueMessageKey('network')).toBe('raw.lutSource.issues.network')
    expect(lutIssueMessageKey('unsupported-scheme')).toBe(
      'raw.lutSource.issues.unsupportedScheme',
    )
  })

  it('falls back to the generic key for unknown codes', () => {
    expect(lutIssueMessageKey('fetch-failed')).toBe(
      'raw.lutSource.issues.generic',
    )
  })

  it('names a calibration document only as an invalid catalog', () => {
    expect(lutIssueMessageKey('invalid-catalog')).toBe(
      'raw.lutSource.issues.invalidCatalog',
    )
    expect(lutIssueMessageKey('calibration-catalog')).toBe(
      'raw.lutSource.issues.generic',
    )
  })
})

describe('summarizeLutIssues', () => {
  it('returns null when there are no issues', () => {
    expect(summarizeLutIssues([])).toBeNull()
  })

  it('leads with the first issue and keeps the total count', () => {
    expect(
      summarizeLutIssues([
        issue({ code: 'unsupported-entry' }),
        issue({ code: 'missing-sha256' }),
        issue({ code: 'invalid-entry' }),
      ]),
    ).toEqual({
      code: 'unsupported-entry',
      messageKey: 'raw.lutSource.issues.unsupportedEntry',
      count: 3,
    })
  })
})
