import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { workspacePaths as paths } from './paths'

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
