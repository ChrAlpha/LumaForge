/// <reference types="node" />
// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'

import * as exportEntry from './export/index'
import * as rootEntry from './index'
import * as policyEntry from './policy/index'

const srcDir = fileURLToPath(new URL('.', import.meta.url))
const entries = {
  root: join(srcDir, 'index.ts'),
  export: join(srcDir, 'export/index.ts'),
  policy: join(srcDir, 'policy/index.ts'),
}

const contextTypes = [
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
]

let program: ts.Program

beforeAll(() => {
  program = ts.createProgram({
    rootNames: Object.values(entries),
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      noEmit: true,
      types: [],
    },
  })
}, 30_000)

/** The `@deprecated` text (whitespace collapsed) a consumer of `entry` sees on `name`. */
function deprecationOf(entry: string, name: string): string | null {
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entry)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  const exported =
    moduleSymbol && checker.tryGetMemberInModuleExports(name, moduleSymbol)
  if (!exported) throw new Error(`${name} is not exported from ${entry}`)
  const declared =
    exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported
  const tag = declared
    .getJsDocTags(checker)
    .find((candidate) => candidate.name === 'deprecated')
  return tag ? ts.displayPartsToString(tag.text).replace(/\s+/g, ' ') : null
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

describe('deprecated engine scaffolding on the public entries', () => {
  it('keeps every deprecated value exported with the same identity', () => {
    expect(rootEntry.NODE_DEFAULT_CAPABILITY).toBe(
      policyEntry.NODE_DEFAULT_CAPABILITY,
    )
    expect(policyEntry.NODE_DEFAULT_CAPABILITY).toEqual({
      coi: false,
      pthread: false,
      deviceMemoryGB: null,
      hwConcurrency: 1,
      webKitClass: 'unknown',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: false,
    })
    expect(typeof exportEntry.createNodeJpegRowSink).toBe('function')
    expect(rootEntry.normalizeExportConcurrency).toBe(
      exportEntry.normalizeExportConcurrency,
    )
  })

  it('keeps the deprecated type shapes on both entries', () => {
    expectTypeOf<rootEntry.ExportFidelity>().toEqualTypeOf<policyEntry.ExportFidelity>()
    expectTypeOf<policyEntry.ExportFidelity>().toEqualTypeOf<
      'safe' | 'balanced' | 'max'
    >()
    expectTypeOf<rootEntry.RenderBudget>().toEqualTypeOf<policyEntry.RenderBudget>()
    expectTypeOf<keyof policyEntry.RenderBudget>().toEqualTypeOf<
      'maxConcurrent' | 'maxCandidatesPerSweep' | 'softMemoryBudgetMiB'
    >()
    expectTypeOf<keyof rootEntry.LumaRenderContext>().toEqualTypeOf<
      | 'rawRuntime'
      | 'jpegRuntime'
      | 'capability'
      | 'observeRenderEvent'
      | 'outputSink'
      | 'manifestStore'
      | 'checkpointStore'
      | 'profileFetcher'
      | 'profileCache'
      | 'signal'
    >()
    expectTypeOf<
      rootEntry.LumaRenderContext['capability']
    >().toEqualTypeOf<policyEntry.CapabilityVector>()
    expectTypeOf(
      policyEntry.NODE_DEFAULT_CAPABILITY,
    ).toEqualTypeOf<policyEntry.CapabilityVector>()
  })

  it('accepts the same preference values for export concurrency', () => {
    expectTypeOf(exportEntry.normalizeExportConcurrency)
      .parameter(1)
      .toEqualTypeOf<policyEntry.PerformancePreference>()
    expectTypeOf(exportEntry.normalizeExportConcurrency)
      .parameter(1)
      .toEqualTypeOf<policyEntry.ExportFidelity>()
    expect(exportEntry.normalizeExportConcurrency(undefined, 'safe')).toBe(1)
    expect(exportEntry.normalizeExportConcurrency(undefined, 'balanced')).toBe(
      2,
    )
    expect(exportEntry.normalizeExportConcurrency(undefined, 'max')).toBe(3)
  })

  it('marks the unused scaffolding deprecated on every entry that exports it', () => {
    for (const name of contextTypes) {
      expect(deprecationOf(entries.root, name), name).not.toBeNull()
    }
    expect(deprecationOf(entries.root, 'LumaRenderContext')).toContain(
      'explicit parameters',
    )
    for (const entry of [entries.root, entries.policy]) {
      expect(deprecationOf(entry, 'RenderBudget')).not.toBeNull()
      expect(deprecationOf(entry, 'NODE_DEFAULT_CAPABILITY')).toContain(
        'CapabilityVector',
      )
      expect(deprecationOf(entry, 'ExportFidelity')).toContain(
        'PerformancePreference',
      )
    }
    expect(deprecationOf(entries.export, 'createNodeJpegRowSink')).toContain(
      'JpegRowSink',
    )
    expect(deprecationOf(entries.export, 'BytesJpegRuntime')).not.toBeNull()
    expect(deprecationOf(entries.export, 'BytesJpegEncoder')).not.toBeNull()
  })

  it('leaves the replacements supported', () => {
    expect(deprecationOf(entries.policy, 'PerformancePreference')).toBeNull()
    for (const entry of [entries.root, entries.policy]) {
      expect(deprecationOf(entry, 'CapabilityVector')).toBeNull()
    }
    for (const entry of [entries.root, entries.export]) {
      expect(deprecationOf(entry, 'normalizeExportConcurrency')).toBeNull()
    }
    expect(deprecationOf(entries.export, 'JpegRowSink')).toBeNull()
    expect(deprecationOf(entries.export, 'createWasmJpegRowSink')).toBeNull()
  })

  it('has no engine code depending on ExportFidelity beyond the entries', () => {
    const importers = sourceFiles(srcDir)
      .filter((file) => /\bexport-fidelity'/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file).replaceAll('\\', '/'))
      .sort()
    expect(importers).toEqual(['index.ts', 'policy/index.ts'])
  })
})
