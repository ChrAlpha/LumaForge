import type { TestInfo } from '@playwright/test'

import {
  gateRawFixture,
  resolvePrivateRawFixture,
} from '../../scripts/ci/raw-fixtures.mjs'

// The export specs expect one particular file's plan, output size, aspect or
// resource load, so each resolves only from its own variable and never falls
// back to the small public DNG. Unset, the tests skip as optional private
// coverage; LUMAFORGE_REQUIRE_PRIVATE_FIXTURES=1 makes that a failure.

const LARGE_RAF_FIXTURE = resolvePrivateRawFixture(
  'LUMAFORGE_100MP_RAF',
  'a local 100MP Fujifilm RAF (GFX100RF, 16-bit lossless compressed)',
)

const SONY_ARW_FIXTURE = resolvePrivateRawFixture(
  'LUMAFORGE_SONY_ARW',
  'a local 61MP Sony ARW that decodes to 9566x6374',
)

/** The 100MP RAF whose size selects the expected export plans. */
export function resolveRawFixture(testInfo: TestInfo) {
  return gateRawFixture(testInfo, LARGE_RAF_FIXTURE)
}

/** The 61MP, 3:2 Sony ARW behind the output-size and resource assertions. */
export function resolveSonyArwFixture(testInfo: TestInfo) {
  return gateRawFixture(testInfo, SONY_ARW_FIXTURE)
}
