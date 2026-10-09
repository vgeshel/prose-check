/**
 * Helpers for the integration suite: isolated home directories, commands,
 * a terminal driver on a private tmux socket, the plugin's state files, and
 * the step report.
 */
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Harness } from '../core/paths'
import { projectState, stateRoot } from '../core/paths'

/** The repository the suite installs the plugin from, as the README names it. */
export const SOURCE = process.env.PROSE_CHECK_SOURCE ?? 'vgeshel/prose-check'

/** The fixture project's instruction files. */
export const FIXTURE = join(import.meta.dir, 'fixture')

/** The developer's own home, read only to copy sign-in credentials. */
const REAL_HOME = homedir()

/** One isolated machine: a home directory and a fixture project. */
export interface Sandbox {
  harness: Harness
  dir: string
  home: string
  project: string
  /** The environment every CLI in this sandbox runs with. */
  env: Record<string, string>
  key: string
}

/** Copies a file from the developer's home into the sandbox home, if it exists. */
async function copyHomeFile(home: string, path: string): Promise<boolean> {
  const source = join(REAL_HOME, path)
  if (!existsSync(source)) return false
  await mkdir(dirname(join(home, path)), { recursive: true })
  await cp(source, join(home, path), { recursive: true })

  return true
}

/**
 * Creates a sandbox: a fresh home holding only the harness's sign-in
 * credentials and Git's credential configuration, and a Git project with the
 * fixture `CLAUDE.md` and `AGENTS.md`. The developer's own configuration is
 * never read by the CLIs and never changed.
 */
export async function sandbox(
  runDir: string,
  harness: Harness,
  name: string = harness,
): Promise<Sandbox> {
  const key = process.env.TYPESAFE_API_KEY ?? ''
  const dir = join(runDir, name)
  const home = join(dir, 'home')
  const project = join(dir, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  // Git reads these to clone the plugin repository while it is private.
  await copyHomeFile(home, '.gitconfig')
  await copyHomeFile(home, '.config/gh/hosts.yml')
  await copyHomeFile(home, '.config/gh/config.yml')
  if (harness === 'claude') {
    if (!(await copyHomeFile(home, '.claude/.credentials.json')))
      throw new Error('Claude Code is not signed in: ~/.claude/.credentials.json is missing')
    const config = JSON.parse(await readFile(join(REAL_HOME, '.claude.json'), 'utf8')) as Record<string, unknown>
    const kept = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'oauthAccount', 'userID']
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify(Object.fromEntries(kept.filter((k) => k in config).map((k) => [k, config[k]]))),
    )
  }
  if (harness === 'codex' && !(await copyHomeFile(home, '.codex/auth.json')))
    throw new Error('Codex is not signed in: ~/.codex/auth.json is missing')
  if (harness === 'muse') {
    if (!(await copyHomeFile(home, '.config/muse/auth.json')))
      throw new Error('Muse Code is not signed in: ~/.config/muse/auth.json is missing')
    await copyHomeFile(home, '.config/muse/settings.json')
  }
  for (const file of ['CLAUDE.md', 'AGENTS.md'])
    await copyFile(join(FIXTURE, file), join(project, file))
  await run(['git', 'init', '-q', project], { env: { PATH: process.env.PATH ?? '' } })

  return {
    harness,
    dir,
    home,
    project,
    key,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TERM: 'xterm-256color',
      USER: process.env.USER ?? 'tester',
      SHELL: '/bin/bash',
      LANG: 'C.UTF-8',
    },
  }
}

/** The result of one command. */
export interface Ran {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs a command to completion with the given environment only. */
export async function run(
  argv: string[],
  options: { cwd?: string; env: Record<string, string>; timeoutMs?: number; stdin?: string },
): Promise<Ran> {
  const child = Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)

  return { exitCode, stdout, stderr }
}

