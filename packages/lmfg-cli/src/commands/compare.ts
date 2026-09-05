import { encodePreviewFrameToJpeg } from '@lumaforge/render-engine/preview'
import type { Command } from 'commander'
import { InvalidArgumentError } from 'commander'

import type { CompareSheetResult } from '../schemas/results'
import type { SheetTile } from '../services/contact-sheet'
import { buildContactSheet } from '../services/contact-sheet'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'
import type { CommandHost } from './context'
import { runCommand } from './context'
import { openRenderSession, withRuntime } from './render-shared'

function parseLayout(value: string): { cols: number; rows: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match)
    throw new InvalidArgumentError('Expected <cols>x<rows>, e.g. 4x3.')
  const cols = Number.parseInt(match[1], 10)
  const rows = Number.parseInt(match[2], 10)
  if (cols < 1 || rows < 1)
    throw new InvalidArgumentError('Layout dimensions must be positive.')
  return { cols, rows }
}

type SheetOptions = {
  iteration: string
  layout?: { cols: number; rows: number }
  gap: number
  name?: string
}

export function registerCompareCommands(
  program: Command,
  host: CommandHost,
): void {
  const compare = program
    .command('compare')
    .description('Compose comparison artifacts from rendered candidates')
  compare
    .command('sheet')
    .description(
      'Recompose a contact sheet for an iteration from its stored candidate tiles',
    )
    .requiredOption('--iteration <id>', 'iteration id, e.g. iter_0001')
    .option(
      '--layout <colsxrows>',
      'grid layout, e.g. 3x2 (default: near-square)',
      parseLayout,
    )
    .option(
      '--gap <n>',
      'gap between tiles in pixels',
      (v: string) => Number.parseInt(v, 10),
      4,
    )
    .option(
      '--name <name>',
      'artifact base name (default: contact-sheet or contact-sheet-<layout>)',
    )
    .action(async function (this: Command, options: SheetOptions) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.compare.sheet.v1', command: 'compare.sheet' },
          async (): Promise<CompareSheetResult> => {
            const { record } = await openRenderSession(ctx)
            const iterationStore = createIterationStore(
              ctx.workspaceRoot,
              record.id,
            )
            const iteration = await iterationStore.read(options.iteration)
            const tiles: SheetTile[] = []
            for (const candidate of iteration.candidates) {
              const tile = await iterationStore.readCandidateTile(
                iteration.id,
                candidate.id,
              )
              tiles.push({ id: candidate.id, ...tile })
            }
            const cols =
              options.layout?.cols ?? Math.ceil(Math.sqrt(tiles.length))
            const built = buildContactSheet({
              tiles,
              cols,
              rows: options.layout?.rows,
              gap: options.gap,
            })
            const name =
              options.name ??
              (options.layout
                ? `contact-sheet-${built.cols}x${built.rows}`
                : 'contact-sheet')
            return withRuntime(ctx, async (runtime) => {
              const jpegRuntime = await runtime.jpeg()
              const jpeg = (await encodePreviewFrameToJpeg(
                (o) => jpegRuntime.createEncoder(o),
                {
                  rgba: built.sheet.rgba,
                  width: built.sheet.width,
                  height: built.sheet.height,
                  quality: 0.85,
                },
              )) as Uint8Array
              const written = await iterationStore.writeContactSheet(
                iteration.id,
                {
                  name,
                  jpeg,
                  map: {
                    schema: 'lmfg.contact-sheet-map.v1',
                    iteration_id: iteration.id,
                    cols: built.cols,
                    rows: built.rows,
                    tile_width: built.tileWidth,
                    tile_height: built.tileHeight,
                    gap: built.gap,
                    width: built.sheet.width,
                    height: built.sheet.height,
                    tiles: built.map,
                  },
                },
              )
              ctx.output.event({
                event: 'artifact.ready',
                role: 'contact-sheet',
                uri: toFileUri(written.sheet),
              })
              return {
                session_id: record.id,
                iteration_id: iteration.id,
                contact_sheet: {
                  uri: toFileUri(written.sheet),
                  map_uri: toFileUri(written.map),
                  width: built.sheet.width,
                  height: built.sheet.height,
                  cols: built.cols,
                  rows: built.rows,
                  tile_width: built.tileWidth,
                  tile_height: built.tileHeight,
                },
                tiles: built.map,
              }
            })
          },
        ),
      )
    })
}
