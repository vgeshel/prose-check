/**
 * The debug records and metrics lines that every harness writes, and the
 * counting of metrics for the status view. Both files hold one JSON value per
 * line. No record holds the API key.
 */
import type { Evaluation, SkipReason } from './check'
import { SKIP_REASONS } from './check'
import type { Harness } from './paths'
import type { Rule } from './rules'
import { isRecord } from './rules'

/** What a check did to the turn. */
export type Outcome = 'skipped' | 'passed' | 'rewrite-requested' | 'warning-shown'

/** A debug record of one extraction event. */
export interface ExtractionRecord {
  type: 'extraction'
  event: 'start' | 'success' | 'failure'
  at: string
  harness: Harness
  project: string
  hash: string
  ruleCount?: number
  reason?: string
}

/** A debug record of one check at the end of a turn. */
export interface CheckRecord {
  type: 'check'
  at: string
  harness: Harness
  project: string
  session: string
  outcome: Outcome
  reason?: SkipReason
  detail?: string
  replyLength: number
  rules?: Rule[]
  reply?: string
  probabilities?: { rule: string; probability: number }[]
  broken?: string[]
  threshold?: number
  latencyMs?: number
  /** The native hook result the Codex and Muse Code adapters returned. */
  result?: Record<string, string>
}

/** One debug record. */
export type DebugRecord = ExtractionRecord | CheckRecord

/** The outcome a check's evaluation leads to before the harness decides on a rewrite. */
export function outcomeOf(
  evaluation: Evaluation,
  rewriteAllowed: boolean,
): Outcome {
  if (evaluation.kind === 'skipped') return 'skipped'
  if (evaluation.broken.length === 0) return 'passed'

  return rewriteAllowed ? 'rewrite-requested' : 'warning-shown'
}

/** The debug record of one check. */
export function checkRecord(args: {
  at: number
  harness: Harness
  project: string
  session: string
  reply: string
  evaluation: Evaluation
  outcome: Outcome
  result?: Record<string, string>
}): CheckRecord {
  const { evaluation } = args
  const base = {
    type: 'check' as const,
    at: new Date(args.at).toISOString(),
    harness: args.harness,
    project: args.project,
    session: args.session,
    outcome: args.outcome,
    replyLength: args.reply.length,
    ...(args.result === undefined ? {} : { result: args.result }),
  }
  if (evaluation.kind === 'skipped')
    return {
      ...base,
      reason: evaluation.reason,
      ...(evaluation.detail === undefined ? {} : { detail: evaluation.detail }),
      ...(evaluation.latencyMs === undefined
        ? {}
        : { latencyMs: evaluation.latencyMs }),
    }

  return {
    ...base,
    rules: evaluation.rules,
    reply: args.reply,
    probabilities: evaluation.rules.map((rule, index) => ({
      rule: rule.rule,
      probability: evaluation.probabilities[index] ?? 0,
    })),
    broken: evaluation.broken.map((rule) => rule.rule),
    threshold: evaluation.threshold,
    latencyMs: evaluation.latencyMs,
  }
}

/** The debug record of one extraction event. */
export function extractionRecord(args: {
  at: number
  harness: Harness
  project: string
  hash: string
  event: ExtractionRecord['event']
  ruleCount?: number
  reason?: string
}): ExtractionRecord {
  return {
    type: 'extraction',
    event: args.event,
    at: new Date(args.at).toISOString(),
    harness: args.harness,
    project: args.project,
    hash: args.hash,
    ...(args.ruleCount === undefined ? {} : { ruleCount: args.ruleCount }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  }
}

/** One line of the metrics file. */
export type MetricLine =
  | { at: number; session: string; event: 'session-start' }
  | {
      at: number
      session: string
      event: 'check'
      outcome: Outcome
      reason?: SkipReason
      latencyMs?: number
    }

/** The metrics line of one check. */
export function checkMetric(
  at: number,
  session: string,
  evaluation: Evaluation,
  outcome: Outcome,
): MetricLine {
  return {
    at,
    session,
    event: 'check',
    outcome,
    ...(evaluation.kind === 'skipped' ? { reason: evaluation.reason } : {}),
    ...(evaluation.kind === 'checked'
      ? { latencyMs: evaluation.latencyMs }
      : {}),
  }
}

/** Counts of check outcomes over a set of metrics lines. */
export interface Counters {
  /** Checks that Jev answered: passes, rewrites requested, and warnings shown. */
  checks: number
  passes: number
  rewrites: number
  warnings: number
  skips: Record<SkipReason, number>
  jevTimeouts: number
  jevErrors: number
  /** The mean Jev latency of the answered checks, or undefined when there were none. */
  averageLatencyMs: number | undefined
}

/** The counts for one session and for every session. */
export interface Metrics {
  /** The session the `session` counts belong to, when one is known. */
  session: string | undefined
  current: Counters
  total: Counters
}

function emptyCounters(): Counters {
  return {
    checks: 0,
    passes: 0,
    rewrites: 0,
    warnings: 0,
    skips: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
      SkipReason,
      number
    >,
    jevTimeouts: 0,
    jevErrors: 0,
    averageLatencyMs: undefined,
  }
}

function parseLine(line: string): MetricLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.at !== 'number' ||
    typeof value.session !== 'string'
  )
    return undefined
  if (value.event === 'session-start')
    return { at: value.at, session: value.session, event: 'session-start' }
  if (value.event !== 'check') return undefined
  const outcome = value.outcome
  if (
    outcome !== 'skipped' &&
    outcome !== 'passed' &&
    outcome !== 'rewrite-requested' &&
    outcome !== 'warning-shown'
  )
    return undefined
  const reason = SKIP_REASONS.find((known) => known === value.reason)

  return {
    at: value.at,
    session: value.session,
    event: 'check',
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(typeof value.latencyMs === 'number'
      ? { latencyMs: value.latencyMs }
      : {}),
  }
}

function count(lines: readonly MetricLine[]): Counters {
  const counters = emptyCounters()
  let latencyTotal = 0
  let latencyCount = 0
  for (const line of lines) {
    if (line.event !== 'check') continue
    if (line.outcome === 'skipped') {
      if (line.reason !== undefined) counters.skips[line.reason] += 1
      if (line.reason === 'jev-timeout') counters.jevTimeouts += 1
      if (line.reason === 'jev-error') counters.jevErrors += 1
      continue
    }
    counters.checks += 1
    if (line.outcome === 'passed') counters.passes += 1
    if (line.outcome === 'rewrite-requested') counters.rewrites += 1
    if (line.outcome === 'warning-shown') counters.warnings += 1
    if (line.latencyMs !== undefined) {
      latencyTotal += line.latencyMs
      latencyCount += 1
    }
  }
  counters.averageLatencyMs =
    latencyCount === 0 ? undefined : Math.round(latencyTotal / latencyCount)

  return counters
}

/**
 * Counts the metrics file's lines for `session` and in total. Without a
 * session, the current session is the one that started last.
 */
export function aggregate(text: string, session?: string): Metrics {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseLine)
    .filter((line): line is MetricLine => line !== undefined)
  const current =
    session ??
    lines.filter((line) => line.event === 'session-start').at(-1)?.session ??
    lines.at(-1)?.session

  return {
    session: current,
    current: count(lines.filter((line) => line.session === current)),
    total: count(lines),
  }
}