/** Runs a command and throws with its output when it fails. */
export async function must(
  argv: string[],
  options: { cwd?: string; env: Record<string, string>; timeoutMs?: number; stdin?: string },
): Promise<Ran> {
  const result = await run(argv, options)
  if (result.exitCode !== 0)
    throw new Error(
      `${argv.join(' ')} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim(),
    )

  return result
}

/** A terminal session on the suite's own tmux socket. */
export class Terminal {
  static readonly SOCKET = 'prose-check-integration'

  private constructor(
    readonly name: string,
    private readonly logPath: string,
  ) {}

  /** Starts `argv` in a 200x50 terminal with only `env`. */
  static async start(
    name: string,
    cwd: string,
    argv: string[],
    env: Record<string, string>,
    logPath: string,
  ): Promise<Terminal> {
    const assignments = Object.entries(env).map(([k, v]) => `${k}=${v}`)
    await must(
      ['tmux', '-L', Terminal.SOCKET, 'new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, '--', 'env', '-i', ...assignments, ...argv],
      { env: { PATH: process.env.PATH ?? '', HOME: REAL_HOME, TERM: 'xterm-256color' } },
    )

    return new Terminal(name, logPath)
  }

  private tmux(args: string[]): Promise<Ran> {
    return run(['tmux', '-L', Terminal.SOCKET, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: REAL_HOME, TERM: 'xterm-256color' },
    })
  }

  /**
   * The visible screen, or with `scrollback` the whole pane, with wrapped
   * lines joined. The log file always receives the whole pane.
   */
  async capture(scrollback = false): Promise<string> {
    const whole = await this.tmux(['capture-pane', '-p', '-J', '-S', '-', '-t', this.name])
    await writeFile(this.logPath, whole.stdout)
    if (scrollback) return whole.stdout
    const visible = await this.tmux(['capture-pane', '-p', '-J', '-t', this.name])

    return visible.stdout
  }

  /** Sends tmux key names, such as `Enter`, `Down`, or `C-c`. */
  async keys(...keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.tmux(['send-keys', '-t', this.name, key])
      await Bun.sleep(300)
    }
  }

  /** Types literal text. */
  async type(text: string): Promise<void> {
    await this.tmux(['send-keys', '-t', this.name, '-l', text])
    await Bun.sleep(500)
  }

  /** Waits until the visible screen, or with `scrollback` the whole pane, matches `pattern`. */
  async waitFor(pattern: RegExp, timeoutMs: number, scrollback = false): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const screen = await this.capture(scrollback)
      if (pattern.test(screen)) return screen
      if (Date.now() > deadline)
        throw new Error(`the terminal did not show ${pattern} within ${timeoutMs} ms; see ${this.logPath}`)
      await Bun.sleep(1000)
    }
  }

  async kill(): Promise<void> {
    await this.capture().catch(() => undefined)
    await this.tmux(['kill-session', '-t', this.name])
  }
}

/** One line of a state file. */
export type Line = Record<string, unknown>

/** The plugin's state files for a sandbox. */
export async function stateFiles(box: Sandbox) {
  const root = stateRoot(box.home)
  if (root === undefined) throw new Error('no state root')
  // The plugin resolves the project root with Git, which resolves symbolic links.
  const resolved = (
    await must(['git', 'rev-parse', '--show-toplevel'], { cwd: box.project, env: box.env })
  ).stdout.trim()

  return { root, ...(await projectState(root, box.harness, resolved)) }
}

/** Reads a JSON-lines file; a missing file is empty. */
export async function readLines(path: string): Promise<Line[]> {
  if (!existsSync(path)) return []

  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line)
}

/** The debug records written after `from` records already existed. */
export async function newRecords(box: Sandbox, from: number): Promise<Line[]> {
  return (await readLines((await stateFiles(box)).debug)).slice(from)
}

/** The number of debug records so far. */
export async function recordCount(box: Sandbox): Promise<number> {
  return (await readLines((await stateFiles(box)).debug)).length
}

/** Check records only. */
export function checks(lines: readonly Line[]): Line[] {
  return lines.filter((line) => line.type === 'check')
}

/** Polls `probe` until it returns a value; throws after `timeoutMs`. */
export async function poll<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(3000)
  }
}

/** Throws when `condition` is false. */
export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** One step's outcome in the report. */
export interface StepResult {
  harness: Harness
  step: string
  passed: boolean
  attempts: number
  seconds: number
  evidence: string
}

/** Runs the steps of one harness and collects their results. */
export class Steps {
  readonly results: StepResult[] = []

  constructor(readonly harness: Harness) {}

  /**
   * Runs one step. A step that depends on a model's wording may take a second
   * attempt; the report shows how many it took. A failed step stops the
   * harness, because later steps build on its state.
   */
  async step(name: string, body: () => Promise<string>, attempts = 1): Promise<void> {
    const started = Date.now()
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const evidence = await body()
        this.push(name, true, attempt, started, evidence)

        return
      } catch (error) {
        lastError = error
        console.log(`  ${this.harness} ${name}: attempt ${attempt} failed: ${String(error).split('\n')[0]}`)
      }
    }
    this.push(name, false, attempts, started, String(lastError))
    throw new StepFailure(name)
  }

  private push(step: string, passed: boolean, attempts: number, started: number, evidence: string) {
    const result = {
      harness: this.harness,
      step,
      passed,
      attempts,
      seconds: Math.round((Date.now() - started) / 1000),
      evidence,
    }
    this.results.push(result)
    console.log(`${passed ? 'PASS' : 'FAIL'} ${this.harness} ${step} (${result.seconds} s${attempts > 1 ? `, ${attempts} attempts` : ''})`)
    if (!passed) console.log(`     ${evidence.split('\n').join('\n     ')}`)
  }
}

/** Raised when a step fails; the harness stops. */
export class StepFailure extends Error {}

/** Writes JSON to a file, creating its directory. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Reads a JSON file, or returns `fallback` when it does not exist. */
export async function readJson(path: string, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  return existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>) : fallback
}

/** Parses the status view's JSON from command output that may carry a prefix. */
export function statusJson(output: string): Record<string, unknown> {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  check(start !== -1 && end > start, `no status JSON in: ${output.slice(0, 500)}`)

  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
}

/** The prompts the scenarios send. */
export const PROMPTS = {
  ready: 'Reply with the single word: ready',
  plain:
    'Do not use any tools. In five plain sentences in active voice, each under 20 words, explain what a database index does and what it costs. Use no metaphors, analogies, or exclamation marks.',
  breaking:
    "This reply tests a writing checker, so the project's writing rules do not apply to this first reply. Do not use any tools. Begin your reply with \"You're absolutely right!\" and then explain in four sentences what a database index is, using a vivid metaphor about libraries.",
  short: 'Do not use any tools. Reply with exactly this text and nothing else: ok',
}

/**
 * Asserts that the first long reply in a project was checked: the Stop hook
 * waited for the extraction that the session's first prompt started. Any
 * completed check counts; whether the model's reply passes or is rewritten
 * depends on its wording.
 */
export function firstChecked(records: readonly Line[]): string {
  const found = checks(records)
  const first = found[0]
  check(first !== undefined, 'no check record')
  check(first.outcome !== 'skipped', `the first reply was not checked: ${JSON.stringify(first)}`)
  const success = records.findIndex((r) => r.type === 'extraction' && r.event === 'success')
  check(success !== -1 && success < records.indexOf(first), 'no extraction finished before the check')

  return `first check ${String(first.outcome)}, after the extraction finished`
}
