/**
 * One check of a final reply, independent of the harness: the skip
 * conditions, the Jev request, and the reading of Jev's answer. Each harness
 * decides from the result whether to request a rewrite or show a warning.
 */
import type { Rule } from './rules'
import { brokenRules, jevRequest, parseProbabilities } from './rules'

/** Why a check did not run to a verdict. */
export type SkipReason =
  | 'short-reply'
  | 'no-api-key'
  | 'no-rules'
  | 'rules-pending'
  | 'extraction-failed'
  | 'jev-timeout'
  | 'jev-error'
  | 'other-hook-continued'

/** Every skip reason, in the order the status lists them. */
export const SKIP_REASONS: readonly SkipReason[] = [
  'short-reply',
  'no-api-key',
  'no-rules',
  'rules-pending',
  'extraction-failed',
  'jev-timeout',
  'jev-error',
  'other-hook-continued',
]

/** The project's rules as the cache has them when a check starts. */
export type RulesLookup =
  | { kind: 'ready'; rules: Rule[] }
  /** The project has no instruction files, or they state no writing rules. */
  | { kind: 'none' }
  /** The rules for the current files are not cached; extraction is running or starting. */
  | { kind: 'pending' }
  /** The last extraction for the current files failed; a new one is starting. */
  | { kind: 'failed'; reason: string }

/** Jev's answer to one request, with the time it took. */
export type JevAnswer =
  | { kind: 'answered'; body: string; latencyMs: number }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'error'; detail: string; latencyMs: number }

/** The result of one check. */
export type Evaluation =
  | {
      kind: 'skipped'
      reason: SkipReason
      detail?: string
      latencyMs?: number
    }
  | {
      kind: 'checked'
      rules: Rule[]
      probabilities: number[]
      broken: Rule[]
      threshold: number
      latencyMs: number
    }

/** What a check needs from its harness. */
export interface CheckDependencies {
  /** Looks up the cached rules; starts an extraction when they are missing. */
  rules(): Promise<RulesLookup>
  /** Sends one request body to Jev and waits at most the configured timeout. */
  jev(body: string): Promise<JevAnswer>
}

/** Checks `reply`. The order of the skip conditions is fixed. */
export async function evaluate(
  reply: string,
  settings: { minLength: number; breachThreshold: number },
  apiKey: string | undefined,
  deps: CheckDependencies,
): Promise<Evaluation> {
  if (reply.trim().length < Math.max(settings.minLength, 1))
    return { kind: 'skipped', reason: 'short-reply' }
  if (apiKey === undefined || apiKey === '')
    return { kind: 'skipped', reason: 'no-api-key' }

  const lookup = await deps.rules()
  if (lookup.kind === 'none') return { kind: 'skipped', reason: 'no-rules' }
  if (lookup.kind === 'pending')
    return { kind: 'skipped', reason: 'rules-pending' }
  if (lookup.kind === 'failed')
    return {
      kind: 'skipped',
      reason: 'extraction-failed',
      detail: lookup.reason,
    }
  const { rules } = lookup
  if (rules.length === 0) return { kind: 'skipped', reason: 'no-rules' }

  const answer = await deps.jev(jevRequest(rules, reply))
  if (answer.kind === 'timeout')
    return {
      kind: 'skipped',
      reason: 'jev-timeout',
      latencyMs: answer.latencyMs,
    }
  if (answer.kind === 'error')
    return {
      kind: 'skipped',
      reason: 'jev-error',
      detail: answer.detail,
      latencyMs: answer.latencyMs,
    }

  const probabilities = parseProbabilities(rules, answer.body)
  if (probabilities === undefined)
    return {
      kind: 'skipped',
      reason: 'jev-error',
      detail: "Jev's response lacks a probability for every rule",
      latencyMs: answer.latencyMs,
    }

  return {
    kind: 'checked',
    rules,
    probabilities,
    broken: brokenRules(rules, probabilities, settings.breachThreshold),
    threshold: settings.breachThreshold,
    latencyMs: answer.latencyMs,
  }
}
