/**
 * The Codex and Muse Code status and doctor commands.
 *
 *   bun adapters/status.ts [--project DIR] status codex|muse [--json] [--session ID]
 *   bun adapters/status.ts [--project DIR] doctor codex|muse [--json]
 *
 * The launcher at `~/.local/state/prose-check/bin/prose-check` runs it with
 * `--project` set to the caller's working directory.
 */
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

import type { JevAnswer } from '../core/check'
import type { DoctorReport } from '../core/doctor'
import {
  bunFinding,
  doctorReport,
  filesFinding,
  formatDoctor,
  hooksFinding,
  jevFinding,
  keyFinding,
  rulesFinding,
  stateFinding,
} from '../core/doctor'
import type { KeyCheck } from '../core/key'
import { DOCTOR_PROBE_TIMEOUT_MS, keyCheck, keyProbeRequest, recordKeyCheck } from '../core/key'
import type { CacheStatus, Status } from '../core/status'
import { formatStatus } from '../core/status'
import { aggregate, lastSessionStart } from '../core/records'
import { parseCachedRules, isRecord } from '../core/rules'
import { hashSources, readSources } from '../core/sources'
import { cacheFile } from './check'
import type { CommandHarness } from './contracts'
import { parseExtractionStatus } from './contracts'
import { processEnvironment } from './environment'
import { parseJson, readText, writeText } from './files'
import type { Project } from './project'
import { loadProject } from './project'
import { isLeased, jev } from './runtime'

const USAGE =
  'usage: prose-check status codex|muse [--json] [--session ID]\n       prose-check doctor codex|muse [--json]'

/** The parsed command line. */
export interface StatusArguments {
  command: 'status' | 'doctor'
  project: string
  harness: CommandHarness
  json: boolean
  session: string | undefined
}

/** Parses the command line; returns an error message for an unusable one. */
export function parseArguments(
  argv: readonly string[],
  cwd: string,
): StatusArguments | { error: string } {
  let project = cwd
  let json = false
  let session: string | undefined
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? ''
    if (value === '--json') json = true
    else if (value === '--project' || value === '--session') {
      const next = argv[index + 1]
      if (next === undefined) return { error: `${value} needs a value` }
      index += 1
      if (value === '--project') project = next
      else session = next
    } else positional.push(value)
  }
  const [command, harness, ...rest] = positional
  if (
    (command !== 'status' && command !== 'doctor') ||
    (harness !== 'codex' && harness !== 'muse') ||
    rest.length > 0
  )
    return { error: USAGE }

  return { command, project, harness, json, session }
}

async function version(): Promise<string> {
  const manifest = parseJson(
    await readText(`${import.meta.dir}/../.codex-plugin/plugin.json`),
  )

  return isRecord(manifest) && typeof manifest.version === 'string'
    ? manifest.version
    : 'unknown'
}

async function cacheStatus(project: Project): Promise<CacheStatus> {
  const sources = await readSources(project.root, readText, project.harness)
  if (sources.length === 0)
    return {
      files: [],
      state: 'no-files',
      ruleCount: undefined,
      extracting: false,
      lastFailure: undefined,
    }
  const hash = await hashSources(sources)
  const files = sources.map((source) => source.path)
  if (project.state === undefined)
    return {
      files,
      state: 'missing',
      ruleCount: undefined,
      extracting: false,
      lastFailure: undefined,
    }
  const path = cacheFile(project.state, hash)
  const cached = parseCachedRules(parseJson(await readText(path)))
  const last = parseExtractionStatus(
    parseJson(await readText(project.state.extraction)),
  )
  const isCurrent = cached?.hash === hash
  const isStale =
    !isCurrent &&
    last?.status === 'succeeded' &&
    last.hash !== hash &&
    last.ruleCount !== undefined

  return {
    files,
    state: isCurrent ? 'current' : isStale ? 'stale' : 'missing',
    ruleCount: isCurrent ? cached.rules.length : isStale ? last.ruleCount : undefined,
    extracting: await isLeased(path, Date.now()),
    lastFailure:
      last?.hash === hash && last.status === 'failed'
        ? { reason: last.reason ?? 'unknown', at: last.at }
        : undefined,
  }
}

