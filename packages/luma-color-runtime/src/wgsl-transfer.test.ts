import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { TRANSFER_FUNCTIONS } from './log-encoding'
import { LUMA_COLOR_TRANSFER_WGSL, LUT_TRANSFER_UNIFORMS } from './wgsl'

// This checks the port's scalar formulas with JS number arithmetic. It does
// not compile WGSL or stand in for browser GPU f32 readback comparisons.
function scalarTransferEvaluator() {
  const constants = LUMA_COLOR_TRANSFER_WGSL.match(/^const TRANSFER_.+;$/gm)!
  const functions: string[] = []
  const signature = /fn (\w+)\(([^)]*)\) -> f32 \{/g
  for (const match of LUMA_COLOR_TRANSFER_WGSL.matchAll(signature)) {
    let end = match.index! + match[0].length
    let depth = 1
    while (depth > 0 && end < LUMA_COLOR_TRANSFER_WGSL.length) {
      const token = LUMA_COLOR_TRANSFER_WGSL[end++]
      if (token === '{') depth++
      if (token === '}') depth--
    }
    expect(depth).toBe(0)
    const body = LUMA_COLOR_TRANSFER_WGSL.slice(
      match.index! + match[0].length,
      end,
    )
    functions.push(`function ${match[1]}(${match[2]}) {${body}`)
  }
  const source = [...constants, ...functions]
    .join('\n')
    .replace(/: (f32|i32)/g, '')
  return runInNewContext(
    `${source}\n({ encode: encodeTransferChannel, decode: decodeTransferChannel })`,
    {
      pow: Math.pow,
      max: Math.max,
      min: Math.min,
      log: Math.log,
      log2: Math.log2,
      sign: Math.sign,
      abs: Math.abs,
      exp: Math.exp,
      sqrt: Math.sqrt,
    },
    { timeout: 1000 },
  ) as {
    encode: (value: number, transfer: number) => number
    decode: (value: number, transfer: number) => number
  }
}

describe('wGSL scalar transfer formula parity with CPU', () => {
  const evaluator = scalarTransferEvaluator()
  const samples = [
    -1,
    -0.1,
    -0.05641088,
    -0.0126,
    -0.01,
    -0.0001,
    0,
    2 ** -16,
    2 ** -15,
    0.000889,
    0.00089,
    0.0031308,
    0.006,
    0.0078,
    0.0078125,
    0.01,
    0.010591,
    0.01125,
    0.0126,
    0.018,
    0.04045,
    0.0730597,
    0.081,
    0.092864125,
    0.097465473,
    0.100537775223865,
    0.100686685370811,
    0.138,
    0.14,
    0.1496,
    0.15277891,
    0.155251141552511,
    0.18,
    0.181,
    0.328,
    1,
    2,
    8,
  ].flatMap((value) => [value - 1e-9, value, value + 1e-9])

  for (const [id, transfer] of Object.entries(TRANSFER_FUNCTIONS)) {
    it(`preserves ${id} encoding and decoding across signed values and curve toes`, () => {
      const uniform = LUT_TRANSFER_UNIFORMS[transfer.id]
      for (const operation of ['encode', 'decode'] as const) {
        for (const value of samples) {
          const expected = transfer[operation](value)
          const actual = evaluator[operation](value, uniform)
          const tolerance = Math.max(1, Math.abs(expected)) * 1e-12
          expect(
            Math.abs(actual - expected),
            `${operation}(${value})`,
          ).toBeLessThanOrEqual(tolerance)
        }
      }
    })
  }
})
