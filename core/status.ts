/**
 * The status view: the data every harness gathers, and its text form. The
 * Claude Code `/prose-check` command and the Codex and Muse Code status
 * command print the same report.
 */
import type { SkipReason } from './check'
import { SKIP_REASONS } from './check'
import type { Options } from './options'
import type { Harness } from './paths'
import type { Counters, Metrics } from './records'

/** The rule cache for the current project and instruction files. */
export interface CacheStatus {
  /** The instruction files found in the project root, in reading order. */
  files: string[]
  /** `current`: cached for these files; `stale`: cached for other contents; `missing`: none. */
  state: 'current' | 'stale' | 'missing' | 'no-files'
  /** The number of cached rules, when any are cached. */
  ruleCount: number | undefined
  /** Whether an extraction is running now. */
  extracting: boolean
  /** The reason the last extraction failed, when it failed for these files. */
  lastFailure: { reason: string; at: string } | undefined
}

/** Everything the status view reports. */
export interface Status {
  harness: Harness
  version: string
  projectRoot: string
  /** The settings in effect; undefined with `settingsError` when they are invalid. */
  settings: Options | undefined
  settingsError: string | undefined
  /** Whether `TYPESAFE_API_KEY` is set, and where it was found. */
  apiKey: { isSet: boolean; source: 'environment' | '.env.local' | undefined }
  cache: CacheStatus
  metrics: Metrics
  stateDir: string | undefined
  debugFile: string | undefined
}

const REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  'short-reply': 'reply under minLength',
  'no-api-key': 'no API key',
  'no-rules': 'no writing rules in the project',
  'rules-pending': 'rules not yet extracted',
  'extraction-failed': 'extraction failed',
  'jev-timeout': 'Jev timeout',
  'jev-error': 'Jev error',
  'other-hook-continued': 'another Stop hook continued the turn',
}

function cacheLine(cache: CacheStatus): string {
  if (cache.state === 'no-files')
    return 'no CLAUDE.md or AGENTS.md in the project root'
  const count =
    cache.ruleCount === undefined ? 'no rules' : `${cache.ruleCount} rules`
  const match =
    cache.state === 'current'
      ? 'matches the current instruction files'
      : cache.state === 'stale'
        ? 'does not match the current instruction files'
        : 'no rules cached for the current instruction files'

  return cache.state === 'missing' ? match : `${count}, ${match}`
}

function counterLines(label: string, counters: Counters): string[] {
  const skips = SKIP_REASONS.filter((reason) => counters.skips[reason] > 0)
    .map((reason) => `${REASON_LABELS[reason]} ${counters.skips[reason]}`)
    .join(', ')

  return [
    `${label}:`,
    `  checks completed: ${counters.checks}`,
    `  passes: ${counters.passes}`,
    `  rewrites requested: ${counters.rewrites}`,
    `  warnings shown: ${counters.warnings}`,
    `  skips: ${skips === '' ? 'none' : skips}`,
    `  Jev timeouts: ${counters.jevTimeouts}`,
    `  Jev errors: ${counters.jevErrors}`,
    `  average Jev latency: ${
      counters.averageLatencyMs === undefined
        ? 'no answered checks'
        : `${counters.averageLatencyMs} ms`
    }`,
  ]
}

/** The status view as plain text. */
export function formatStatus(status: Status): string {
  const settings =
    status.settings === undefined
      ? `invalid (${status.settingsError ?? 'unknown error'}); replies finish unchecked`
      : `timeoutMs ${status.settings.timeoutMs}, minLength ${status.settings.minLength}, breachThreshold ${status.settings.breachThreshold}, debug ${status.settings.debug ? 'on' : 'off'}`
  const key = status.apiKey.isSet
    ? `set (from ${status.apiKey.source ?? 'the environment'})`
    : 'not set; replies finish unchecked'
  const extraction = status.cache.extracting
    ? 'running'
    : status.cache.lastFailure === undefined
      ? 'not running'
      : `last attempt failed at ${status.cache.lastFailure.at}: ${status.cache.lastFailure.reason}`

  return [
    `prose-check ${status.version} (${status.harness})`,
    `Project: ${status.projectRoot}`,
    `Settings: ${settings}`,
    `TYPESAFE_API_KEY: ${key}`,
    `Instruction files: ${
      status.cache.files.length === 0 ? 'none' : status.cache.files.join(', ')
    }`,
    `Rule cache: ${cacheLine(status.cache)}`,
    `Extraction: ${extraction}`,
    ...counterLines(
      `This session (${status.metrics.session ?? 'none recorded'})`,
      status.metrics.current,
    ),
    ...counterLines('All sessions', status.metrics.total),
    `State directory: ${status.stateDir ?? 'unavailable: HOME is not set'}`,
    `Debug records: ${
      status.settings?.debug === true
        ? (status.debugFile ?? 'unavailable')
        : 'off'
    }`,
  ].join('\n')
}
