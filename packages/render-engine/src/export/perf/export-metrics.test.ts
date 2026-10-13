import { describe, expect, it } from 'vitest'

import { createExportMetricCollector } from './export-metrics'

describe('export performance metrics', () => {
  it('stamps each stage record with the export it belongs to', () => {
    const collector = createExportMetricCollector({
      requestId: 'export-1',
      fileName: 'sample.RAF',
      width: 11662,
      height: 8746,
      browser: 'unit-test',
    })
    const base = {
      requestId: 'export-1',
      fileName: 'sample.RAF',
      width: 11662,
      height: 8746,
      megapixels: 101.99,
      browser: 'unit-test',
    }

    expect(
      collector.record({
        kind: 'strip',
        stripIndex: 0,
        totalStrips: 2,
        rows: 512,
        rawReadMs: 10,
        colorMs: 4,
        jpegWriteMs: 2,
        totalMs: 16,
      }),
    ).toMatchObject({ ...base, kind: 'strip', rawReadMs: 10, colorMs: 4 })
    expect(
      collector.record({
        kind: 'summary',
        stripRows: 512,
        retries: 0,
        concurrency: 1,
        totalMs: 32,
        outputBytes: 1024,
      }),
    ).toMatchObject({ ...base, kind: 'summary', outputBytes: 1024 })
  })
})
