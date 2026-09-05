import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runMcpServer as serve } from './server'

function ownVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as {
        name?: string
        version?: string
      }
      if (pkg.name === '@lumaforge/lmfg-mcp') return pkg.version ?? 'unknown'
    } catch {
      // keep walking up
    }
    dir = dirname(dir)
  }
  return 'unknown'
}

export { createLmfgMcpServer, runCliTool, toCallToolResult } from './server'
export { findTool, TOOLS } from './tools'

export function runMcpServer(argv: readonly string[]): Promise<number> {
  return serve(argv, ownVersion())
}
