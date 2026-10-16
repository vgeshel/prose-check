/**
 * The doctor report: one finding per condition the hooks depend on, each
 * failure with a specific fix. The Claude Code `/prose-check doctor` command
 * and the Codex and Muse Code `prose-check doctor` command gather the
 * findings and print the same report.
 */
import type { KeyCheck, KeySource } from './key'
import { DOCTOR_PROBE_TIMEOUT_MS, KEY_LOCATIONS } from './key'
import type { Harness } from './paths'
import type { CacheStatus } from './status'

/**
 * `ok`: the condition holds; `fail`: replies finish unchecked until it is
 * fixed; `pending`: the plugin is still working on it; `skipped`: not tested,
 * because an earlier condition failed.
 */
export type FindingStatus = 'ok' | 'fail' | 'pending' | 'skipped'

/** The result of one condition. */
export interface Finding {
  check: string
  status: FindingStatus
  detail: string
  /** What to do, for a failure or a pending condition. */
  fix?: string
}

/** Everything the doctor command reports. */
export interface DoctorReport {
  harness: Harness
  version: string
  projectRoot: string
  findings: Finding[]
  /** False when any finding failed. */
  ok: boolean
}

/** The Bun executable the hook launchers use, or undefined when there is none. */
export function bunFinding(path: string | undefined): Finding {
  return path === undefined
    ? {
        check: 'Bun',
        status: 'fail',
        detail: 'not found on PATH or at ~/.bun/bin/bun',
        fix: 'Install Bun from https://bun.com. Its installer puts it at ~/.bun/bin/bun, where the hooks look for it when it is not on PATH.',
      }
    : { check: 'Bun', status: 'ok', detail: path }
}

/**
 * Whether `TYPESAFE_API_KEY` is set where the hooks read it, and where it came
 * from. `inShellOnly`: the shell has a key that the harness does not pass to
 * its hooks.
 */
export function keyFinding(
  key: { source: KeySource } | undefined,
  harness: Harness,
  inShellOnly = false,
): Finding {
  return key === undefined
    ? {
        check: 'TYPESAFE_API_KEY',
        status: 'fail',
        detail: inShellOnly ? 'not set where the hooks read it' : 'not set',
        fix: `${inShellOnly ? 'Your shell exports TYPESAFE_API_KEY, but Muse Code does not pass the shell\'s variables to hooks. ' : ''}${KEY_LOCATIONS[harness]}.`,
      }
    : {
        check: 'TYPESAFE_API_KEY',
        status: 'ok',
        detail: `set (from ${key.source})`,
      }
}

/** Jev's verdict on the key; `check` is undefined when there is no key to test. */
export function jevFinding(
  check: KeyCheck | undefined,
  source: KeySource | undefined,
  harness: Harness,
): Finding {
  const name = 'Jev'
  if (check === undefined)
    return {
      check: name,
      status: 'skipped',
      detail: 'not tested, because TYPESAFE_API_KEY is not set',
    }
  const retry = 'Run the command again; checks that meet this error let replies finish unchecked.'
  switch (check.kind) {
    case 'accepted':
      return { check: name, status: 'ok', detail: 'accepted the key' }
    case 'rejected':
      return {
        check: name,
        status: 'fail',
        detail: `rejected the key with HTTP ${check.status}`,
        fix: `The key from ${source === '.env.local' ? '.env.local' : 'the environment'} is not a valid TypeSafe API key. Replace it. ${KEY_LOCATIONS[harness]}.`,
      }
    case 'http-error':
      return {
        check: name,
        status: 'fail',
        detail: `answered HTTP ${check.status}; the key could not be tested`,
        fix: retry,
      }
    case 'timeout':
      return {
        check: name,
        status: 'fail',
        detail: `did not answer within ${DOCTOR_PROBE_TIMEOUT_MS / 1000} seconds`,
        fix: `Check this machine's connection to https://api.typesafe.ai. ${retry}`,
      }
    case 'failed':
      return {
        check: name,
        status: 'fail',
        detail: check.detail,
        fix: `Check this machine's connection to https://api.typesafe.ai. ${retry}`,
      }
  }
}

/** The files each harness reads, as the fix for a project without them. */
const FILES: Readonly<Record<Harness, string>> = {
  claude: 'CLAUDE.md or AGENTS.md',
  codex: 'AGENTS.md',
  muse: 'AGENTS.md',
}

/** The instruction files found in the project root. */
export function filesFinding(files: readonly string[], harness: Harness): Finding {
  return files.length === 0
    ? {
        check: 'Instruction files',
        status: 'fail',
        detail: 'none in the project root',
        fix: `Run the command in the project, or add the writing rules to ${FILES[harness]} in the project root.`,
      }
    : { check: 'Instruction files', status: 'ok', detail: files.join(', ') }
}

