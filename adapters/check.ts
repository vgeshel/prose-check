/**
 * The Codex and Muse Code hook logic: rule lookup with background extraction,
 * the check, the rewrite allowance per session, and the records. File,
 * process, clock, and HTTP effects are injected.
 */
import type { JevAnswer, RulesLookup } from '../core/check'
import { evaluate } from '../core/check'
import type { Options } from '../core/options'
import type { ProjectState } from '../core/paths'
import { AGENT_NAMES } from '../core/paths'
import type { DebugRecord } from '../core/records'
import {
  checkMetric,
  checkRecord,
  extractionRecord,
  outcomeOf,
} from '../core/records'
import {
  EXTRACTION_TIMEOUT_MS,
  extractionPrompt,
  parseCachedRules,
  rewriteRequest,
  warning,
} from '../core/rules'
import { hashSources, readSources, sha256Hex } from '../core/sources'
import type { CommandHarness, Extraction, Hook, HookOutput } from './contracts'
import { parseExtractionStatus, parseTurn } from './contracts'
import { parseJson } from './files'

/** The effects the hook logic uses. */
export interface AdapterDependencies {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string): Promise<void>
  append(path: string, value: unknown): Promise<void>
  /**
   * Takes the project's extraction lease and starts the extractor. Resolves
   * false without starting one when another extraction holds the lease.
   */
  extract(job: Extraction): Promise<boolean>
  jev(body: string, timeoutMs: number, key: string): Promise<JevAnswer>
  now(): number
  sleep(ms: number): Promise<void>
}

/**
 * How long the Stop hook waits for a running extraction before it lets the
 * reply finish unchecked: past the extraction limit, so that the wait sees
 * the extraction's result or its recorded failure. The Stop hook timeouts in
 * `hooks/codex.json` and `.muse-plugin/plugin.json` are set above this.
 */
export const RULES_WAIT_MS = EXTRACTION_TIMEOUT_MS + 10_000

/** How often the waiting Stop hook looks for the extraction's result. */
const POLL_MS = 500

/** What one hook invocation knows about its project. */
export interface HookContext {
  harness: CommandHarness
  root: string
  /** The settings from `.prose-check.json`, or why they are invalid. */
  settings: { options: Options } | { error: string }
  apiKey: string | undefined
  /** The state files; undefined when `HOME` is not set. */
  state: ProjectState | undefined
}

/** The cache file for one instruction-file hash. */
export function cacheFile(state: ProjectState, hash: string): string {
  return `${state.rules}/${hash}.json`
}

async function turnFile(state: ProjectState, session: string): Promise<string> {
  return `${state.turns}/${await sha256Hex(session)}.json`
}

/** The rule lookup, with the cache file it reads, for a later wait. */
interface Lookup {
  rules: RulesLookup
  hash?: string
  cachePath?: string
}

/**
 * Looks up the rules for the current instruction files. When they are not
 * cached, starts the extraction unless one is already running.
 */
async function lookupRules(
  event: Hook,
  context: HookContext,
  options: Options,
  state: ProjectState,
  deps: AdapterDependencies,
): Promise<Lookup> {
  const sources = await readSources(context.root, deps.read, context.harness)
  if (sources.length === 0) return { rules: { kind: 'none' } }

  const hash = await hashSources(sources)
  const cachePath = cacheFile(state, hash)
  const cached = parseCachedRules(parseJson(await deps.read(cachePath)))
  if (cached?.hash === hash)
    return {
      rules:
        cached.rules.length === 0
          ? { kind: 'none' }
          : { kind: 'ready', rules: cached.rules },
    }

  const last = parseExtractionStatus(parseJson(await deps.read(state.extraction)))
  const started = await deps.extract({
    harness: context.harness,
    root: context.root,
    hash,
    cachePath,
    statusPath: state.extraction,
    ...(options.debug ? { debugPath: state.debug } : {}),
    prompt: extractionPrompt(sources),
    ...(event.model === undefined ? {} : { model: event.model }),
  })
  if (started && options.debug)
    await record(
      deps,
      state,
      extractionRecord({
        at: deps.now(),
        harness: context.harness,
        project: context.root,
        hash,
        event: 'start',
      }),
    )

  return {
    rules:
      started && last?.hash === hash && last.status === 'failed'
        ? { kind: 'failed', reason: last.reason ?? 'unknown' }
        : { kind: 'pending' },
    hash,
    cachePath,
  }
}

/**
 * Waits up to `RULES_WAIT_MS` for the running extraction of `hash`: until its
 * rules are cached, or it records a failure after the wait began.
 */
