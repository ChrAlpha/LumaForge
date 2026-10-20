import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import {
  createHdrGainMapRowBandProcessor,
  getLUTColorProfile,
  HDR_GAIN_MAP_NEUTRAL_CODE,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  concatByteRows,
  makeCapability,
  makeJpegOutput,
  makePatternedProcessedWindow,
  neutralGraph,
} from './full-res-export-test-fixtures'
import type { JpegRowSink, JpegRowSinkTrailer } from './jpeg/row-writer'

const STORED_GAIN_MAP = Uint8Array.of(0xFF, 0xD8, 0xFF, 0xD9)

/** A primary writer that keeps its rows and reports the trailer it got. */
function collectingWriter(options: { storesGainMap?: boolean } = {}) {
  const rows: Uint8Array[] = []
  const trailers: Array<JpegRowSinkTrailer | undefined> = []
  const writer = {
    writeRows: vi.fn(async (bytes: Uint8Array) => {
      rows.push(new Uint8Array(bytes))
    }),
    close: vi.fn(async (trailer?: JpegRowSinkTrailer) => {
      trailers.push(trailer)
      const output = makeJpegOutput([Uint8Array.of(0xFF, 0xD8, 0xFF, 0xD9)])
      return trailer && options.storesGainMap !== false
        ? { ...output, gainMap: { primaryByteLength: 4 } }
        : output
    }),
    abort: vi.fn(async () => undefined),
  }
  return { writer, rows, trailers }
}

/** A gain map sink that keeps its rows and hands back a stand-in JPEG. */
function collectingGainMapSink() {
  const rows: Uint8Array[] = []
  const qualities: number[] = []
  const aborts = vi.fn()
  const sink: JpegRowSink = {
    createSession({ quality }) {
      qualities.push(quality)
      return {
        async writeRows(bytes) {
          rows.push(new Uint8Array(bytes))
        },
        async close() {
          return makeJpegOutput([STORED_GAIN_MAP])
        },
        abort: aborts,
      }
    },
  }
  return { sink, rows, qualities, aborts }
}

function exportInput(size: number, graph: SupportedExportColorGraphDescriptor) {
  const rect = { x: 0, y: 0, width: size, height: size }
  return {
    capability: makeCapability({
      width: size,
      height: size,
      rawWidth: size,
      rawHeight: size,
      visibleCrop: rect,
    }),
    graph,
    preferredRows: 64,
    concurrency: 1,
    readProcessedWindow: vi.fn(async (request) =>
      makePatternedProcessedWindow(request),
    ),
  } satisfies Partial<Parameters<typeof runFullResolutionJpegExport>[0]>
}

describe('runFullResolutionJpegExport with a gain map', () => {
  const graph = neutralGraph({ userExposureEv: 1.5 })

  it('writes the SDR export unchanged and the gain map beside it', async () => {
    const size = 70
    const sdr = collectingWriter()
    await runFullResolutionJpegExport({
      ...exportInput(size, graph),
      writerFactory: () => sdr.writer,
    })

    const hdr = collectingWriter()
    const gainMap = collectingGainMapSink()
    const output = await runFullResolutionJpegExport({
      ...exportInput(size, graph),
      writerFactory: () => hdr.writer,
      hdrGainMap: { sink: gainMap.sink },
    })

    expect(concatByteRows(hdr.rows)).toEqual(concatByteRows(sdr.rows))
    expect(gainMap.qualities).toEqual([0.98])
    const window = makePatternedProcessedWindow({
      outputRect: { x: 0, y: 0, width: size, height: size },
      halo: { left: 0, top: 0, right: 0, bottom: 0 },
    })
    const expected = createHdrGainMapRowBandProcessor({
      width: size,
      rowBandRows: size,
      graph,
    }).processUint16Rows(window.data, size)
    expect(concatByteRows(gainMap.rows)).toEqual(expected.gainMap)
    // The primary sink receives the gain map with its ISO 21496-1 segments.
    const container = hdr.trailers[0]!.gainMapContainer
    expect(Array.from(container.subarray(0, 2))).toEqual([0xFF, 0xD8])
    expect(new TextDecoder().decode(container)).toContain(
      'urn:iso:std:iso:ts:21496:-1',
    )
    expect(output.gainMap).toEqual({ primaryByteLength: 4 })
  })

  it('mattes the gain map with no gain where the frame has no photograph', async () => {
    const size = 64
    const hdr = collectingWriter()
    const gainMap = collectingGainMapSink()
    await runFullResolutionJpegExport({
      ...exportInput(size, graph),
      writerFactory: () => hdr.writer,
      hdrGainMap: { sink: gainMap.sink },
      geometry: { matrix: [1, 0, 0.5, 0, 1, 0, 0, 0, 1], constrainCrop: false },
    })

    const codes = concatByteRows(gainMap.rows)
    expect(Array.from(codes.subarray(0, 3))).toEqual([
      HDR_GAIN_MAP_NEUTRAL_CODE,
      HDR_GAIN_MAP_NEUTRAL_CODE,
      HDR_GAIN_MAP_NEUTRAL_CODE,
    ])
    expect(codes).toHaveLength(concatByteRows(hdr.rows).length)
  })

  it('refuses a LUT look before reading the source', async () => {
    const input = exportInput(8, {
      ...graph,
      lutProfile: getLUTColorProfile('display-srgb')!,
    })
    const writerFactory = vi.fn(() => collectingWriter().writer)

    await expect(
      runFullResolutionJpegExport({
        ...input,
        writerFactory,
        hdrGainMap: { sink: collectingGainMapSink().sink },
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_HDR_UNSUPPORTED_LOOK')
    expect(input.readProcessedWindow).not.toHaveBeenCalled()
    expect(writerFactory).not.toHaveBeenCalled()
  })

  it('refuses a primary sink that does not store the gain map', async () => {
    await expect(
      runFullResolutionJpegExport({
        ...exportInput(8, graph),
        writerFactory: () => collectingWriter({ storesGainMap: false }).writer,
        hdrGainMap: { sink: collectingGainMapSink().sink },
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_GAIN_MAP_SINK_UNSUPPORTED')
  })

  it('aborts the gain map writer when the export fails', async () => {
    const gainMap = collectingGainMapSink()
    const input = exportInput(8, graph)
    input.readProcessedWindow.mockRejectedValueOnce(new Error('READ_FAILED'))

    await expect(
      runFullResolutionJpegExport({
        ...input,
        writerFactory: () => collectingWriter().writer,
        hdrGainMap: { sink: gainMap.sink },
      }),
    ).rejects.toThrow('READ_FAILED')
    expect(gainMap.aborts).toHaveBeenCalledTimes(1)
  })
})
