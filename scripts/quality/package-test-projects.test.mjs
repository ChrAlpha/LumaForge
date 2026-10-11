// @vitest-environment node
import assert from 'node:assert/strict'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from 'vite'

// Runs under `node --test` and under the Vitest tooling project.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

// Each package test project: its config file, the environment its suite
// runs in by default, and the build-only plugin (if any) that rewrites dist.
const PROJECTS = [
  {
    dir: 'luma-color-runtime',
    config: 'vite.config.ts',
    environment: 'node',
  },
  {
    dir: 'luma-raw-runtime',
    config: 'vite.config.ts',
    environment: 'jsdom',
    distPlugin: 'luma-raw-preserve-native-assets',
  },
  {
    dir: 'luma-jpeg-runtime',
    config: 'vite.config.ts',
    environment: 'jsdom',
    distPlugin: 'luma-jpeg-preserve-native-assets',
  },
  { dir: 'render-engine', config: 'vite.config.ts', environment: 'node' },
  { dir: 'lmfg-cli', config: 'vite.config.ts', environment: 'node' },
  { dir: 'lmfg-mcp', config: 'vite.config.ts', environment: 'node' },
  {
    dir: 'luma-native-artifacts',
    config: 'vitest.config.mjs',
    environment: 'node',
  },
]

function packageDir(dir) {
  return fileURLToPath(new URL(`../../packages/${dir}`, import.meta.url))
}

async function resolveProject(project, command) {
  return resolveConfig(
    {
      configFile: `${packageDir(project.dir)}/${project.config}`,
      logLevel: 'silent',
      mode: 'test',
    },
    command,
  )
}

describe('package test projects', () => {
  for (const project of PROJECTS) {
    it(`${project.dir} is rooted at its package with an explicit name and environment`, async () => {
      const config = await resolveProject(project, 'serve')

      assert.equal(config.root, packageDir(project.dir))
      assert.equal(config.test?.name, `@lumaforge/${project.dir}`)
      assert.equal(config.test?.environment, project.environment)
    })
  }

  it('gives every package project a unique name', async () => {
    const names = await Promise.all(
      PROJECTS.map(
        async (project) =>
          (await resolveProject(project, 'serve')).test?.name ?? null,
      ),
    )

    assert.equal(new Set(names).size, PROJECTS.length)
  })

  for (const project of PROJECTS.filter((project) => project.distPlugin)) {
    it(`${project.dir} runs its dist-cleaning hook only when building`, async () => {
      const serve = await resolveProject(project, 'serve')
      const build = await resolveProject(project, 'build')
      const names = (config) => config.plugins.map((plugin) => plugin.name)

      assert.ok(!names(serve).includes(project.distPlugin))
      assert.ok(names(build).includes(project.distPlugin))
    })
  }
})
