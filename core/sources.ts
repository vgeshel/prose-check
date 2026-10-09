/**
 * Reading the instruction files that each harness gives its model, and
 * hashing them. The caller supplies file access, so the Claude Code mod and
 * the Bun adapters share it.
 */
import type { Harness } from './paths'
import type { Source } from './rules'
import { importedPaths } from './rules'

/** Reads one file; resolves undefined when the file does not exist. */
export type ReadFile = (path: string) => Promise<string | undefined>

/** How many import hops Claude Code follows from a root instruction file. */
export const IMPORT_HOPS = 4

/**
 * Resolves `imported` against the directory of `from`, both relative to the
 * project root. Undefined when the result leaves the project root.
 */
export function resolveImport(from: string, imported: string): string | undefined {
  const parts = from.split('/').slice(0, -1)
  for (const part of imported.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }

  return parts.length === 0 ? undefined : parts.join('/')
}

/** Reads the first of `names` that exists, or with `nonEmpty`, that has text. */
async function first(
  root: string,
  names: readonly string[],
  read: ReadFile,
  nonEmpty: boolean,
): Promise<Source | undefined> {
  for (const path of names) {
    const text = await read(`${root}/${path}`)
    if (text !== undefined && (!nonEmpty || text.trim() !== ''))
      return { path, text }
  }

  return undefined
}

/** Adds the files that `root` imports, breadth first, up to `IMPORT_HOPS` hops. */
async function withImports(
  projectRoot: string,
  root: Source,
  read: ReadFile,
): Promise<Source[]> {
  const sources = [root]
  let frontier = [root]
  for (let hop = 1; hop <= IMPORT_HOPS && frontier.length > 0; hop += 1) {
    const next: Source[] = []
    for (const source of frontier) {
      for (const imported of importedPaths(source.text)) {
        const path = resolveImport(source.path, imported)
        if (path === undefined || sources.some((known) => known.path === path))
          continue
        const text = await read(`${projectRoot}/${path}`)
        if (text === undefined) continue
        const added = { path, text }
        sources.push(added)
        next.push(added)
      }
    }
    frontier = next
  }

  return sources
}

/**
 * Reads the project-root instruction files that `harness` gives its model:
 *
 * - Claude Code: `CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md`,
 *   with their `@path` imports up to four hops deep.
 * - Codex: the first non-empty file of `AGENTS.override.md` and `AGENTS.md`.
 *   Codex does not read `CLAUDE.md` or follow imports.
 * - Muse Code: `AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`,
 *   without imports.
 */
export async function readSources(
  root: string,
  read: ReadFile,
  harness: Harness,
): Promise<Source[]> {
  if (harness === 'codex') {
    const found = await first(root, ['AGENTS.override.md', 'AGENTS.md'], read, true)

    return found === undefined ? [] : [found]
  }
  if (harness === 'muse') {
    const found = await first(root, ['AGENTS.md', 'CLAUDE.md'], read, false)

    return found === undefined ? [] : [found]
  }
  const found = await first(root, ['CLAUDE.md', 'AGENTS.md'], read, false)

  return found === undefined ? [] : withImports(root, found, read)
}

/** SHA-256 of `text`, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** The hash that identifies one version of the instruction files. */
export function hashSources(sources: readonly Source[]): Promise<string> {
  return sha256Hex(JSON.stringify(sources))
}
