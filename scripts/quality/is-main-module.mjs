import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the script Node was started with.
 * Both sides are compared as real paths: Node loads a symlinked script from
 * its target, so comparing the symlink path itself would skip the script.
 * @param {string} moduleUrl `import.meta.url` of the calling module.
 * @param {string | undefined} [script] The script path Node was given.
 */
export function isMainModule(moduleUrl, script = process.argv[1]) {
  if (!script) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
