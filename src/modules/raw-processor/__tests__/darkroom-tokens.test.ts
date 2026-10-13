import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const tailwindCss = readFileSync(
  resolve(process.cwd(), 'src/styles/tailwind.css'),
  'utf8',
)
const rawLabCss = readFileSync(
  resolve(process.cwd(), 'src/modules/raw-processor/raw-lab.css'),
  'utf8',
)

function definitionLine(css: string, token: string) {
  return css.split('\n').find((line) => line.trim().startsWith(`${token}:`))
}

function lightnessOf(decl: string) {
  const match = decl.match(/oklch\(\s*([0-9.]+)/)
  expect(match, `expected an oklch literal in: ${decl}`).not.toBeNull()
  return Number(match![1])
}

describe('darkroom token truth', () => {
  it('defines the neutral surface tokens dark in @theme (single source)', () => {
    for (const token of [
      '--color-lf-surface',
      '--color-lf-surface-raised',
      '--color-lf-surface-sunk',
      '--color-lf-surface-muted',
    ]) {
      const line = definitionLine(tailwindCss, token)
      expect(line, `missing ${token} in @theme`).toBeDefined()
      expect(lightnessOf(line!), `${token} should be dark`).toBeLessThan(0.3)
    }
  })

  it('keeps .raw-lab from re-declaring the neutral surface tokens (single source)', () => {
    expect(rawLabCss).not.toMatch(/--color-lf-surface\s*:/)
    expect(rawLabCss).not.toMatch(/--color-lf-on-surface\s*:/)
  })
})
