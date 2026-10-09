/** File effects of the Codex and Muse Code adapters. */
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

/** True for a Node file system error with the given code. */
export function hasCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === code
  )
}

/** Reads a text file; a missing file resolves undefined, other failures reject. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return undefined
    throw error
  }
}

/**
 * Writes a file through a temporary file and a rename, so another process
 * never reads a partial write.
 */
export async function writeText(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * Appends one JSON line in one write to a file opened for appending, so
 * concurrent writers on a local file system do not interleave lines.
 */
export async function appendJsonLine(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

/** Parses JSON text; undefined for missing or invalid text. */
export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