/** The rule cache for the current instruction files. */
export function rulesFinding(cache: CacheStatus, harness: Harness): Finding {
  const name = 'Rules'
  if (cache.state === 'no-files')
    return {
      check: name,
      status: 'skipped',
      detail: 'not extracted, because there are no instruction files',
    }
  if (cache.lastFailure !== undefined && !cache.extracting)
    return {
      check: name,
      status: 'fail',
      detail: `the last extraction failed at ${cache.lastFailure.at}: ${cache.lastFailure.reason}`,
      fix:
        harness === 'claude'
          ? 'The next check retries the extraction. If the failure repeats, the reason names its cause.'
          : `The next session or check retries the extraction. If the failure repeats, the reason names its cause; confirm that \`${harness} exec\` runs in a terminal.`,
    }
  if (cache.state === 'current')
    return (cache.ruleCount ?? 0) === 0
      ? {
          check: name,
          status: 'fail',
          detail: 'the instruction files state no writing rules for replies',
          fix: `Add the writing rules for replies to ${FILES[harness]}.`,
        }
      : {
          check: name,
          status: 'ok',
          detail: `${cache.ruleCount} rules extracted for the current instruction files`,
        }
  if (cache.extracting)
    return {
      check: name,
      status: 'pending',
      detail: 'extraction running',
      fix: 'Run the command again when it finishes.',
    }

  return {
    check: name,
    status: 'pending',
    detail: 'not extracted for the current instruction files yet',
    fix: 'The next session start or check starts the extraction.',
  }
}

/** Whether the plugin can write its state directory; `error` is the write failure. */
export function stateFinding(dir: string | undefined, error: string | undefined): Finding {
  if (dir === undefined)
    return {
      check: 'State directory',
      status: 'fail',
      detail: 'unavailable, because HOME is not set',
      fix: 'Run the harness with HOME set.',
    }

  return error === undefined
    ? { check: 'State directory', status: 'ok', detail: `writable (${dir})` }
    : {
        check: 'State directory',
        status: 'fail',
        detail: `${dir} cannot be written: ${error}`,
        fix: `Make ${dir} and its parent directories writable by your user.`,
      }
}

/** How a person makes each command-hook harness run the plugin's hooks. */
const HOOK_FIXES: Readonly<Record<Exclude<Harness, 'claude'>, string>> = {
  codex:
    'Start a new codex session in this project and send one prompt. If this still fails, run /hooks in Codex and trust the prose-check hooks, then send a prompt in a new session.',
  muse: 'Start a new muse session in this project and send one prompt. If this still fails, run `muse plugins inspect prose-check`: both hooks must show trusted_enabled; run `muse plugins approve prose-check` if they do not.',
}

/** Whether a hook has run in this project: the last session start it recorded. */
export function hooksFinding(
  lastSessionStart: number | undefined,
  harness: Exclude<Harness, 'claude'>,
): Finding {
  return lastSessionStart === undefined
    ? {
        check: 'Hooks',
        status: 'fail',
        detail: 'no session start recorded in this project',
        fix: HOOK_FIXES[harness],
      }
    : {
        check: 'Hooks',
        status: 'ok',
        detail: `the last session started at ${new Date(lastSessionStart).toISOString()}`,
      }
}

const LABELS: Readonly<Record<FindingStatus, string>> = {
  ok: 'ok',
  fail: 'FAIL',
  pending: 'pending',
  skipped: 'skipped',
}

/** The doctor report as plain text. */
export function formatDoctor(report: DoctorReport): string {
  const failures = report.findings.filter((finding) => finding.status === 'fail').length
  const lines = report.findings.flatMap((finding) => [
    `${LABELS[finding.status].padEnd(9)}${finding.check}: ${finding.detail}`,
    ...(finding.fix === undefined ? [] : [`${' '.repeat(9)}Fix: ${finding.fix}`]),
  ])

  return [
    `prose-check ${report.version} doctor (${report.harness})`,
    `Project: ${report.projectRoot}`,
    ...lines,
    failures === 0
      ? 'Result: no problems found.'
      : `Result: ${failures} ${failures === 1 ? 'problem' : 'problems'}; replies finish unchecked until ${failures === 1 ? 'it is' : 'they are'} fixed.`,
  ].join('\n')
}

/** Assembles the report. */
export function doctorReport(
  harness: Harness,
  version: string,
  projectRoot: string,
  findings: Finding[],
): DoctorReport {
  return {
    harness,
    version,
    projectRoot,
    findings,
    ok: findings.every((finding) => finding.status !== 'fail'),
  }
}