/** Gathers the status view for one harness and project. */
export async function gatherStatus(
  args: StatusArguments,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Status> {
  const project = await loadProject(args.harness, args.project, env)
  const metricsText =
    project.state === undefined ? '' : ((await readText(project.state.metrics)) ?? '')

  return {
    harness: args.harness,
    version: await version(),
    projectRoot: project.root,
    settings: 'options' in project.settings ? project.settings.options : undefined,
    settingsError: 'error' in project.settings ? project.settings.error : undefined,
    apiKey: {
      isSet: project.key !== undefined,
      source: project.key?.source,
    },
    cache: await cacheStatus(project),
    metrics: aggregate(metricsText, args.session),
    stateDir: project.state?.dir,
    debugFile: project.state?.debug,
  }
}

/** The effects the doctor command uses beyond the file system. */
export interface DoctorDependencies {
  jev(body: string, timeoutMs: number, key: string): Promise<JevAnswer>
  /** The Bun executable the hook launchers would run, or undefined. */
  bun(env: Readonly<Record<string, string | undefined>>): string | undefined
}

/**
 * Finds Bun the way `hooks/run.sh` does: on PATH, then at `~/.bun/bin/bun`.
 */
export function findBun(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const onPath = Bun.which('bun', { PATH: env.PATH ?? '' })
  if (onPath !== null) return onPath
  const home = env.HOME
  const installed = home === undefined || home === '' ? undefined : `${home}/.bun/bin/bun`

  return installed !== undefined && existsSync(installed) ? installed : undefined
}

const DOCTOR_DEPENDENCIES: DoctorDependencies = {
  jev: (body, timeoutMs, key) => jev(body, timeoutMs, key),
  bun: findBun,
}

/** Writes and removes a file in the project's state directory; the error, if any. */
async function writeProbe(dir: string): Promise<string | undefined> {
  const path = `${dir}/.doctor-${process.pid}`
  try {
    await writeText(path, '')
    await unlink(path)

    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Tests every condition the hooks depend on, for one harness and project. */
export async function gatherDoctor(
  args: StatusArguments,
  env: Readonly<Record<string, string | undefined>>,
  deps: DoctorDependencies = DOCTOR_DEPENDENCIES,
): Promise<DoctorReport> {
  // Muse Code passes no shell variable but PATH to hooks, so its hooks see only `.env.local`.
  const shellKey = env.TYPESAFE_API_KEY
  const hookEnv =
    args.harness === 'muse' ? { ...env, TYPESAFE_API_KEY: undefined } : env
  const project = await loadProject(args.harness, args.project, hookEnv)
  let check: KeyCheck | undefined
  if (project.key !== undefined) {
    const answer = await deps.jev(keyProbeRequest(), DOCTOR_PROBE_TIMEOUT_MS, project.key.key)
    check = keyCheck(answer)
    await recordKeyCheck(project.key.key, project.stateRoot, check, {
      write: writeText,
      now: () => Date.now(),
    })
  }
  const metricsText =
    project.state === undefined ? '' : ((await readText(project.state.metrics).catch(() => undefined)) ?? '')
  const cache = await cacheStatus(project).catch(
    (): CacheStatus => ({ files: [], state: 'no-files', ruleCount: undefined, extracting: false, lastFailure: undefined }),
  )

  return doctorReport(args.harness, await version(), project.root, [
    bunFinding(deps.bun(env)),
    keyFinding(
      project.key,
      args.harness,
      project.key === undefined && shellKey !== undefined && shellKey !== '',
    ),
    jevFinding(check, project.key?.source, args.harness),
    hooksFinding(lastSessionStart(metricsText), args.harness),
    filesFinding(cache.files, args.harness),
    rulesFinding(cache, args.harness),
    stateFinding(
      project.state?.dir,
      project.state === undefined ? undefined : await writeProbe(project.state.dir),
    ),
  ])
}

/** Runs the command; returns the exit status. */
export async function main(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  write: (text: string) => void,
  doctorDependencies: DoctorDependencies = DOCTOR_DEPENDENCIES,
): Promise<number> {
  const args = parseArguments(argv, cwd)
  if ('error' in args) {
    write(`${args.error}\n`)

    return 2
  }
  if (args.command === 'doctor') {
    const report = await gatherDoctor(args, env, doctorDependencies)
    write(`${args.json ? JSON.stringify(report, null, 2) : formatDoctor(report)}\n`)

    return report.ok ? 0 : 1
  }
  const status = await gatherStatus(args, env)
  write(
    `${args.json ? JSON.stringify(status, null, 2) : formatStatus(status)}\n`,
  )

  return 0
}

if (import.meta.main)
  process.exitCode = await main(
    process.argv.slice(2),
    process.cwd(),
    processEnvironment(),
    (text) => process.stdout.write(text),
  )
