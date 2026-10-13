// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describeLutProfile,
  lutIdentityFromProfile,
} from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  contractInputFromIdentity,
  inferContract,
  loadLutFile,
  resolveLutContract,
  toLutIdentity,
  validateContract,
} from './lut'

function cube(lines: string[]): string {
  const size = 2
  const rows: string[] = []
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) rows.push(`${r} ${g} ${b}`)
    }
  }
  return [...lines, `LUT_3D_SIZE ${size}`, ...rows].join('\n')
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-lut-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('lut service', () => {
  it('confirms a contract from LUMAFORGE_ metadata comments', async () => {
    await writeFile(
      join(dir, 'vlog.cube'),
      cube([
        'TITLE "VLog to 709"',
        '# LUMAFORGE_ROLE=combined-look-output',
        '# LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        '# LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        '# LUMAFORGE_OUTPUT_TRANSFER=bt709',
        '# LUMAFORGE_OUTPUT_RANGE=full',
      ]),
    )
    const loaded = await loadLutFile('vlog.cube', dir)
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/)
    const resolved = resolveLutContract(loaded)
    expect(resolved.source).toBe('metadata')
    expect(resolved.identity).toMatchObject({
      kind: 'local-file',
      filename: 'vlog.cube',
      sha256: loaded.sha256,
      input_contract: { gamut: 'v-gamut', transfer: 'v-log', range: 'full' },
      output_contract: {
        gamut: 'srgb-rec709',
        transfer: 'bt709',
        range: 'full',
        role: 'combined-look-output',
      },
    })
    expect(inferContract(loaded).complete).toBe(true)
  })

  it('reports recommendations and fails closed without a contract', async () => {
    await writeFile(
      join(dir, 'slog3.cube'),
      cube(['TITLE "Sony S-Gamut3.Cine S-Log3 to Rec709"']),
    )
    const loaded = await loadLutFile('slog3.cube', dir)
    const inferred = inferContract(loaded)
    expect(inferred.complete).toBe(false)
    expect(inferred.resolution.kind).toBe('recommended')
    expect(inferred.suggested_contracts[0]).toMatchObject({
      role: 'combined-look-output',
      input_profile: 'sony-sgamut3cine-slog3',
    })
    expect(() => resolveLutContract(loaded)).toThrow(
      expect.objectContaining({ code: 'lut.contract.incomplete', exitCode: 4 }),
    )
    const resolved = resolveLutContract(loaded, inferred.suggested_contracts[0])
    expect(resolved.source).toBe('params')
    expect(resolved.profile.inputTransfer).toBe('s-log3')
  })

  it('validates explicit contracts and explains issues', async () => {
    await writeFile(join(dir, 'x.cube'), cube(['TITLE "x"']))
    const loaded = await loadLutFile('x.cube', dir)
    const ok = validateContract(loaded, {
      role: 'display-look',
      input_gamut: 'srgb-rec709',
      input_transfer: 'srgb',
      input_range: 'full',
    })
    expect(ok.valid).toBe(true)
    expect(ok.export_supported).toBe(true)
    const bad = validateContract(loaded, {
      role: 'scene-creative',
      input_gamut: 'v-gamut',
      input_transfer: 'v-log',
    })
    expect(bad.valid).toBe(false)
    expect(bad.issues.join(' ')).toMatch(/output/i)
    expect(() =>
      resolveLutContract(loaded, {
        role: 'scene-creative',
        input_gamut: 'v-gamut',
        input_transfer: 'v-log',
      }),
    ).toThrow(expect.objectContaining({ code: 'lut.contract.invalid' }))
  })

  it('rejects non-cube files and parse failures with argument errors', async () => {
    await writeFile(join(dir, 'a.txt'), 'nope')
    await writeFile(join(dir, 'broken.cube'), 'TITLE "b"\nLUT_3D_SIZE 2\n0 0 0')
    await expect(loadLutFile('a.txt', dir)).rejects.toMatchObject({
      code: 'args.invalid',
    })
    await expect(loadLutFile('broken.cube', dir)).rejects.toMatchObject({
      code: 'lut.parse_failed',
      exitCode: 2,
    })
    await expect(loadLutFile('missing.cube', dir)).rejects.toMatchObject({
      code: 'file.not_found',
    })
  })
  it('carries the confirmed metadata contract into the LUT data it renders', async () => {
    await writeFile(
      join(dir, 'vlog.cube'),
      cube([
        'TITLE "VLog to 709"',
        '# LUMAFORGE_ROLE=combined-look-output',
        '# LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        '# LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        '# LUMAFORGE_OUTPUT_TRANSFER=bt709',
        '# LUMAFORGE_OUTPUT_RANGE=full',
      ]),
    )
    const loaded = await loadLutFile('vlog.cube', dir)
    const resolved = resolveLutContract(loaded)
    expect(resolved.profile).toMatchObject({
      id: 'panasonic-vgamut-vlog',
      inputGamut: 'v-gamut',
      inputTransfer: 'v-log',
    })
    expect(resolved.lutData.profileResolution).toEqual({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: resolved.profile,
    })
  })

  it('renders an explicit contract over the metadata contract', async () => {
    await writeFile(
      join(dir, 'display.cube'),
      cube([
        'TITLE "Display look"',
        '# LUMAFORGE_INPUT_PROFILE=display-srgb',
        '# LUMAFORGE_ROLE=display-look',
      ]),
    )
    const loaded = await loadLutFile('display.cube', dir)
    expect(resolveLutContract(loaded).lutData.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
    })

    const resolved = resolveLutContract(loaded, {
      role: 'combined-look-output',
      input_profile: 'panasonic-vgamut-vlog',
      output_gamut: 'srgb-rec709',
      output_transfer: 'bt709',
      output_range: 'full',
    })
    expect(resolved.source).toBe('params')
    expect(resolved.profile).toMatchObject({
      id: 'panasonic-vgamut-vlog',
      role: 'combined-look-output',
      inputGamut: 'v-gamut',
      inputTransfer: 'v-log',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    })
    expect(resolved.parsed.profileResolution).toEqual({
      kind: 'confirmed',
      confidence: 'user',
      profile: resolved.profile,
    })
    expect(resolved.lutData.profileResolution).toEqual(
      resolved.parsed.profileResolution,
    )
    expect(resolved.identity.input_contract).toEqual({
      gamut: 'v-gamut',
      transfer: 'v-log',
      range: 'full',
    })
  })

  it('names explicit contracts by canonical registry profile IDs', async () => {
    await writeFile(join(dir, 'x.cube'), cube(['TITLE "x"']))
    const loaded = await loadLutFile('x.cube', dir)
    const output = {
      output_gamut: 'srgb-rec709',
      output_transfer: 'bt709',
      output_range: 'full',
    } as const
    const registered = resolveLutContract(loaded, {
      role: 'combined-look-output',
      input_gamut: 's-gamut3-cine',
      input_transfer: 's-log3',
      input_range: 'full',
      ...output,
    })
    expect(registered.profile.id).toBe('sony-sgamut3cine-slog3')
    expect(registered.lutData.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'user',
      profile: { id: 'sony-sgamut3cine-slog3', inputTransfer: 's-log3' },
    })

    const unregistered = resolveLutContract(loaded, {
      role: 'combined-look-output',
      input_gamut: 'v-gamut',
      input_transfer: 's-log3',
      input_range: 'full',
      ...output,
    })
    expect(unregistered.profile).toMatchObject({
      id: 'v-gamut-s-log3',
      inputGamut: 'v-gamut',
      inputTransfer: 's-log3',
    })
    expect(unregistered.lutData.profileResolution).toMatchObject({
      kind: 'confirmed',
      profile: { id: 'v-gamut-s-log3' },
    })
  })

  it('refuses a LUT whose metadata targets an unsupported output space', async () => {
    await writeFile(
      join(dir, 'cineon.cube'),
      cube(['TITLE "Sony S-Log3 to Cineon"']),
    )
    const loaded = await loadLutFile('cineon.cube', dir)
    expect(loaded.parsed.profileResolution.kind).toBe('unsupported-output')
    expect(() => resolveLutContract(loaded)).toThrow(
      expect.objectContaining({ code: 'lut.contract.unsupported_output' }),
    )
    expect(inferContract(loaded)).toMatchObject({
      complete: false,
      contract: null,
    })
  })

  it('refuses an unencodable output transfer apart from an unstated output range', async () => {
    await writeFile(join(dir, 'x.cube'), cube(['TITLE "x"']))
    const loaded = await loadLutFile('x.cube', dir)
    const contract = {
      role: 'combined-look-output',
      input_profile: 'sony-sgamut3cine-slog3',
      output_gamut: 'srgb-rec709',
    } as const
    expect(() =>
      resolveLutContract(loaded, {
        ...contract,
        output_transfer: 'linear',
        output_range: 'full',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'lut.contract.unsupported_output' }),
    )
    expect(() =>
      resolveLutContract(loaded, {
        ...contract,
        output_transfer: 'bt709',
        output_range: 'unknown',
      }),
    ).toThrow(expect.objectContaining({ code: 'lut.contract.incomplete' }))
  })

  it('never records an unspecified range and replays unknown ranges from the descriptor', async () => {
    await writeFile(join(dir, 'vlog.cube'), cube(['TITLE "V-Log to Rec709"']))
    const loaded = await loadLutFile('vlog.cube', dir)
    const resolved = resolveLutContract(loaded, {
      role: 'combined-look-output',
      input_profile: 'panasonic-vgamut-vlog',
      output_gamut: 'srgb-rec709',
      output_transfer: 'bt709',
      output_range: 'full',
    })
    expect(resolved.identity.input_contract.range).toBe('full')

    // A browser manifest may carry 'unknown' ranges for the same profile.
    const unspecified = { ...resolved.profile, inputRange: 'unknown' as const }
    expect(() => toLutIdentity(loaded, unspecified)).toThrow(
      expect.objectContaining({ code: 'lut.contract.incomplete', exitCode: 4 }),
    )
    const browserIdentity = lutIdentityFromProfile({
      filename: loaded.filename,
      sha256: loaded.sha256,
      profile: unspecified,
    }).identity!
    expect(browserIdentity.input_contract.range).toBe('unknown')

    expect(() => contractInputFromIdentity(browserIdentity)).toThrow(
      expect.objectContaining({ code: 'lut.contract.incomplete' }),
    )
    const descriptor = describeLutProfile(unspecified)!
    const replayed = resolveLutContract(
      loaded,
      contractInputFromIdentity(browserIdentity, {
        input_range: descriptor.input.range,
        output_range: descriptor.output.range,
      }),
    )
    expect(describeLutProfile(replayed.profile)).toEqual(descriptor)
  })
})
