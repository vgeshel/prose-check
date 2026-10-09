/**
 * The check's settings and their defaults, shared by the Claude Code mod and
 * the Codex and Muse Code adapters.
 */
import { DEFAULT_BREACH_THRESHOLD, isRecord } from './rules'

/** The default wait for Jev, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 300

/** The default minimum reply length, in characters, that the check applies to. */
export const DEFAULT_MIN_LENGTH = 200

/** The settings in effect for one check. */
export interface Options {
  timeoutMs: number
  minLength: number
  breachThreshold: number
  debug: boolean
}

/** The settings used when nothing overrides them. */
export const DEFAULT_OPTIONS: Options = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  minLength: DEFAULT_MIN_LENGTH,
  breachThreshold: DEFAULT_BREACH_THRESHOLD,
  debug: false,
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isMinLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 1
}

/**
 * Reads the Claude Code mod's `userConfig` values. A missing or invalid value
 * falls back to its default, field by field.
 */
export function modOptions(values: Readonly<Record<string, unknown>>): Options {
  return {
    timeoutMs: isTimeout(values.timeoutMs)
      ? values.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    minLength: isMinLength(values.minLength)
      ? values.minLength
      : DEFAULT_MIN_LENGTH,
    breachThreshold: isThreshold(values.breachThreshold)
      ? values.breachThreshold
      : DEFAULT_BREACH_THRESHOLD,
    debug: values.debug === true,
  }
}

/**
 * Reads a project's `.prose-check.json` for the Codex and Muse Code adapters.
 * `undefined` (no file) gives the defaults. Returns an error message when the
 * file is not an object or a present field is invalid; the adapters then let
 * every reply finish unchecked.
 */
export function projectOptions(
  value: unknown,
): { options: Options } | { error: string } {
  if (value === undefined) return { options: DEFAULT_OPTIONS }
  if (!isRecord(value)) return { error: 'the file is not a JSON object' }

  const options = { ...DEFAULT_OPTIONS }
  if (value.timeoutMs !== undefined) {
    if (!isTimeout(value.timeoutMs))
      return { error: 'timeoutMs must be a positive number' }
    options.timeoutMs = value.timeoutMs
  }
  if (value.minLength !== undefined) {
    if (!isMinLength(value.minLength))
      return { error: 'minLength must be a non-negative integer' }
    options.minLength = value.minLength
  }
  if (value.breachThreshold !== undefined) {
    if (!isThreshold(value.breachThreshold))
      return {
        error: 'breachThreshold must be greater than 0 and at most 1',
      }
    options.breachThreshold = value.breachThreshold
  }
  if (value.debug !== undefined) {
    if (typeof value.debug !== 'boolean')
      return { error: 'debug must be true or false' }
    options.debug = value.debug
  }

  return { options }
}
