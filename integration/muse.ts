/** The Muse Code integration flow, following the README's Muse Code steps. */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { completed, metricsMatch, rewritten } from './claude'
import { doctorPasses, envLocal, extracted, launcherDoctor, launcherStatus, projectSettings, single, warned } from './codex'
import type { Sandbox, Steps } from './lib'
import {
  PROMPTS,
  firstChecked,
  marketplaceSource,
  check,
  must,
  newRecords,
  run,
  readLines,
  recordCount,
  sandbox,
  stateFiles,
} from './lib'

const OPTIONS = { debug: true, timeoutMs: 3000 }

/** Runs one `muse exec` session; returns its standard output. */
async function exec(
  box: Sandbox,
  text: string,
  log: string,
  env: Record<string, string> = box.env,
  options: string[] = [],
): Promise<string> {
  const result = await must(['muse', 'exec', ...options, text], {
    cwd: box.project,
    env,
    timeoutMs: 300_000,
  })
  await writeFile(join(box.dir, `${log}.out.txt`), `${result.stdout}\n${result.stderr}`)

  return result.stdout
}

/**
 * The sandbox environment with every PATH directory that holds a `bun`
 * removed, as on a machine where Bun is installed but not on the PATH that
 * Muse Code passes to hooks. Muse Code itself stays reachable.
 */
function withoutBun(box: Sandbox): Record<string, string> {
  const muse = Bun.which('muse', { PATH: box.env.PATH ?? '' })
  check(muse !== null, 'muse is not on PATH')
  const kept = (box.env.PATH ?? '').split(':').filter((dir) => dir !== '' && !existsSync(join(dir, 'bun')))
  check(kept.includes(dirname(muse)), `muse is in a directory that also holds bun: ${dirname(muse)}`)

  return { ...box.env, PATH: kept.join(':') }
}

/**
 * The `systemMessage` of the SessionStart hook in the newest Muse Code session
 * log. Muse Code 1.4.9 shows it in the interactive footer for about five
 * seconds and records it in the log as `hook_run_terminal.system_message`;
 * `muse exec` prints it nowhere, so the log is the record the suite reads.
 */
async function sessionStartMessage(box: Sandbox): Promise<string | undefined> {
  const root = join(box.home, '.local/share/muse/sessions')
  const logs: { path: string; mtime: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // Subagent sessions keep their own logs under `subagent/`.
      if (entry.isDirectory() && entry.name !== 'subagent') await walk(path)
      else if (entry.name === 'session.jsonl') logs.push({ path, mtime: (await stat(path)).mtimeMs })
    }
  }
  if (existsSync(root)) await walk(root)
  const newest = logs.sort((a, b) => b.mtime - a.mtime)[0]
  if (newest === undefined) return undefined
  // Each record holds a hook event at `payload.event`.
  const events = (await readFile(newest.path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { payload?: { event?: Record<string, unknown> } }).payload?.event ?? {})
  const hook = events.find(
    (event) =>
      event.kind === 'hook_run_terminal' &&
      event.event === 'SessionStart' &&
      String(event.hook_key).startsWith('plugin:prose-check:'),
  )

  return typeof hook?.system_message === 'string' ? hook.system_message : undefined
}

/**
 * The session-start cases run Muse Code's `echo` provider, which needs no
 * model, in a project without instruction files, so that they start no rule
 * extraction and leave the fixture project's first session for the case
 * that waits for one.
 */
const ECHO = ['--provider', 'echo']

/** The number of session-start metrics lines so far. */
async function sessionStarts(box: Sandbox): Promise<number> {
  return (await readLines((await stateFiles(box)).metrics)).filter((l) => l.event === 'session-start').length
}

/** Installs the plugin from the configured marketplace and approves its hooks. */
async function install(box: Sandbox): Promise<string> {
  await must(['muse', 'plugins', 'install', 'prose-check@prose-check'], { env: box.env, cwd: box.dir })
  const before = await must(['muse', 'plugins', 'inspect', 'prose-check'], { env: box.env, cwd: box.dir })
  check(before.stdout.includes('status=review_needed'), `hooks not awaiting review: ${before.stdout}`)
  await must(['muse', 'plugins', 'approve', 'prose-check'], { env: box.env, cwd: box.dir })
  const after = await must(['muse', 'plugins', 'inspect', 'prose-check'], { env: box.env, cwd: box.dir })
  check(!after.stdout.includes('review_needed'), `hooks still awaiting review: ${after.stdout}`)

  return after.stdout.split('\n').find((l) => l.startsWith('prose-check')) ?? ''
}

