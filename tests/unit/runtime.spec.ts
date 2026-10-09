import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectState } from '../../core/paths'
import { EXTRACTION_TIMEOUT_MS } from '../../core/rules'
import { RULES_WAIT_MS } from '../../adapters/check'
import { hashSources, readSources } from '../../core/sources'
import { processEnvironment } from '../../adapters/environment'
import { SCRATCH_MARKER, runExtraction } from '../../adapters/extraction'
import { readText, writeText } from '../../adapters/files'
import { LEASE_MS, extract, jev, leaseFile } from '../../adapters/runtime'

const PLUGIN = join(import.meta.dir, '../..')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'prose-check-test-'))
  directories.push(path)

  return path
}

/** Writes a stand-in harness CLI that records its call and prints `reply`. */
async function fakeCli(
  dir: string,
  name: string,
  reply: string,
  exitCode = 0,
): Promise<string> {
  const report = join(dir, `${name}.observed.json`)
  await writeFile(
    join(dir, name),
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const at = args.indexOf('--output-last-message')
if (at >= 0) await Bun.write(args[at + 1], ${JSON.stringify(reply)})
const promptAt = args.indexOf('--prompt-file')
const input = promptAt >= 0 ? await Bun.file(args[promptAt + 1]).text() : await Bun.stdin.text()
const inGit = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], { stderr: 'ignore' }).exitCode === 0
const marker = await Bun.file(${JSON.stringify(SCRATCH_MARKER)}).exists()
await Bun.write(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd(), args, input, inGit, marker }))
console.log(${JSON.stringify(reply)})
process.exit(${exitCode})
`,
  )
  await chmod(join(dir, name), 0o755)

  return report
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error('timed out')
}

const RULES_REPLY = JSON.stringify({
  rules: [{ rule: 'fixture rule', question: 'fixture question' }],
})

describe('files', () => {
  it('publishes complete bytes and treats missing files as absent', async () => {
    const root = await temporary()
    const path = join(root, 'cache', 'rules.json')
    expect(await readText(path)).toBeUndefined()
    await writeText(path, '{"sentinel":"first"}')
    expect(await readText(path)).toBe('{"sentinel":"first"}')
    expect(await readdir(join(root, 'cache'))).toEqual(['rules.json'])
    await expect(readText(root)).rejects.toThrow()
  })
})

describe('extraction child process', () => {
  for (const harness of ['codex', 'muse'] as const) {
    it(`extracts through an actual ${harness} process in a marked scratch directory outside Git`, async () => {
      const root = await temporary()
      const bin = join(root, 'bin')
      await mkdir(bin)
      const report = await fakeCli(bin, harness, RULES_REPLY)
      const previous = process.env.PATH
      process.env.PATH = `${bin}:${previous ?? ''}`
      const state = await projectState(join(root, 'state'), harness, '/repo')
      const job = {
        harness,
        root: '/repo',
        hash: 'a'.repeat(64),
        cachePath: join(state.rules, `${'a'.repeat(64)}.json`),
        statusPath: state.extraction,
        debugPath: state.debug,
        prompt: 'fixture extraction input',
        model: 'fixture-model',
      }
      await writeText(leaseFile(job.cachePath), '')
      try {
        expect(await runExtraction(job)).toBe(true)
      } finally {
        process.env.PATH = previous
      }

      expect(JSON.parse((await readText(job.cachePath)) ?? '')).toEqual({
        hash: job.hash,
        rules: [{ rule: 'fixture rule', question: 'fixture question' }],
      })
      expect(JSON.parse((await readText(state.extraction)) ?? '')).toEqual(
        expect.objectContaining({ hash: job.hash, status: 'succeeded', ruleCount: 1 }),
      )
      expect(JSON.parse((await readText(state.debug)) ?? '')).toEqual(
        expect.objectContaining({ type: 'extraction', event: 'success', ruleCount: 1 }),
      )
      const observed = JSON.parse((await readText(report)) ?? '') as {
        cwd: string
        args: string[]
        input: string
        inGit: boolean
        marker: boolean
      }
      expect(observed.args).toEqual(expect.arrayContaining(['--model', 'fixture-model']))
      // Medium covered every checkable rule for Codex; Muse needs high (README, Behavior).
      expect(observed.args).toEqual(
        expect.arrayContaining(
          harness === 'codex'
            ? ['-c', 'model_reasoning_effort=medium']
            : ['--reasoning-effort', 'high'],
        ),
      )
      expect(observed.input).toContain(job.prompt)
      expect(observed.inGit).toBe(false)
      expect(observed.marker).toBe(true)
      expect(await readdir(state.rules)).toEqual([`${job.hash}.json`])
    })
  }

  it('records a failure for invalid output and for a failing CLI, and publishes no rules', async () => {
    const root = await temporary()
    const bin = join(root, 'bin')
    await mkdir(bin)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    const state = await projectState(join(root, 'state'), 'muse', '/repo')
    const job = {
      harness: 'muse' as const,
      root: '/repo',
      hash: 'b'.repeat(64),
      cachePath: join(state.rules, `${'b'.repeat(64)}.json`),
      statusPath: state.extraction,
      debugPath: state.debug,
      prompt: 'fixture',
    }
    try {
      await fakeCli(bin, 'muse', 'invalid')
      expect(await runExtraction(job)).toBe(false)
      expect(JSON.parse((await readText(state.extraction)) ?? '')).toEqual(
        expect.objectContaining({
          status: 'failed',
          reason: "the model's reply is not a JSON array of valid rules",
        }),
      )
      await fakeCli(bin, 'muse', RULES_REPLY, 1)
      expect(await runExtraction(job)).toBe(false)
      expect(JSON.parse((await readText(state.extraction)) ?? '')).toEqual(
        expect.objectContaining({
          status: 'failed',
          reason: expect.stringMatching(/^the extraction failed: /),
        }),
      )
    } finally {
      process.env.PATH = previous
    }
    expect(await readText(job.cachePath)).toBeUndefined()
    expect(
      (await readText(state.debug))
        ?.trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event),
    ).toEqual(['failure', 'failure'])
  })

  it('deduplicates an active lease and replaces an expired one', async () => {
    const root = await temporary()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await fakeCli(bin, 'muse', RULES_REPLY)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    const state = await projectState(join(root, 'state'), 'muse', '/repo')
    const job = {
      harness: 'muse' as const,
      root: '/repo',
      hash: 'c'.repeat(64),
      cachePath: join(state.rules, `${'c'.repeat(64)}.json`),
      statusPath: state.extraction,
      prompt: 'fixture',
    }
    try {
      await writeText(leaseFile(job.cachePath), '')
      expect(await extract(job)).toBe(false)
      await utimes(leaseFile(job.cachePath), 1, 1)
      expect(await extract(job)).toBe(true)
      await waitFor(async () => (await readText(job.cachePath)) !== undefined)
      await waitFor(async () => (await readText(leaseFile(job.cachePath))) === undefined)
    } finally {
      process.env.PATH = previous
    }
  })
})

/** Runs one hook launcher in `cwd` with `input` on standard input. */
async function hook(
  harness: 'codex' | 'muse',
  cwd: string,
  input: string,
  env: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(['sh', join(PLUGIN, `hooks/${harness}.sh`)], {
    cwd,
    env,
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)

  return output
}

describe('hook command boundary', () => {
  it('runs from the installed copy, keeps state under HOME, and installs the status launcher', async () => {
    const root = await temporary()
    const home = join(root, 'home')
    const project = join(root, 'project')
    const bin = join(root, 'bin')
    await mkdir(join(project, 'sub'), { recursive: true })
    await mkdir(bin)
    await fakeCli(bin, 'muse', RULES_REPLY)
    Bun.spawnSync(['git', 'init', '-q', project])
    await writeFile(join(project, 'AGENTS.md'), 'fixture source input')
    const env = {
      ...processEnvironment(),
      HOME: home,
      PATH: `${bin}:${processEnvironment().PATH ?? ''}`,
      TYPESAFE_API_KEY: '',
    }

    expect(await hook('muse', project, 'invalid JSON', env)).toBe('{}\n')
    expect(
      await hook(
        'muse',
        join(project, 'sub'),
        JSON.stringify({
          hook_event_name: 'SessionStart',
          cwd: join(project, 'sub'),
          session_id: 'fixture-session',
        }),
        env,
      ),
    ).toBe('{}\n')

    const resolved = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: project })
      .stdout.toString()
      .trim()
    const hash = await hashSources(await readSources(resolved, readText, 'muse'))
    const state = await projectState(join(home, '.local/state/prose-check'), 'muse', resolved)
    await waitFor(async () => (await readText(join(state.rules, `${hash}.json`))) !== undefined)
    expect(await readdir(project)).not.toContain('.artifacts')

    expect((await readText(join(home, '.local/state/prose-check/muse/plugin-root')))).toBe(PLUGIN)
    const launcher = join(home, '.local/state/prose-check/bin/prose-check')
    const status = Bun.spawnSync([launcher, 'status', 'muse', '--json'], {
      cwd: join(project, 'sub'),
      env,
    })
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout.toString())).toEqual(
      expect.objectContaining({
        harness: 'muse',
        projectRoot: resolved,
        apiKey: { isSet: false },
        cache: expect.objectContaining({ state: 'current', ruleCount: 1, files: ['AGENTS.md'] }),
        metrics: expect.objectContaining({ session: 'fixture-session' }),
      }),
    )

    expect(
      await hook(
        'muse',
        project,
        JSON.stringify({
          hook_event_name: 'Stop',
          cwd: project,
          session_id: 'fixture-session',
          turn_id: 't',
          stop_hook_active: false,
          last_assistant_message: 'short',
        }),
        env,
      ),
    ).toBe('{}\n')
  })

  it('does nothing in an extraction scratch directory', async () => {
    const root = await temporary()
    const home = join(root, 'home')
    await writeFile(join(root, SCRATCH_MARKER), '')
    const env = { ...processEnvironment(), HOME: home }
    expect(
      await hook(
        'codex',
        root,
        JSON.stringify({ hook_event_name: 'SessionStart', cwd: root, session_id: 's' }),
        env,
      ),
    ).toBe('{}\n')
    expect(await readText(join(home, '.local/state/prose-check/codex/plugin-root'))).toBeUndefined()
  })

  it('prints an empty result when Bun is not on PATH', async () => {
    const root = await temporary()
    const child = Bun.spawn(['/bin/sh', join(PLUGIN, 'hooks/codex.sh')], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      stdin: new TextEncoder().encode('{}'),
      stdout: 'pipe',
    })
    expect(await new Response(child.stdout).text()).toBe('{}\n')
  })
})

describe('repository layout', () => {
  it('declares one version and the prose-check marketplace in every manifest', async () => {
    const read = async (path: string) =>
      JSON.parse(await readFile(join(PLUGIN, path), 'utf8')) as Record<string, unknown>
    const claude = await read('.claude-plugin/plugin.json')
    const claudeMarketplace = await read('.claude-plugin/marketplace.json')
    const codex = await read('.codex-plugin/plugin.json')
    const codexMarketplace = await read('.agents/plugins/marketplace.json')
    const muse = await read('.muse-plugin/plugin.json')
    const pkg = await read('package.json')
    const versions = [
      claude.version,
      codex.version,
      muse.version,
      pkg.version,
      (claudeMarketplace.plugins as { version: string }[])[0]?.version,
    ]
    expect(new Set(versions).size).toBe(1)
    expect(claudeMarketplace.name).toBe('prose-check')
    expect(codexMarketplace.name).toBe('prose-check')
    for (const manifest of [claude, codex, muse]) expect(manifest.name).toBe('prose-check')
  })

  it('orders the time limits: extraction, then the Stop wait, then the Stop hook timeouts; the lease outlasts the extraction', async () => {
    const read = async (path: string) =>
      JSON.parse(await readFile(join(PLUGIN, path), 'utf8')) as Record<string, unknown>
    const codexHooks = (await read('hooks/codex.json')).hooks as {
      Stop: { hooks: { timeout: number }[] }[]
    }
    const museHooks = ((await read('.muse-plugin/plugin.json')).capabilities as {
      hooks: { event: string; timeoutMs: number }[]
    }).hooks
    const codexStopMs = (codexHooks.Stop[0]?.hooks[0]?.timeout ?? 0) * 1000
    const museStopMs = museHooks.find((hook) => hook.event === 'Stop')?.timeoutMs ?? 0

    expect(RULES_WAIT_MS).toBeGreaterThan(EXTRACTION_TIMEOUT_MS)
    expect(codexStopMs).toBeGreaterThan(RULES_WAIT_MS)
    expect(museStopMs).toBeGreaterThan(RULES_WAIT_MS)
    expect(LEASE_MS).toBeGreaterThan(EXTRACTION_TIMEOUT_MS)
  })

  it('runs the adapters and the mod with no installed packages', async () => {
    const files = [
      ...(await readdir(join(PLUGIN, 'adapters'))).map((name) => `adapters/${name}`),
      ...(await readdir(join(PLUGIN, 'core'))).map((name) => `core/${name}`),
      'hooks/register.ts',
    ].filter((name) => name.endsWith('.ts'))
    for (const file of files) {
      const text = await readFile(join(PLUGIN, file), 'utf8')
      const specifiers = [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(
        (match) => match[1] ?? '',
      )
      for (const specifier of specifiers)
        expect(
          specifier.startsWith('node:') ||
            specifier.startsWith('./') ||
            specifier.startsWith('../') ||
            (file === 'hooks/register.ts' && specifier === 'claude-code'),
        ).toBe(true)
    }
  })
})

describe('Jev request', () => {
  it('distinguishes an answer, a non-2xx status, a timeout, and a failed request', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/ok')
          return Response.json({
            auth: request.headers.get('authorization'),
            body: await request.text(),
          })
        if (path === '/slow') {
          await Bun.sleep(500)
          return new Response('late')
        }
        return new Response('busy', { status: 529 })
      },
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const ok = await jev('{"q":1}', 2000, 'k', `${base}/ok`)
      expect(ok.kind).toBe('answered')
      expect(ok.kind === 'answered' ? JSON.parse(ok.body) : undefined).toEqual({
        auth: 'Bearer k',
        body: '{"q":1}',
      })
      expect(await jev('{}', 2000, 'k', `${base}/busy`)).toEqual(
        expect.objectContaining({ kind: 'error', detail: 'HTTP 529' }),
      )
      const slow = await jev('{}', 50, 'k', `${base}/slow`)
      expect(slow.kind).toBe('timeout')
      expect(slow.latencyMs).toBeGreaterThanOrEqual(40)
      expect(slow.latencyMs).toBeLessThan(450)
    } finally {
      await server.stop(true)
    }
    const refused = await jev('{}', 2000, 'k', 'http://127.0.0.1:1/')
    expect(refused).toEqual(
      expect.objectContaining({ kind: 'error', detail: expect.stringMatching(/^request failed: /) }),
    )
  })
})
