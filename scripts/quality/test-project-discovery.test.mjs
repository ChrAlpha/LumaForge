// @vitest-environment node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Runs under `node --test` and under the Vitest tooling project.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const TIMEOUT = { timeout: 120_000 }

// The aggregate projects, the environment each runs in by default, and the
// repository files each one owns.
const PACKAGE_PROJECTS = {
  'luma-color-runtime': 'node',
  'luma-raw-runtime': 'jsdom',
  'luma-jpeg-runtime': 'jsdom',
  'render-engine': 'node',
  'lmfg-cli': 'node',
  'lmfg-mcp': 'node',
  'luma-native-artifacts': 'node',
}
const PROJECTS = {
  app: 'jsdom',
  tooling: 'node',
  ...PACKAGE_PROJECTS,
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** The project that should own a repository-relative test file. */
function ownerOf(file) {
  const packageDir = /^packages\/([^/]+)\//.exec(file)?.[1]
  if (packageDir) return packageDir
  if (file.startsWith('src/')) return 'app'
  return 'tooling'
}

/** Every test file in the checkout except the Playwright browser specs. */
function intendedTestFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((file) => TEST_FILE.test(file))
    .filter((file) => !file.startsWith('tests/browser/'))
    .filter((file) => existsSync(join(repoRoot, file)))
    .sort()
}

// Resolves the root config through the Vitest API in a clean child process,
// so the inventory is the same under either test runner.
const INVENTORY_SCRIPT = `
import { writeFileSync } from 'node:fs'
import { createVitest } from 'vitest/node'

const vitest = await createVitest(
  'test',
  { watch: false, run: false },
  { logLevel: 'silent' },
)
try {
  const specifications = await vitest.globTestSpecifications()
  writeFileSync(
    process.env.LF_TEST_PROJECT_INVENTORY,
    JSON.stringify({
      projects: vitest.projects.map((project) => ({
        name: project.name,
        root: project.config.root,
        environment: project.config.environment,
        setupFiles: project.config.setupFiles,
        aliases: (project.vite.config.resolve.alias ?? [])
          .map((alias) => alias.find)
          .filter((find) => typeof find === 'string'),
        plugins: project.vite.config.plugins.map((plugin) => plugin.name),
        jsx: project.vite.config.esbuild ? project.vite.config.esbuild.jsx : null,
      })),
      files: specifications.map((specification) => ({
        project: specification.project.name,
        file: specification.moduleId,
      })),
    }),
  )
} finally {
  await vitest.close()
}
`

let inventoryPromise
function inventory() {
  inventoryPromise ??= Promise.resolve().then(() => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-test-projects-'))
    const out = join(dir, 'inventory.json')
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:VITEST|TEST$|NODE_ENV$)/.test(key),
      ),
    )
    try {
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', INVENTORY_SCRIPT],
        {
          cwd: repoRoot,
          env: { ...env, LF_TEST_PROJECT_INVENTORY: out },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      )
      const result = JSON.parse(readFileSync(out, 'utf8'))
      return {
        ...result,
        files: result.files.map(({ project, file }) => ({
          project,
          file: file.slice(repoRoot.length),
        })),
      }
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
  return inventoryPromise
}

function project(projects, name) {
  const found = projects.find((candidate) => candidate.name === name)
  assert.ok(found, `missing Vitest project ${name}`)
  return found
}

describe('aggregate Vitest projects', () => {
  it(
    'defines the app, tooling and every package project once',
    TIMEOUT,
    async () => {
      const { projects } = await inventory()

      assert.deepEqual(
        projects.map((candidate) => candidate.name).sort(),
        Object.keys(PROJECTS).sort(),
      )
      for (const [name, environment] of Object.entries(PROJECTS)) {
        assert.equal(project(projects, name).environment, environment, name)
      }
      for (const name of Object.keys(PACKAGE_PROJECTS)) {
        assert.equal(
          project(projects, name).root,
          join(repoRoot, 'packages', name),
          name,
        )
      }
    },
  )

  it(
    'runs every intended test file in exactly one project',
    TIMEOUT,
    async () => {
      const { files } = await inventory()
      const seen = new Map()
      for (const { project: name, file } of files) {
        seen.set(file, [...(seen.get(file) ?? []), name])
      }

      const duplicated = [...seen].filter(([, names]) => names.length > 1)
      assert.deepEqual(duplicated, [])
      assert.deepEqual([...seen.keys()].sort(), intendedTestFiles())
      for (const [file, [name]] of seen) {
        assert.equal(name, ownerOf(file), file)
      }
    },
  )

  it(
    'keeps the native smoke suites in their package projects',
    TIMEOUT,
    async () => {
      const { files } = await inventory()

      for (const name of ['luma-raw-runtime', 'luma-jpeg-runtime']) {
        assert.ok(
          files.some(
            (entry) =>
              entry.project === name &&
              entry.file === `packages/${name}/src/native-smoke.test.ts`,
          ),
          `${name} native smoke`,
        )
      }
    },
  )

  it(
    'confines the app aliases and DOM setup to the app project',
    TIMEOUT,
    async () => {
      const { projects } = await inventory()
      const app = project(projects, 'app')

      assert.deepEqual(app.setupFiles, [join(repoRoot, 'src/test/setup.ts')])
      assert.ok(app.aliases.includes('~'))
      assert.ok(app.aliases.includes('@lumaforge/render-engine'))
      assert.equal(app.jsx, 'automatic')

      for (const other of projects.filter((entry) => entry.name !== 'app')) {
        assert.deepEqual(other.setupFiles, [], other.name)
        assert.ok(!other.aliases.includes('~'), other.name)
        assert.ok(!other.aliases.includes('@pkg'), other.name)
      }
      // Package projects resolve workspace packages through their dist entries.
      for (const name of Object.keys(PACKAGE_PROJECTS)) {
        assert.deepEqual(
          project(projects, name).aliases.filter((find) =>
            find.startsWith('@lumaforge/'),
          ),
          [],
          name,
        )
      }
    },
  )

  it(
    'compiles JSX without React Fast Refresh in any project',
    TIMEOUT,
    async () => {
      const { projects } = await inventory()

      for (const entry of projects) {
        assert.deepEqual(
          entry.plugins.filter((name) => /react/i.test(name)),
          [],
          entry.name,
        )
      }
    },
  )

  it(
    'selects only defined projects in the package scripts',
    TIMEOUT,
    async () => {
      const { projects } = await inventory()
      const names = new Set(projects.map((entry) => entry.name))
      const { scripts } = JSON.parse(
        readFileSync(join(repoRoot, 'package.json'), 'utf8'),
      )

      for (const script of ['test:app', 'test:runtime', 'test:ui']) {
        const selected = Array.from(
          scripts[script].matchAll(/--project (\S+)/g),
          (match) => match[1],
        )
        assert.ok(selected.length > 0, script)
        for (const name of selected)
          assert.ok(names.has(name), `${script}: ${name}`)
      }
    },
  )
})
