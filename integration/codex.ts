/** The Codex integration flow, following the README's Codex steps. */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { completed, metricsMatch, rewritten } from './claude'
import type { Line, Sandbox, Steps } from './lib'
import {
  PROMPTS,
  REF,
  SOURCE,
  firstChecked,
  marketplaceSource,
  Terminal,
  check,
  checks,
  must,
  newRecords,
  poll,
  readLines,
  recordCount,
  run,
  sandbox,
  stateFiles,
  statusJson,
} from './lib'

const PLUGIN = 'prose-check@prose-check'
const OPTIONS = { debug: true, timeoutMs: 3000 }

/** Writes the project's `.prose-check.json`. */
export async function projectSettings(box: Sandbox, options: Record<string, unknown>): Promise<void> {
  await writeFile(join(box.project, '.prose-check.json'), `${JSON.stringify(options)}\n`)
}

/** Writes or removes `TYPESAFE_API_KEY` in the project's `.env.local`. */
export async function envLocal(box: Sandbox, withKey: boolean): Promise<void> {
  const path = join(box.project, '.env.local')
  if (withKey) await writeFile(path, `TYPESAFE_API_KEY=${box.key}\n`)
  else await rm(path, { force: true })
}

/** Runs the status command the README names: the launcher in the state directory. */
export async function launcherStatus(
  box: Sandbox,
  harness: 'codex' | 'muse',
  json = true,
): Promise<{ text: string; value: Record<string, unknown> | undefined }> {
  const { root } = await stateFiles(box)
  const result = await must([join(root, 'bin/prose-check'), 'status', harness, ...(json ? ['--json'] : [])], {
    cwd: box.project,
    env: box.env,
  })

  return { text: result.stdout, value: json ? statusJson(result.stdout) : undefined }
}

/** Runs the doctor command the README names; returns its exit status and output. */
export async function launcherDoctor(
  box: Sandbox,
  harness: 'codex' | 'muse',
): Promise<{ exitCode: number; text: string }> {
  const { root } = await stateFiles(box)
  const result = await run([join(root, 'bin/prose-check'), 'doctor', harness], { cwd: box.project, env: box.env })
  await writeFile(join(box.dir, `doctor-${Date.now()}.txt`), `${result.stdout}\n${result.stderr}`)

  return { exitCode: result.exitCode, text: result.stdout }
}

/** Asserts that the doctor command passes; returns its findings. */
export async function doctorPasses(box: Sandbox, harness: 'codex' | 'muse'): Promise<string> {
  const result = await launcherDoctor(box, harness)
  check(result.exitCode === 0, `doctor exited ${result.exitCode}: ${result.text}`)
  check(result.text.includes('Result: no problems found.'), `doctor output: ${result.text}`)

  return result.text.split('\n').slice(2, -1).join('\n')
}

/** Waits until the status shows a current rule cache; asserts the extraction records. */
export async function extracted(box: Sandbox, harness: 'codex' | 'muse', from: number): Promise<string> {
  // Codex and Muse Code load AGENTS.md; neither reads the fixture's CLAUDE.md.
  const current = await poll(
    'a current rule cache',
    async () => {
      const { value } = await launcherStatus(box, harness)
      const cache = value?.cache as { state: string } | undefined

      return cache?.state === 'current' ? value : undefined
    },
    300_000,
  )
  const cache = current.cache as { files: string[]; ruleCount: number }
  check(JSON.stringify(cache.files) === '["AGENTS.md"]', `instruction files: ${JSON.stringify(cache.files)}`)
  check(cache.ruleCount > 0, 'no rules extracted')
  const extraction = (await newRecords(box, from)).filter((r) => r.type === 'extraction')
  check(extraction.some((r) => r.event === 'start'), 'no extraction start record')
  const success = extraction.find((r) => r.event === 'success')
  check(success?.ruleCount === cache.ruleCount, `extraction success record: ${JSON.stringify(success)}`)

  return `${cache.ruleCount} rules cached; records: ${extraction.map((r) => r.event).join(', ')}`
}

/** Asserts exactly one new check record with this outcome and reason. */
export function single(records: readonly Line[], outcome: string, reason?: string): Line {
  const found = checks(records)
  check(found.length === 1, `expected one check record, got ${JSON.stringify(found)}`)
  const record = found[0] ?? {}
  check(record.outcome === outcome && (reason === undefined || record.reason === reason), `unexpected record: ${JSON.stringify(record)}`)

  return record
}

