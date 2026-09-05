import { randomBytes } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

import { LmfgError } from '../protocol/errors'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(path: string): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', {
        message: `File not found: ${path}`,
        cause: error,
      })
    }
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new LmfgError('schema.invalid', {
      message: `File is not valid JSON: ${path}`,
      cause: error,
    })
  }
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!(await fileExists(path))) return null
  return readJson<T>(path)
}

export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path))
  await appendFile(path, `${line}\n`)
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listFiles(
  dir: string,
  suffix?: string,
): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix)),
      )
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
