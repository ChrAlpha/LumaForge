import { createProgram } from '@lumaforge/lmfg-cli'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runCliTool, toCallToolResult } from './server'
import { findTool, TOOLS } from './tools'

describe('tool table', () => {
  it('names every tool uniquely with a JSON-schema-able input', () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^lmfg_[a-z_]+$/)
      const schema = z.toJSONSchema(z.object(tool.inputShape), {
        target: 'draft-2020-12',
        io: 'input',
      })
      expect(schema.type).toBe('object')
    }
  })

  it('builds argv that mirrors the CLI flags', () => {
    expect(
      findTool('lmfg_render_sweep')!.argv({
        session: 'sess_1',
        plan: { axes: { exposure_ev: [0, 1] } },
        quality: 80,
        contact_sheet: true,
        concurrency: 'auto',
        workspace: '.lmfg',
        timeout_ms: 5000,
      }),
    ).toEqual([
      'render',
      'sweep',
      '--plan-json',
      '{"axes":{"exposure_ev":[0,1]}}',
      '--quality',
      '80',
      '--contact-sheet',
      '--concurrency',
      'auto',
      '--workspace',
      '.lmfg',
      '--session',
      'sess_1',
      '--timeout',
      '5000',
    ])
  })
})

/** A value of the input's type; argv only formats it, so no refinement applies. */
function sample(schema: z.ZodType): unknown {
  const def = schema._zod.def
  switch (def.type) {
    case 'optional':
      return sample((schema as z.ZodOptional).unwrap() as z.ZodType)
    case 'string':
      return 'x'
    case 'number':
      return 2
    case 'boolean':
      return true
    case 'enum':
      return (schema as z.ZodEnum).options[0]
    case 'literal':
      return (schema as z.ZodLiteral).value
    case 'union':
      return sample((schema as z.ZodUnion).options[0] as z.ZodType)
    case 'record':
      return { k: 1 }
    default:
      throw new Error(`No sample for a ${def.type} input.`)
  }
}

type Command = ReturnType<typeof createProgram>

function leafCommands(command: Command, path: string[] = []): string[][] {
  if (command.commands.length === 0) return [path]
  return command.commands.flatMap((sub) =>
    leafCommands(sub, [...path, sub.name()]),
  )
}

describe('tools against the CLI program', () => {
  const program = createProgram(
    { stdout: () => {}, stderr: () => {}, cwd: '/' },
    () => {},
  )

  it('maps the tools one-to-one onto the leaf CLI commands', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(
      leafCommands(program)
        .map((path) => `lmfg_${path.join('_')}`)
        .sort(),
    )
  })

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s passes every input as a declared argument or option of its command',
    (name, tool) => {
      const input = Object.fromEntries(
        Object.entries(tool.inputShape).map(([key, schema]) => [
          key,
          sample(schema as z.ZodType),
        ]),
      )
      const argv = tool.argv(input)
      let command = program
      const path: string[] = []
      for (
        let sub = command.commands.find((c) => c.name() === argv[path.length]);
        sub;
        sub = command.commands.find((c) => c.name() === argv[path.length])
      ) {
        command = sub
        path.push(sub.name())
      }
      expect(`lmfg_${path.join('_')}`).toBe(name)
      const options = [...command.options, ...program.options]
      const positionals: string[] = []
      for (let i = path.length; i < argv.length; i += 1) {
        const option = options.find((o) => o.long === argv[i])
        if (!argv[i].startsWith('--')) positionals.push(argv[i])
        else if (!option) expect.fail(`${argv[i]} is not an option of ${name}`)
        else if (option.required || option.optional) i += 1
      }
      expect(positionals.length).toBeLessThanOrEqual(
        command.registeredArguments.length,
      )
      for (const key of Object.keys(tool.inputShape)) {
        const { [key]: _omitted, ...rest } = input
        if ((tool.inputShape[key] as z.ZodType).safeParse(undefined).success)
          expect(tool.argv(rest), `${name} ${key}`).not.toEqual(argv)
      }
    },
  )
})

describe('runCliTool / toCallToolResult', () => {
  it('parses the envelope, forwards --quiet, and maps failures to isError', async () => {
    const calls: string[][] = []
    const fake = async (
      argv: readonly string[],
      io: { stdout: (s: string) => void },
    ) => {
      calls.push([...argv])
      io.stdout(
        '{"schema":"lmfg.version.v1","ok":true,"result":{"lmfg":"0.1.0"}}\n',
      )
      return 0
    }
    const run = await runCliTool(['version'], '/tmp', fake as never)
    expect(calls[0]).toEqual(['version', '--quiet'])
    expect(run.envelope.ok).toBe(true)
    const result = toCallToolResult(run)
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({ ok: true, exit_code: 0 })
    expect(
      JSON.parse((result.content[0] as { text: string }).text),
    ).toMatchObject({
      result: { lmfg: '0.1.0' },
    })

    const failing = async (
      _argv: readonly string[],
      io: { stdout: (s: string) => void },
    ) => {
      io.stdout(
        '{"schema":"lmfg.error.v1","ok":false,"error":{"code":"args.invalid","message":"nope"}}\n',
      )
      return 2
    }
    const failed = toCallToolResult(
      await runCliTool(['x'], '/tmp', failing as never),
    )
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      exit_code: 2,
      error: { code: 'args.invalid' },
    })

    const silent = async () => 10
    const broken = toCallToolResult(
      await runCliTool(['x'], '/tmp', silent as never),
    )
    expect(broken.isError).toBe(true)
    expect(broken.structuredContent).toMatchObject({
      error: { code: 'internal' },
    })
  })
})
