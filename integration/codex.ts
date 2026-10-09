/** The Codex integration flow, following the README's Codex steps. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { completed, metricsMatch, rewritten } from './claude'
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
  readLines,
  recordCount,
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
  await must(['codex', 'plugin', 'marketplace', 'add', SOURCE], { env: box.env, cwd: box.project })
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

  await steps.step('enable the plugin for a repository: a new team member installs and trusts the hooks', async () => {
    const team = await sandbox(runDir, 'codex', 'codex-team')
    await mkdir(join(team.project, '.codex'), { recursive: true })
    await writeFile(join(team.project, '.codex/config.toml'), `[plugins."${PLUGIN}"]\nenabled = true\n`)
    const trusted = await install(team, 'codex-team')
    await envLocal(team, true)
    await exec(team, PROMPTS.ready, 'team')
    const starts = (await readLines((await stateFiles(team)).metrics)).filter((l) => l.event === 'session-start')
    check(starts.length === 1, 'the hooks did not run for the team member')

    return `hooks view: ${trusted}; the SessionStart hook ran`
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
