/**
 * The integration suite: installs prose-check from its GitHub repository in
 * the real Claude Code, Codex, and Muse Code CLIs, each in an isolated home
 * directory, and checks every README step against the real TypeSafe Jev API.
 *
 *   bun integration/run.ts [claude] [codex] [muse] [--out DIR]
 *
 * With no harness named, it runs all three at once. It writes each harness's
 * homes, projects, logs, and terminal captures under the output directory
 * (default `integration/runs/<time>/`) and a summary in `report.md` there.
 * It exits 1 when any step fails.
 */
import { existsSync } from 'node:fs'
import { mkdir, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Harness } from '../core/paths'
import { claude } from './claude'
import { codex } from './codex'
import type { StepResult } from './lib'
import { SOURCE, StepFailure, Steps, Terminal, checks, readLines, run } from './lib'
import { muse } from './muse'

const FLOWS: Record<Harness, (runDir: string, steps: Steps) => Promise<void>> = { claude, codex, muse }

function parse(argv: readonly string[]): { harnesses: Harness[]; out: string } {
  const harnesses: Harness[] = []
  let out = join(import.meta.dir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--out') {
      out = argv[index + 1] ?? out
      index += 1
    } else if (value === 'claude' || value === 'codex' || value === 'muse') harnesses.push(value)
    else throw new Error(`unknown argument ${String(value)}; usage: bun integration/run.ts [claude] [codex] [muse] [--out DIR]`)
  }

  return { harnesses: harnesses.length === 0 ? ['claude', 'codex', 'muse'] : harnesses, out }
}

/**
 * The free disk space each harness needs: one full run writes about 300 MB per
 * harness. When the disk fills, the hooks cannot write their records, and the
 * steps fail with missing records instead of naming the cause.
 */
const FREE_BYTES_PER_HARNESS = 600 * 1024 * 1024

/** Free bytes on the file system that holds `path` or its nearest existing parent. */
async function freeBytes(path: string): Promise<number> {
  let existing = path
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  const stats = await statfs(existing)

  return stats.bavail * stats.bsize
}

async function preflight(harnesses: readonly Harness[], out: string): Promise<void> {
  const missing: string[] = []
  const free = await freeBytes(out)
  const needed = FREE_BYTES_PER_HARNESS * harnesses.length
  if (free < needed)
    missing.push(
      `only ${Math.floor(free / 1024 ** 2)} MB is free under ${out}; the run needs ${needed / 1024 ** 2} MB`,
    )
  if ((process.env.TYPESAFE_API_KEY ?? '') === '') missing.push('TYPESAFE_API_KEY is not set')
  for (const command of ['git', 'tmux', 'bun', ...harnesses]) {
    const found = await run(['sh', '-c', `command -v ${command}`], { env: { PATH: process.env.PATH ?? '' } })
    if (found.exitCode !== 0) missing.push(`${command} is not on PATH`)
  }
  if (missing.length > 0) throw new Error(missing.join('\n'))
}

/** Counts the CLI sessions and Jev requests one harness used, from its records. */
async function cost(out: string, harness: Harness): Promise<string> {
  const sessions = new Set<string>()
  let jev = 0
  let extractions = 0
  for (const name of [harness, `${harness}-team`]) {
    const metrics = await readLines(
      (await run(['sh', '-c', `ls ${join(out, name, 'home/.local/state/prose-check', harness)}/*/metrics.jsonl 2>/dev/null`], { env: { PATH: process.env.PATH ?? '' } })).stdout.trim().split('\n')[0] ?? '',
    ).catch(() => [])
    for (const line of metrics) sessions.add(String(line.session))
    const debug = await readLines(
      (await run(['sh', '-c', `ls ${join(out, name, 'home/.local/state/prose-check', harness)}/*/debug.jsonl 2>/dev/null`], { env: { PATH: process.env.PATH ?? '' } })).stdout.trim().split('\n')[0] ?? '',
    ).catch(() => [])
    jev += checks(debug).filter((line) => typeof line.latencyMs === 'number').length
    extractions += debug.filter((line) => line.type === 'extraction' && line.event === 'start').length
  }

  return `${harness}: ${sessions.size} sessions with prose-check loaded, ${jev} Jev requests, ${extractions} extractions`
}

function report(results: readonly StepResult[], costs: readonly string[], source: string): string {
  const rows = results.map(
    (r) =>
      `| ${r.harness} | ${r.step} | ${r.passed ? 'pass' : '**FAIL**'} | ${r.attempts} | ${r.seconds} |`,
  )
  const evidence = results.map(
    (r) => `### ${r.harness}: ${r.step}\n\n\`\`\`\n${r.evidence}\n\`\`\``,
  )

  return [
    `# prose-check integration run`,
    '',
    `Source: ${source}. Date: ${new Date().toISOString()}.`,
    '',
    '| Harness | Step | Result | Attempts | Seconds |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Cost',
    '',
    ...costs.map((line) => `- ${line}`),
    '',
    '## Evidence',
    '',
    ...evidence,
    '',
  ].join('\n')
}

const { harnesses, out } = parse(process.argv.slice(2))
await preflight(harnesses, out)
await mkdir(out, { recursive: true })
console.log(`Installing from ${SOURCE}. Output: ${out}`)

const all = harnesses.map((harness) => new Steps(harness))
await Promise.all(
  all.map(async (steps) => {
    try {
      await FLOWS[steps.harness](out, steps)
    } catch (error) {
      if (!(error instanceof StepFailure)) {
        steps.results.push({
          harness: steps.harness,
          step: 'setup',
          passed: false,
          attempts: 1,
          seconds: 0,
          evidence: String(error),
        })
        console.log(`FAIL ${steps.harness} setup: ${String(error)}`)
      }
    }
  }),
)
await run(['tmux', '-L', Terminal.SOCKET, 'kill-server'], { env: { PATH: process.env.PATH ?? '' } })

const results = all.flatMap((steps) => steps.results)
const costs = await Promise.all(harnesses.map((harness) => cost(out, harness)))
const text = report(results, costs, SOURCE)
await writeFile(join(out, 'report.md'), text)
const failed = results.filter((r) => !r.passed).length
console.log(`\n${results.length - failed} of ${results.length} steps passed.`)
for (const line of costs) console.log(line)
console.log(`Report: ${join(out, 'report.md')}`)
process.exitCode = failed === 0 ? 0 : 1
