import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'

import { finishTool, verifyCompletion } from './completion.js'
import type { HostOptions, ModelTool, ToolExecution } from './types.js'

class ToolOutcomeUnknownError extends Error {}

function toolError(error: unknown): ToolExecution {
  return {
    result: {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
    },
  }
}

function payload(result: CallToolResult): Record<string, unknown> {
  const envelope =
    result.structuredContent ??
    JSON.parse(
      result.content.find((part) => part.type === 'text')?.text ?? '{}',
    )
  if (result.isError || envelope.ok === false)
    throw new Error(JSON.stringify(envelope.error ?? envelope))
  return envelope.result as Record<string, unknown>
}

function nativePath(path: string): string {
  return path.startsWith('file:') ? fileURLToPath(path) : path
}

export async function createHost(options: HostOptions) {
  const client = new Client({ name: 'lmfg-vision-agent', version: '0.1.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(options.repoRoot, 'packages/lmfg-mcp/bin/lmfg-mcp.mjs'),
      '--cwd',
      options.repoRoot,
    ],
    cwd: options.repoRoot,
    env: {
      PATH: process.env.PATH ?? '',
      LUMAFORGE_NATIVE_RUNTIME_MODE: 'prebuilt',
    },
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const available = (await client.listTools()).tools.filter(
      (tool) => tool.name !== 'lmfg_lut_fetch',
    )
    if (!available.some((tool) => tool.name === 'lmfg_image_read'))
      throw new Error(
        'MCP server has no image reader. Build the vision-capable lmfg-mcp first.',
      )
    const tools: ModelTool[] = available.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema,
      },
    }))
    tools.push(finishTool)
    const source = await realpath(options.sourcePath)
    const workspace = await realpath(options.workspace)
    const allowedLuts = new Set(
      await Promise.all(options.lutPaths.map((path) => realpath(path))),
    )
    for (const path of allowedLuts) {
      const bytes = await readFile(path)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await mkdir(resolve(workspace, 'luts'), { recursive: true })
      await writeFile(resolve(workspace, 'luts', `${sha256}.cube`), bytes)
      await options.record({ event: 'lut_cached', path, sha256 })
    }
    const sessions = new Set<string>()
    const images: Array<{ step: number; result: Record<string, unknown> }> = []

    const invoke = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      try {
        return (await client.callTool({ name, arguments: args }, undefined, {
          timeout: options.toolTimeoutMs + 30000,
        })) as CallToolResult
      } catch (error) {
        if (error instanceof McpError && [-32601, -32602].includes(error.code))
          throw error
        throw new ToolOutcomeUnknownError(
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const schemas: Record<string, unknown> = {}
    for (const id of ['lmfg.params.v1', 'lmfg.plan.v1', 'lmfg.sweep.v1'])
      schemas[id] = payload(
        await invoke('lmfg_schema_show', { id }),
      ).json_schema
    const capabilities = payload(await invoke('lmfg_capabilities', {}))
    await options.record({ event: 'host_ready', capabilities, schemas, tools })

    async function authorizePaths(
      args: Record<string, unknown>,
    ): Promise<void> {
      const selectors = new Set([
        'output',
        'name',
        'session',
        'iteration',
        'candidate',
        'baseline',
        'preview_id',
        'iteration_id',
        'candidate_id',
        'session_id',
      ])
      const validateSelectors = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
          if (
            selectors.has(key) &&
            (typeof item !== 'string' || !/^[a-z0-9][\w.-]{0,95}$/i.test(item))
          )
            throw new Error(`Unsafe artifact selector: ${key}`)
          validateSelectors(item)
        }
      }
      validateSelectors(args)
      if (
        args.workspace !== undefined &&
        resolve(String(args.workspace)) !== workspace
      )
        throw new Error('Use this run workspace only.')
      if (args.session !== undefined && !sessions.has(String(args.session)))
        throw new Error('Session was not created in this run.')
      for (const key of ['source', 'file']) {
        if (
          args[key] !== undefined &&
          (await realpath(
            resolve(options.repoRoot, nativePath(String(args[key]))),
          )) !== source
        )
          throw new Error('This run edits only its declared source RAW.')
      }
      if (args.manifest !== undefined) {
        const path = await realpath(
          resolve(options.repoRoot, nativePath(String(args.manifest))),
        )
        const rel = relative(workspace, path)
        if (
          rel.startsWith('..') ||
          isAbsolute(rel) ||
          !path.endsWith('manifest.json')
        )
          throw new Error(
            'Manifest must be a generated manifest inside this run workspace.',
          )
        args.manifest = path
      }
      const checkLuts = async (value: unknown): Promise<void> => {
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
          if (key === 'lut' && item) {
            const path =
              typeof item === 'string'
                ? item
                : (item as { path?: unknown }).path
            if (
              typeof path !== 'string' ||
              !allowedLuts.has(await realpath(resolve(options.repoRoot, path)))
            )
              throw new Error(
                'LUT must be one of the files explicitly supplied to this run.',
              )
          } else await checkLuts(item)
        }
      }
      await checkLuts(args)
    }

    const execute = async (
      name: string,
      originalArgs: Record<string, unknown>,
      step: number,
    ): Promise<ToolExecution> => {
      const args = structuredClone(originalArgs)
      try {
        if (name === 'finish_edit') {
          const completion = await verifyCompletion(args, {
            workspace,
            sourcePath: source,
            step,
            images,
            replay: async (manifest, session) => {
              await options.record({
                event: 'verification_replay_started',
                step,
                manifest,
                session,
              })
              const result = await invoke('lmfg_render_replay', {
                manifest,
                session,
                workspace,
                name: `agent-verify-${step}`,
                timeout_ms: options.toolTimeoutMs,
              })
              await options.record({
                event: 'verification_replay_result',
                step,
                result,
              })
              return payload(result)
            },
          })
          return {
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ ok: true, result: completion }),
                },
              ],
            },
            completion,
          }
        }
        const spec = available.find((tool) => tool.name === name)
        if (!spec) throw new Error('Tool is not available in this run.')
        await authorizePaths(args)
        const properties = spec.inputSchema.properties ?? {}
        if ('workspace' in properties) args.workspace = workspace
        if ('timeout_ms' in properties) args.timeout_ms = options.toolTimeoutMs
        if ('max_pixels' in properties && args.max_pixels === undefined)
          args.max_pixels = 1500000
        if (name === 'lmfg_session_init') args.source = source
        for (const key of ['source', 'file'])
          if (typeof args[key] === 'string') args[key] = nativePath(args[key])
        await options.record({ event: 'tool_effective_args', step, name, args })
        let result: CallToolResult
        try {
          result = await invoke(name, args)
        } catch (error) {
          if (
            error instanceof McpError &&
            [-32601, -32602].includes(error.code)
          )
            return toolError(error)
          return { ...toolError(error), terminal: 'tool_outcome_unknown' }
        }
        if (!result.isError && name === 'lmfg_session_init')
          sessions.add(String(payload(result).id))
        if (
          !result.isError &&
          name === 'lmfg_image_read' &&
          result.content.some((part) => part.type === 'image')
        )
          images.push({ step, result: payload(result) })
        return { result }
      } catch (error) {
        return {
          ...toolError(error),
          ...(error instanceof ToolOutcomeUnknownError
            ? { terminal: 'tool_outcome_unknown' }
            : {}),
        }
      }
    }
    return {
      tools,
      schemas,
      capabilities,
      execute,
      close: () => client.close(),
    }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}
