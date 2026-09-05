import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe } from 'vitest'

import { runCli } from '../cli'
import { detectCapabilities } from '../runtime/capability'

export const PACKAGE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)
export const FIXTURE_PATH = resolve(
  PACKAGE_DIR,
  '../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
export const fixtureReady =
  existsSync(FIXTURE_PATH) &&
  detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm
    .available
export const describeWithFixture: typeof describe = (
  fixtureReady ? describe : describe.skip
) as typeof describe

export type CliRun = {
  code: number
  stdout: string
  stderr: string
  /** Parsed JSON envelope (json mode) or the last NDJSON line (ndjson mode). */
  envelope: Record<string, unknown> & {
    ok?: boolean
    result?: Record<string, unknown>
    error?: Record<string, unknown>
  }
  lines: Array<Record<string, unknown>>
}

export function createCliHarness(cwd: string) {
  return {
    async run(...argv: string[]): Promise<CliRun> {
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(argv, {
        stdout: (s) => {
          out.push(s)
        },
        stderr: (s) => {
          err.push(s)
        },
        cwd,
      })
      const stdout = out.join('')
      const lines = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      return {
        code,
        stdout,
        stderr: err.join(''),
        envelope: (lines.at(-1) ?? {}) as CliRun['envelope'],
        lines,
      }
    },
  }
}

export function identityCube(comments: string[]): string {
  const rows: string[] = []
  for (let b = 0; b < 2; b += 1) {
    for (let g = 0; g < 2; g += 1) {
      for (let r = 0; r < 2; r += 1) rows.push(`${r} ${g} ${b}`)
    }
  }
  return [
    'TITLE "Identity"',
    ...comments.map((c) => `# ${c}`),
    'LUT_3D_SIZE 2',
    ...rows,
  ].join('\n')
}
