import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as publicApi from '../index'
import {
  assertPortablePathSegment,
  DEFAULT_WORKSPACE_DIRNAME,
  isPortablePathSegment,
  resolveWorkspaceRoot,
  workspacePaths as paths,
} from './paths'

const root = '/workspace/.lmfg'
const sid = 'sess_20260906T000000_abcdef'
const iter = 'iter_0001'

describe('workspace artifact segments', () => {
  const selectors: Array<[string, (value: string) => string]> = [
    ['session', (value) => paths.sessionFile(root, value)],
    ['iteration', (value) => paths.iterationPlanFile(root, sid, value)],
    [
      'candidate',
      (value) => paths.candidatePreviewFile(root, sid, iter, value),
    ],
    ['preview', (value) => paths.previewManifestFile(root, sid, value)],
    ['sheet', (value) => paths.contactSheetMapFile(root, sid, iter, value)],
    ['export', (value) => paths.exportManifestFile(root, sid, value)],
    ['session replay', (value) => paths.replayOutputFile(root, sid, value)],
    ['workspace replay', (value) => paths.workspaceReplay(root, value)],
    ['LUT cache', (value) => paths.lutCacheFile(root, value)],
  ]

  it.each(selectors)(
    'rejects path syntax in the %s selector',
    (_name, path) => {
      for (const value of [
        '',
        '.',
        '..',
        '../outside',
        '/outside',
        'a/b',
        'a\\b',
        '\\outside',
        'C:outside',
        'C:\\outside',
        '\\\\host\\share',
        'bad\0name',
        'bad\nname',
      ]) {
        expect(() => path(value), value).toThrow(/single portable path segment/)
      }
    },
  )

  it.each([
    'NUL',
    'CON.txt',
    'aUx',
    'prn.jpg',
    'COM1',
    'lpt9.png',
    'COM¹',
    'LPT².jpg',
    'CONIN$',
    'CONOUT$',
    'a:b',
    'a?b',
    'a*b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    'trailing.',
    'trailing ',
  ])('rejects Windows-special basename %s on every OS', (value) => {
    expect(() => paths.exportFile(root, sid, value)).toThrow(
      /single portable path segment/,
    )
  })

  it('preserves ordinary basenames and the existing suffix behavior', () => {
    for (const name of [
      'final',
      'final.jpg',
      'Gallery final',
      '照片',
      'contrast.v2',
      'COM10',
    ]) {
      expect(paths.exportFile(root, sid, name)).toBe(
        join(root, 'sessions', sid, 'exports', `${name}.jpg`),
      )
      expect(paths.contactSheetFile(root, sid, iter, name)).toBe(
        join(root, 'sessions', sid, 'iterations', iter, `${name}.jpg`),
      )
    }
  })
})

describe('portable path segment rule', () => {
  it('accepts ordinary identifiers and rejects path syntax', () => {
    for (const value of ['sess_20260906T000000_abcdef', 'final.jpg', '照片'])
      expect(isPortablePathSegment(value), value).toBe(true)
    for (const value of ['', '..', 'a/b', 'a\\b', 'NUL', 'trailing.', 1, null])
      expect(isPortablePathSegment(value), String(value)).toBe(false)
  })

  it('returns accepted segments and throws args.invalid otherwise', () => {
    expect(assertPortablePathSegment('iter_0001')).toBe('iter_0001')
    expect(() => assertPortablePathSegment('../outside')).toThrow(
      expect.objectContaining({
        code: 'args.invalid',
        message: expect.stringMatching(/single portable path segment/),
      }),
    )
  })
})

describe('workspace root and layout', () => {
  it('resolves the default .lmfg root and explicit roots against cwd', () => {
    expect(DEFAULT_WORKSPACE_DIRNAME).toBe('.lmfg')
    expect(resolveWorkspaceRoot('/work')).toBe(resolve('/work', '.lmfg'))
    expect(resolveWorkspaceRoot('/work', 'out/ws')).toBe(
      resolve('/work', 'out/ws'),
    )
    expect(resolveWorkspaceRoot('/work', '/abs/ws')).toBe(resolve('/abs/ws'))
  })

  it('pins the session artifact layout', () => {
    const session = join(root, 'sessions', sid)
    expect(paths.sessionFile(root, sid)).toBe(join(session, 'session.json'))
    expect(paths.iterationPlanFile(root, sid, iter)).toBe(
      join(session, 'iterations', iter, 'plan.json'),
    )
    expect(paths.contactSheetFile(root, sid, iter)).toBe(
      join(session, 'iterations', iter, 'contact-sheet.jpg'),
    )
    expect(paths.contactSheetMapFile(root, sid, iter)).toBe(
      join(session, 'iterations', iter, 'contact-sheet.map.json'),
    )
    expect(paths.candidatePreviewFile(root, sid, iter, 'cand_0001')).toBe(
      join(
        session,
        'iterations',
        iter,
        'candidates',
        'cand_0001',
        'preview.jpg',
      ),
    )
    expect(paths.previewFile(root, sid, 'prev_0001')).toBe(
      join(session, 'previews', 'prev_0001.jpg'),
    )
    expect(paths.exportManifestFile(root, sid, 'final')).toBe(
      join(session, 'exports', 'final.manifest.json'),
    )
  })
})

describe('public workspace contracts', () => {
  it('exports the resolver, layout, segment rule, and record schemas', () => {
    expect(publicApi.resolveWorkspaceRoot).toBe(resolveWorkspaceRoot)
    expect(publicApi.workspacePaths).toBe(paths)
    expect(publicApi.DEFAULT_WORKSPACE_DIRNAME).toBe('.lmfg')
    expect(publicApi.isPortablePathSegment).toBe(isPortablePathSegment)
    expect(publicApi.assertPortablePathSegment).toBe(assertPortablePathSegment)
    expect(typeof publicApi.toFileUri).toBe('function')
    for (const schema of [
      publicApi.SessionRecordSchema,
      publicApi.IterationRecordSchema,
      publicApi.ContactSheetMapSchema,
    ])
      expect(typeof schema?.parse).toBe('function')
  })
})
