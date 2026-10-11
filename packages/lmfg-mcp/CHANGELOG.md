# Changelog

All notable changes to `@lumaforge/lmfg-mcp` are documented here. The format
follows Keep a Changelog; versions follow semver.

## 0.1.0 - Unreleased

First release; `package.json` already reads 0.1.0. Requires
`@lumaforge/lmfg-cli` 0.2.0 and `@lumaforge/render-engine` 0.2.0; the
`workspace:*` dependency ranges publish as those exact versions. Publish
this package last, after `@lumaforge/lmfg-cli` and every package that one
requires (see its changelog).

### Added

- `lmfg-mcp`, a stdio MCP server. Every `lmfg` command is one tool that runs
  the CLI in-process and returns its envelope unchanged as structured
  content, `{ schema, ok, result | error, exit_code }`, so error codes, exit
  codes, fail-closed export rules, and manifests are exactly those of the
  CLI: the strict manifest reading, the `manifest verify` geometry check, the
  RAW error taxonomy, and the `cleanup_failures` diagnostics of
  `@lumaforge/lmfg-cli` 0.2.0 apply unchanged. Failures set `isError: true`.
  `--cwd` sets the directory relative paths and the default `.lmfg`
  workspace resolve against.
- `lmfg_image_read` (`lmfg.image.read.v1`, refusal code `image.refused`):
  the JPEG of one session preview, candidate, or contact sheet, with its
  SHA-256, source identity, dimensions, and the contact-sheet tile map.
- `lmfg_export_detail` (`lmfg.export.detail.v1`, refusal code
  `export_detail.refused`): a lossless 1:1 PNG region of an existing
  full-resolution export, written with a receipt under the session's
  `exports/details`.
- Both image tools read the workspace through the layout and record schemas
  `@lumaforge/lmfg-cli` exports and every manifest through the render-engine
  `parseRenderManifest`, so they accept only what the CLI accepts.
  `lmfg_export_detail` accepts a manifest's recorded output dimensions only
  when the render-engine `checkRecordedExportGeometry` finds them to be the
  frame the export delivers.