async function waitForRules(
  hash: string,
  cachePath: string,
  state: ProjectState,
  deps: AdapterDependencies,
): Promise<RulesLookup> {
  const began = deps.now()
  while (deps.now() - began < RULES_WAIT_MS) {
    await deps.sleep(POLL_MS)
    const cached = parseCachedRules(parseJson(await deps.read(cachePath)))
    if (cached?.hash === hash)
      return cached.rules.length === 0
        ? { kind: 'none' }
        : { kind: 'ready', rules: cached.rules }
    const last = parseExtractionStatus(parseJson(await deps.read(state.extraction)))
    if (
      last?.hash === hash &&
      last.status === 'failed' &&
      Date.parse(last.at) >= began
    )
      return { kind: 'failed', reason: last.reason ?? 'unknown' }
  }

  return { kind: 'pending' }
}

/** The rules for the Stop check: the lookup, then a wait while extraction runs. */
async function rulesForCheck(
  event: Hook,
  context: HookContext,
  options: Options,
  state: ProjectState,
  deps: AdapterDependencies,
): Promise<RulesLookup> {
  const lookup = await lookupRules(event, context, options, state, deps)
  if (
    lookup.rules.kind !== 'pending' ||
    lookup.hash === undefined ||
    lookup.cachePath === undefined
  )
    return lookup.rules

  return waitForRules(lookup.hash, lookup.cachePath, state, deps)
}

async function record(
  deps: AdapterDependencies,
  state: ProjectState,
  value: DebugRecord,
): Promise<void> {
  await deps.append(state.debug, value).catch(() => undefined)
}

async function sessionStart(
  event: Extract<Hook, { hook_event_name: 'SessionStart' }>,
  context: HookContext,
  options: Options,
  state: ProjectState,
  deps: AdapterDependencies,
): Promise<HookOutput> {
  await deps
    .append(state.metrics, {
      at: deps.now(),
      session: event.session_id,
      event: 'session-start',
    })
    .catch(() => undefined)
  await deps
    .write(state.project, JSON.stringify({ root: context.root }))
    .catch(() => undefined)
  await lookupRules(event, context, options, state, deps)

  return {}
}

async function stop(
  event: Extract<Hook, { hook_event_name: 'Stop' }>,
  context: HookContext,
  options: Options,
  state: ProjectState,
  deps: AdapterDependencies,
): Promise<HookOutput> {
  const statePath = await turnFile(state, event.session_id)
  // A new human turn resets the allowance, even when its reply is skipped.
  if (!event.stop_hook_active)
    await deps.write(
      statePath,
      JSON.stringify({ turnId: event.turn_id, rewritten: false }),
    )

  const reply = event.last_assistant_message ?? ''
  const evaluation = await evaluate(reply, options, context.apiKey, {
    rules: () => rulesForCheck(event, context, options, state, deps),
    jev: (body) => deps.jev(body, options.timeoutMs, context.apiKey ?? ''),
  })

  let rewriteAllowed = true
  if (evaluation.kind === 'checked' && evaluation.broken.length > 0) {
    const previous = parseTurn(parseJson(await deps.read(statePath)))
    // Another hook's continuation keeps the turn id, so it does not consume the allowance.
    rewriteAllowed = !(
      previous?.rewritten === true &&
      (previous.turnId === event.turn_id || event.stop_hook_active)
    )
  }

  const outcome = outcomeOf(evaluation, rewriteAllowed)
  let output: HookOutput = {}
  if (outcome === 'warning-shown' && evaluation.kind === 'checked')
    output = {
      systemMessage: warning(
        evaluation.broken.map((rule) => rule.rule),
        AGENT_NAMES[context.harness],
      ),
    }
  if (outcome === 'rewrite-requested' && evaluation.kind === 'checked') {
    await deps.write(
      statePath,
      JSON.stringify({ turnId: event.turn_id, rewritten: true }),
    )
    output = { decision: 'block', reason: rewriteRequest(evaluation.broken) }
  }

  const at = deps.now()
  await deps
    .append(state.metrics, checkMetric(at, event.session_id, evaluation, outcome))
    .catch(() => undefined)
  if (options.debug)
    await record(
      deps,
      state,
      checkRecord({
        at,
        harness: context.harness,
        project: context.root,
        session: event.session_id,
        reply,
        evaluation,
        outcome,
        result: { ...output },
      }),
    )

  return output
}

/**
 * Handles one hook event. Invalid settings, a missing `HOME`, and storage,
 * extraction, or Jev failures let the turn finish unchecked: the result is `{}`.
 */
export async function checkHook(
  event: Hook,
  context: HookContext,
  deps: AdapterDependencies,
): Promise<HookOutput> {
  if (!('options' in context.settings) || context.state === undefined)
    return {}
  const { options } = context.settings
  const { state } = context
  try {
    return event.hook_event_name === 'SessionStart'
      ? await sessionStart(event, context, options, state, deps)
      : await stop(event, context, options, state, deps)
  } catch {
    return {}
  }
}
