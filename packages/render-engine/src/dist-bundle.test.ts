/// <reference types="node" />
// @vitest-environment node

// Bundle smoke. If the build output regresses (e.g. vite externalization
// breaks a node:* import, or the subpath exports stop resolving), this test
// catches it before consumers do.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_INDEX = join(packageDir, 'dist', 'index.js')
const DIST_MANIFEST = join(packageDir, 'dist', 'manifest.js')
const DIST_POLICY = join(packageDir, 'dist', 'policy.js')

const DIST_AVAILABLE =
  existsSync(DIST_INDEX) && existsSync(DIST_MANIFEST) && existsSync(DIST_POLICY)

const describeWithDist = DIST_AVAILABLE ? describe : describe.skip

// The context-object and checkpoint-journal types no engine function took.
const RETIRED_SCAFFOLDING = [
  'CheckpointStore',
  'LumaRenderContext',
  'ManifestStore',
  'OutputSink',
  'OutputSinkHandle',
  'OutputSinkMeta',
  'OutputSinkResult',
  'ProfileCache',
  'ProfileFetcher',
  'ProfileFetchOptions',
  'RenderEvent',
  'ExportCheckpointManifest',
  'ExportInProgress',
  'JpegResumeState',
  'OutputIntent',
  'ResumeFingerprint',
  'SourceReacquisitionMode',
  // The policy aliases and defaults no engine function took.
  'ExportFidelity',
  'NODE_DEFAULT_CAPABILITY',
  'RenderBudget',
]

/** The declaration entry of every published subpath, from package.json. */
function publishedTypeEntries(): Record<string, string> {
  const pkg = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as { exports: Record<string, { types: string }> }
  return Object.fromEntries(
    Object.entries(pkg.exports).map(([subpath, target]) => [
      subpath,
      join(packageDir, target.types),
    ]),
  )
}

function declarationFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return declarationFiles(path)
    return entry.name.endsWith('.d.ts') ? [path] : []
  })
}

describeWithDist(
  'dist bundle smoke — guards against vite externalization or subpath regressions',
  () => {
    it('imports + uses sealRenderManifest from the published bundle', async () => {
      const mod = (await import(DIST_INDEX)) as {
        sealRenderManifest: (m: unknown) => { manifest_sha256: string }
        verifyManifestSha256: (m: unknown) => boolean
      }
      const sealed = mod.sealRenderManifest(buildMinimalManifest() as never)
      expect(sealed.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(mod.verifyManifestSha256(sealed)).toBe(true)
    })

    it('@/manifest subpath resolves and exports the hash helpers', async () => {
      const mod = (await import(DIST_MANIFEST)) as {
        sha256Hex: (bytes: Uint8Array) => string
      }
      expect(typeof mod.sha256Hex).toBe('function')
      expect(mod.sha256Hex(new Uint8Array(0))).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })

    it('publishes no retired context, checkpoint or policy scaffolding on any subpath', () => {
      const typeEntries = publishedTypeEntries()
      const program = ts.createProgram({
        rootNames: Object.values(typeEntries),
        options: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          target: ts.ScriptTarget.ESNext,
          noEmit: true,
          types: [],
        },
      })
      const checker = program.getTypeChecker()
      const exportsOf = (subpath: string): Set<string> => {
        const source = program.getSourceFile(typeEntries[subpath])
        const moduleSymbol = source && checker.getSymbolAtLocation(source)
        if (!moduleSymbol) throw new Error(`${subpath} has no declarations`)
        return new Set(
          checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()),
        )
      }

      for (const subpath of Object.keys(typeEntries)) {
        const exported = exportsOf(subpath)
        for (const name of RETIRED_SCAFFOLDING) {
          expect(exported.has(name), `${name} in ${subpath}`).toBe(false)
        }
      }
      // The supported explicit inputs and the manifest identity stay published.
      for (const name of [
        'CapabilityVector',
        'RenderIdentity',
        'RenderManifest',
      ]) {
        expect(exportsOf('.').has(name), name).toBe(true)
      }
      for (const name of [
        'runFullResolutionJpegExport',
        'RunFullResolutionJpegExportInput',
        'JpegRowSink',
        'ExportOutputResult',
        'createWasmJpegRowSink',
      ]) {
        expect(exportsOf('./export').has(name), name).toBe(true)
      }
      expect(exportsOf('./manifest').has('RenderIdentity')).toBe(true)

      const declarations = declarationFiles(join(packageDir, 'dist'))
        .map((file) => relative(packageDir, file).replaceAll('\\', '/'))
        .filter((file) => /\/context\/|\/export-checkpoint\.d\.ts$/.test(file))
      expect(declarations).toEqual([])
    }, 30_000)

    it('@/policy subpath resolves and ships the policy decisions without a Node default', async () => {
      const mod = (await import(DIST_POLICY)) as Record<string, unknown>
      expect(typeof mod.deriveExportPolicy).toBe('function')
      expect(typeof mod.deriveInteractivePolicy).toBe('function')
      expect(typeof mod.deriveRuntimeResourceBudget).toBe('function')
      expect(mod).not.toHaveProperty('NODE_DEFAULT_CAPABILITY')
    })
  },
)

if (!DIST_AVAILABLE) {
  describe('dist bundle smoke — SKIPPED', () => {
    it('dist missing; run `pnpm build` first', () => {
      expect(DIST_AVAILABLE).toBe(false)
    })
  })
}

function buildMinimalManifest() {
  return {
    manifest_version: 1,
    kind: 'preview',
    produced_at: '2026-06-13T12:00:00Z',
    parent_manifest_sha256: null,
    source_raw: {
      sha256: '0'.repeat(64),
      byte_size: 1024,
      filename: 'x.raw',
      decoded_dimensions: { width: 1, height: 1 },
    },
    calibration: null,
    lut: null,
    color_graph: { fingerprint: '0'.repeat(64), descriptor: {} },
    render_params: { exposure_ev: 0 },
    output: {
      format: 'jpeg',
      dimensions: { width: 1, height: 1 },
      color_space: 'srgb',
      quality: 80,
      filename: 'out.jpg',
      sha256: '0'.repeat(64),
    },
    policy: { kind: 'preview-quick', row_slice: 64, concurrency: 1 },
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.0',
      luma_raw_runtime: '0.1.0',
      luma_jpeg_runtime: '0.1.0',
      native_artifacts: { build_id: 'test', variant: 'desktop' },
    },
  }
}