/** Asserts a rewrite followed by a warning that the hook returned as `systemMessage`. */
export function warned(records: readonly Line[], agent: string): string {
  const found = checks(records)
  const outcomes = found.map((r) => r.outcome)
  check(JSON.stringify(outcomes) === '["rewrite-requested","warning-shown"]', `outcomes: ${JSON.stringify(outcomes)}`)
  const result = found[1]?.result as { systemMessage?: string } | undefined
  check(
    result?.systemMessage?.startsWith(`Warning from prose-check: ${agent} rewrote this reply once`) === true,
    `the hook did not return the warning as systemMessage: ${JSON.stringify(result)}`,
  )
  const block = found[0]?.result as { decision?: string } | undefined
  check(block?.decision === 'block', `the first hook result is not a block: ${JSON.stringify(block)}`)

  return `outcomes ${outcomes.join(', ')}; systemMessage: ${result.systemMessage.split('\n')[0] ?? ''}`
}

/**
 * Commits the files that make Codex install prose-check for everyone who works
 * in the project, as the README's "Enable it for everyone" section lists them:
 * a repository marketplace that names the GitHub repository, and the project
 * entry that enables the plugin.
 */
async function commitRepositoryMarketplace(box: Sandbox): Promise<void> {
  await mkdir(join(box.project, '.agents/plugins'), { recursive: true })
  await writeFile(
    join(box.project, '.agents/plugins/marketplace.json'),
    `${JSON.stringify(
      {
        name: 'prose-check',
        interface: { displayName: 'prose-check' },
        plugins: [
          {
            name: 'prose-check',
            source: { source: 'url', url: `https://github.com/${SOURCE}.git`, ...(REF === '' ? {} : { ref: REF }) },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  await mkdir(join(box.project, '.codex'), { recursive: true })
  await writeFile(join(box.project, '.codex/config.toml'), `[plugins."${PLUGIN}"]\nenabled = true\n`)
  // Never `git add -A`: the project's .env.local holds the key.
  await must(['git', '-C', box.project, 'add', '.agents', '.codex', 'AGENTS.md', 'CLAUDE.md'], { env: box.env })
  await must(['git', '-C', box.project, '-c', 'user.name=suite', '-c', 'user.email=suite@example.com', 'commit', '-q', '-m', 'Enable prose-check'], { env: box.env })
}

/** Runs one `codex exec` session; returns the final message. */
async function exec(box: Sandbox, text: string, log: string): Promise<string> {
  const last = join(box.dir, `${log}.last.txt`)
  const result = await must(['codex', 'exec', '--output-last-message', last, text], {
    cwd: box.project,
    env: box.env,
    timeoutMs: 300_000,
  })
  await writeFile(join(box.dir, `${log}.out.txt`), `${result.stdout}\n${result.stderr}`)

  return existsSync(last) ? readFile(last, 'utf8') : ''
}

/** Installs from the marketplace and trusts the hooks through `/hooks`, as the README says. */
async function install(box: Sandbox, name: string): Promise<string> {
  await must(['codex', 'plugin', 'marketplace', 'add', marketplaceSource('codex')], { env: box.env, cwd: box.project })
  await must(['codex', 'plugin', 'add', PLUGIN], { env: box.env, cwd: box.project })
  const terminal = await Terminal.start(name, box.project, ['codex'], box.env, join(box.dir, `${name}.screen.txt`))
  try {
    const first = await terminal.waitFor(/Trust this folder|Hooks need review/, 60_000)
    if (/Trust this folder/.test(first)) await terminal.keys('Enter')
    // Codex offers the review at startup when hooks are new or changed.
    const review = await terminal.waitFor(/Hooks need review/, 60_000)
    if (/Review hooks/.test(review)) await terminal.keys('Enter')
    await terminal.waitFor(/t trust all/, 30_000)
    await terminal.keys('t')
    const trusted = await terminal.waitFor(/SessionStart\s+1\s+1\s/, 30_000)
    await terminal.keys('Escape', 'C-c', 'C-c')
    const config = await readFile(join(box.home, '.codex/config.toml'), 'utf8')
    check(config.includes(`[hooks.state."${PLUGIN}:hooks/codex.json:stop:0:0"]`), 'the Stop hook is not trusted')

    return trusted.split('\n').find((l) => /SessionStart\s+1\s+1/.test(l))?.trim() ?? ''
  } finally {
    await terminal.kill()
  }
}

/** Runs the Codex flow. */
export async function codex(runDir: string, steps: Steps): Promise<void> {
  const box = await sandbox(runDir, 'codex')

  await steps.step('install from the marketplace and trust the hooks', async () => {
    const trusted = await install(box, 'codex-install')
    await envLocal(box, true)
    await projectSettings(box, OPTIONS)

    return `hooks view: ${trusted}`
  })

  await steps.step('check the first reply in a new project, after the rule extraction it starts', async () => {
    await exec(box, PROMPTS.plain, 'first')
    const files = await stateFiles(box)
    const starts = (await readLines(files.metrics)).filter((l) => l.event === 'session-start')
    check(starts.length === 1, `session-start lines: ${starts.length}`)
    const result = firstChecked(await newRecords(box, 0))
    const { text } = await launcherStatus(box, 'codex', false)
    check(/prose-check \d+\.\d+\.\d+ \(codex\)/.test(text), `status: ${text}`)
    check(text.includes('TYPESAFE_API_KEY: set (from .env.local)'), 'the key from .env.local is not set')

    return `${result}\n${text.split('\n').slice(0, 7).join('\n')}`
  })

  await steps.step('extract the rules from AGENTS.md only', () => extracted(box, 'codex', 0))

  await steps.step('pass every doctor check after the first session', () => doctorPasses(box, 'codex'))

  await steps.step('show a rejected key at session start in the transcript, and fail the doctor', async () => {
    await writeFile(join(box.project, '.env.local'), 'TYPESAFE_API_KEY=fixt123\n')
    const from = await recordCount(box)
    const terminal = await Terminal.start('codex-key', box.project, ['codex'], box.env, join(box.dir, 'key.screen.txt'))
    try {
      const first = await terminal.waitFor(/Trust this folder|Hooks need review|context left|for shortcuts|›/, 60_000)
      if (/Trust this folder/.test(first)) await terminal.keys('Enter')
      check(!/Hooks need review/.test(first), 'Codex asks to review the hooks again')
      await Bun.sleep(2000)
      // Codex runs SessionStart when the first prompt is sent.
      await terminal.type(PROMPTS.ready)
      await terminal.keys('Enter')
      const screen = await terminal.waitFor(/Hook · prose-check: Jev rejected TYPESAFE_API_KEY with HTTP 401/, 120_000, true)
      const line = screen.split('\n').find((l) => l.includes('Jev rejected')) ?? ''
      const doctor = await launcherDoctor(box, 'codex')
      check(doctor.exitCode === 1, `doctor exited ${doctor.exitCode}`)
      check(doctor.text.includes('FAIL     Jev: rejected the key with HTTP 401'), `doctor: ${doctor.text}`)
      // The Stop hook for the reply can write its record after the transcript
      // shows the line. Wait for it, so that the record does not land in the
      // next step's records.
      const records = await poll(
        'the check record for the reply',
        async () => {
          const found = await newRecords(box, from)

          return checks(found).length > 0 ? found : undefined
        },
        120_000,
      )
      single(records, 'skipped', 'short-reply')

      return `transcript: ${line.trim()}\ndoctor: exit 1, ${doctor.text.split('\n').find((l) => l.includes('Jev:'))?.trim() ?? ''}\nrecord: skipped, short-reply`
    } finally {
      await terminal.kill()
      await envLocal(box, true)
    }
  })

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

      return warned(await newRecords(box, from), 'Codex')
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
      const { value } = await launcherStatus(box, 'codex')
      check((value?.apiKey as { isSet: boolean }).isSet === false, 'the status shows a key')

      return 'outcome skipped, reason no-api-key; status shows the key as not set'
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
    const { value } = await launcherStatus(box, 'codex')
    const { text } = await launcherStatus(box, 'codex', false)
    await writeFile(join(box.dir, 'status.txt'), text)
    check(/Rule cache: \d+ rules, matches the current instruction files/.test(text), 'the status text does not show a current cache')
    check(!text.includes(box.key) && !JSON.stringify(value).includes(box.key), 'the status shows the API key')

    return metricsMatch(value ?? {}, await newRecords(box, 0))
  })

  await steps.step('enable the plugin for a repository: a new team member trusts the folder and the hooks, without installing', async () => {
    const team = await sandbox(runDir, 'codex', 'codex-team')
    await commitRepositoryMarketplace(team)
    await envLocal(team, true)
    // First start: the member trusts the folder.
    const first = await Terminal.start('codex-team-1', team.project, ['codex'], team.env, join(team.dir, 'team-1.screen.txt'))
    const cache = join(team.home, '.codex/plugins/cache/prose-check/prose-check')
    try {
      await first.waitFor(/Trust this folder/, 60_000)
      await first.keys('Enter')
      await first.waitFor(/context left|for shortcuts|Hooks need review/, 60_000)
      await Bun.sleep(5000)
    } finally {
      await first.kill()
    }
    // Second start: Codex installs the plugin that the project names. The
    // install can finish after startup, so the member opens /hooks to trust its
    // hooks, as the README says.
    const second = await Terminal.start('codex-team-2', team.project, ['codex'], team.env, join(team.dir, 'team-2.screen.txt'))
    try {
      const start = await second.waitFor(/Hooks need review|for shortcuts/, 60_000)
      await poll('Codex to install the plugin from the repository marketplace', async () => (existsSync(cache) ? true : undefined), 120_000)
      if (/Review hooks/.test(start)) await second.keys('Enter')
      else {
        await Bun.sleep(2000)
        await second.type('/hooks')
        await second.keys('Enter')
      }
      await second.waitFor(/t trust all/, 30_000)
      await second.keys('t')
      await second.waitFor(/SessionStart\s+1\s+1\s/, 30_000)
      await second.keys('Escape', 'C-c', 'C-c')
    } finally {
      await second.kill()
    }
    const config = await readFile(join(team.home, '.codex/config.toml'), 'utf8')
    check(config.includes(`[hooks.state."${PLUGIN}:hooks/codex.json:stop:0:0"]`), 'the Stop hook is not trusted')
    check(!config.includes('[marketplaces.'), 'the member added a marketplace')
    await exec(team, PROMPTS.ready, 'team')
    const starts = (await readLines((await stateFiles(team)).metrics)).filter((l) => l.event === 'session-start')
    check(starts.length === 1, `session-start lines: ${starts.length}`)
    const root = (await readFile(join(team.home, '.local/state/prose-check/codex/plugin-root'), 'utf8')).trim()
    // macOS reports the temporary directory as /private/var as well as /var.
    check(realpathSync(root).startsWith(realpathSync(cache)), `the hooks ran from ${root}, not the plugin Codex installed`)

    // A second clone at another path needs only folder trust: the hook trust names no path.
    const clone: Sandbox = { ...team, project: join(team.dir, 'project-clone') }
    await must(['git', 'clone', '-q', team.project, clone.project], { env: team.env })
    await envLocal(clone, true)
    const third = await Terminal.start('codex-team-3', clone.project, ['codex'], team.env, join(team.dir, 'team-3.screen.txt'))
    try {
      await third.waitFor(/Trust this folder/, 60_000)
      await third.keys('Enter')
      const after = await third.waitFor(/context left|for shortcuts|Hooks need review/, 60_000)
      check(!/Hooks need review/.test(after), 'Codex asks to review the hooks again in a second clone')
      await Bun.sleep(3000)
    } finally {
      await third.kill()
    }
    await exec(clone, PROMPTS.ready, 'team-clone')
    const cloneStarts = (await readLines((await stateFiles(clone)).metrics)).filter((l) => l.event === 'session-start')
    check(cloneStarts.length === 1, `session-start lines in the second clone: ${cloneStarts.length}`)

    return `installed by Codex at ${root}; hooks ran in the project and in a second clone with only folder trust`
  })

  await steps.step('add the repository marketplace to a project whose member installed the plugin: the hooks run once', async () => {
    await commitRepositoryMarketplace(box)
    const terminal = await Terminal.start('codex-both', box.project, ['codex'], box.env, join(box.dir, 'both.screen.txt'))
    try {
      const screen = await terminal.waitFor(/context left|for shortcuts|Hooks need review|Trust this folder/, 60_000)
      check(!/Hooks need review|Trust this folder/.test(screen), 'Codex asks to trust the folder or review the hooks again')
      await Bun.sleep(5000)
    } finally {
      await terminal.kill()
    }
    const from = (await readLines((await stateFiles(box)).metrics)).length
    await exec(box, PROMPTS.ready, 'both')
    const lines = (await readLines((await stateFiles(box)).metrics)).slice(from)
    const starts = lines.filter((l) => l.event === 'session-start').length
    const stops = lines.filter((l) => l.event === 'check').length
    check(starts === 1 && stops === 1, `session-start lines ${starts}, check lines ${stops}`)
    // The update and uninstall steps test the member's own install.
    await rm(join(box.project, '.agents'), { recursive: true, force: true })
    await rm(join(box.project, '.codex'), { recursive: true, force: true })

    return 'one session-start line and one check line per session'
  })

  await steps.step('update to the latest version', async () => {
    const upgrade = await must(['codex', 'plugin', 'marketplace', 'upgrade', 'prose-check'], { env: box.env, cwd: box.project })
    const add = await must(['codex', 'plugin', 'add', PLUGIN], { env: box.env, cwd: box.project })
    const from = (await readLines((await stateFiles(box)).metrics)).length
    await exec(box, PROMPTS.ready, 'updated')
    const lines = (await readLines((await stateFiles(box)).metrics)).slice(from)
    check(lines.some((l) => l.event === 'session-start'), 'the hooks did not run after the update')

    return `${upgrade.stdout.trim().split('\n').at(-1) ?? ''}; ${add.stdout.trim().split('\n').at(-1) ?? ''}; hooks still run`
  })

  await steps.step('uninstall', async () => {
    await must(['codex', 'plugin', 'remove', PLUGIN], { env: box.env, cwd: box.project })
    const from = (await readLines((await stateFiles(box)).metrics)).length
    await exec(box, PROMPTS.ready, 'uninstalled')
    const lines = (await readLines((await stateFiles(box)).metrics)).slice(from)
    check(lines.length === 0, 'the hooks still run')

    return 'a new session runs no prose-check hook'
  })
}