/** Runs the Muse Code flow. */
export async function muse(runDir: string, steps: Steps): Promise<void> {
  const box = await sandbox(runDir, 'muse')

  await steps.step('install from the marketplace and approve the hooks', async () => {
    await must(['muse', 'plugins', 'marketplace', 'add', 'prose-check', marketplaceSource('muse')], { env: box.env, cwd: box.dir })
    const inspected = await install(box)
    await envLocal(box, true)
    await projectSettings(box, OPTIONS)

    return inspected
  })

  // A project without instruction files for the session-start cases.
  const bare: Sandbox = { ...box, project: join(box.dir, 'bare-project') }
  await mkdir(bare.project, { recursive: true })
  await must(['git', 'init', '-q', bare.project], { env: box.env })

  await steps.step('show a message at session start when Bun is not on PATH', async () => {
    const env = withoutBun(box)
    await exec(bare, PROMPTS.ready, 'no-bun', env, ECHO)
    const message = await sessionStartMessage(bare)
    check(message?.includes('Bun was not found on PATH or at ~/.bun/bin/bun') === true, `SessionStart systemMessage: ${String(message)}`)
    check(!existsSync((await stateFiles(bare)).metrics), 'the adapter ran without Bun')

    return `PATH without Bun: ${env.PATH}\nsystemMessage: ${message ?? ''}`
  })

  await steps.step('run the hooks with Bun at ~/.bun/bin/bun when Bun is not on PATH', async () => {
    const env = withoutBun(box)
    const link = join(box.home, '.bun/bin/bun')
    await mkdir(dirname(link), { recursive: true })
    await symlink(process.execPath, link)
    try {
      const before = await sessionStarts(bare)
      await exec(bare, PROMPTS.ready, 'bun-fallback', env, ECHO)
      check((await sessionStarts(bare)) === before + 1, 'the SessionStart hook did not run the adapter')

      return `the hooks ran ${link}; systemMessage: ${(await sessionStartMessage(bare)) ?? 'none'}`
    } finally {
      await rm(join(box.home, '.bun'), { recursive: true, force: true })
    }
  })

  await steps.step('warn at session start about a missing key and a rejected key', async () => {
    const envFile = join(bare.project, '.env.local')
    await rm(envFile, { force: true })
    await exec(bare, PROMPTS.ready, 'start-no-key', box.env, ECHO)
    const missing = await sessionStartMessage(bare)
    check(missing?.startsWith('prose-check: TYPESAFE_API_KEY is not set') === true, `missing key: ${String(missing)}`)

    await writeFile(envFile, 'TYPESAFE_API_KEY=fixt123\n')
    await exec(bare, PROMPTS.ready, 'start-rejected-key', box.env, ECHO)
    const rejected = await sessionStartMessage(bare)
    check(rejected?.includes('Jev rejected TYPESAFE_API_KEY with HTTP 401') === true, `rejected key: ${String(rejected)}`)
    const { root } = await stateFiles(bare)
    const doctor = await run([join(root, 'bin/prose-check'), 'doctor', 'muse'], { cwd: bare.project, env: box.env })
    check(doctor.exitCode === 1 && doctor.stdout.includes('FAIL     Jev: rejected the key with HTTP 401'), `doctor: ${doctor.stdout}`)

    await writeFile(envFile, `TYPESAFE_API_KEY=${box.key}\n`)
    await exec(bare, PROMPTS.ready, 'start-good-key', box.env, ECHO)
    const accepted = await sessionStartMessage(bare)
    check(accepted === undefined, `a working key produced a message: ${String(accepted)}`)

    return `missing: ${missing ?? ''}\nrejected: ${rejected ?? ''}\ndoctor: ${doctor.stdout.split('\n').find((l) => l.includes('Jev:')) ?? ''}`
  })

  await steps.step('check the first reply in a new project, after the rule extraction it starts', async () => {
    await exec(box, PROMPTS.plain, 'first')
    const starts = (await readLines((await stateFiles(box)).metrics)).filter((l) => l.event === 'session-start')
    check(starts.length === 1, `session-start lines: ${starts.length}`)
    const result = firstChecked(await newRecords(box, 0))
    const { text } = await launcherStatus(box, 'muse', false)
    check(/prose-check \d+\.\d+\.\d+ \(muse\)/.test(text), `status: ${text}`)
    check(text.includes('TYPESAFE_API_KEY: set (from .env.local)'), 'the key from .env.local is not set')

    return `${result}\n${text.split('\n').slice(0, 7).join('\n')}`
  })

  await steps.step('extract the rules from AGENTS.md only', () => extracted(box, 'muse', 0))

  await steps.step('pass every doctor check after the first session', () => doctorPasses(box, 'muse'))

  await steps.step('pass a reply that follows the rules', async () => {
    const from = await recordCount(box)
    await exec(box, PROMPTS.plain, 'pass')
    const record = single(await newRecords(box, from), 'passed')
    completed(record)

    return `outcome passed; probabilities ${JSON.stringify(record.probabilities)}`
  }, 2)

  await steps.step('rewrite a reply that breaks a rule; the result is the rewritten reply', async () => {
    // A rewritten reply is often shorter than the 200-character default.
    await projectSettings(box, { ...OPTIONS, minLength: 1 })
    try {
      const from = await recordCount(box)
      const result = await exec(box, PROMPTS.breaking, 'rewrite')
      const [first, last] = rewritten(await newRecords(box, from), result)

      return `first: ${String(first?.outcome)} ${JSON.stringify(first?.broken)}; last: ${String(last?.outcome)}`
    } finally {
      await projectSettings(box, OPTIONS)
    }
  }, 2)

  await steps.step('return the warning as systemMessage when the rewrite still breaks a rule', async () => {
    await projectSettings(box, { ...OPTIONS, breachThreshold: 0.01, minLength: 1 })
    try {
      const from = await recordCount(box)
      await exec(box, PROMPTS.plain, 'warning')

      return warned(await newRecords(box, from), 'Muse')
    } finally {
      await projectSettings(box, OPTIONS)
    }
  })

  await steps.step('skip a reply under minLength', async () => {
    const from = await recordCount(box)
    await exec(box, PROMPTS.short, 'short')
    single(await newRecords(box, from), 'skipped', 'short-reply')

    return 'outcome skipped, reason short-reply'
  })

  await steps.step('skip when TYPESAFE_API_KEY is missing', async () => {
    await envLocal(box, false)
    try {
      const from = await recordCount(box)
      await exec(box, PROMPTS.plain, 'no-key')
      single(await newRecords(box, from), 'skipped', 'no-api-key')
      const { value } = await launcherStatus(box, 'muse')
      check((value?.apiKey as { isSet: boolean }).isSet === false, 'the status shows a key')

      return 'outcome skipped, reason no-api-key; status shows the key as not set'
    } finally {
      await envLocal(box, true)
    }
  })

  await steps.step('report a key that Jev rejects: session start, metrics, status, and doctor', async () => {
    await writeFile(join(box.project, '.env.local'), 'TYPESAFE_API_KEY=fixt123\n')
    try {
      const from = await recordCount(box)
      await exec(box, PROMPTS.plain, 'rejected-key')
      const record = single(await newRecords(box, from), 'skipped', 'jev-error')
      check(record.detail === 'HTTP 401', `detail: ${String(record.detail)}`)
      const metrics = (await readLines((await stateFiles(box)).metrics)).at(-1)
      check(metrics?.detail === 'HTTP 401', `metrics line: ${JSON.stringify(metrics)}`)
      const { text } = await launcherStatus(box, 'muse', false)
      check(text.includes('(latest: HTTP 401)'), `status: ${text}`)
      const result = await launcherDoctor(box, 'muse')
      check(result.exitCode === 1, `doctor exited ${result.exitCode}`)
      check(result.text.includes('FAIL     Jev: rejected the key with HTTP 401'), `doctor: ${result.text}`)
      const message = await sessionStartMessage(box)
      check(message?.includes('HTTP 401') === true, `SessionStart systemMessage: ${String(message)}`)

      return `metrics detail HTTP 401; status: ${text.split('\n').find((l) => l.includes('latest')) ?? ''}`
    } finally {
      await envLocal(box, true)
    }
  })

  await steps.step('skip when Jev does not answer within timeoutMs', async () => {
    await projectSettings(box, { ...OPTIONS, timeoutMs: 1 })
    try {
      const from = await recordCount(box)
      await exec(box, PROMPTS.plain, 'timeout')
      const record = single(await newRecords(box, from), 'skipped', 'jev-timeout')

      return `outcome skipped, reason jev-timeout, latency ${String(record.latencyMs)} ms`
    } finally {
      await projectSettings(box, OPTIONS)
    }
  })

  await steps.step('show the status and metrics', async () => {
    const { value } = await launcherStatus(box, 'muse')
    const { text } = await launcherStatus(box, 'muse', false)
    await writeFile(join(box.dir, 'status.txt'), text)
    check(/Rule cache: \d+ rules, matches the current instruction files/.test(text), 'the status text does not show a current cache')
    check(!text.includes(box.key) && !JSON.stringify(value).includes(box.key), 'the status shows the API key')

    return metricsMatch(value ?? {}, await newRecords(box, 0))
  })

  await steps.step('update to the latest version', async () => {
    await must(['muse', 'plugins', 'marketplace', 'update', 'prose-check'], { env: box.env, cwd: box.dir })
    await must(['muse', 'plugins', 'remove', 'prose-check'], { env: box.env, cwd: box.dir })
    const inspected = await install(box)
    const from = (await readLines((await stateFiles(box)).metrics)).length
    await exec(box, PROMPTS.ready, 'updated')
    const lines = (await readLines((await stateFiles(box)).metrics)).slice(from)
    check(lines.some((l) => l.event === 'session-start'), 'the hooks did not run after the update')

    return `${inspected}; hooks still run`
  })

  await steps.step('uninstall', async () => {
    await must(['muse', 'plugins', 'remove', 'prose-check', '--delete-data'], { env: box.env, cwd: box.dir })
    const list = await must(['muse', 'plugins', 'list'], { env: box.env, cwd: box.dir })
    check(!list.stdout.includes('prose-check'), `still listed: ${list.stdout}`)
    const from = (await readLines((await stateFiles(box)).metrics)).length
    await exec(box, PROMPTS.ready, 'uninstalled')
    const lines = (await readLines((await stateFiles(box)).metrics)).slice(from)
    check(lines.length === 0, 'the hooks still run')

    return 'muse plugins list no longer lists it, and a new session runs no prose-check hook'
  })
}
