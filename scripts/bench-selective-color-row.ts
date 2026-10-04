/**
 * Selective-color CPU micro-benchmark.
 *
 * Wall-clock timing for the row-band path of the selective-color OKLab/OKLch
 * shift. Used as a measured baseline for the selective-color performance
 * budget. Intentionally observational — no asserts, no
 * acceptance threshold. Capture the output in commit/PR notes when shipping
 * changes that touch the row path.
 *
 * Implementation notes:
 *   - 1024×1024 (1 MP) interleaved linear-ProPhoto buffer. Synthetic gradient
 *     across hue/saturation/lightness via deterministic OKLch construction so
 *     the LUT actually sees coverage rather than degenerate neutrals.
 *   - Non-trivial bake params (red.hue=+50, blue.saturation=-30) so the LUT
 *     buffer is populated with measurable shifts (not the all-zero degenerate).
 *   - Per-step decomposition (matmul forward, signedCbrt, atan2, LUT sample,
 *     sin/cos, matmul inverse) would require instrumenting helpers and is
 *     deferred to a follow-up. v1 reports total wall-clock + pixels/ms only.
 *
 * Run:
 *   pnpm exec tsx scripts/bench-selective-color-row.ts
 *
 * Node 24+ also runs this directly via native TS type-stripping:
 *   node scripts/bench-selective-color-row.ts
 */

import { performance } from 'node:perf_hooks'

import {
  applySelectiveColorRow,
  oklabToLinearProPhoto,
  oklchToOklab,
  resolveSelectiveColorParams,
} from '@lumaforge/luma-color-runtime'

const WIDTH = 1024
const HEIGHT = 1024
const ITERATIONS = 10
const WARMUP_ITERATIONS = 2

function buildSyntheticGradient(): Float32Array {
  const pixels = WIDTH * HEIGHT
  const buf = new Float32Array(pixels * 3)
  const lab = new Float32Array(3)
  const rgb = new Float32Array(3)
  const lch = new Float32Array(3)

  // Hue across X, chroma across Y blocks, lightness modulated by a diagonal.
  for (let y = 0; y < HEIGHT; y += 1) {
    const yT = y / (HEIGHT - 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const xT = x / (WIDTH - 1)
      // OKLch h is normalised to [0, 1) per the package contract.
      lch[0] = 0.4 + 0.4 * ((xT + yT) * 0.5) // L in [0.4, 0.8]
      lch[1] = 0.04 + 0.16 * yT // C in [0.04, 0.20]
      lch[2] = xT
      oklchToOklab(lch, lab)
      oklabToLinearProPhoto(lab, rgb)
      const p = (y * WIDTH + x) * 3
      buf[p + 0] = rgb[0]
      buf[p + 1] = rgb[1]
      buf[p + 2] = rgb[2]
    }
  }

  return buf
}

function neutralBand() {
  return { hue: 0, saturation: 0, lightness: 0 }
}

function buildBakeParams() {
  return {
    selectiveColor: {
      red: { hue: 50, saturation: 0, lightness: 0 },
      orange: neutralBand(),
      yellow: neutralBand(),
      green: neutralBand(),
      aqua: neutralBand(),
      blue: { hue: 0, saturation: -30, lightness: 0 },
      purple: neutralBand(),
      magenta: neutralBand(),
    },
  }
}

function timeOnePass(
  input: Float32Array,
  output: Float32Array,
  prepared: ReturnType<typeof resolveSelectiveColorParams>['prepared'],
): number {
  const t0 = performance.now()
  applySelectiveColorRow(input, output, prepared)
  return performance.now() - t0
}

function main() {
  const input = buildSyntheticGradient()
  const output = new Float32Array(input.length)
  const { prepared } = resolveSelectiveColorParams(buildBakeParams())

  // Warm-up: amortise JIT / inline-cache priming so the first measured pass
  // isn't a cold outlier.
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    timeOnePass(input, output, prepared)
  }

  const samples: number[] = []
  let totalMs = 0
  for (let i = 0; i < ITERATIONS; i += 1) {
    const ms = timeOnePass(input, output, prepared)
    samples.push(ms)
    totalMs += ms
  }

  const pixels = WIDTH * HEIGHT
  const avgMs = totalMs / ITERATIONS
  const pixelsPerMs = pixels / avgMs
  const sorted = [...samples].sort((a, b) => a - b)
  const medianMs = sorted[Math.floor(sorted.length / 2)]
  const minMs = sorted[0]
  const maxMs = sorted.at(-1)

  console.log(
    `selective_color_row: input=${WIDTH}x${HEIGHT} (${pixels} px), iterations=${ITERATIONS}`,
  )
  console.log(`selective_color_row: total_ms_per_pass_avg=${avgMs.toFixed(3)}`)
  console.log(
    `selective_color_row: total_ms_per_pass_median=${medianMs.toFixed(3)}`,
  )
  console.log(`selective_color_row: total_ms_per_pass_min=${minMs.toFixed(3)}`)
  console.log(`selective_color_row: total_ms_per_pass_max=${maxMs.toFixed(3)}`)
  console.log(`selective_color_row: pixels_per_ms=${pixelsPerMs.toFixed(0)}`)
  console.log(
    `selective_color_row: megapixels_per_second=${((pixelsPerMs * 1000) / 1_000_000).toFixed(2)}`,
  )
}

main()
