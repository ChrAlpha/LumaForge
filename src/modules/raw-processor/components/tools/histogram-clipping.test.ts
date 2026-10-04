import { describe, expect, it } from 'vitest'

import { formatClippingPercent } from './histogram-clipping'

describe('formatClippingPercent', () => {
  it('reads 0% only for a true zero', () => {
    expect(formatClippingPercent(0, 1_000_000)).toBe('0%')
    expect(formatClippingPercent(0, 0)).toBe('0%')
    expect(formatClippingPercent(1, 1_000_000)).toBe('<0.1%')
  })

  it('keeps one decimal below 10% and whole numbers above', () => {
    expect(formatClippingPercent(21_019, 1_747_200)).toBe('1.2%')
    expect(formatClippingPercent(10_048, 1_747_200)).toBe('0.6%')
    expect(formatClippingPercent(1, 2)).toBe('50%')
    expect(formatClippingPercent(123, 1000)).toBe('12%')
  })

  it('never rounds a partial share up to the whole frame', () => {
    expect(formatClippingPercent(999_999, 1_000_000)).toBe('>99%')
    expect(formatClippingPercent(1_000_000, 1_000_000)).toBe('100%')
  })
})
