/**
 * Whether Jev accepts `TYPESAFE_API_KEY`: the one-question request that tests
 * the key, the reading of its answer, the per-key verdict cache, and the
 * warning that a session start shows for a missing or rejected key.
 *
 *   <state root>/keys/<first 16 hex digits of the key's SHA-256>.json
 *
 * The cache holds `{ verdict, status?, at }` and never the key.
 */
import type { JevAnswer } from './check'
import type { Harness } from './paths'
import { isRecord, jevRequest } from './rules'
import { sha256Hex } from './sources'

/** How long the session-start test of a key waits for Jev. */
export const SESSION_PROBE_TIMEOUT_MS = 3000

/** How long the doctor command waits for Jev. */
export const DOCTOR_PROBE_TIMEOUT_MS = 10_000

/** Where the key comes from. Claude Code passes every key in the environment. */
export type KeySource = 'environment' | '.env.local'

/** The command that checks the setup, as a person runs it in each harness. */
export const DOCTOR_COMMANDS: Readonly<Record<Harness, string>> = {
  claude: '/prose-check doctor',
  codex: '~/.local/state/prose-check/bin/prose-check doctor codex',
  muse: '~/.local/state/prose-check/bin/prose-check doctor muse',
}

/** Where each harness's hooks read the key from, as an instruction. */
export const KEY_LOCATIONS: Readonly<Record<Harness, string>> = {
  claude:
    'Set it in the "env" block of ~/.claude/settings.json, or export it in the shell that starts Claude Code, then start a new session',
  codex:
    "Set it in the project root's .env.local, or export it in the shell that starts Codex, then start a new session",
  muse: "Set it in the project root's .env.local, then start a new session",
}

/** The request body that tests a key: one question about the reply `ok`. */
export function keyProbeRequest(): string {
  return jevRequest(
    [
      {
        rule: 'Write in English.',
        question: 'Is `response` written in a language other than English?',
      },
    ],
    'ok',
  )
}

/** What one answer from Jev says about the key. */
export type KeyCheck =
  | { kind: 'accepted' }
  /** HTTP 401 or 403: Jev did not authenticate the key. */
  | { kind: 'rejected'; status: number }
  | { kind: 'http-error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'failed'; detail: string }

/** Reads one Jev answer as a verdict on the key. */
export function keyCheck(answer: JevAnswer): KeyCheck {
  if (answer.kind === 'answered') return { kind: 'accepted' }
  if (answer.kind === 'timeout') return { kind: 'timeout' }
  if (answer.status === undefined) return { kind: 'failed', detail: answer.detail }

  return answer.status === 401 || answer.status === 403
    ? { kind: 'rejected', status: answer.status }
    : { kind: 'http-error', status: answer.status }
}

/** The verdict cache file for `key`. */
export async function keyFile(stateRoot: string, key: string): Promise<string> {
  return `${stateRoot}/keys/${(await sha256Hex(key)).slice(0, 16)}.json`
}

/** A cached verdict on one key. */
interface Verdict {
  verdict: 'accepted' | 'rejected'
  status?: number
  at: string
}

function parseVerdict(text: string | undefined): Verdict | undefined {
  let value: unknown
  try {
    value = text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    (value.verdict !== 'accepted' && value.verdict !== 'rejected') ||
    typeof value.at !== 'string'
  )
    return undefined

  return {
    verdict: value.verdict,
    at: value.at,
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  }
}

/** The effects the key test uses. */
export interface KeyDependencies {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string): Promise<void>
  /** Sends `body` to Jev with the key under test. */
  probe(body: string): Promise<JevAnswer>
  now(): number
}

/**
 * Caches an accepted or rejected verdict for `key`; other results leave the
 * cache alone. A failed write is ignored: the next session tests again.
 */
export async function recordKeyCheck(
  key: string,
  stateRoot: string | undefined,
  check: KeyCheck,
  deps: Pick<KeyDependencies, 'write' | 'now'>,
): Promise<void> {
  if (stateRoot === undefined) return
  if (check.kind !== 'accepted' && check.kind !== 'rejected') return
  const value: Verdict = {
    verdict: check.kind,
    ...(check.kind === 'rejected' ? { status: check.status } : {}),
    at: new Date(deps.now()).toISOString(),
  }
  await deps
    .write(await keyFile(stateRoot, key), JSON.stringify(value))
    .catch(() => undefined)
}

/**
 * The warning for a key that Jev rejected with `status`. Claude Code shows a
 * plugin's transcript line under the plugin's name; the command adapters add
 * the `prose-check:` prefix themselves.
 */
export function rejectedKeyWarning(
  status: number,
  source: KeySource,
  harness: Harness,
): string {
  return `Jev rejected TYPESAFE_API_KEY with HTTP ${status}, so every reply finishes unchecked. The key comes from ${source === 'environment' ? 'the environment' : '.env.local'}. Replace it with a valid TypeSafe API key. ${KEY_LOCATIONS[harness]}. Then run ${DOCTOR_COMMANDS[harness]} to confirm.`
}

/** The warning for a missing key. */
export function missingKeyWarning(harness: Harness): string {
  return `TYPESAFE_API_KEY is not set, so every reply finishes unchecked. ${KEY_LOCATIONS[harness]}. Then run ${DOCTOR_COMMANDS[harness]} to confirm.`
}

/**
 * The warning a session start shows, or undefined when the key is usable or
 * Jev could not judge it. A key whose cached verdict is `accepted` costs no
 * request; any other key gets one request of at most
 * `SESSION_PROBE_TIMEOUT_MS`. Only an accepted verdict is cached, so a
 * rejected key is tested, and warned about, at every session start.
 */
export async function sessionKeyWarning(
  key: { key: string; source: KeySource } | undefined,
  stateRoot: string | undefined,
  harness: Harness,
  deps: KeyDependencies,
): Promise<string | undefined> {
  if (key === undefined || key.key === '') return missingKeyWarning(harness)
  const cached =
    stateRoot === undefined
      ? undefined
      : parseVerdict(
          await deps.read(await keyFile(stateRoot, key.key)).catch(() => undefined),
        )
  if (cached?.verdict === 'accepted') return undefined

  const check = keyCheck(await deps.probe(keyProbeRequest()))
  await recordKeyCheck(key.key, stateRoot, check, deps)

  return check.kind === 'rejected'
    ? rejectedKeyWarning(check.status, key.source, harness)
    : undefined
}

/**
 * Records a check's Jev answer that rejected the key, so that the next
 * session start tests the key again and warns.
 */
export async function noteKeyAnswer(
  key: string,
  stateRoot: string | undefined,
  answer: JevAnswer,
  deps: Pick<KeyDependencies, 'write' | 'now'>,
): Promise<void> {
  const check = keyCheck(answer)
  if (check.kind === 'rejected') await recordKeyCheck(key, stateRoot, check, deps)
}
