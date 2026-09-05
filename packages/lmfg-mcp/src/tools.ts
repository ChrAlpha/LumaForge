import { z } from 'zod'

/**
 * One MCP tool per `lmfg` command. Inputs are typed with zod so hosts get
 * JSON Schema for free; `argv` turns validated input into the exact CLI
 * argument vector, so behaviour, exit codes, and envelopes stay the CLI's.
 */

const workspace = z
  .string()
  .optional()
  .describe(
    'Artifact root (default: .lmfg under the server working directory).',
  )
const session = z.string().describe('Session id from lmfg_session_init.')
const memoryProfile = z
  .enum(['desktop', 'low-memory'])
  .optional()
  .describe('Native memory profile.')
const timeoutMs = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Per-call timeout in milliseconds.')
const quality = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('JPEG quality 1-100.')
const maxPixels = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Decode budget in pixels.')
const jsonObject = z.record(z.string(), z.unknown())

const GlobalShape = {
  workspace,
  memory_profile: memoryProfile,
  timeout_ms: timeoutMs,
}

type GlobalArgs = {
  workspace?: string
  memory_profile?: 'desktop' | 'low-memory'
  timeout_ms?: number
  session?: string
  yes?: boolean
}

function globals(args: GlobalArgs): string[] {
  const argv: string[] = []
  if (args.workspace) argv.push('--workspace', args.workspace)
  if (args.session) argv.push('--session', args.session)
  if (args.memory_profile) argv.push('--memory-profile', args.memory_profile)
  if (args.timeout_ms) argv.push('--timeout', String(args.timeout_ms))
  if (args.yes) argv.push('--yes')
  return argv
}

function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [name, String(value)]
}

export type ToolSpec<Shape extends z.ZodRawShape> = {
  name: string
  title: string
  description: string
  /** Result schema id the CLI envelope carries on success. */
  resultSchema: string
  inputShape: Shape
  argv: (args: z.infer<z.ZodObject<Shape>>) => string[]
}

/** Shape-erased tool; inputs are validated against `inputShape` before `argv` runs. */
export type AnyToolSpec = {
  name: string
  title: string
  description: string
  resultSchema: string
  inputShape: z.ZodRawShape
  argv: (args: Record<string, unknown>) => string[]
}

function tool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): AnyToolSpec {
  return spec as unknown as AnyToolSpec
}

