/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as hdrAnalysis from './hdr-analysis'
import type { RawDynamicRangeInfo } from './index'
import { analyzeRawDynamicRange } from './index'
import type { LumaRawMetadata } from './types'

function metadata(levels: Partial<LumaRawMetadata>): LumaRawMetadata {
  return { supportLevel: 'official', ...levels }
}

describe('analyzeRawDynamicRange (deprecated, kept for compatibility)', () => {
  it('is still exported from the package entry as the same function', () => {
    expect(analyzeRawDynamicRange).toBe(hdrAnalysis.analyzeRawDynamicRange)
  })

  it('recommends HDR when white sits 12+ stops above black and the frame fills the sensor', () => {
    const info: RawDynamicRangeInfo = analyzeRawDynamicRange(
      metadata({
        blackLevel: 2,
        whiteLevel: 16383,
        dataMaximum: 15000,
        perChannelBlack: [2, 2, 2, 2],
      }),
    )

    expect(info).toEqual({
      engineeringDynamicRange: Math.log2(16383 / 2),
      sensorUtilization: (15000 - 2) / (16383 - 2),
      highlightHeadroom: Math.log2(16383 / 15000),
      effectiveBitDepth: 14,
      perChannelBlack: [2, 2, 2, 2],
      sensorSaturation: 16383 - 2,
      recommendation: 'hdr-recommended',
    })
  })

  it('reports HDR-capable for 10+ stops when the frame barely uses the sensor', () => {
    const info = analyzeRawDynamicRange(
      metadata({ blackLevel: 2, whiteLevel: 16383, dataMaximum: 2000 }),
    )

    expect(info.recommendation).toBe('hdr-capable')
    expect(info.perChannelBlack).toBeNull()
  })

  it('reports SDR for a typical 14-bit black level of 512', () => {
    const info = analyzeRawDynamicRange(
      metadata({ blackLevel: 512, whiteLevel: 16383, dataMaximum: 16000 }),
    )

    expect(info.engineeringDynamicRange).toBe(Math.log2(16383 / 512))
    expect(info.effectiveBitDepth).toBe(14)
    expect(info.recommendation).toBe('sdr')
  })

  it('returns null facts when the levels are missing or unusable', () => {
    const empty = {
      engineeringDynamicRange: null,
      sensorUtilization: null,
      highlightHeadroom: null,
      effectiveBitDepth: null,
      perChannelBlack: null,
      sensorSaturation: null,
      recommendation: 'sdr',
    }

    expect(analyzeRawDynamicRange(metadata({}))).toEqual(empty)
    expect(
      analyzeRawDynamicRange(metadata({ blackLevel: 0, whiteLevel: 16383 })),
    ).toEqual(empty)
    expect(
      analyzeRawDynamicRange(metadata({ blackLevel: 600, whiteLevel: 500 })),
    ).toEqual(empty)
  })

  it('marks both public declarations @deprecated in their doc comments', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'hdr-analysis.ts'),
      'utf8',
    )
    const deprecatedDeclaration = (declaration: string) =>
      new RegExp(
        String.raw`/\*\*(?:(?!\*/)[\s\S])*@deprecated(?:(?!\*/)[\s\S])*\*/\s*${declaration}\b`,
      )

    expect(source).toMatch(
      deprecatedDeclaration('export type RawDynamicRangeInfo'),
    )
    expect(source).toMatch(
      deprecatedDeclaration('export function analyzeRawDynamicRange'),
    )
  })
})
