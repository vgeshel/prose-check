/** Resolves the project, its settings, the API key, and the state files. */
import type { Options } from '../core/options'
import { projectOptions } from '../core/options'
import type { ProjectState } from '../core/paths'
import { projectState, stateRoot } from '../core/paths'
import type { CommandHarness } from './contracts'
import type { KeySource } from './environment'
import { apiKey } from './environment'
import { parseJson, readText } from './files'

/** The project root: the Git work tree root above `cwd`, or `cwd` outside Git. */
export function projectRoot(cwd: string): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const root = result.stdout.toString().trim()

    return result.exitCode === 0 && root !== '' ? root : cwd
  } catch {
    return cwd
  }
}

/** Everything an adapter command needs to know about the project. */
export interface Project {
  harness: CommandHarness
  root: string
  settings: { options: Options } | { error: string }
  key: { key: string; source: KeySource } | undefined
  stateRoot: string | undefined
  state: ProjectState | undefined
}

/** Reads `.prose-check.json`; a file that is not valid JSON is an error. */
async function settings(
  root: string,
): Promise<{ options: Options } | { error: string }> {
  let text: string | undefined
  try {
    text = await readText(`${root}/.prose-check.json`)
  } catch (error) {
    return { error: `.prose-check.json cannot be read: ${String(error)}` }
  }
  const value = parseJson(text)
  if (text !== undefined && value === undefined)
    return { error: '.prose-check.json is not valid JSON' }
  const parsed = projectOptions(value)

  return 'error' in parsed
    ? { error: `.prose-check.json: ${parsed.error}` }
    : parsed
}

/** Resolves the project that contains `cwd`. */
export async function loadProject(
  harness: CommandHarness,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Project> {
  const root = projectRoot(cwd)
  const base = stateRoot(env.HOME)

  return {
    harness,
    root,
    settings: await settings(root),
    key: await apiKey(root, env),
    stateRoot: base,
    state:
      base === undefined ? undefined : await projectState(base, harness, root),
  }
}
