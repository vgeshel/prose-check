/**
 * The background extractor: runs `codex exec` or `muse exec` with the
 * extraction prompt in an empty scratch directory, validates the reply, and
 * publishes the rules, the extraction status, and the debug records.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { extractionRecord } from '../core/records'
import type { Rule } from '../core/rules'
import { EXTRACTION_TIMEOUT_MS, parseRules } from '../core/rules'
import type { Extraction, ExtractionStatus } from './contracts'
import { appendJsonLine, readText, writeText } from './files'
import { leaseFile } from './runtime'

/**
 * The file that marks a directory as an extraction scratch directory. The
 * harness CLI runs the plugin's own hooks there too; the adapters do nothing
 * in a directory that holds it.
 */
export const SCRATCH_MARKER = '.prose-check-extraction'


const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'question'],
        properties: { rule: { type: 'string' }, question: { type: 'string' } },
      },
    },
  },
}

const SCHEMA_SUFFIX =
  '\nReturn an object with a single rules array, matching the supplied JSON schema. Do not call tools.'

/**
 * The reasoning effort for each CLI's extraction. In October 2026 tests on a
 * 30 KB AGENTS.md, Codex at medium covered every checkable writing rule in
 * about 20 seconds, while low dropped a rule and high took over a minute.
 * Muse Code at medium dropped "prefer short sentences" in 2 of 5 runs and
 * "state specific facts" in 4 of 5; high, its default, covered both in every
 * run but takes 2 to 3 minutes. Set explicitly so a user's Codex setting or a
 * changed Muse default does not change the extraction.
 */
const CODEX_EFFORT = 'medium'
const MUSE_EFFORT = 'high'

function argumentsFor(job: Extraction, prefix: string): string[] {
  const args =
    job.harness === 'codex'
      ? [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--output-schema',
          `${prefix}.schema.json`,
          '--output-last-message',
          `${prefix}.reply.json`,
          '-c',
          `model_reasoning_effort=${CODEX_EFFORT}`,
          '-',
        ]
      : [
          'exec',
          '--prompt-file',
          `${prefix}.prompt.txt`,
          '--output-schema',
          `${prefix}.schema.json`,
          '--max-model-steps',
          '1',
          '--reasoning-effort',
          MUSE_EFFORT,
          '--disable-write',
          '--disable-shell',
          '--disable-web-tools',
          '--disable-reminders',
          '--no-session-log',
        ]
  if (job.model !== undefined && job.model !== '') args.push('--model', job.model)

  return args
}

function run(
  job: Extraction,
  scratch: string,
  prefix: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      job.harness,
      argumentsFor(job, prefix),
      {
        cwd: scratch,
        timeout: EXTRACTION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
      (failure, stdout) => {
        if (failure !== null) reject(failure)
        else resolve(stdout)
      },
    )
    child.stdin?.on('error', reject)
    child.stdin?.end(job.harness === 'codex' ? `${job.prompt}${SCHEMA_SUFFIX}` : '')
  })
}

function describe(job: Extraction, error: unknown): string {
  if (error instanceof Error) {
    const killed = 'killed' in error && error.killed === true
    if (killed)
      return `${job.harness} exec did not finish within ${EXTRACTION_TIMEOUT_MS / 1000} seconds`

    return error.message.split('\n')[0] ?? error.name
  }

  return String(error)
}

/** Runs one extraction job to completion; never rejects. */
export async function runExtraction(job: Extraction): Promise<boolean> {
  const prefix = join(dirname(job.cachePath), `${job.hash}.${randomUUID()}`)
  let scratch: string | undefined
  let rules: Rule[] | undefined
  let reason: string | undefined
  try {
    scratch = await mkdtemp(join(tmpdir(), 'prose-check-'))
    await writeFile(join(scratch, SCRATCH_MARKER), '')
    await writeText(`${prefix}.schema.json`, JSON.stringify(responseSchema))
    await writeText(`${prefix}.prompt.txt`, `${job.prompt}${SCHEMA_SUFFIX}`)
    const stdout = await run(job, scratch, prefix)
    const reply =
      job.harness === 'codex' ? await readText(`${prefix}.reply.json`) : stdout
    rules = parseRules(reply ?? '')
    if (rules === undefined)
      reason = "the model's reply is not a JSON array of valid rules"
    else
      await writeText(job.cachePath, JSON.stringify({ hash: job.hash, rules }))
  } catch (error) {
    rules = undefined
    reason = `the extraction failed: ${describe(job, error)}`
  }

  const at = Date.now()
  const status: ExtractionStatus = {
    hash: job.hash,
    status: rules === undefined ? 'failed' : 'succeeded',
    at: new Date(at).toISOString(),
    ...(reason === undefined ? {} : { reason }),
    ...(rules === undefined ? {} : { ruleCount: rules.length }),
  }
  await writeText(job.statusPath, JSON.stringify(status)).catch(() => undefined)
  if (job.debugPath !== undefined)
    await appendJsonLine(
      job.debugPath,
      extractionRecord({
        at,
        harness: job.harness,
        project: job.root,
        hash: job.hash,
        event: rules === undefined ? 'failure' : 'success',
        ...(rules === undefined
          ? { reason: reason ?? 'unknown' }
          : { ruleCount: rules.length }),
      }),
    ).catch(() => undefined)

  await Promise.all(
    [
      `${prefix}.schema.json`,
      `${prefix}.prompt.txt`,
      `${prefix}.reply.json`,
      leaseFile(job.cachePath),
    ].map((path) => unlink(path).catch(() => undefined)),
  )
  if (scratch !== undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)

  return rules !== undefined
}
