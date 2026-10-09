import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Evaluation, JevAnswer, RulesLookup } from '../core/check'
import { evaluate } from '../core/check'
import type { Options } from '../core/options'
import { modOptions } from '../core/options'
import type { ProjectState } from '../core/paths'
import { projectState, stateRoot } from '../core/paths'
import type { DebugRecord, MetricLine } from '../core/records'
import {
  aggregate,
  checkMetric,
  checkRecord,
  extractionRecord,
  outcomeOf,
} from '../core/records'
import type { CachedRules, Rule, Source } from '../core/rules'
import {
  EXTRACTION_TIMEOUT_MS,
  JEV_URL,
  extractionPrompt,
  isRecord,
  parseCachedRules,
  parseRules,
  rewriteRequest,
  warning,
} from '../core/rules'
import { hashSources, readSources } from '../core/sources'
import type { Status } from '../core/status'
import { formatStatus } from '../core/status'

/** The token cap for the host model's extraction reply. */
const EXTRACTION_MAX_TOKENS = 8192


const turn = atom({ plugin: 'prose-check', key: 'turn' } as const, {
  rewrites: 0,
  violations: [],
})

/**
 * The extraction in flight, by sources hash, so that concurrent checks share
 * one host-model call. A reload drops it; the store keeps finished results.
 */
const pending = new Map<string, Promise<Rule[] | undefined>>()

let options: Options = modOptions({})

/** The last extraction's outcome for a project, kept in the store. */
interface ExtractionStatus {
  hash: string
  status: 'succeeded' | 'failed'
  reason?: string
  at: string
}

function parseExtractionStatus(value: unknown): ExtractionStatus | undefined {
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
  }
}

/** Reads the instruction files Claude Code loads: CLAUDE.md or AGENTS.md, with imports. */
async function projectSources($: EngineInterface): Promise<Source[]> {
  const root = await $.session.root()

  return readSources(
    root,
    async (path) => ((await $.fs.exists(path)) ? await $.fs.read(path) : undefined),
    'claude',
  )
}

/** The state files for this project, or undefined when HOME is not set. */
async function state($: EngineInterface): Promise<ProjectState | undefined> {
  const base = stateRoot(await $.env.get('HOME'))
  if (base === undefined) return undefined

  return projectState(base, 'claude', await $.session.root())
}

/**
 * Appends one line to a state file. The mod's file API only replaces whole
 * files, so a shell append keeps concurrent sessions from losing lines.
 * Failures are ignored: records never block a turn.
 */
async function appendLine(
  $: EngineInterface,
  path: string,
  value: unknown,
): Promise<void> {
  try {
    await $.process.run(
      ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path],
      { stdin: `${JSON.stringify(value)}\n`, timeoutMs: 5000 },
    )
  } catch {
    // The record is lost; the check's result stands.
  }
}

async function debug($: EngineInterface, record: DebugRecord): Promise<void> {
  if (!options.debug) return
  const files = await state($)
  if (files !== undefined) await appendLine($, files.debug, record)
}

async function metric($: EngineInterface, line: MetricLine): Promise<void> {
  const files = await state($)
  if (files !== undefined) await appendLine($, files.metrics, line)
}

/** Asks the host model to extract the rules, then caches them in the store under `rules:<project root>`. */
async function extractRules(
  $: EngineInterface,
  hash: string,
  sources: readonly Source[],
): Promise<Rule[] | undefined> {
  const root = await $.session.root()
  const record = { harness: 'claude' as const, project: root, hash }
  await debug(
    $,
    extractionRecord({ ...record, at: await $.clock.now(), event: 'start' }),
  )

  let rules: Rule[] | undefined
  let reason: string | undefined
  try {
    const reply = await $.model.complete({
      model: await $.session.model(),
      prompt: extractionPrompt(sources),
      maxTokens: EXTRACTION_MAX_TOKENS,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    })
    if (!reply.isAnswered) reason = `the model did not answer (${reply.reason})`
    else {
      rules = parseRules(reply.text)
      if (rules === undefined)
        reason = "the model's reply is not a JSON array of valid rules"
    }
  } catch (error) {
    reason = `the extraction request failed: ${String(error)}`
  }

  const at = await $.clock.now()
  const status: ExtractionStatus = {
    hash,
    status: rules === undefined ? 'failed' : 'succeeded',
    at: new Date(at).toISOString(),
    ...(reason === undefined ? {} : { reason }),
  }
  await $.store.set(`extraction:${root}`, status)
  if (rules === undefined) {
    await debug(
      $,
      extractionRecord({
        ...record,
        at,
        event: 'failure',
        reason: reason ?? 'unknown',
      }),
    )

    return undefined
  }

  const cached: CachedRules = { hash, rules }
  await $.store.set(`rules:${root}`, cached)
  await debug(
    $,
    extractionRecord({
      ...record,
      at,
      event: 'success',
      ruleCount: rules.length,
    }),
  )

  return rules
}

