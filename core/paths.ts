/**
 * Where prose-check keeps its per-user state: debug records, metrics, and,
 * for Codex and Muse Code, the rule cache and per-session turn state.
 *
 *   <state root>/<harness>/<project id>/
 *
 * The state root is `~/.local/state/prose-check`. It depends on `HOME` alone:
 * Muse Code runs hooks with a reduced environment that keeps `HOME` but not
 * variables such as `XDG_STATE_HOME`, and the hooks and the status command
 * must agree on the location. The project id is the project root's base name
 * and the first 16 hex digits of the SHA-256 of its absolute path, so two
 * projects never share a directory.
 */
import { sha256Hex } from './sources'

/** The three agent harnesses prose-check supports. */
export type Harness = 'claude' | 'codex' | 'muse'

/** The display name of each harness, as the warning text uses it. */
export const AGENT_NAMES: Readonly<Record<Harness, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse',
}

/** The state root, or undefined when `HOME` is not set. */
export function stateRoot(home: string | undefined): string | undefined {
  if (home === undefined || home === '') return undefined

  return `${trimSlash(home)}/.local/state/prose-check`
}

/** The files of one harness and project under the state root. */
export interface ProjectState {
  dir: string
  /** One JSON line per debug record. */
  debug: string
  /** One JSON line per session start and per check. */
  metrics: string
  /** The last extraction's status (Codex and Muse Code). */
  extraction: string
  /** The cached rules, one file per instruction-file hash (Codex and Muse Code). */
  rules: string
  /** The rewrite state of each session (Codex and Muse Code). */
  turns: string
  /** The project root, for a person reading the directory. */
  project: string
}

/** The state files for `harness` and the project at `root`. */
export async function projectState(
  root: string,
  harness: Harness,
  projectRoot: string,
): Promise<ProjectState> {
  const name =
    (trimSlash(projectRoot).split('/').at(-1) ?? '').replace(
      /[^\w.-]/g,
      '_',
    ) || 'root'
  const id = (await sha256Hex(projectRoot)).slice(0, 16)
  const dir = `${root}/${harness}/${name}-${id}`

  return {
    dir,
    debug: `${dir}/debug.jsonl`,
    metrics: `${dir}/metrics.jsonl`,
    extraction: `${dir}/extraction.json`,
    rules: `${dir}/rules`,
    turns: `${dir}/turns`,
    project: `${dir}/project.json`,
  }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
