import process from 'node:process'

import { checkDeployArtifact } from './check.mjs'
import { createDeployConfig, resolveDeployOptions } from './config.mjs'
import { prepareDeployTarget } from './prepare.mjs'
import { publishDeployTarget } from './publish.mjs'

export async function deploy(config = createDeployConfig(), env = process.env) {
  const options = resolveDeployOptions(env)
  await checkDeployArtifact(config)
  await prepareDeployTarget(config, options)
  await publishDeployTarget(config, options, env)
}

if (import.meta.main) {
  await deploy()
}