/**
 * Runs one extraction and records it in `pending` while it runs, so that the
 * status view reports it and a concurrent warm-up does not start another.
 */
function trackedExtraction(
  $: EngineInterface,
  hash: string,
  sources: readonly Source[],
): Promise<Rule[] | undefined> {
  const extraction = extractRules($, hash, sources).finally(() => {
    if (pending.get(hash) === extraction) pending.delete(hash)
  })
  if (!pending.has(hash)) pending.set(hash, extraction)

  return extraction
}

/**
 * The rules for the Stop check. When they are not cached, the Stop hook runs
 * the extraction itself and waits for it: a hook's time budget stops only
 * while its own `$` calls run, so it cannot wait on the extraction that
 * session start began.
 */
async function rulesForCheck($: EngineInterface): Promise<RulesLookup> {
  const sources = await projectSources($)
  if (sources.length === 0) return { kind: 'none' }

  const hash = await hashSources(sources)
  const root = await $.session.root()
  const cached = parseCachedRules(await $.store.get(`rules:${root}`))
  if (cached?.hash === hash)
    return cached.rules.length === 0
      ? { kind: 'none' }
      : { kind: 'ready', rules: cached.rules }

  // After a failed extraction, report it at once and retry in the background,
  // so that a failing extraction does not delay every turn.
  const last = parseExtractionStatus(await $.store.get(`extraction:${root}`))
  if (last?.hash === hash && last.status === 'failed') {
    $.clock.after(0, () => {
      void warmRules($)
    })

    return { kind: 'failed', reason: last.reason ?? 'unknown' }
  }

  const rules = await trackedExtraction($, hash, sources)
  if (rules === undefined) {
    const failed = parseExtractionStatus(await $.store.get(`extraction:${root}`))

    return { kind: 'failed', reason: failed?.reason ?? 'the extraction failed' }
  }

  return rules.length === 0 ? { kind: 'none' } : { kind: 'ready', rules }
}

/** Starts the extraction ahead of the first check, so that check finds the rules ready. */
async function warmRules($: EngineInterface): Promise<void> {
  try {
    const sources = await projectSources($)
    if (sources.length === 0) return
    const hash = await hashSources(sources)
    const root = await $.session.root()
    const cached = parseCachedRules(await $.store.get(`rules:${root}`))
    if (cached?.hash === hash || pending.has(hash)) return
    await trackedExtraction($, hash, sources)
  } catch {
    // The first check extracts the rules itself.
  }
}

/**
 * Sends the request to Jev and waits at most `timeoutMs`. A non-2xx status
 * (rate limit, exhausted credit, overload, and the rest) and a network
 * failure are errors.
 */
