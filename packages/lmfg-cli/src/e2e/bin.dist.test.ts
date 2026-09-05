// @vitest-environment node
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { PACKAGE_DIR } from './fixture'

const exec = promisify(execFile)
const BIN = join(PACKAGE_DIR, 'bin', 'lmfg.mjs')
const DIST_AVAILABLE = existsSync(join(PACKAGE_DIR, 'dist', 'index.js'))
const d = DIST_AVAILABLE ? describe : describe.skip

d('packaged bin', () => {
  it('runs version and capabilities from dist', async () => {
    const version = await exec(process.execPath, [BIN, 'version'], {
      cwd: PACKAGE_DIR,
    })
    expect(JSON.parse(version.stdout)).toMatchObject({
      schema: 'lmfg.version.v1',
      ok: true,
    })
    const caps = await exec(
      process.execPath,
      [BIN, 'capabilities', '--quiet'],
      { cwd: PACKAGE_DIR },
    )
    expect(JSON.parse(caps.stdout).result.active_tier).toBe('cpu_wasm')
  })

  it('exits 2 on unknown commands', async () => {
    await expect(
      exec(process.execPath, [BIN, 'nope'], { cwd: PACKAGE_DIR }),
    ).rejects.toMatchObject({
      code: 2,
    })
  })
})

if (!DIST_AVAILABLE) {
  describe('packaged bin — skipped', () => {
    it('dist missing; run `pnpm --filter @lumaforge/lmfg-cli build` first', () => {
      expect(DIST_AVAILABLE).toBe(false)
    })
  })
}
