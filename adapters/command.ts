/**
 * The Codex and Muse Code hook command: reads one native hook event on
 * standard input and prints one native hook result. Every failure prints `{}`,
 * which lets the turn finish unchecked.
 */
import { chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

import { checkHook } from './check'
import type { CommandHarness } from './contracts'
import { parseHook } from './contracts'
import { processEnvironment } from './environment'
import { SCRATCH_MARKER } from './extraction'
import { parseJson, readText, writeText } from './files'
import type { Project } from './project'
import { loadProject } from './project'
import { runtime } from './runtime'

/** The plugin's installed root: the directory above `adapters/`. */
export const PLUGIN_ROOT = dirname(import.meta.dir)

/**
 * The launcher installed at `<state root>/bin/prose-check`. It runs the status
 * or doctor command of the plugin copy that the named harness last loaded, and
 * the Claude Code doctor through `claude -p`, because Claude Code passes the
 * key from its own settings only to its sessions.
 */
export const LAUNCHER = `#!/bin/sh
# Written by the prose-check plugin. Runs the status or doctor command of the
# installed plugin copy that the named harness last loaded.
usage="usage: prose-check status codex|muse [--json] [--session ID]
       prose-check doctor claude|codex|muse [--json]"
state="$(cd "$(dirname "$0")/.." && pwd)"
case "$1 $2" in
  "doctor claude") shift 2; exec claude -p "/prose-check doctor\${*:+ $*}" ;;
  "status codex"|"status muse"|"doctor codex"|"doctor muse") ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
root="$(cat "$state/$2/plugin-root" 2>/dev/null)" || {
  echo "prose-check: the prose-check hooks have not run in a $2 session on this machine yet." >&2
  echo "Start a new $2 session in a project and send one prompt, then run this command again. The README's $2 section lists what else to check." >&2
  exit 1
}
bun="$(command -v bun 2>/dev/null)"
if [ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ]; then bun="$HOME/.bun/bin/bun"; fi
if [ -z "$bun" ]; then
  echo "prose-check: Bun was not found on PATH or at ~/.bun/bin/bun. Install Bun from https://bun.com." >&2
  exit 1
fi
project="$PWD"
cd "$root" && exec "$bun" --no-env-file adapters/status.ts --project "$project" "$@"
`

/** Records this copy's location and installs the status launcher. */
export async function installLauncher(project: Project): Promise<void> {
  if (project.stateRoot === undefined) return
  const rootFile = `${project.stateRoot}/${project.harness}/plugin-root`
  if ((await readText(rootFile)) !== PLUGIN_ROOT)
    await writeText(rootFile, PLUGIN_ROOT)
  const launcher = `${project.stateRoot}/bin/prose-check`
  if ((await readText(launcher)) !== LAUNCHER) {
    await writeText(launcher, LAUNCHER)
    await chmod(launcher, 0o755)
  }
}

/** Runs one hook invocation for `harness`. */
export async function runCommand(harness: CommandHarness): Promise<void> {
  let output = {}
  try {
    const event = parseHook(parseJson(await Bun.stdin.text()))
    const isScratch =
      event !== undefined &&
      (await Bun.file(`${event.cwd}/${SCRATCH_MARKER}`).exists())
    if (event !== undefined && !isScratch) {
      const project = await loadProject(harness, event.cwd, processEnvironment())
      if (event.hook_event_name === 'SessionStart')
        await installLauncher(project).catch(() => undefined)
      output = await checkHook(
        event,
        {
          harness,
          root: project.root,
          settings: project.settings,
          apiKey: project.key?.key,
          keySource: project.key?.source,
          stateRoot: project.stateRoot,
          state: project.state,
        },
        runtime,
      )
    }
  } catch {
    output = {}
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}
