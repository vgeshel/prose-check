/**
 * The Codex and Muse Code status command.
 *
 *   bun adapters/status.ts [--project DIR] status codex|muse [--json] [--session ID]
 *
 * The launcher at `~/.local/state/prose-check/bin/prose-check` runs it with
 * `--project` set to the caller's working directory.
 */
import type { CacheStatus, Status } from '../core/status'
import { formatStatus } from '../core/status'
import { aggregate } from '../core/records'
import { parseCachedRules, isRecord } from '../core/rules'
import { hashSources, readSources } from '../core/sources'
import { cacheFile } from './check'
import type { CommandHarness } from './contracts'
import { parseExtractionStatus } from './contracts'
import { processEnvironment } from './environment'
import { parseJson, readText } from './files'
import type { Project } from './project'
import { loadProject } from './project'
import { isLeased } from './runtime'

/** The parsed command line. */
export interface StatusArguments {
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
  if (command !== 'status' || (harness !== 'codex' && harness !== 'muse') || rest.length > 0)
    return {
      error: 'usage: prose-check status codex|muse [--json] [--session ID]',
    }

  return { project, harness, json, session }
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

/** Runs the command; returns the exit status. */
export async function main(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  write: (text: string) => void,
): Promise<number> {
  const args = parseArguments(argv, cwd)
  if ('error' in args) {
    write(`${args.error}\n`)

    return 2
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
