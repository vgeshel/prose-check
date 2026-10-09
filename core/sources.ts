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

/** The SHA-256 round constants (FIPS 180-4, section 4.2.2). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** SHA-256 of `bytes` (FIPS 180-4), computed without leaving the current task. */
function sha256(bytes: Uint8Array): Uint8Array {
  const blocks = Math.ceil((bytes.length + 9) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = bytes.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let block = 0; block < blocks; block += 1) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block * 64 + t * 4)
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15] ?? 0
      const b = w[t - 2] ?? 0
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = [
      hash[0] ?? 0, hash[1] ?? 0, hash[2] ?? 0, hash[3] ?? 0,
      hash[4] ?? 0, hash[5] ?? 0, hash[6] ?? 0, hash[7] ?? 0,
    ]
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choice + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] = (hash[0] ?? 0) + a
    hash[1] = (hash[1] ?? 0) + b
    hash[2] = (hash[2] ?? 0) + c
    hash[3] = (hash[3] ?? 0) + d
    hash[4] = (hash[4] ?? 0) + e
    hash[5] = (hash[5] ?? 0) + f
    hash[6] = (hash[6] ?? 0) + g
    hash[7] = (hash[7] ?? 0) + h
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  hash.forEach((word, index) => outView.setUint32(index * 4, word))

  return out
}

/**
 * SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. It computes the digest
 * synchronously instead of with `crypto.subtle`, whose digest completes off
 * the main thread: the Claude Code test kit cannot wait for that, so tests of
 * background extraction raced it.
 */
export function sha256Hex(text: string): Promise<string> {
  const digest = sha256(new TextEncoder().encode(text))

  return Promise.resolve(
    [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
}

/** The hash that identifies one version of the instruction files. */
export function hashSources(sources: readonly Source[]): Promise<string> {
  return sha256Hex(JSON.stringify(sources))
}
