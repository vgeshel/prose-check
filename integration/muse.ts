/** The Muse Code integration flow, following the README's Muse Code steps. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { completed, metricsMatch, rewritten } from './claude'
import { envLocal, extracted, launcherStatus, projectSettings, single, warned } from './codex'
import type { Sandbox, Steps } from './lib'
import {
  PROMPTS,
  firstChecked,
  SOURCE,
  check,
  must,
  newRecords,
  readLines,
  recordCount,
  sandbox,
  stateFiles,
} from './lib'

const OPTIONS = { debug: true, timeoutMs: 3000 }

/** Runs one `muse exec` session; returns its standard output. */
async function exec(box: Sandbox, text: string, log: string): Promise<string> {
  const result = await must(['muse', 'exec', text], {
    cwd: box.project,
    env: box.env,
    timeoutMs: 300_000,
  })
  await writeFile(join(box.dir, `${log}.out.txt`), `${result.stdout}\n${result.stderr}`)

  return result.stdout
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
    await must(['muse', 'plugins', 'marketplace', 'add', 'prose-check', SOURCE], { env: box.env, cwd: box.dir })
    const inspected = await install(box)
    await envLocal(box, true)
    await projectSettings(box, OPTIONS)

    return inspected
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