export const TOOLS = [
  tool({
    name: 'lmfg_version',
    title: 'lmfg version',
    description: 'Report the lmfg CLI and runtime versions.',
    resultSchema: 'lmfg.version.v1',
    inputShape: {},
    argv: () => ['version'],
  }),
  tool({
    name: 'lmfg_capabilities',
    title: 'lmfg capabilities',
    description:
      'Report render tiers, native artifacts, and limits of this install.',
    resultSchema: 'lmfg.capabilities.v1',
    inputShape: { memory_profile: memoryProfile },
    argv: (args) => ['capabilities', ...globals(args)],
  }),
  tool({
    name: 'lmfg_schema_list',
    title: 'lmfg schema list',
    description: 'List every JSON schema id the CLI can describe.',
    resultSchema: 'lmfg.schema.list.v1',
    inputShape: {},
    argv: () => ['schema', 'list'],
  }),
  tool({
    name: 'lmfg_schema_show',
    title: 'lmfg schema show',
    description:
      'Show the JSON Schema (draft 2020-12) for a schema id such as lmfg.params.v1.',
    resultSchema: 'lmfg.schema.show.v1',
    inputShape: { id: z.string().describe('Schema id, e.g. lmfg.params.v1.') },
    argv: (args) => ['schema', 'show', args.id],
  }),
  tool({
    name: 'lmfg_session_init',
    title: 'lmfg session init',
    description:
      'Create a session for a RAW file (computes its full-file SHA-256).',
    resultSchema: 'lmfg.session.v1',
    inputShape: {
      source: z.string().describe('Path to the RAW file.'),
      ...GlobalShape,
    },
    argv: (args) => [
      'session',
      'init',
      '--source',
      args.source,
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_session_status',
    title: 'lmfg session status',
    description:
      'Describe a session: source identity, previews, iterations, exports.',
    resultSchema: 'lmfg.session.status.v1',
    inputShape: { session, workspace },
    argv: (args) => ['session', 'status', ...globals(args)],
  }),
  tool({
    name: 'lmfg_session_list',
    title: 'lmfg session list',
    description: 'List sessions in the workspace.',
    resultSchema: 'lmfg.session.list.v1',
    inputShape: { workspace },
    argv: (args) => ['session', 'list', ...globals(args)],
  }),
  tool({
    name: 'lmfg_inspect',
    title: 'lmfg inspect',
    description:
      'Probe a RAW file (or the session source) for metadata and export capability.',
    resultSchema: 'lmfg.inspect.v1',
    inputShape: {
      file: z
        .string()
        .optional()
        .describe('RAW file; omit to inspect the session source.'),
      session: z.string().optional(),
      ...GlobalShape,
    },
    argv: (args) => [
      'inspect',
      ...(args.file ? [args.file] : []),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_lut_inspect',
    title: 'lmfg lut inspect',
    description:
      'Parse a .cube LUT and resolve its color contract from metadata.',
    resultSchema: 'lmfg.lut.inspect.v1',
    inputShape: { lut: z.string().describe('Path to the .cube file.') },
    argv: (args) => ['lut', 'inspect', args.lut],
  }),
  tool({
    name: 'lmfg_lut_contract_infer',
    title: 'lmfg lut contract infer',
    description:
      'Infer candidate color contracts for a LUT whose metadata is incomplete.',
    resultSchema: 'lmfg.lut.contract.infer.v1',
    inputShape: { lut: z.string() },
    argv: (args) => ['lut', 'contract', 'infer', '--lut', args.lut],
  }),
  tool({
    name: 'lmfg_lut_contract_validate',
    title: 'lmfg lut contract validate',
    description:
      'Validate an explicit color contract against a LUT and report export support.',
    resultSchema: 'lmfg.lut.contract.validate.v1',
    inputShape: {
      lut: z.string(),
      contract: jsonObject.describe('Contract object (lmfg.contract.v1).'),
    },
    argv: (args) => [
      'lut',
      'contract',
      'validate',
      '--lut',
      args.lut,
      '--contract-json',
      JSON.stringify(args.contract),
    ],
  }),
  tool({
    name: 'lmfg_lut_fetch',
    title: 'lmfg lut fetch',
    description:
      'Download a .cube LUT into the workspace cache with SHA-256 verification (network must be allowed explicitly).',
    resultSchema: 'lmfg.lut.fetch.v1',
    inputShape: {
      url: z.string().describe('https URL of the .cube file.'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      out: z
        .string()
        .optional()
        .describe('Destination file (default: workspace LUT cache).'),
      allow_network: z
        .boolean()
        .optional()
        .describe('Permit outbound HTTP(S) for this call.'),
      workspace,
      timeout_ms: timeoutMs,
    },
    argv: (args) => [
      'lut',
      'fetch',
      '--url',
      args.url,
      '--sha256',
      args.sha256,
      ...flag('--out', args.out),
      ...(args.allow_network ? ['--allow-network'] : []),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_render_preview',
    title: 'lmfg render preview',
    description:
      'Render one CPU preview for a params object and store it in the session. Use lmfg_image_read with the returned preview_id to see the image before refining edits.',
    resultSchema: 'lmfg.render.preview.v1',
    inputShape: {
      session,
      params: jsonObject
        .optional()
        .describe('Params object (lmfg.params.v1); defaults when omitted.'),
      max_pixels: maxPixels,
      quality,
      ...GlobalShape,
    },
    argv: (args) => [
      'render',
      'preview',
      ...(args.params ? ['--params-json', JSON.stringify(args.params)] : []),
      ...flag('--max-pixels', args.max_pixels),
      ...flag('--quality', args.quality),
      ...globals(args),
    ],
  }),
  ...(['candidate', 'sweep'] as const).map((kind) =>
    tool({
      name: `lmfg_render_${kind}`,
      title: `lmfg render ${kind}`,
      description:
        kind === 'candidate'
          ? 'Render an explicit list of candidates (lmfg.plan.v1) with per-candidate manifests, metrics, and tiles. Use lmfg_image_read to inspect the contact sheet and selected candidates visually.'
          : 'Expand parameter axes (lmfg.sweep.v1) into candidates and render them with per-candidate manifests, metrics, and tiles. Use lmfg_image_read to inspect the contact sheet and selected candidates visually.',
      resultSchema: `lmfg.render.${kind}.v1`,
      inputShape: {
        session,
        plan: jsonObject.describe(
          kind === 'candidate'
            ? 'Plan object (lmfg.plan.v1).'
            : 'Sweep object (lmfg.sweep.v1).',
        ),
        max_pixels: maxPixels,
        quality,
        contact_sheet: z.boolean().optional(),
        sheet_cols: z.number().int().positive().optional(),
        tile_width: z.number().int().positive().optional(),
        concurrency: z
          .union([z.literal('auto'), z.number().int().min(1).max(64)])
          .optional()
          .describe('Worker threads for candidate rendering (default auto).'),
        ...GlobalShape,
      },
      argv: (args) => [
        'render',
        kind,
        '--plan-json',
        JSON.stringify(args.plan),
        ...flag('--max-pixels', args.max_pixels),
        ...flag('--quality', args.quality),
        ...(args.contact_sheet ? ['--contact-sheet'] : []),
        ...flag('--sheet-cols', args.sheet_cols),
        ...flag('--tile-width', args.tile_width),
        ...flag('--concurrency', args.concurrency),
        ...globals(args),
      ],
    }),
  ),
  tool({
    name: 'lmfg_render_export',
    title: 'lmfg render export',
    description:
      'Full-resolution JPEG export from a candidate (iteration + candidate) or a params object; fails closed when reproducibility cannot be proven.',
    resultSchema: 'lmfg.render.export.v1',
    inputShape: {
      session,
      iteration: z.string().optional(),
      candidate: z.string().optional(),
      params: jsonObject
        .optional()
        .describe('Params object when not exporting a candidate.'),
      quality,
      output: z
        .string()
        .optional()
        .describe('Artifact base name under exports/ (default final).'),
      preferred_rows: z.number().int().positive().optional(),
      yes: z.boolean().optional().describe('Overwrite an existing export.'),
      ...GlobalShape,
    },
    argv: (args) => [
      'render',
      'export',
      ...flag('--iteration', args.iteration),
      ...flag('--candidate', args.candidate),
      ...(args.params ? ['--params-json', JSON.stringify(args.params)] : []),
      ...flag('--quality', args.quality),
      ...flag('--output', args.output),
      ...flag('--preferred-rows', args.preferred_rows),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_render_replay',
    title: 'lmfg render replay',
    description:
      'Re-render a manifest from its recorded params and LUT contract and report whether the output bytes were reproduced.',
    resultSchema: 'lmfg.render.replay.v1',
    inputShape: {
      manifest: z.string().describe('Manifest JSON file to replay.'),
      session: z
        .string()
        .optional()
        .describe('Session whose source to replay against.'),
      source: z
        .string()
        .optional()
        .describe('RAW file to replay against (instead of a session).'),
      lut: z.string().optional().describe('LUT file matching the manifest.'),
      name: z.string().optional().describe('Replay directory name.'),
      yes: z.boolean().optional(),
      ...GlobalShape,
    },
    argv: (args) => [
      'render',
      'replay',
      '--manifest',
      args.manifest,
      ...flag('--source', args.source),
      ...flag('--lut', args.lut),
      ...flag('--name', args.name),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_compare_sheet',
    title: 'lmfg compare sheet',
    description:
      'Recompose a contact sheet from the stored tiles of an iteration.',
    resultSchema: 'lmfg.compare.sheet.v1',
    inputShape: {
      session,
      iteration: z.string(),
      layout: z
        .string()
        .regex(/^\d+x\d+$/)
        .optional()
        .describe('Grid layout, e.g. 3x2.'),
      gap: z.number().int().min(0).optional(),
      name: z.string().optional(),
      workspace,
      timeout_ms: timeoutMs,
    },
    argv: (args) => [
      'compare',
      'sheet',
      '--iteration',
      args.iteration,
      ...flag('--layout', args.layout),
      ...flag('--gap', args.gap),
      ...flag('--name', args.name),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_metrics_compute',
    title: 'lmfg metrics compute',
    description: 'Return stored luma/chroma metrics for a candidate.',
    resultSchema: 'lmfg.metrics.compute.v1',
    inputShape: {
      session,
      iteration: z.string(),
      candidate: z.string(),
      workspace,
    },
    argv: (args) => [
      'metrics',
      'compute',
      '--iteration',
      args.iteration,
      '--candidate',
      args.candidate,
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_metrics_compare',
    title: 'lmfg metrics compare',
    description:
      'Report every candidate of an iteration as metric deltas against a baseline candidate.',
    resultSchema: 'lmfg.metrics.compare.v1',
    inputShape: {
      session,
      iteration: z.string(),
      baseline: z
        .string()
        .optional()
        .describe('Baseline candidate id (default: first).'),
      workspace,
    },
    argv: (args) => [
      'metrics',
      'compare',
      '--iteration',
      args.iteration,
      ...flag('--baseline', args.baseline),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_metrics_rank',
    title: 'lmfg metrics rank',
    description:
      'Score candidates against an objective (lmfg.objective.v1) and rank them best-first.',
    resultSchema: 'lmfg.metrics.rank.v1',
    inputShape: {
      session,
      iteration: z.string(),
      objective: jsonObject.describe(
        'Objective object keyed by metric, e.g. {"luma.mean": {"target": 0.45}}.',
      ),
      workspace,
    },
    argv: (args) => [
      'metrics',
      'rank',
      '--iteration',
      args.iteration,
      '--objective',
      JSON.stringify(args.objective),
      ...globals(args),
    ],
  }),
  tool({
    name: 'lmfg_manifest_verify',
    title: 'lmfg manifest verify',
    description:
      'Verify a render manifest canonical hash and environment match.',
    resultSchema: 'lmfg.manifest.verify.v1',
    inputShape: { manifest: z.string(), memory_profile: memoryProfile },
    argv: (args) => ['manifest', 'verify', args.manifest, ...globals(args)],
  }),
  tool({
    name: 'lmfg_manifest_show',
    title: 'lmfg manifest show',
    description: 'Display a render manifest.',
    resultSchema: 'lmfg.manifest.show.v1',
    inputShape: { manifest: z.string() },
    argv: (args) => ['manifest', 'show', args.manifest],
  }),
]

export function findTool(name: string): AnyToolSpec | undefined {
  return TOOLS.find((spec) => spec.name === name)
}
