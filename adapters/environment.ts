/**
 * Process environment access for the Codex and Muse Code adapters, and the
 * `.env.local` fallback for `TYPESAFE_API_KEY`.
 */
import { readText } from './files'

/** The process environment as a plain record of defined strings. */
export function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/**
 * Reads one variable from dotenv text: `NAME=value`, optionally preceded by
 * `export`, with optional single or double quotes around the value. Returns
 * the last assignment, as dotenv loaders do.
 */
export function dotenvValue(text: string, name: string): string | undefined {
  let found: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    )
    if (match === null || match[1] !== name) continue
    let value = (match[2] ?? '').trim()
    const quote = value[0]
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.endsWith(quote)
    )
      value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    found = value
  }

  return found
}

/** Where the adapters found the API key. */
export type KeySource = 'environment' | '.env.local'

/**
 * `TYPESAFE_API_KEY` from the process environment, or else from the project
 * root's `.env.local`. Muse Code runs hooks without the shell's environment,
 * so `.env.local` is how a Muse hook receives the key.
 */
export async function apiKey(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ key: string; source: KeySource } | undefined> {
  const fromEnvironment = env.TYPESAFE_API_KEY
  if (fromEnvironment !== undefined && fromEnvironment !== '')
    return { key: fromEnvironment, source: 'environment' }
  const text = await readText(`${root}/.env.local`).catch(() => undefined)
  const fromFile = text === undefined ? undefined : dotenvValue(text, 'TYPESAFE_API_KEY')

  return fromFile === undefined || fromFile === ''
    ? undefined
    : { key: fromFile, source: '.env.local' }
}
