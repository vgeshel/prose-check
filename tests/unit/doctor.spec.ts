import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DoctorReport } from '../../core/doctor'
import {
  bunFinding,
  filesFinding,
  formatDoctor,
  hooksFinding,
  jevFinding,
  keyFinding,
  rulesFinding,
  stateFinding,
} from '../../core/doctor'
import { keyFile, keyProbeRequest } from '../../core/key'
import { projectState } from '../../core/paths'
import { hashSources, readSources } from '../../core/sources'
import { findBun, gatherDoctor, main } from '../../adapters/status'
import { readText, writeText } from '../../adapters/files'
import type { JevAnswer } from '../../core/check'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'prose-check-doctor-'))
  directories.push(path)

  return path
}

const cache = { files: ['AGENTS.md'], extracting: false, lastFailure: undefined }

describe('doctor findings', () => {
  it('reports where Bun was found, or how to install it', () => {
    expect(bunFinding('/u/.bun/bin/bun')).toEqual({ check: 'Bun', status: 'ok', detail: '/u/.bun/bin/bun' })
    const missing = bunFinding(undefined)
    expect(missing.status).toBe('fail')
    expect(missing.fix).toContain('https://bun.com')
  })

  it('reports the key source, and where each harness reads a missing key', () => {
    expect(keyFinding({ source: '.env.local' }, 'muse')).toEqual({
      check: 'TYPESAFE_API_KEY',
      status: 'ok',
      detail: 'set (from .env.local)',
    })
    const missing = keyFinding(undefined, 'claude')
    expect(missing.status).toBe('fail')
    expect(missing.fix).toContain('~/.claude/settings.json')
  })

  it('tells a rejected key from another HTTP error, a timeout, and a failed request', () => {
    expect(jevFinding({ kind: 'accepted' }, 'environment', 'codex').status).toBe('ok')
    const rejected = jevFinding({ kind: 'rejected', status: 401 }, 'environment', 'claude')
    expect(rejected.status).toBe('fail')
    expect(rejected.detail).toBe('rejected the key with HTTP 401')
    expect(rejected.fix).toContain('the environment')
    expect(rejected.fix).toContain('~/.claude/settings.json')
    expect(jevFinding({ kind: 'http-error', status: 529 }, 'environment', 'codex').detail).toBe(
      'answered HTTP 529; the key could not be tested',
    )
    expect(jevFinding({ kind: 'timeout' }, 'environment', 'codex').detail).toBe('did not answer within 10 seconds')
    expect(jevFinding({ kind: 'failed', detail: 'request failed: x' }, 'environment', 'codex').detail).toBe(
      'request failed: x',
    )
    expect(jevFinding(undefined, undefined, 'codex').status).toBe('skipped')
  })

  it('reports the instruction files, or which files each harness reads', () => {
    expect(filesFinding(['CLAUDE.md', 'AGENTS.md'], 'claude')).toEqual({
      check: 'Instruction files',
      status: 'ok',
      detail: 'CLAUDE.md, AGENTS.md',
    })
    const none = filesFinding([], 'codex')
    expect(none.status).toBe('fail')
    expect(none.fix).toContain('AGENTS.md')
  })

  it('reports extracted, pending, running, stale, and failed rules', () => {
    expect(rulesFinding({ ...cache, state: 'current', ruleCount: 12 }, 'codex')).toEqual({
      check: 'Rules',
      status: 'ok',
      detail: '12 rules extracted for the current instruction files',
    })
    expect(rulesFinding({ ...cache, state: 'missing', ruleCount: undefined }, 'codex').status).toBe('pending')
    expect(rulesFinding({ ...cache, state: 'stale', ruleCount: 3, extracting: true }, 'muse').detail).toBe(
      'extraction running',
    )
    const failed = rulesFinding(
      { ...cache, state: 'missing', ruleCount: undefined, lastFailure: { reason: 'r', at: 'T' } },
      'muse',
    )
    expect(failed.status).toBe('fail')
    expect(failed.detail).toBe('the last extraction failed at T: r')
    expect(rulesFinding({ ...cache, state: 'no-files', ruleCount: undefined }, 'muse').status).toBe('skipped')
    expect(rulesFinding({ ...cache, state: 'current', ruleCount: 0 }, 'muse').status).toBe('fail')
  })

  it('reports whether the state directory is writable and whether the hooks have run', () => {
    expect(stateFinding('/s', undefined).status).toBe('ok')
    expect(stateFinding('/s', 'EACCES').fix).toContain('/s')
    expect(stateFinding(undefined, undefined).status).toBe('fail')
    expect(hooksFinding(Date.parse('2026-10-16T00:00:00Z'), 'codex').detail).toBe(
      'the last session started at 2026-10-16T00:00:00.000Z',
    )
    const never = hooksFinding(undefined, 'muse')
    expect(never.status).toBe('fail')
    expect(never.fix).toContain('muse plugins inspect prose-check')
    expect(hooksFinding(undefined, 'codex').fix).toContain('/hooks')
  })

  it('prints each finding with its fix and a result line', () => {
    const report: DoctorReport = {
      harness: 'codex',
      version: '1.0.0',
      projectRoot: '/p',
      findings: [bunFinding('/b'), keyFinding(undefined, 'codex'), jevFinding(undefined, undefined, 'codex')],
      ok: false,
    }
    const text = formatDoctor(report)
    expect(text.split('\n').slice(0, 5)).toEqual([
      'prose-check 1.0.0 doctor (codex)',
      'Project: /p',
      'ok       Bun: /b',
      'FAIL     TYPESAFE_API_KEY: not set',
      expect.stringMatching(/^ {9}Fix: /),
    ])
    expect(text).toContain('skipped  Jev: not tested, because TYPESAFE_API_KEY is not set')
    expect(text.split('\n').at(-1)).toBe('Result: 1 problem; replies finish unchecked until it is fixed.')
    expect(formatDoctor({ ...report, findings: [bunFinding('/b')], ok: true }).split('\n').at(-1)).toBe(
      'Result: no problems found.',
    )
  })
})

