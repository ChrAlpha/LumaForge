#!/usr/bin/env node
// Large-fixture validation for the lmfg CLI: export, verify, and replay
// 60-100 MP RAW files under both memory profiles, recording wall time and
// peak RSS. Gated by LMFG_LARGE_FIXTURES=1 because the fixtures are not
// redistributable and each run takes minutes.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = [
  {
    label: 'GFX100RF RAF (102 MP)',
    path:
      process.env.LUMAFORGE_100MP_RAF ??
      '/workspaces/LumaForge/test-images/Fujifilm - GFX100RF - 16bit lossless compressed (4_3).RAF',
  },
  {
    label: 'Sony ARW (61 MP)',
    path: process.env.LUMAFORGE_SONY_ARW ?? '/workspaces/LumaForge/test-images/SGL00940.ARW',
  },
]
const PROFILES = ['desktop', 'low-memory']

if (process.env.LMFG_LARGE_FIXTURES !== '1') {
  console.error('Set LMFG_LARGE_FIXTURES=1 to run the large-fixture validation.')
  process.exit(0)
}
for (const fixture of FIXTURES) {
  if (!existsSync(fixture.path)) {
    console.error(`Missing fixture: ${fixture.path}`)
    process.exit(2)
  }
}

/** Run the CLI in a child process and return its envelope plus peak RSS. */
function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { runCli } = await import(${JSON.stringify(join(PACKAGE_DIR, 'dist', 'index.js'))});
         const code = await runCli(${JSON.stringify([...args, '--quiet'])});
         process.stderr.write('\\n__RSS__ ' + process.resourceUsage().maxRSS * 1024 + '\\n');
         process.exitCode = code;`,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const rss = Number(/__RSS__ (\d+)/.exec(stderr)?.[1] ?? 0)
      const last = stdout.trim().split('\n').filter(Boolean).at(-1)
      let envelope = null
      try {
        envelope = last ? JSON.parse(last) : null
      } catch {
        envelope = null
      }
      resolve({ code, envelope, rss, seconds: (performance.now() - started) / 1000, stderr })
    })
  })
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(0)
}

const rows = []
const cwd = await mkdtemp(join(tmpdir(), 'lmfg-large-'))
await writeFile(join(cwd, 'params.json'), JSON.stringify({ exposure_ev: 0.2, contrast: 10 }))
try {
  for (const fixture of FIXTURES) {
    const init = await runCli(['session', 'init', '--source', fixture.path], cwd)
    if (init.code !== 0) throw new Error(`session init failed: ${init.stderr}`)
    const session = init.envelope.result.id
    for (const profile of PROFILES) {
      const output = `final-${profile}`
      const exported = await runCli(
        ['render', 'export', '--session', session, '--params', 'params.json', '--output', output, '--memory-profile', profile, '--yes'],
        cwd,
      )
      const manifestPath = join(cwd, '.lmfg', 'sessions', session, 'exports', `${output}.manifest.json`)
      const verified = exported.code === 0 ? await runCli(['manifest', 'verify', manifestPath], cwd) : null
      const replayed =
        exported.code === 0
          ? await runCli(['render', 'replay', '--session', session, '--manifest', manifestPath, '--name', `replay-${profile}`, '--memory-profile', profile, '--yes'], cwd)
          : null
      const result = exported.envelope?.result
      rows.push({
        fixture: fixture.label,
        profile,
        export_ok: exported.code === 0,
        export_seconds: exported.seconds.toFixed(1),
        export_rss_mb: mb(exported.rss),
        cli_reported_rss_mb: result ? mb(result.resource?.max_rss_bytes ?? 0) : 'n/a',
        dimensions: result ? `${result.output.width}x${result.output.height}` : 'n/a',
        jpeg_mb: result ? (result.output.byte_size / 1024 / 1024).toFixed(1) : 'n/a',
        verify_ok: verified?.code === 0,
        replay_reproduced: replayed?.envelope?.result?.reproduced ?? false,
        replay_seconds: replayed ? replayed.seconds.toFixed(1) : 'n/a',
        error: exported.code === 0 ? '' : exported.envelope?.error?.message ?? exported.stderr.slice(-300),
      })
      // Free disk between runs; the JPEGs are 20-30 MB each.
      await rm(join(cwd, '.lmfg', 'sessions', session, 'replays'), { recursive: true, force: true })
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true })
}

const header = ['fixture', 'profile', 'export_ok', 'export_seconds', 'export_rss_mb', 'dimensions', 'jpeg_mb', 'verify_ok', 'replay_reproduced', 'replay_seconds']
const table = [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${header.map((key) => String(row[key])).join(' | ')} |`),
]
process.stdout.write(`${table.join('\n')}\n`)
const failures = rows.filter((row) => !row.export_ok || !row.verify_ok || !row.replay_reproduced)
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2))
  process.exit(1)
}
