/** The Claude Code integration flow, following the README's Claude Code steps. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Line, Sandbox, Steps } from './lib'
import {
  PROMPTS,
  firstChecked,
  SOURCE,
  Terminal,
  check,
  checks,
  must,
  newRecords,
  poll,
  readJson,
  recordCount,
  run,
  sandbox,
  statusJson,
  writeJson,
} from './lib'

const PLUGIN = 'prose-check@prose-check'

/** Writes `~/.claude/settings.json`: the API key in `env`, and the plugin's options. */
async function settings(
  box: Sandbox,
  options: Record<string, unknown>,
  withKey = true,
): Promise<void> {
  const path = join(box.home, '.claude/settings.json')
  const current = await readJson(path, {})
  const env = { ...((current.env as Record<string, string> | undefined) ?? {}) }
  if (withKey) env.TYPESAFE_API_KEY = box.key
  else delete env.TYPESAFE_API_KEY
  await writeJson(path, {
    ...current,
    env,
    pluginConfigs: { [PLUGIN]: { options } },
  })
}

const OPTIONS = { debug: true, timeoutMs: 3000 }

/** Runs one headless session; returns its final result text. */
async function prompt(box: Sandbox, text: string, log: string): Promise<string> {
  const result = await must(
    ['claude', '-p', '--output-format', 'json', '--debug-file', join(box.dir, `${log}.debug.log`), text],
    { cwd: box.project, env: box.env, timeoutMs: 300_000 },
  )
  await writeFile(join(box.dir, `${log}.json`), result.stdout)
  const parsed = JSON.parse(result.stdout) as { result?: unknown }

  return typeof parsed.result === 'string' ? parsed.result : ''
}

/** Runs `/prose-check --json` headless and parses the status. */
async function status(box: Sandbox): Promise<Record<string, unknown>> {
  const result = await must(['claude', '-p', '/prose-check --json'], {
    cwd: box.project,
    env: box.env,
    timeoutMs: 120_000,
  })

  return statusJson(result.stdout)
}

function only(records: readonly Line[], outcome: string, reason?: string): Line {
  const found = checks(records)
  check(found.length === 1, `expected one check record, got ${JSON.stringify(found)}`)
  const record = found[0] ?? {}
  check(record.outcome === outcome, `expected outcome ${outcome}, got ${JSON.stringify(record)}`)
  if (reason !== undefined)
    check(record.reason === reason, `expected reason ${reason}, got ${JSON.stringify(record)}`)

  return record
}

/** Asserts the record of a completed check carries every documented field. */
export function completed(record: Line): void {
  for (const field of ['rules', 'reply', 'probabilities', 'broken', 'threshold', 'latencyMs'])
    check(field in record, `the check record lacks ${field}: ${JSON.stringify(record)}`)
}

/** Asserts a rewrite: the first check requested it, the last one checked the rewritten reply. */
export function rewritten(records: readonly Line[], finalText: string | undefined): Line[] {
  const found = checks(records)
  const first = found[0]
  const last = found.at(-1)
  check(first?.outcome === 'rewrite-requested', `the first check did not request a rewrite: ${JSON.stringify(first)}`)
  check(found.length >= 2 && last !== undefined, `no check of the rewritten reply: ${JSON.stringify(found)}`)
  check(
    last.outcome === 'passed' || last.outcome === 'warning-shown',
    `unexpected final outcome: ${JSON.stringify(last)}`,
  )
  check(last.reply !== first.reply, 'the rewritten reply equals the first reply')
  if (finalText !== undefined)
    check(
      finalText.trim().endsWith(String(last.reply).trim()),
      `the final result is not the rewritten reply.\nresult: ${finalText}\nlast checked reply: ${String(last.reply)}`,
    )
  completed(first)
  completed(last)

  return [first, last]
}

/** Asserts that the status totals equal the counts of every check record so far. */
export function metricsMatch(statusValue: Record<string, unknown>, all: readonly Line[]): string {
  const metrics = statusValue.metrics as { total: Record<string, unknown> }
  const total = metrics.total as {
    checks: number
    passes: number
    rewrites: number
    warnings: number
    jevTimeouts: number
    jevErrors: number
    skips: Record<string, number>
    averageLatencyMs?: number
  }
  const records = checks(all)
  const count = (outcome: string) => records.filter((r) => r.outcome === outcome).length
  const skips = (reason: string) => records.filter((r) => r.reason === reason).length
  const expected = {
    passes: count('passed'),
    rewrites: count('rewrite-requested'),
    warnings: count('warning-shown'),
    jevTimeouts: skips('jev-timeout'),
    jevErrors: skips('jev-error'),
  }
  for (const [name, value] of Object.entries(expected))
    check(
      total[name as keyof typeof expected] === value,
      `status total ${name} is ${String(total[name as keyof typeof expected])}, the debug records count ${value}`,
    )
  check(total.checks === expected.passes + expected.rewrites + expected.warnings, 'checks completed differs from passes + rewrites + warnings')
  for (const reason of ['short-reply', 'no-api-key', 'jev-timeout'])
    check((total.skips[reason] ?? 0) === skips(reason) && skips(reason) >= 1, `skip count for ${reason} is wrong or zero`)
  check(expected.passes >= 1 && expected.rewrites >= 2 && expected.warnings >= 1, `too few outcomes: ${JSON.stringify(expected)}`)
  check(typeof total.averageLatencyMs === 'number', 'no average Jev latency')

  return `totals ${JSON.stringify({ ...expected, checks: total.checks, skips: total.skips, averageLatencyMs: total.averageLatencyMs })}`
}

