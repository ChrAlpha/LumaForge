import { describe } from 'vitest'

import { assertFixtureGate, resolveFixtureGate } from './fixture-gate'

export const fixtureGate = resolveFixtureGate()
assertFixtureGate(fixtureGate)

export const FIXTURE_PATH = fixtureGate.fixturePath
export const fixtureReady = fixtureGate.ready
export const describeWithFixture: typeof describe = (
  fixtureReady ? describe : describe.skip
) as typeof describe
