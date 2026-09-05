// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { runCli } from './cli'

describe('runCli', () => {
  it('returns exit code 0 for version', async () => {
    const stdout: string[] = []
    const code = await runCli(['version'], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
      cwd: process.cwd(),
    })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.join('')).ok).toBe(true)
  })
})
