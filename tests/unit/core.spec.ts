import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_OPTIONS, modOptions, projectOptions } from '../../core/options'
import { projectState, stateRoot } from '../../core/paths'
import { aggregate } from '../../core/records'
import { formatStatus } from '../../core/status'
import { importedPaths } from '../../core/rules'
import { hashSources, readSources } from '../../core/sources'
import { parseExtraction, parseHook } from '../../adapters/contracts'
import { apiKey, dotenvValue } from '../../adapters/environment'
import { readText, writeText } from '../../adapters/files'
import { gatherStatus, main, parseArguments } from '../../adapters/status'
import { leaseFile } from '../../adapters/runtime'

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

describe('settings', () => {
  it('keeps the defaults and the probability range', () => {
    expect(DEFAULT_OPTIONS).toEqual({
      timeoutMs: 300,
      minLength: 200,
      breachThreshold: 0.85,
      debug: false,
    })
    expect(projectOptions(undefined)).toEqual({ options: DEFAULT_OPTIONS })
    expect(projectOptions({ timeoutMs: 1000, debug: true })).toEqual({
      options: { ...DEFAULT_OPTIONS, timeoutMs: 1000, debug: true },
    })
    for (const invalid of [
      { timeoutMs: 0 },
      { breachThreshold: 1.1 },
      { breachThreshold: 0 },
      { minLength: -1 },
      { minLength: 1.5 },
      { debug: 'yes' },
      [],
    ])
      expect('error' in projectOptions(invalid)).toBe(true)
  })

  it('falls back field by field for the Claude Code mod', () => {
    expect(modOptions({ timeoutMs: -5, minLength: 10, breachThreshold: 2, debug: true })).toEqual({
      ...DEFAULT_OPTIONS,
      minLength: 10,
      debug: true,
    })
  })
})

describe('state location', () => {
  it('uses HOME alone and separates projects by root', async () => {
    expect(stateRoot('/home/u/')).toBe('/home/u/.local/state/prose-check')
    expect(stateRoot(undefined)).toBeUndefined()
    const one = await projectState('/s', 'codex', '/work/app')
    const two = await projectState('/s', 'codex', '/other/app')
    expect(one.dir).toMatch(/^\/s\/codex\/app-[0-9a-f]{16}$/)
    expect(one.dir).not.toBe(two.dir)
    expect(one.debug).toBe(`${one.dir}/debug.jsonl`)
  })
})

