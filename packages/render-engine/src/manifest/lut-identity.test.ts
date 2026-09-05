import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { lutIdentityFromProfile } from './lut-identity'

const profile = {
  id: 'vlog',
  label: 'V-Log',
  role: 'combined-look-output',
  inputGamut: 'panasonic-vgamut',
  inputTransfer: 'v-log',
  inputRange: 'unknown',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'bt709',
  aliases: [],
} as unknown as LUTColorProfile

describe('lutIdentityFromProfile', () => {
  it('records unspecified ranges as unknown by default', () => {
    const result = lutIdentityFromProfile({
      filename: 'vlog.cube',
      sha256: 'a'.repeat(64),
      profile,
    })
    expect(result.identity).toMatchObject({
      input_contract: { range: 'unknown' },
      output_contract: { range: 'unknown', role: 'combined-look-output' },
    })
  })

  it('refuses unspecified ranges when explicit ranges are required', () => {
    const result = lutIdentityFromProfile({
      filename: 'vlog.cube',
      sha256: 'a'.repeat(64),
      profile,
      requireExplicitRange: true,
    })
    expect(result.identity).toBeNull()
    expect(result).toMatchObject({
      failure: { code: 'range-unspecified', contract: 'input' },
    })

    const explicit = lutIdentityFromProfile({
      filename: 'vlog.cube',
      sha256: 'a'.repeat(64),
      profile: {
        ...profile,
        inputRange: 'full',
        outputRange: 'legal',
      } as unknown as LUTColorProfile,
      requireExplicitRange: true,
    })
    expect(explicit.identity).toMatchObject({
      input_contract: { range: 'full' },
      output_contract: { range: 'legal' },
    })
  })

  it('fails when no output transfer can be derived', () => {
    const result = lutIdentityFromProfile({
      filename: 'x.cube',
      sha256: 'b'.repeat(64),
      profile: {
        ...profile,
        outputTransfer: undefined,
      } as unknown as LUTColorProfile,
    })
    expect(result).toMatchObject({
      identity: null,
      failure: { code: 'output-transfer-missing' },
    })
  })
})
