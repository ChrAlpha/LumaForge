import { resolve } from 'node:path'
import process from 'node:process'

import deployConfig from '../../deploy.config.mjs'
import { nativeRuntimeAssetPaths } from '../native-runtime/assets.mjs'

export const DEPLOY_TARGETS = ['cloudflare', 'vercel']
export const DEPLOY_ENVS = ['preview', 'production']
const DEFAULT_PRODUCTION_BRANCHES = ['main', 'master']

export function createDeployConfig(root = process.cwd()) {
  const outputDir = resolve(root, deployConfig.outputDir)
  const vercelOutputDir = resolve(root, deployConfig.vercel.outputDir)

  return {
    root,
    siteUrl: deployConfig.siteUrl,
    outputDir,
    nativeAssets: nativeRuntimeAssetPaths(),
    crossOriginIsolationHeaders: deployConfig.crossOriginIsolationHeaders,
    wasmHeaders: deployConfig.wasmHeaders,
    cloudflare: {
      projectNameEnv: deployConfig.cloudflare.projectNameEnv,
    },
    vercel: {
      outputDir: vercelOutputDir,
      outputStaticDir: resolve(vercelOutputDir, 'static'),
      orgIdEnv: deployConfig.vercel.orgIdEnv,
      projectIdEnv: deployConfig.vercel.projectIdEnv,
    },
  }
}

function readRequiredOption(env, key) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required.`)
  return value
}

function parseProductionBranches(env = process.env) {
  return (
    env.DEPLOY_PRODUCTION_BRANCHES || DEFAULT_PRODUCTION_BRANCHES.join(',')
  )
    .split(',')
    .map((branch) => branch.trim())
    .filter(Boolean)
}

export function inferDeployEnv(env = process.env) {
  if (
    env.GITHUB_EVENT_NAME === 'pull_request' ||
    env.GITHUB_EVENT_NAME === 'pull_request_target'
  ) {
    return 'preview'
  }

  const refName = env.GITHUB_REF_NAME?.trim()
  if (refName && parseProductionBranches(env).includes(refName)) {
    return 'production'
  }

  return 'preview'
}

export function resolveDeployOptions(env = process.env) {
  const target = readRequiredOption(env, 'DEPLOY_TARGET')
  if (!DEPLOY_TARGETS.includes(target)) {
    throw new Error(
      `DEPLOY_TARGET must be one of: ${DEPLOY_TARGETS.join(', ')}`,
    )
  }

  const deployEnv = env.DEPLOY_ENV?.trim() || inferDeployEnv(env)
  if (!DEPLOY_ENVS.includes(deployEnv)) {
    throw new Error(`DEPLOY_ENV must be one of: ${DEPLOY_ENVS.join(', ')}`)
  }

  return { target, deployEnv }
}