describe('instruction files', () => {
  const read = (files: Record<string, string>) => (path: string) =>
    Promise.resolve(files[path])
  const paths = async (
    harness: 'claude' | 'codex' | 'muse',
    files: Record<string, string>,
  ) => (await readSources('/p', read(files), harness)).map((source) => source.path)

  it('reads what Claude Code loads: CLAUDE.md and its imports, four hops deep', async () => {
    const files = {
      '/p/CLAUDE.md': 'See @docs/a.md and @./b.md. Not `@c.md`.\n```\n@d.md\n```',
      '/p/AGENTS.md': 'Agents only',
      '/p/docs/a.md': 'A imports @e.md',
      '/p/docs/e.md': 'E imports @../f.md',
      '/p/f.md': 'F imports @g.md',
      '/p/g.md': 'G imports @h.md',
      '/p/h.md': 'H is five hops away',
      '/p/b.md': 'B',
      '/p/c.md': 'in a code span',
      '/p/d.md': 'in a fenced block',
    }
    expect(await paths('claude', files)).toEqual([
      'CLAUDE.md',
      'docs/a.md',
      'b.md',
      'docs/e.md',
      'f.md',
      'g.md',
    ])
  })

  it('skips imports in every CommonMark code span and fenced block form', async () => {
    const text = [
      '@kept.md',
      '````md',
      '@long-fence.md',
      '`````',
      '   ~~~',
      '@indented-tilde.md',
      '   ~~~~',
      'Spans: ``@double.md`` and `` a ` b @inside.md``.',
      '```',
      '@unclosed.md',
    ].join('\n')
    expect(importedPaths(text)).toEqual(['kept.md'])
  })

  it('reads imports again after a fence closes with a longer or indented fence', () => {
    const text = ['````', '@in-long.md', '`````', '@after-long.md', '~~~', '@in-tilde.md', '   ~~~~', '@after-tilde.md'].join('\n')
    expect(importedPaths(text)).toEqual(['after-long.md', 'after-tilde.md'])
  })

  it('keeps imports after an unmatched backtick in a tight list or with CRLF line endings', () => {
    expect(
      importedPaths(['- Wrap names in backticks (`).', '- @rules.md', '- Run `make`.'].join('\n')),
    ).toEqual(['rules.md'])
    expect(
      importedPaths(['Wrap names in backticks (`).', '', '@rules.md', '', 'Run `make`.'].join('\r\n')),
    ).toEqual(['rules.md'])
  })

  it('recognizes fenced blocks in a file with CRLF line endings', () => {
    expect(importedPaths(['```', '@in-fence.md', '```', '@after.md'].join('\r\n'))).toEqual([
      'after.md',
    ])
  })

  it('treats a backtick after an even number of backslashes as unescaped', () => {
    expect(importedPaths('Two slashes \\\\` @hidden.md` and @visible.md')).toEqual(['visible.md'])
  })

  it('recognizes a code span only within one line, as the README states', () => {
    expect(importedPaths(['Run `make', '@wrapped.md` now.'].join('\n'))).toEqual(['wrapped.md'])
  })

  it('keeps imports after an unmatched or escaped backtick', () => {
    const unmatched = ['Wrap names in backticks (`).', '', '@rules.md', '', 'Run `make`.'].join('\n')
    expect(importedPaths(unmatched)).toEqual(['rules.md'])
    const escaped = 'Type \\` to quote. @escaped.md and a lone ` later.'
    expect(importedPaths(escaped)).toEqual(['escaped.md'])
  })

  it('reads AGENTS.md and its imports in Claude Code when there is no CLAUDE.md', async () => {
    expect(
      await paths('claude', { '/p/AGENTS.md': 'Rules @x.md', '/p/x.md': 'X' }),
    ).toEqual(['AGENTS.md', 'x.md'])
  })

  it('ignores imports that leave the project root', async () => {
    expect(
      await paths('claude', { '/p/CLAUDE.md': '@../outside.md', '/outside.md': 'O' }),
    ).toEqual(['CLAUDE.md'])
  })

  it('reads what Codex loads: AGENTS.override.md, else AGENTS.md, never CLAUDE.md or imports', async () => {
    const files = {
      '/p/CLAUDE.md': 'Claude only',
      '/p/AGENTS.md': 'Rules @x.md',
      '/p/x.md': 'X',
    }
    expect(await paths('codex', files)).toEqual(['AGENTS.md'])
    expect(
      await paths('codex', { ...files, '/p/AGENTS.override.md': 'Override' }),
    ).toEqual(['AGENTS.override.md'])
    expect(
      await paths('codex', { ...files, '/p/AGENTS.override.md': ' \n' }),
    ).toEqual(['AGENTS.md'])
    expect(await paths('codex', { '/p/CLAUDE.md': 'Claude only' })).toEqual([])
  })

  it('reads what Muse Code loads: AGENTS.md, else CLAUDE.md, without imports', async () => {
    const files = { '/p/CLAUDE.md': 'Claude @x.md', '/p/x.md': 'X' }
    expect(await paths('muse', files)).toEqual(['CLAUDE.md'])
    expect(await paths('muse', { ...files, '/p/AGENTS.md': 'Agents' })).toEqual([
      'AGENTS.md',
    ])
  })

  it('hashes the sources', async () => {
    const sources = await readSources('/p', read({ '/p/AGENTS.md': 'A' }), 'muse')
    expect(await hashSources(sources)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('environment', () => {
  it('reads TYPESAFE_API_KEY from dotenv text', () => {
    expect(dotenvValue('A=1\nexport TYPESAFE_API_KEY="k1"\n', 'TYPESAFE_API_KEY')).toBe('k1')
    expect(dotenvValue("TYPESAFE_API_KEY='k2' \n", 'TYPESAFE_API_KEY')).toBe('k2')
    expect(dotenvValue('TYPESAFE_API_KEY=k3 # note\n# TYPESAFE_API_KEY=x', 'TYPESAFE_API_KEY')).toBe('k3')
    expect(dotenvValue('OTHER=1', 'TYPESAFE_API_KEY')).toBeUndefined()
  })

  it('prefers the environment and falls back to the project root .env.local', async () => {
    const root = await temporary()
    expect(await apiKey(root, {})).toBeUndefined()
    await writeFile(join(root, '.env.local'), 'TYPESAFE_API_KEY=from-file\n')
    expect(await apiKey(root, {})).toEqual({ key: 'from-file', source: '.env.local' })
    expect(await apiKey(root, { TYPESAFE_API_KEY: 'from-env' })).toEqual({
      key: 'from-env',
      source: 'environment',
    })
    expect(await apiKey(root, { TYPESAFE_API_KEY: '' })).toEqual({
      key: 'from-file',
      source: '.env.local',
    })
  })
})

describe('hook contracts', () => {
  it('validates the consumed fields', () => {
    const stop = {
      hook_event_name: 'Stop',
      cwd: '/repo',
      session_id: 's',
      turn_id: 't',
      stop_hook_active: false,
      last_assistant_message: null,
      transcript_path: null,
    }
    expect(parseHook(stop)).toEqual({
      hook_event_name: 'Stop',
      cwd: '/repo',
      session_id: 's',
      turn_id: 't',
      stop_hook_active: false,
      last_assistant_message: null,
    })
    expect(parseHook({ ...stop, stop_hook_active: 'false' })).toBeUndefined()
    expect(parseHook({ ...stop, turn_id: '' })).toBeUndefined()
    expect(parseHook({ ...stop, hook_event_name: 'PreToolUse' })).toBeUndefined()
    expect(parseHook({ hook_event_name: 'SessionStart', cwd: '/r', session_id: 's', model: 'm' })).toEqual(
      { hook_event_name: 'SessionStart', cwd: '/r', session_id: 's', model: 'm' },
    )
    const job = {
      harness: 'muse' as const,
      root: '/repo',
      hash: 'd'.repeat(64),
      cachePath: '/s/rules/x.json',
      statusPath: '/s/extraction.json',
      debugPath: '/s/debug.jsonl',
      prompt: 'p',
      model: 'm',
    }
    expect(parseExtraction(job)).toEqual(job)
    expect(parseExtraction({ ...job, harness: 'claude' })).toBeUndefined()
    expect(parseExtraction({ ...job, hash: 'short' })).toBeUndefined()
    expect(parseExtraction({ ...job, debugPath: '' })).toBeUndefined()
  })
})

describe('metrics', () => {
  it('counts outcomes for the latest session and in total', () => {
    const lines = [
      { at: 1, session: 'a', event: 'session-start' },
      { at: 2, session: 'a', event: 'check', outcome: 'passed', latencyMs: 100 },
      { at: 3, session: 'a', event: 'check', outcome: 'skipped', reason: 'jev-timeout' },
      { at: 4, session: 'b', event: 'session-start' },
      { at: 5, session: 'b', event: 'check', outcome: 'rewrite-requested', latencyMs: 300 },
      { at: 6, session: 'b', event: 'check', outcome: 'warning-shown', latencyMs: 200 },
      { at: 7, session: 'b', event: 'check', outcome: 'skipped', reason: 'jev-error' },
      { at: 8, session: 'b', event: 'check', outcome: 'skipped', reason: 'short-reply' },
    ]
    const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`
    const metrics = aggregate(text)
    expect(metrics.session).toBe('b')
    expect(metrics.current).toEqual(
      expect.objectContaining({
        checks: 2,
        passes: 0,
        rewrites: 1,
        warnings: 1,
        jevTimeouts: 0,
        jevErrors: 1,
        averageLatencyMs: 250,
      }),
    )
    expect(metrics.current.skips['short-reply']).toBe(1)
    expect(metrics.total).toEqual(
      expect.objectContaining({ checks: 3, passes: 1, jevTimeouts: 1, averageLatencyMs: 200 }),
    )
    expect(aggregate(text, 'a').current.checks).toBe(1)
    expect(aggregate('').current.averageLatencyMs).toBeUndefined()
  })
})

describe('status command', () => {
  async function fixture() {
    const root = await temporary()
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', project])
    const resolved = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: project })
      .stdout.toString()
      .trim()
    await writeFile(join(project, 'AGENTS.md'), 'Use short sentences.')
    const state = await projectState(join(home, '.local/state/prose-check'), 'codex', resolved)
    const hash = await hashSources(await readSources(resolved, readText, 'codex'))
    const args = { project, harness: 'codex' as const, json: true, session: undefined }

    return { home, project, resolved, state, hash, args }
  }

  it('parses its command line', () => {
    expect(parseArguments(['status', 'muse', '--json', '--session', 'x'], '/cwd')).toEqual({
      project: '/cwd',
      harness: 'muse',
      json: true,
      session: 'x',
    })
    expect(parseArguments(['--project', '/p', 'status', 'codex'], '/cwd')).toEqual(
      expect.objectContaining({ project: '/p', harness: 'codex', json: false }),
    )
    expect('error' in parseArguments(['status', 'claude'], '/cwd')).toBe(true)
    expect('error' in parseArguments(['status', 'codex', '--session'], '/cwd')).toBe(true)
  })

  it('reports a missing cache, a running extraction, and a failed one', async () => {
    const f = await fixture()
    const env = { HOME: f.home }
    expect((await gatherStatus(f.args, env)).cache).toEqual({
      files: ['AGENTS.md'],
      state: 'missing',
      ruleCount: undefined,
      extracting: false,
      lastFailure: undefined,
    })
    await writeText(leaseFile(`${f.state.rules}/${f.hash}.json`), '')
    expect((await gatherStatus(f.args, env)).cache.extracting).toBe(true)
    await writeText(
      f.state.extraction,
      JSON.stringify({ hash: f.hash, status: 'failed', at: '2026-10-08T00:00:00.000Z', reason: 'r' }),
    )
    expect((await gatherStatus(f.args, env)).cache.lastFailure).toEqual({
      reason: 'r',
      at: '2026-10-08T00:00:00.000Z',
    })
  })

  it('reports a current cache, a stale one, the key source, and invalid settings', async () => {
    const f = await fixture()
    const env = { HOME: f.home }
    await writeText(
      `${f.state.rules}/${f.hash}.json`,
      JSON.stringify({ hash: f.hash, rules: [{ rule: 'r', question: 'q' }] }),
    )
    await writeText(
      f.state.extraction,
      JSON.stringify({ hash: f.hash, status: 'succeeded', at: 'x', ruleCount: 1 }),
    )
    await writeFile(join(f.project, '.env.local'), 'TYPESAFE_API_KEY=secret-value\n')
    const current = await gatherStatus(f.args, env)
    expect(current.cache).toEqual(expect.objectContaining({ state: 'current', ruleCount: 1 }))
    expect(current.apiKey).toEqual({ isSet: true, source: '.env.local' })
    expect(JSON.stringify(current)).not.toContain('secret-value')

    await writeFile(join(f.project, 'AGENTS.md'), 'Use active voice.')
    expect((await gatherStatus(f.args, env)).cache).toEqual(
      expect.objectContaining({ state: 'stale', ruleCount: 1 }),
    )

    await writeFile(join(f.project, '.prose-check.json'), '{"timeoutMs": 0}')
    const invalid = await gatherStatus(f.args, env)
    expect(invalid.settings).toBeUndefined()
    expect(invalid.settingsError).toBe('.prose-check.json: timeoutMs must be a positive number')
    await writeFile(join(f.project, '.prose-check.json'), '{')
    expect((await gatherStatus(f.args, env)).settingsError).toBe('.prose-check.json is not valid JSON')
  })

  it('prints text with every metric and exits 2 on a bad command line', async () => {
    const f = await fixture()
    await writeText(
      f.state.metrics,
      `${JSON.stringify({ at: 1, session: 'abc', event: 'session-start' })}\n${JSON.stringify({ at: 2, session: 'abc', event: 'check', outcome: 'passed', latencyMs: 90 })}\n`,
    )
    let out = ''
    expect(await main(['status', 'codex'], f.project, { HOME: f.home }, (text) => (out += text))).toBe(0)
    expect(out).toContain('prose-check 0.3.3 (codex)')
    expect(out).toContain(`Project: ${f.resolved}`)
    expect(out).toContain('This session (abc):')
    expect(out).toContain('  checks completed: 1')
    expect(out).toContain('  average Jev latency: 90 ms')
    expect(out).toContain('Debug records: off')
    out = ''
    expect(await main(['status'], f.project, {}, (text) => (out += text))).toBe(2)
    expect(out).toContain('usage:')
  })

  it('formats every cache state', () => {
    const base = {
      harness: 'muse' as const,
      version: '1',
      projectRoot: '/p',
      settings: { ...DEFAULT_OPTIONS, debug: true },
      settingsError: undefined,
      apiKey: { isSet: false, source: undefined },
      metrics: aggregate(''),
      stateDir: '/s',
      debugFile: '/s/debug.jsonl',
    }
    const cache = { files: ['AGENTS.md'], ruleCount: 3, extracting: true, lastFailure: undefined }
    expect(formatStatus({ ...base, cache: { ...cache, state: 'stale' } })).toContain(
      'Rule cache: 3 rules, does not match the current instruction files',
    )
    expect(formatStatus({ ...base, cache: { ...cache, state: 'no-files', files: [] } })).toContain(
      'Rule cache: no CLAUDE.md or AGENTS.md in the project root',
    )
    const text = formatStatus({ ...base, cache: { ...cache, state: 'missing' } })
    expect(text).toContain('Extraction: running')
    expect(text).toContain('Debug records: /s/debug.jsonl')
    expect(text).toContain('TYPESAFE_API_KEY: not set')
  })
})
