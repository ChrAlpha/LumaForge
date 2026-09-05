// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  createSessionId,
  formatCandidateId,
  formatIterationId,
  formatPreviewId,
  isSessionId,
} from './ids'

describe('ids', () => {
  it('creates spec-shaped session ids', () => {
    const id = createSessionId(new Date('2026-09-05T02:03:04Z'), () => 'abc123')
    expect(id).toBe('sess_20260905T020304_abc123')
    expect(isSessionId(id)).toBe(true)
    expect(isSessionId('sess_x')).toBe(false)
  })

  it('formats zero-padded iteration, candidate, preview ids', () => {
    expect(formatIterationId(1)).toBe('iter_0001')
    expect(formatCandidateId(12)).toBe('cand_0012')
    expect(formatPreviewId(3)).toBe('prev_0003')
  })
})
