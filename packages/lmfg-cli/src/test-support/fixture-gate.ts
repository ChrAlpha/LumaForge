import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { detectCapabilities } from '../runtime/capability'
import { LMFG_PACKAGE_DIR } from '../runtime/versions'

export const DEFAULT_FIXTURE_PATH = resolve(
  LMFG_PACKAGE_DIR,
  '../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)

export type FixtureGate = {
  ready: boolean
  required: boolean
  fixturePath: string
  reasons: string[]
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * Decide whether fixture-gated suites can run. `LMFG_FIXTURE_PATH` overrides
 * the RAW fixture location; `LMFG_REQUIRE_FIXTURE=1` turns "skip" into a hard
 * failure so CI cannot pass silently without the fixture or native artifacts.
 */
export function resolveFixtureGate(
  env: NodeJS.ProcessEnv = process.env,
): FixtureGate {
  const fixturePath = env.LMFG_FIXTURE_PATH
    ? resolve(env.LMFG_FIXTURE_PATH)
    : DEFAULT_FIXTURE_PATH
  const reasons: string[] = []
  if (!existsSync(fixturePath))
    reasons.push(`RAW fixture missing: ${fixturePath}`)
  const cpu = detectCapabilities({ memoryProfile: 'desktop' }).render_tiers
    .cpu_wasm
  if (!cpu.available) reasons.push('native WASM artifacts missing')
  return {
    ready: reasons.length === 0,
    required: isTruthyFlag(env.LMFG_REQUIRE_FIXTURE),
    fixturePath,
    reasons,
  }
}

export function assertFixtureGate(gate: FixtureGate): void {
  if (gate.required && !gate.ready) {
    throw new Error(
      `LMFG_REQUIRE_FIXTURE is set but fixture-gated tests cannot run: ${gate.reasons.join('; ')}`,
    )
  }
}
