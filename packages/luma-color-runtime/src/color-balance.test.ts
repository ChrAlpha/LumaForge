import { describe, expect, it } from 'vitest'

import {
  normalizeColorBalanceParams,
  resolveColorBalanceParams,
} from './color-balance'

function expectCloseTriplet(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
) {
  expect(actual[0]).toBeCloseTo(expected[0], 6)
  expect(actual[1]).toBeCloseTo(expected[1], 6)
  expect(actual[2]).toBeCloseTo(expected[2], 6)
}

describe('color balance', () => {
  it('normalizes invalid and out-of-range input to finite UI bounds', () => {
    expect(
      normalizeColorBalanceParams({
        userTemperature: Number.POSITIVE_INFINITY,
        userTint: Number.NaN,
      }),
    ).toEqual({ userTemperature: 0, userTint: 0 })

    expect(
      normalizeColorBalanceParams({
        userTemperature: 140,
        userTint: -180,
      }),
    ).toEqual({ userTemperature: 100, userTint: -100 })
  })

  it('resolves neutral controls to identity gain', () => {
    const resolved = resolveColorBalanceParams({
      userTemperature: 0,
      userTint: 0,
    })

    expect(resolved.userTemperature).toBe(0)
    expect(resolved.userTint).toBe(0)
    expectCloseTriplet(resolved.gain, [1, 1, 1])
  })

  it('warms by increasing red relative to blue', () => {
    const warm = resolveColorBalanceParams({
      userTemperature: 100,
      userTint: 0,
    })
    const cool = resolveColorBalanceParams({
      userTemperature: -100,
      userTint: 0,
    })

    expect(warm.gain[0]).toBeGreaterThan(warm.gain[2])
    expect(cool.gain[2]).toBeGreaterThan(cool.gain[0])
  })

  it('tints magenta by reducing green relative to red and blue', () => {
    const magenta = resolveColorBalanceParams({
      userTemperature: 0,
      userTint: 100,
    })
    const green = resolveColorBalanceParams({
      userTemperature: 0,
      userTint: -100,
    })

    expect(magenta.gain[1]).toBeLessThan(magenta.gain[0])
    expect(magenta.gain[1]).toBeLessThan(magenta.gain[2])
    expect(green.gain[1]).toBeGreaterThan(green.gain[0])
    expect(green.gain[1]).toBeGreaterThan(green.gain[2])
  })
})
