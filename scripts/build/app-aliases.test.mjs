import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'

import { expect, it } from 'vitest'

import { APP_ALIASES } from './app-aliases.mjs'

const read = (path) =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))

// Node entries the browser app never imports; lmfg and the runtime tests
// consume them from dist.
const NODE_ONLY = [
  '@lumaforge/luma-jpeg-runtime/node',
  '@lumaforge/luma-raw-runtime/node',
]

it('matches the tsconfig paths and points at existing sources', () => {
  const expected = Object.fromEntries(
    APP_ALIASES.map(({ find, path }) =>
      extname(path) === ''
        ? [`${find}/*`, [`./${path}/*`]]
        : [find, [`./${path}`]],
    ),
  )
  expect(read('tsconfig.json').compilerOptions.paths).toEqual(expected)
  for (const { path } of APP_ALIASES) {
    expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(true)
  }
  APP_ALIASES.forEach(({ find }, index) => {
    const shadowed = APP_ALIASES.slice(index + 1).filter((later) =>
      later.find.startsWith(`${find}/`),
    )
    expect(shadowed, `${find} precedes its subpaths`).toEqual([])
  })
})

it('aliases every export subpath of an aliased package', () => {
  const finds = new Set(APP_ALIASES.map(({ find }) => find))
  const packages = new Set(
    APP_ALIASES.filter(({ path }) => path.startsWith('packages/')).map(
      ({ path }) => path.split('/').slice(0, 2).join('/'),
    ),
  )
  for (const dir of packages) {
    const { name, exports } = read(`${dir}/package.json`)
    for (const subpath of Object.keys(exports)) {
      const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`
      if (NODE_ONLY.includes(specifier)) continue
      expect(finds, `${specifier} has an app alias`).toContain(specifier)
    }
  }
})
