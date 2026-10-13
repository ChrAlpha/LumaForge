import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createDeployConfig, resolveDeployOptions } from './config.mjs'

function createCloudflareHeaders(config) {
  return [
    '/*',
    ...Object.entries(config.crossOriginIsolationHeaders).map(
      ([key, value]) => `  ${key}: ${value}`,
    ),
    '',
    '/*.wasm',
    ...Object.entries(config.wasmHeaders).map(
      ([key, value]) => `  ${key}: ${value}`,
    ),
    '',
  ].join('\n')
}

function createVercelBuildOutputConfig(config) {
  return {
    version: 3,
    routes: [
      {
        src: '/(.*)',
        headers: config.crossOriginIsolationHeaders,
        continue: true,
      },
      {
        src: '/(.*)\\.wasm',
        headers: config.wasmHeaders,
        continue: true,
      },
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index.html' },
    ],
  }
}

async function copyDirectoryContents(
  sourceDir,
  targetDir,
  { exclude = [] } = {},
) {
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  const entries = await readdir(sourceDir)
  await Promise.all(
    entries
      .filter((entry) => !exclude.includes(entry))
      .map(async (entry) => {
        await cp(join(sourceDir, entry), join(targetDir, entry), {
          recursive: true,
        })
      }),
  )
}

async function assertDirectory(path, label) {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${label} does not exist: ${path}`)
}

export async function prepareCloudflareDeploy(config = createDeployConfig()) {
  await assertDirectory(config.outputDir, 'Build output directory')
  await writeFile(
    join(config.outputDir, '_headers'),
    createCloudflareHeaders(config),
  )
  await writeFile(join(config.outputDir, '_redirects'), '/* /index.html 200\n')
}

export async function prepareVercelDeploy(config = createDeployConfig()) {
  await assertDirectory(config.outputDir, 'Build output directory')
  await copyDirectoryContents(config.outputDir, config.vercel.outputStaticDir, {
    exclude: ['_headers', '_redirects'],
  })
  await writeFile(
    join(config.vercel.outputDir, 'config.json'),
    `${JSON.stringify(createVercelBuildOutputConfig(config), null, 2)}\n`,
  )
}

export async function prepareDeployTarget(
  config = createDeployConfig(),
  options = resolveDeployOptions(),
) {
  if (options.target === 'cloudflare') {
    await prepareCloudflareDeploy(config)
    return
  }

  await prepareVercelDeploy(config)
}