/** Runs the Claude Code flow. */
export async function claude(runDir: string, steps: Steps): Promise<void> {
  const box = await sandbox(runDir, 'claude')

  await steps.step('install from the marketplace and confirm the mod loads', async () => {
    await must(['claude', 'plugin', 'marketplace', 'add', SOURCE], { env: box.env, cwd: box.project })
    await must(['claude', 'plugin', 'install', PLUGIN], { env: box.env, cwd: box.project })
    await settings(box, OPTIONS)
    const log = join(box.dir, 'loaded.debug.log')
    const result = await must(['claude', '-p', '--debug-file', log, '/prose-check'], {
      cwd: box.project,
      env: box.env,
    })
    const debugLog = await readFile(log, 'utf8')
    check(debugLog.includes(`hooks module ${PLUGIN} loaded`), 'the debug log does not show the hooks module loading')
    check(/prose-check \d+\.\d+\.\d+ \(claude\)/.test(result.stdout), `unexpected /prose-check output: ${result.stdout}`)
    check(result.stdout.includes('TYPESAFE_API_KEY: set (from environment)'), 'the key from the env block is not set')

    return result.stdout.split('\n').slice(0, 7).join('\n')
  })

  await steps.step('check the first reply after AGENTS.md changes, after the rule extraction', async () => {
    // A changed instruction file has no cached rules, as in a new project.
    await appendFile(join(box.project, 'AGENTS.md'), '- Keep each reply under 150 words.\n')
    const from = await recordCount(box)
    await prompt(box, PROMPTS.plain, 'first')
    const records = await newRecords(box, from)
    const result = firstChecked(records)
    const value = await status(box)
    const cache = value.cache as { files: string[]; state: string; ruleCount: number }
    // CLAUDE.md imports AGENTS.md, so Claude Code loads both.
    check(JSON.stringify(cache.files) === '["CLAUDE.md","AGENTS.md"]', `instruction files: ${JSON.stringify(cache.files)}`)
    check(cache.state === 'current' && cache.ruleCount > 0, `cache: ${JSON.stringify(cache)}`)
    const success = records.find((r) => r.type === 'extraction' && r.event === 'success')
    check(success?.ruleCount === cache.ruleCount, `extraction success record: ${JSON.stringify(success)}`)

    return `${result}; ${cache.ruleCount} rules cached from ${cache.files.join(', ')}`
  })

  await steps.step('pass a reply that follows the rules', async () => {
    const from = await recordCount(box)
    await prompt(box, PROMPTS.plain, 'pass')
    const record = only(await newRecords(box, from), 'passed')
    completed(record)

    return `outcome passed; probabilities ${JSON.stringify(record.probabilities)}`
  }, 2)

  await steps.step('rewrite a reply that breaks a rule; the result is the rewritten reply', async () => {
    // A rewritten reply is often shorter than the 200-character default.
    await settings(box, { ...OPTIONS, minLength: 1 })
    try {
      const from = await recordCount(box)
      const result = await prompt(box, PROMPTS.breaking, 'rewrite')
      const [first, last] = rewritten(await newRecords(box, from), result)

      return `first: ${String(first?.outcome)} ${JSON.stringify(first?.broken)}; last: ${String(last?.outcome)}`
    } finally {
      await settings(box, OPTIONS)
    }
  }, 2)

  await steps.step('show the warning in the interactive transcript when the rewrite still breaks a rule', async () => {
    await settings(box, { ...OPTIONS, breachThreshold: 0.01, minLength: 1 })
    const from = await recordCount(box)
    const terminal = await Terminal.start('claude-warning', box.project, ['claude'], box.env, join(box.dir, 'warning.screen.txt'))
    try {
      const first = await terminal.waitFor(/trust this folder|for shortcuts|effort/i, 60_000)
      if (/trust this folder/i.test(first)) await terminal.keys('Down', 'Enter')
      await terminal.waitFor(/effort|for shortcuts|auto mode/i, 60_000)
      await Bun.sleep(3000)
      await terminal.type(PROMPTS.plain)
      await terminal.keys('Enter')
      const screen = await terminal.waitFor(/Warning from prose-check: Claude rewrote this reply once/, 300_000, true)
      await terminal.type('/exit')
      await terminal.keys('Enter')
      const outcomes = checks(await newRecords(box, from)).map((r) => r.outcome)
      check(
        JSON.stringify(outcomes) === '["rewrite-requested","warning-shown"]',
        `outcomes: ${JSON.stringify(outcomes)}`,
      )
      const line = screen.split('\n').find((l) => l.includes('Warning from prose-check')) ?? ''

      return `transcript: ${line.trim()}; outcomes ${outcomes.join(', ')}`
    } finally {
      await terminal.kill()
      await settings(box, OPTIONS)
    }
  })

  await steps.step('skip a reply under minLength', async () => {
    const from = await recordCount(box)
    await prompt(box, PROMPTS.short, 'short')
    only(await newRecords(box, from), 'skipped', 'short-reply')

    return 'outcome skipped, reason short-reply'
  })

  await steps.step('skip when TYPESAFE_API_KEY is missing', async () => {
    await settings(box, OPTIONS, false)
    try {
      const from = await recordCount(box)
      await prompt(box, PROMPTS.plain, 'no-key')
      only(await newRecords(box, from), 'skipped', 'no-api-key')
      const value = await status(box)
      check((value.apiKey as { isSet: boolean }).isSet === false, 'the status shows a key')

      return 'outcome skipped, reason no-api-key; status shows the key as not set'
    } finally {
      await settings(box, OPTIONS)
    }
  })

  await steps.step('skip when Jev does not answer within timeoutMs', async () => {
    await settings(box, { ...OPTIONS, timeoutMs: 1 })
    try {
      const from = await recordCount(box)
      await prompt(box, PROMPTS.plain, 'timeout')
      const record = only(await newRecords(box, from), 'skipped', 'jev-timeout')

      return `outcome skipped, reason jev-timeout, latency ${String(record.latencyMs)} ms`
    } finally {
      await settings(box, OPTIONS)
    }
  })

  await steps.step('show the status and metrics', async () => {
    const value = await status(box)
    const all = await newRecords(box, 0)
    const text = (await must(['claude', '-p', '/prose-check'], { cwd: box.project, env: box.env })).stdout
    await writeFile(join(box.dir, 'status.txt'), text)
    check(/Rule cache: \d+ rules, matches the current instruction files/.test(text), 'the status text does not show a current cache')
    check(!JSON.stringify(value).includes(box.key) && !text.includes(box.key), 'the status shows the API key')

    return metricsMatch(value, all)
  })

  await steps.step('enable the plugin for a repository: a new team member trusts the folder', async () => {
    const team = await sandbox(runDir, 'claude', 'claude-team')
    await mkdir(join(team.project, '.claude'), { recursive: true })
    await writeJson(join(team.project, '.claude/settings.json'), {
      extraKnownMarketplaces: { 'prose-check': { source: { source: 'github', repo: SOURCE } } },
      enabledPlugins: { [PLUGIN]: true },
    })
    await writeJson(join(team.home, '.claude/settings.json'), { env: { TYPESAFE_API_KEY: team.key } })
    const terminal = await Terminal.start('claude-team', team.project, ['claude'], team.env, join(team.dir, 'team.screen.txt'))
    try {
      await terminal.waitFor(/trust this folder/i, 60_000)
      await terminal.keys('Down', 'Enter')
      await terminal.waitFor(/effort|for shortcuts|auto mode/i, 60_000)
      const screen = await poll(
        'the status view to show cached rules',
        async () => {
          await Bun.sleep(5000)
          await terminal.type('/prose-check')
          await Bun.sleep(1000)
          await terminal.keys('Enter')
          await Bun.sleep(3000)
          const shown = await terminal.capture(true)
          const views = shown.split('prose-check: prose-check')

          return /Rule cache: \d+ rules, matches the current instruction files/.test(views.at(-1) ?? '') ? shown : undefined
        },
        180_000,
      )
      await terminal.type('/exit')
      await terminal.keys('Enter')
      const line = screen.split('\n').filter((l) => l.includes('Rule cache:')).at(-1) ?? ''
      const install = await must(['claude', 'plugin', 'install', PLUGIN, '--scope', 'project'], {
        cwd: team.project,
        env: team.env,
      })

      return `after trusting the folder: ${line.trim()}; explicit project-scope install: ${install.stdout.trim().split('\n').at(-1) ?? ''}`
    } finally {
      await terminal.kill()
    }
  })

  await steps.step('update to the latest version', async () => {
    const marketplace = await must(['claude', 'plugin', 'marketplace', 'update', 'prose-check'], { env: box.env, cwd: box.project })
    const update = await must(['claude', 'plugin', 'update', PLUGIN], { env: box.env, cwd: box.project })

    return `${marketplace.stdout.trim().split('\n').at(-1) ?? ''}; ${update.stdout.trim().split('\n').at(-1) ?? ''}`
  })

  await steps.step('uninstall', async () => {
    await must(['claude', 'plugin', 'uninstall', PLUGIN], { env: box.env, cwd: box.project })
    const list = await must(['claude', 'plugin', 'list'], { env: box.env, cwd: box.project })
    check(!list.stdout.includes(PLUGIN), `still listed: ${list.stdout}`)
    const log = join(box.dir, 'uninstalled.debug.log')
    await run(['claude', '-p', '--debug-file', log, '/prose-check'], { cwd: box.project, env: box.env })
    check(!(await readFile(log, 'utf8')).includes(`hooks module ${PLUGIN} loaded`), 'the mod still loads')

    return 'claude plugin list no longer lists it, and a new session does not load it'
  })
}
