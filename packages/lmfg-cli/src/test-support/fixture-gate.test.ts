// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  assertFixtureGate,
  DEFAULT_FIXTURE_PATH,
  resolveFixtureGate,
} from './fixture-gate'

describe('fixture gate', () => {
  it('reports a missing fixture path as not ready', () => {
    const gate = resolveFixtureGate({
      LMFG_FIXTURE_PATH: '/nonexistent/raw.dng',
    })
    expect(gate.ready).toBe(false)
    expect(gate.required).toBe(false)
    expect(gate.fixturePath).toBe('/nonexistent/raw.dng')
    expect(gate.reasons[0]).toMatch(/RAW fixture missing/)
    expect(() => assertFixtureGate(gate)).not.toThrow()
  })

  it('throws when the fixture is required but unavailable', () => {
    const gate = resolveFixtureGate({
      LMFG_FIXTURE_PATH: '/nonexistent/raw.dng',
      LMFG_REQUIRE_FIXTURE: '1',
    })
    expect(gate.required).toBe(true)
    expect(() => assertFixtureGate(gate)).toThrow(/LMFG_REQUIRE_FIXTURE is set/)
  })

  it('defaults to the public DNG fixture path', () => {
    expect(resolveFixtureGate({}).fixturePath).toBe(DEFAULT_FIXTURE_PATH)
    expect(DEFAULT_FIXTURE_PATH).toMatch(/raw-pixls-iphone-se\.dng$/)
  })
})
