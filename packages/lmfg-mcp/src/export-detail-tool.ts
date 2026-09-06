import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExportDetailInput } from './export-detail'
import { createExportDetail, ExportDetailInputSchema } from './export-detail'

export async function readExportDetail(
  cwd: string,
  args: ExportDetailInput,
): Promise<CallToolResult> {
  try {
    const { png, result } = await createExportDetail(cwd, args)
    const structured = { schema: 'lmfg.export.detail.v1', ok: true, result }
    return {
      content: [
        { type: 'text', text: JSON.stringify(structured) },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
      structuredContent: structured,
      isError: false,
    }
  } catch (error) {
    const structured = {
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'export_detail.refused',
        message:
          error instanceof Error
            ? error.message
            : 'Export detail could not be decoded.',
      },
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: true,
    }
  }
}

export function registerExportDetailTool(server: McpServer, cwd: string): void {
  server.registerTool(
    'lmfg_export_detail',
    {
      title: 'View actual export detail at 1:1',
      description:
        'Inspect a pixel region of an existing lmfg full-resolution JPEG export for texture, noise, and JPEG compression artifacts. Verifies its sealed manifest, source identity, full dimensions, and actual JPEG hash before decoding the captured bytes. Returns a lossless PNG image at 1:1, plus source/export/parent-candidate hashes, exact region and full dimensions, decoder version, and content-addressed PNG/receipt URIs under exports/details. Coordinates refer to the already oriented export pixels. Maximum source 120 MP/512 MiB, region 2 MP, PNG 8 MiB; native decoding memory also depends on the full source. Export first; this does not enlarge a preview or render new RAW pixels.',
      inputSchema: ExportDetailInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => readExportDetail(cwd, args),
  )
}