async function askJev(
  $: EngineInterface,
  apiKey: string,
  body: string,
): Promise<JevAnswer> {
  const started = await $.clock.now()
  const timer = new AbortController()
  const request = $.http
    .fetch(JEV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    .then(
      (response) =>
        response.ok
          ? { kind: 'answered' as const, body: response.text }
          : { kind: 'error' as const, detail: `HTTP ${response.status}` },
      (error: unknown) => ({
        kind: 'error' as const,
        detail: `request failed: ${String(error)}`,
      }),
    )
  const timeout = $.clock.sleep(options.timeoutMs, { signal: timer.signal }).then(
    () => ({ kind: 'timeout' as const }),
    () => ({ kind: 'timeout' as const }),
  )

  const result = await Promise.race([request, timeout])
  timer.abort()
  const latencyMs = (await $.clock.now()) - started

  return { ...result, latencyMs }
}

/** Writes the debug record and the metrics line of one check. */
async function recordCheck(
  $: EngineInterface,
  reply: string,
  evaluation: Evaluation,
  rewriteAllowed: boolean,
): Promise<void> {
  const at = await $.clock.now()
  const session = await $.session.id()
  const outcome = outcomeOf(evaluation, rewriteAllowed)
  await metric($, checkMetric(at, session, evaluation, outcome))
  await debug(
    $,
    checkRecord({
      at,
      harness: 'claude',
      project: await $.session.root(),
      session,
      reply,
      evaluation,
      outcome,
    }),
  )
}

/** Gathers the status view for the current project and session. */
async function status($: EngineInterface): Promise<Status> {
  const root = await $.session.root()
  const files = await state($)
  const manifest: unknown = JSON.parse(
    await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
  )
  const version =
    isRecord(manifest) && typeof manifest.version === 'string'
      ? manifest.version
      : 'unknown'
  const apiKey = await $.env.get('TYPESAFE_API_KEY')

  const sources = await projectSources($)
  const hash = sources.length === 0 ? undefined : await hashSources(sources)
  const cached = parseCachedRules(await $.store.get(`rules:${root}`))
  const last = parseExtractionStatus(await $.store.get(`extraction:${root}`))
  const metricsText =
    files !== undefined && (await $.fs.exists(files.metrics))
      ? await $.fs.read(files.metrics)
      : ''

  return {
    harness: 'claude',
    version,
    projectRoot: root,
    settings: options,
    settingsError: undefined,
    apiKey: {
      isSet: apiKey !== undefined && apiKey !== '',
      source: apiKey !== undefined && apiKey !== '' ? 'environment' : undefined,
    },
    cache: {
      files: sources.map((source) => source.path),
      state:
        hash === undefined
          ? 'no-files'
          : cached === undefined
            ? 'missing'
            : cached.hash === hash
              ? 'current'
              : 'stale',
      ruleCount: cached?.rules.length,
      extracting: hash !== undefined && pending.has(hash),
      lastFailure:
        last !== undefined && last.hash === hash && last.status === 'failed'
          ? { reason: last.reason ?? 'unknown', at: last.at }
          : undefined,
    },
    metrics: aggregate(metricsText, await $.session.id()),
    stateDir: files?.dir,
    debugFile: files?.debug,
  }
}

/**
 * Registers the prose check: rule warm-up and the `/prose-check` command at
 * session start, a per-turn reset, the check at the Stop event, and the
 * warning at turn completion.
 */
export const register: Register = (on, values) => {
  options = modOptions(values)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'prose-check',
      description:
        'Shows prose-check status: settings, API key, rule cache, and check metrics.',
      argumentHint: '[--json]',
      immediate: true,
    })
    $.clock.after(0, () => {
      void (async () => {
        await metric($, {
          at: await $.clock.now(),
          session: await $.session.id(),
          event: 'session-start',
        })
        await warmRules($)
      })()
    })

    return started
  })

  on('command.run', { command: 'prose-check' }, async ($, e) => {
    const current = await status($)

    return {
      text: (e.args ?? '').trim() === '--json'
        ? JSON.stringify(current, null, 2)
        : formatStatus(current),
    }
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, () => ({ rewrites: 0, violations: [] }))

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const reply = e.last_assistant_message ?? ''
    // Another Stop hook already continues the turn; check the reply that ends it.
    if (result.block !== undefined || result.preventContinuation === true) {
      await recordCheck(
        $,
        reply,
        { kind: 'skipped', reason: 'other-hook-continued' },
        false,
      )

      return result
    }

    const apiKey = await $.env.get('TYPESAFE_API_KEY')
    const evaluation = await evaluate(reply, options, apiKey, {
      rules: () => rulesForCheck($),
      jev: (body) => askJev($, apiKey ?? '', body),
    })
    const { rewrites } = await read($, turn)
    await recordCheck($, reply, evaluation, rewrites === 0)
    if (evaluation.kind === 'skipped' || evaluation.broken.length === 0)
      return result

    const breaches = evaluation.broken
    if (rewrites === 0) {
      await update($, turn, (current) => ({ ...current, rewrites: 1 }))

      return { ...result, block: rewriteRequest(breaches) }
    }

    await update($, turn, (current) => ({
      ...current,
      violations: breaches.map((breach) => breach.rule),
    }))

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed

    const { violations } = await read($, turn)

    return violations.length === 0
      ? completed
      : { ...completed, text: warning(violations, 'Claude') }
  }).catch(($, e, next) => next(e))
}
