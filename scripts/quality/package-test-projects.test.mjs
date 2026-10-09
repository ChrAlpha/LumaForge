// @vitest-environment node
import { fileURLToPath } from 'node:url'

import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'

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
  it.each(PROJECTS)(
    '$dir is rooted at its package with an explicit name and environment',
    async (project) => {
      const config = await resolveProject(project, 'serve')

      expect(config.root).toBe(packageDir(project.dir))
      expect(config.test?.name).toBe(`@lumaforge/${project.dir}`)
      expect(config.test?.environment).toBe(project.environment)
    },
  )

  it('gives every package project a unique name', async () => {
    const names = await Promise.all(
      PROJECTS.map(
        async (project) =>
          (await resolveProject(project, 'serve')).test?.name ?? null,
      ),
    )

    expect(new Set(names).size).toBe(PROJECTS.length)
  })

  it.each(PROJECTS.filter((project) => project.distPlugin))(
    '$dir runs its dist-cleaning hook only when building',
    async (project) => {
      const serve = await resolveProject(project, 'serve')
      const build = await resolveProject(project, 'build')
      const names = (config) => config.plugins.map((plugin) => plugin.name)

      expect(names(serve)).not.toContain(project.distPlugin)
      expect(names(build)).toContain(project.distPlugin)
    },
  )
})
