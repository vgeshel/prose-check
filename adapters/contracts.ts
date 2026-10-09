/**
 * The hook events the Codex and Muse Code adapters consume, and the jobs they
 * hand to the background extractor. Only consumed fields are validated; the
 * hosts send other event metadata too.
 */
import type { Harness } from '../core/paths'
import { isRecord } from '../core/rules'

/** The two command-hook hosts. */
export type CommandHarness = Exclude<Harness, 'claude'>

/** A validated SessionStart or Stop event. */
export type Hook =
  | {
      hook_event_name: 'SessionStart'
      cwd: string
      session_id: string
      model?: string
    }
  | {
      hook_event_name: 'Stop'
      cwd: string
      session_id: string
      turn_id: string
      stop_hook_active: boolean
      last_assistant_message?: string | null
      model?: string
    }

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Validates a hook event's consumed fields; undefined for anything else. */
export function parseHook(value: unknown): Hook | undefined {
  if (!isRecord(value) || !nonEmpty(value.cwd) || !nonEmpty(value.session_id))
    return undefined
  if (value.model !== undefined && typeof value.model !== 'string')
    return undefined
  const model = typeof value.model === 'string' ? { model: value.model } : {}
  const common = { cwd: value.cwd, session_id: value.session_id, ...model }
  if (value.hook_event_name === 'SessionStart')
    return { hook_event_name: 'SessionStart', ...common }
  if (value.hook_event_name !== 'Stop') return undefined
  if (!nonEmpty(value.turn_id) || typeof value.stop_hook_active !== 'boolean')
    return undefined
  const message = value.last_assistant_message
  if (message !== undefined && message !== null && typeof message !== 'string')
    return undefined

  return {
    hook_event_name: 'Stop',
    ...common,
    turn_id: value.turn_id,
    stop_hook_active: value.stop_hook_active,
    ...(message === undefined ? {} : { last_assistant_message: message }),
  }
}

/** A background extraction job: the prompt and where its results go. */
export interface Extraction {
  harness: CommandHarness
  root: string
  hash: string
  /** The rule cache file for `hash`. */
  cachePath: string
  /** The project's `extraction.json`. */
  statusPath: string
  /** The debug file, when debug records are on. */
  debugPath?: string
  prompt: string
  model?: string
}

/** Validates an extraction job read from the extractor's standard input. */
export function parseExtraction(value: unknown): Extraction | undefined {
  if (!isRecord(value)) return undefined
  const { harness, root, hash, cachePath, statusPath, debugPath, prompt, model } =
    value
  if (harness !== 'codex' && harness !== 'muse') return undefined
  if (
    !nonEmpty(root) ||
    typeof hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !nonEmpty(cachePath) ||
    !nonEmpty(statusPath) ||
    typeof prompt !== 'string' ||
    (debugPath !== undefined && !nonEmpty(debugPath)) ||
    (model !== undefined && typeof model !== 'string')
  )
    return undefined

  return {
    harness,
    root,
    hash,
    cachePath,
    statusPath,
    prompt,
    ...(debugPath === undefined ? {} : { debugPath }),
    ...(model === undefined ? {} : { model }),
  }
}

/** The native hook result: continuation feedback, a warning, or nothing. */
export interface HookOutput {
  decision?: 'block'
  reason?: string
  systemMessage?: string
}

/** A session's rewrite allowance, which survives host-generated continuations. */
export interface TurnState {
  turnId: string
  rewritten: boolean
}

/** Validates stored turn state. */
export function parseTurn(value: unknown): TurnState | undefined {
  return isRecord(value) &&
    typeof value.turnId === 'string' &&
    typeof value.rewritten === 'boolean'
    ? { turnId: value.turnId, rewritten: value.rewritten }
    : undefined
}

/** The last extraction's outcome for a project, in `extraction.json`. */
export interface ExtractionStatus {
  hash: string
  status: 'succeeded' | 'failed'
  at: string
  reason?: string
  ruleCount?: number
}

/** Validates a stored extraction status. */
export function parseExtractionStatus(
  value: unknown,
): ExtractionStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.hash !== 'string' ||
    (value.status !== 'succeeded' && value.status !== 'failed') ||
    typeof value.at !== 'string'
  )
    return undefined

  return {
    hash: value.hash,
    status: value.status,
    at: value.at,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.ruleCount === 'number'
      ? { ruleCount: value.ruleCount }
      : {}),
  }
}
