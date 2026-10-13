import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { createDeployConfig } from './config.mjs'

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function checkDeployArtifact(config = createDeployConfig()) {
  const requiredFiles = [
    'index.html',
    'raw/index.html',
    'og-image.png',
    'robots.txt',
    'sitemap.xml',
    ...config.nativeAssets,
  ]

  for (const file of requiredFiles) {
    if (!(await fileExists(join(config.outputDir, file)))) {
      throw new Error(`Missing deploy artifact: ${file}`)
    }
  }
}

if (import.meta.main) {
  await checkDeployArtifact()
}