describe('Bun lookup', () => {
  it('finds Bun on PATH, then at ~/.bun/bin/bun, the way the hook launcher does', async () => {
    const home = await temporary()
    const bunDir = join(process.execPath, '..')
    expect(findBun({ PATH: bunDir, HOME: home })).toBe(join(bunDir, 'bun'))
    expect(findBun({ PATH: '/usr/bin:/bin', HOME: home })).toBeUndefined()
    expect(findBun({ PATH: '/usr/bin:/bin' })).toBeUndefined()
    await mkdir(join(home, '.bun/bin'), { recursive: true })
    await symlink(process.execPath, join(home, '.bun/bin/bun'))
    expect(findBun({ PATH: '/usr/bin:/bin', HOME: home })).toBe(join(home, '.bun/bin/bun'))
  })
})

describe('doctor command', () => {
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
    const stateRoot = join(home, '.local/state/prose-check')
    const state = await projectState(stateRoot, 'muse', resolved)
    const hash = await hashSources(await readSources(resolved, readText, 'muse'))
    const args = { command: 'doctor' as const, project, harness: 'muse' as const, json: true, session: undefined }

    return { root, home, project, stateRoot, state, hash, args }
  }

  const accepting = { jev: () => Promise.resolve<JevAnswer>({ kind: 'answered', body: '{}', latencyMs: 1 }) }

  it('passes when every condition holds, and sends one key test', async () => {
    const f = await fixture()
    await writeFile(join(f.project, '.env.local'), 'TYPESAFE_API_KEY=good-key\n')
    await writeText(`${f.state.rules}/${f.hash}.json`, JSON.stringify({ hash: f.hash, rules: [{ rule: 'r', question: 'q' }] }))
    await writeText(f.state.metrics, `${JSON.stringify({ at: 1, session: 's', event: 'session-start' })}\n`)
    const sent: { body: string; key: string; timeout: number }[] = []
    const report = await gatherDoctor(f.args, { HOME: f.home, PATH: '/usr/bin:/bin' }, {
      jev: (body, timeout, key) => {
        sent.push({ body, key, timeout })
        return Promise.resolve({ kind: 'answered', body: '{}', latencyMs: 1 })
      },
      bun: () => '/opt/bun',
    })
    expect(report.findings.map((finding) => [finding.check, finding.status])).toEqual([
      ['Bun', 'ok'],
      ['TYPESAFE_API_KEY', 'ok'],
      ['Jev', 'ok'],
      ['Hooks', 'ok'],
      ['Instruction files', 'ok'],
      ['Rules', 'ok'],
      ['State directory', 'ok'],
    ])
    expect(report.ok).toBe(true)
    expect(sent).toEqual([{ body: keyProbeRequest(), key: 'good-key', timeout: 10_000 }])
    expect(JSON.parse((await readText(await keyFile(f.stateRoot, 'good-key'))) ?? '{}').verdict).toBe('accepted')
    expect(JSON.stringify(report)).not.toContain('good-key')
  })

  it('fails for a rejected key, hooks that never ran, and a state directory it cannot write', async () => {
    const f = await fixture()
    await writeFile(join(f.project, '.env.local'), 'TYPESAFE_API_KEY=fixt123\n')
    await mkdir(f.stateRoot, { recursive: true })
    await chmod(f.stateRoot, 0o500)
    try {
      const report = await gatherDoctor(f.args, { HOME: f.home }, {
        jev: () => Promise.resolve({ kind: 'error', detail: 'HTTP 401', status: 401, latencyMs: 1 }),
        bun: () => undefined,
      })
      const status = Object.fromEntries(report.findings.map((finding) => [finding.check, finding.status]))
      expect(status).toEqual({
        Bun: 'fail',
        TYPESAFE_API_KEY: 'ok',
        Jev: 'fail',
        Hooks: 'fail',
        'Instruction files': 'ok',
        Rules: 'pending',
        'State directory': 'fail',
      })
      expect(report.ok).toBe(false)
    } finally {
      await chmod(f.stateRoot, 0o700)
    }
  })

  it('reads the Muse key from .env.local only, as the Muse hooks receive it', async () => {
    const f = await fixture()
    const sent: string[] = []
    const deps = {
      jev: (_body: string, _timeout: number, key: string) => {
        sent.push(key)
        return Promise.resolve<JevAnswer>({ kind: 'answered', body: '{}', latencyMs: 1 })
      },
      bun: () => '/b',
    }
    const env = { HOME: f.home, TYPESAFE_API_KEY: 'shell-key' }
    const missing = await gatherDoctor(f.args, env, deps)
    const key = missing.findings.find((finding) => finding.check === 'TYPESAFE_API_KEY')
    expect(key?.status).toBe('fail')
    expect(key?.fix).toContain('does not pass the shell')
    expect(sent).toEqual([])

    await writeFile(join(f.project, '.env.local'), 'TYPESAFE_API_KEY=file-key\n')
    await gatherDoctor(f.args, env, deps)
    expect(sent).toEqual(['file-key'])
    await gatherDoctor({ ...f.args, harness: 'codex' }, env, deps)
    expect(sent).toEqual(['file-key', 'shell-key'])
  })

  it('exits 1 on a failure and 0 without one, and prints text or JSON', async () => {
    const f = await fixture()
    let out = ''
    expect(await main(['doctor', 'muse'], f.project, { HOME: f.home }, (text) => (out += text), { ...accepting, bun: () => '/b' })).toBe(1)
    expect(out).toContain('prose-check 0.4.0 doctor (muse)')
    expect(out).toContain('FAIL     TYPESAFE_API_KEY: not set')
    expect(out).toContain('Result: ')

    await writeFile(join(f.project, '.env.local'), 'TYPESAFE_API_KEY=k\n')
    await writeText(f.state.metrics, `${JSON.stringify({ at: 1, session: 's', event: 'session-start' })}\n`)
    out = ''
    expect(
      await main(['doctor', 'muse', '--json'], f.project, { HOME: f.home }, (text) => (out += text), { ...accepting, bun: () => '/b' }),
    ).toBe(0)
    expect(JSON.parse(out)).toEqual(expect.objectContaining({ harness: 'muse', ok: true }))
  })
})
