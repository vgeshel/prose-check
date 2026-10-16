import { describe, expect, it } from 'bun:test'

import type { JevAnswer } from '../../core/check'
import type { KeyDependencies } from '../../core/key'
import {
  keyCheck,
  keyFile,
  keyProbeRequest,
  noteKeyAnswer,
  sessionKeyWarning,
} from '../../core/key'
import { JEV_MODEL } from '../../core/rules'

const ROOT = '/home/u/.local/state/prose-check'

function deps(answers: JevAnswer[]) {
  const files = new Map<string, string>()
  const probes: string[] = []
  const value: KeyDependencies = {
    read: (path) => Promise.resolve(files.get(path)),
    write: (path, content) => {
      files.set(path, content)
      return Promise.resolve()
    },
    probe: (body) => {
      probes.push(body)
      const answer = answers.shift()
      if (answer === undefined) throw new Error('unexpected probe')
      return Promise.resolve(answer)
    },
    now: () => Date.parse('2026-10-16T12:00:00.000Z'),
  }

  return { files, probes, deps: value }
}

const ok: JevAnswer = { kind: 'answered', body: '{}', latencyMs: 90 }
const unauthorized: JevAnswer = { kind: 'error', detail: 'HTTP 401', status: 401, latencyMs: 90 }

describe('key check', () => {
  it('sends one question about a two-letter reply', () => {
    const body = JSON.parse(keyProbeRequest()) as Record<string, unknown>
    expect(body.model).toBe(JEV_MODEL)
    expect(body.state).toEqual({ response: 'ok' })
    expect(Object.keys(body.questions as object)).toHaveLength(1)
  })

  it('tells a rejected key from other HTTP errors, a timeout, and a failed request', () => {
    expect(keyCheck(ok)).toEqual({ kind: 'accepted' })
    expect(keyCheck(unauthorized)).toEqual({ kind: 'rejected', status: 401 })
    expect(keyCheck({ kind: 'error', detail: 'HTTP 403', status: 403, latencyMs: 1 })).toEqual({
      kind: 'rejected',
      status: 403,
    })
    expect(keyCheck({ kind: 'error', detail: 'HTTP 529', status: 529, latencyMs: 1 })).toEqual({
      kind: 'http-error',
      status: 529,
    })
    expect(keyCheck({ kind: 'timeout', latencyMs: 1 })).toEqual({ kind: 'timeout' })
    expect(keyCheck({ kind: 'error', detail: 'request failed: x', latencyMs: 1 })).toEqual({
      kind: 'failed',
      detail: 'request failed: x',
    })
  })

  it('names the cache file by a hash of the key, never the key', async () => {
    const path = await keyFile(ROOT, 'secret-key')
    expect(path).toMatch(new RegExp(`^${ROOT}/keys/[0-9a-f]{16}\\.json$`))
    expect(path).not.toContain('secret-key')
    expect(await keyFile(ROOT, 'other-key')).not.toBe(path)
  })
})

describe('session start key warning', () => {
  it('warns about a missing key without a request, and names the doctor command', async () => {
    const d = deps([])
    expect(await sessionKeyWarning(undefined, ROOT, 'claude', d.deps)).toBe(
      'TYPESAFE_API_KEY is not set, so replies go unchecked. Run /prose-check doctor for the fix.',
    )
    expect(await sessionKeyWarning(undefined, ROOT, 'muse', d.deps)).toBe(
      'TYPESAFE_API_KEY is not set, so replies go unchecked. Run ~/.local/state/prose-check/bin/prose-check doctor muse for the fix.',
    )
    expect(d.probes).toEqual([])
  })

  it('keeps the warning short enough for a 200-column Muse Code footer', async () => {
    const d = deps([unauthorized])
    const text = await sessionKeyWarning({ key: 'k', source: '.env.local' }, ROOT, 'muse', d.deps)
    // Muse Code 1.4.9 draws `Hook · SessionStart · prose-check: <text>` after the model name.
    expect(`  echo Hook · SessionStart · prose-check: ${text ?? ''}`.length).toBeLessThanOrEqual(200)
  })

  it('probes a new key once, caches an accepted verdict, and then sends nothing', async () => {
    const d = deps([ok])
    expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', d.deps)).toBeUndefined()
    expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', d.deps)).toBeUndefined()
    expect(d.probes).toEqual([keyProbeRequest()])
    expect(JSON.parse(d.files.get(await keyFile(ROOT, 'k')) ?? '')).toEqual({
      verdict: 'accepted',
      at: '2026-10-16T12:00:00.000Z',
    })
    expect([...d.files.values()].join('')).not.toContain('"k"')
  })

  it('warns when Jev rejects the key, and probes again at the next session', async () => {
    const d = deps([unauthorized, unauthorized])
    const text = await sessionKeyWarning({ key: 'k', source: '.env.local' }, ROOT, 'muse', d.deps)
    expect(text).toBe(
      'Jev rejected TYPESAFE_API_KEY with HTTP 401, so replies go unchecked. Run ~/.local/state/prose-check/bin/prose-check doctor muse for the fix.',
    )
    expect(await sessionKeyWarning({ key: 'k', source: '.env.local' }, ROOT, 'muse', d.deps)).toContain('HTTP 401')
    expect(d.probes).toHaveLength(2)
  })

  it('stays silent and caches nothing when Jev times out, fails, or answers another error', async () => {
    const d = deps([
      { kind: 'timeout', latencyMs: 3000 },
      { kind: 'error', detail: 'HTTP 529', status: 529, latencyMs: 1 },
      { kind: 'error', detail: 'request failed: offline', latencyMs: 1 },
    ])
    for (let index = 0; index < 3; index += 1)
      expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', d.deps)).toBeUndefined()
    expect(d.files.size).toBe(0)
  })

  it('probes without a cache when there is no state directory, and survives a failed write', async () => {
    const d = deps([unauthorized])
    expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, undefined, 'claude', d.deps)).toContain(
      'HTTP 401',
    )
    const failing = deps([ok])
    failing.deps.write = () => Promise.reject(new Error('read-only'))
    expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', failing.deps)).toBeUndefined()
  })

  it('forgets an accepted verdict when a check sees HTTP 401 or 403', async () => {
    const d = deps([ok, unauthorized])
    await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', d.deps)
    await noteKeyAnswer('k', ROOT, { kind: 'error', detail: 'HTTP 529', status: 529, latencyMs: 1 }, d.deps)
    expect(JSON.parse(d.files.get(await keyFile(ROOT, 'k')) ?? '').verdict).toBe('accepted')
    await noteKeyAnswer('k', ROOT, unauthorized, d.deps)
    expect(JSON.parse(d.files.get(await keyFile(ROOT, 'k')) ?? '')).toEqual({
      verdict: 'rejected',
      status: 401,
      at: '2026-10-16T12:00:00.000Z',
    })
    expect(await sessionKeyWarning({ key: 'k', source: 'environment' }, ROOT, 'codex', d.deps)).toContain('HTTP 401')
  })
})
