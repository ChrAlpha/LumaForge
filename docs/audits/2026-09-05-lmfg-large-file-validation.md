# lmfg large-file validation (2026-09-05)

Local run of `LMFG_LARGE_FIXTURES=1 pnpm --filter @lumaforge/lmfg-cli validate:large`
on the devcontainer (16 cores, Node 24.15, `@lumaforge/lmfg-cli` at the P2/P3
working tree). Each row is one `session init` → `render export` →
`manifest verify` → `render replay` chain; `export_rss_mb` is the peak RSS of
the CLI process as reported by `process.resourceUsage().maxRSS`.

| fixture | profile | export_ok | export_seconds | export_rss_mb | dimensions | jpeg_mb | verify_ok | replay_reproduced | replay_seconds |
|---|---|---|---|---|---|---|---|---|---|
| GFX100RF RAF (102 MP) | desktop | true | 84.2 | 1171 | 11662x8746 | 28.4 | true | true | 81.1 |
| GFX100RF RAF (102 MP) | low-memory | true | 89.0 | 1210 | 11662x8746 | 28.4 | true | true | 79.1 |
| Sony ARW (61 MP) | desktop | true | 21.6 | 1078 | 9566x6374 | 42.9 | true | true | 20.6 |
| Sony ARW (61 MP) | low-memory | true | 21.6 | 1043 | 9566x6374 | 42.9 | true | true | 20.4 |

## Streaming export: before and after

Measured on the RAF with the same params, CLI in-process
(`node --input-type=module -e` around `runCli`), one run each:

| path | profile | seconds | peak RSS (MB) |
|---|---|---|---|
| in-memory JPEG (before) | desktop | 81.1 | 1217 |
| in-memory JPEG (before) | low-memory | 81.2 | 1234 |
| streamed to disk (after) | desktop | 81.8 | 1204 |
| streamed to disk (after) | low-memory | 81.7 | 1184 |

Output bytes are identical (`output.sha256` `7a1d89dd1b243e5a…` in every
manifest), so the streaming sink changes memory behaviour only.

## Reading the numbers

- Peak RSS for a 102 MP RAF is about 1.1 to 1.2 GB on both profiles and is
  dominated by the native decode (LibRaw unpacked image plus processed-window
  strips), not by the JPEG. The streaming sink removes the JPEG-sized
  allocations (28 to 43 MB output plus the EXIF copy) but cannot change the
  decoder footprint; a smaller footprint needs the runtime's row-band decode,
  which is out of scope here.
- `--memory-profile low-memory` selects the low-memory native variant; on
  Node it does not reduce peak RSS for these files and is marginally slower on
  the RAF. It remains the profile that mirrors the iOS export path.
- Export time scales with pixel count (about 0.8 s per MP for the RAF, 0.35 s
  per MP for the ARW; the RAF's 16-bit lossless decode is the difference), and
  replay reproduces the export byte for byte in the same time.
- Sweeps: the 64-candidate quick-preview sweep on the public DNG fixture took
  36.3 s serial and 6.2 s with `--concurrency auto` (8 workers), with
  identical per-candidate SHA-256 values.

## How to re-run

```bash
pnpm cli:build
LMFG_LARGE_FIXTURES=1 LUMAFORGE_100MP_RAF=/path/to.RAF LUMAFORGE_SONY_ARW=/path/to.ARW \
  pnpm --filter @lumaforge/lmfg-cli validate:large
```

The script exits non-zero when any export, verification, or replay fails.
