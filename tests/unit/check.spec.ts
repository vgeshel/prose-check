import { describe, expect, it } from 'bun:test'

import type { JevAnswer } from '../../core/check'
import { DEFAULT_OPTIONS } from '../../core/options'
import type { ProjectState } from '../../core/paths'
import { projectState } from '../../core/paths'
import { rewriteRequest, warning } from '../../core/rules'
import type { AdapterDependencies, HookContext } from '../../adapters/check'
import { RULES_WAIT_MS, checkHook } from '../../adapters/check'
import type { Extraction, Hook } from '../../adapters/contracts'

const rules = [{ rule: 'fixture rule', question: 'fixture question' }]
const reply = 'A'.repeat(240)

interface World {
  files: Map<string, string>
  jobs: Extraction[]
  requests: { body: string; timeout: number; key: string }[]
  deps: AdapterDependencies
  state: ProjectState
  setAnswer(answer: JevAnswer | number): void
  setLeased(value: boolean): void
  /** Runs `action` once the fake clock has advanced `afterMs` through sleeps. */
  schedule(afterMs: number, action: () => void): void
  sleeps: number[]
  lines(path: string): Record<string, unknown>[]
}

async function world(): Promise<World> {
  const files = new Map<string, string>([
    ['/repo/AGENTS.md', 'fixture instructions'],
  ])
  const jobs: Extraction[] = []
  const requests: World['requests'] = []
  let answer: JevAnswer | number = 1
  let leased = false
  let clock = 1_700_000_000_000
  const sleeps: number[] = []
  const scheduled: { at: number; action: () => void }[] = []
  const state = await projectState('/home/u/.local/state/prose-check', 'codex', '/repo')
  const deps: AdapterDependencies = {
    read: (path) => Promise.resolve(files.get(path)),
    write: (path, content) => {
      files.set(path, content)
      return Promise.resolve()
    },
    append: (path, value) => {
      files.set(path, `${files.get(path) ?? ''}${JSON.stringify(value)}\n`)
      return Promise.resolve()
    },
    extract: (job) => {
      if (leased) return Promise.resolve(false)
      jobs.push(job)
      return Promise.resolve(true)
    },
    jev: (body, timeout, key) => {
      requests.push({ body, timeout, key })
      return Promise.resolve(
        typeof answer === 'number'
          ? {
              kind: 'answered' as const,
              body: JSON.stringify({ answers: { rule_0: { noul: answer } } }),
              latencyMs: 120,
            }
          : answer,
      )
    },
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      clock += ms
      for (const event of scheduled.filter((item) => item.at <= clock)) {
        scheduled.splice(scheduled.indexOf(event), 1)
        event.action()
      }
      return Promise.resolve()
    },
  }

  return {
    files,
    jobs,
    requests,
    deps,
    state,
    setAnswer: (value) => {
      answer = value
    },
    setLeased: (value) => {
      leased = value
    },
    schedule: (afterMs, action) => {
      scheduled.push({ at: clock + afterMs, action })
    },
    sleeps,
    lines: (path) =>
      (files.get(path) ?? '')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

function context(
  w: World,
  overrides: Partial<HookContext> = {},
  debug = false,
): HookContext {
  return {
    harness: 'codex',
    root: '/repo',
    settings: { options: { ...DEFAULT_OPTIONS, debug } },
    apiKey: 'fixture-key',
    state: w.state,
    ...overrides,
  }
}

type StopHook = Extract<Hook, { hook_event_name: 'Stop' }>

function stop(turn = 't1', active = false, session = 's1'): StopHook {
  return {
    hook_event_name: 'Stop',
    cwd: '/repo',
    session_id: session,
    turn_id: turn,
    stop_hook_active: active,
    last_assistant_message: reply,
  }
}

const start: Hook = {
  hook_event_name: 'SessionStart',
  cwd: '/repo',
  session_id: 's1',
  model: 'fixture-model',
}

/** Runs SessionStart, then publishes the extraction result the job asked for. */
async function warm(w: World, ctx = context(w)): Promise<Extraction> {
  await checkHook(start, ctx, w.deps)
  const job = w.jobs.at(-1)
  if (job === undefined) throw new Error('no extraction job')
  w.files.set(job.cachePath, JSON.stringify({ hash: job.hash, rules }))

  return job
}

describe('prose-check command adapters', () => {
  it('warms rules without calling Jev and invalidates the source hash after an edit', async () => {
    const w = await world()
    const first = await warm(w)
    expect(first).toEqual(
      expect.objectContaining({
        harness: 'codex',
        root: '/repo',
        model: 'fixture-model',
        statusPath: w.state.extraction,
      }),
    )
    expect(first.cachePath.startsWith(`${w.state.rules}/`)).toBe(true)
    expect(first.prompt).toContain('fixture instructions')
    expect(w.requests).toHaveLength(0)
    w.files.set('/repo/AGENTS.md', 'different fixture instructions')
    expect(await checkHook(stop(), context(w), w.deps)).toEqual({})
    expect(w.jobs).toHaveLength(2)
    expect(w.jobs[1]?.hash).not.toBe(first.hash)
    expect(w.requests).toHaveLength(0)
  })

  it('requests one rewrite, warns after another breach, and resets for the next human turn', async () => {
    const w = await world()
    await warm(w)
    expect(await checkHook(stop(), context(w), w.deps)).toEqual({
      decision: 'block',
      reason: rewriteRequest(rules),
    })
    expect(await checkHook(stop('t2', true), context(w), w.deps)).toEqual({
      systemMessage: warning(['fixture rule'], 'Codex'),
    })
    expect((await checkHook(stop('t3'), context(w), w.deps)).decision).toBe(
      'block',
    )
    expect(w.requests[0]?.timeout).toBe(300)
    expect(w.requests[0]?.key).toBe('fixture-key')
    expect(JSON.parse(w.requests[0]?.body ?? '{}')).toMatchObject({
      state: { response: reply },
      questions: { rule_0: { type: 'noul' } },
    })
  })

  it('returns the Muse warning as systemMessage, naming Muse', async () => {
    const w = await world()
    const ctx = context(w, { harness: 'muse' })
    await warm(w, ctx)
    await checkHook(stop(), ctx, w.deps)
    expect(await checkHook(stop('t1', true), ctx, w.deps)).toEqual({
      systemMessage: warning(['fixture rule'], 'Muse'),
    })
  })

  it('returns the Codex warning as systemMessage only', async () => {
    const w = await world()
    await warm(w)
    await checkHook(stop(), context(w), w.deps)
    expect(await checkHook(stop('t1', true), context(w), w.deps)).toEqual({
      systemMessage: warning(['fixture rule'], 'Codex'),
    })
  })

  it('does not consume the rewrite allowance when another hook continued the turn', async () => {
    const w = await world()
    await warm(w)
    expect((await checkHook(stop('t1', true), context(w), w.deps)).decision).toBe(
      'block',
    )
    w.setAnswer(0)
    expect(await checkHook(stop('t1', true), context(w), w.deps)).toEqual({})
  })

  it('resets the allowance when a new human turn first ends with a skipped reply', async () => {
    const w = await world()
    await warm(w)
    await checkHook(stop('t1'), context(w), w.deps)
    await checkHook(
      { ...stop('t2'), last_assistant_message: 'short' },
      context(w),
      w.deps,
    )
    expect((await checkHook(stop('t2', true), context(w), w.deps)).decision).toBe(
      'block',
    )
  })

  it('keeps independent rewrite state for concurrent sessions', async () => {
    const w = await world()
    await warm(w)
    await checkHook(stop(), context(w), w.deps)
    expect(
      (await checkHook(stop('t1', false, 's2'), context(w), w.deps)).decision,
    ).toBe('block')
  })

  it('uses the inclusive threshold and passes compliant replies', async () => {
    const w = await world()
    await warm(w)
    w.setAnswer(0.849)
    expect(await checkHook(stop(), context(w), w.deps)).toEqual({})
    w.setAnswer(0.85)
    expect((await checkHook(stop(), context(w), w.deps)).decision).toBe('block')
  })

  it('skips short replies, missing credentials, and empty rules without a Jev call', async () => {
    const w = await world()
    const job = await warm(w)
    await checkHook(
      { ...stop(), last_assistant_message: 'short' },
      context(w),
      w.deps,
    )
    await checkHook(stop(), context(w, { apiKey: undefined }), w.deps)
    w.files.set(job.cachePath, JSON.stringify({ hash: job.hash, rules: [] }))
    await checkHook(stop(), context(w), w.deps)
    expect(w.requests).toHaveLength(0)
    expect(
      w.lines(w.state.metrics).filter((line) => line.event === 'check').map((line) => line.reason),
    ).toEqual(['short-reply', 'no-api-key', 'no-rules'])
  })

  it('passes through Jev timeouts, errors, and unusable answers', async () => {
    const w = await world()
    await warm(w)
    const answers: JevAnswer[] = [
      { kind: 'timeout', latencyMs: 300 },
      { kind: 'error', detail: 'HTTP 429', latencyMs: 40 },
      { kind: 'answered', body: 'invalid JSON', latencyMs: 50 },
      { kind: 'answered', body: '{}', latencyMs: 50 },
    ]
    for (const answer of answers) {
      w.setAnswer(answer)
      expect(await checkHook(stop(), context(w, {}, true), w.deps)).toEqual({})
    }
    expect(
      w
        .lines(w.state.debug)
        .filter((line) => line.type === 'check')
        .map((line) => [line.reason, line.detail ?? null, line.latencyMs]),
    ).toEqual([
      ['jev-timeout', null, 300],
      ['jev-error', 'HTTP 429', 40],
      ['jev-error', "Jev's response lacks a probability for every rule", 50],
      ['jev-error', "Jev's response lacks a probability for every rule", 50],
    ])
  })

  it('lets every reply finish unchecked when the settings are invalid or HOME is unset', async () => {
    const w = await world()
    await warm(w)
    expect(
      await checkHook(
        stop(),
        context(w, { settings: { error: 'timeoutMs must be a positive number' } }),
        w.deps,
      ),
    ).toEqual({})
    expect(await checkHook(stop(), context(w, { state: undefined }), w.deps)).toEqual(
      {},
    )
    expect(w.requests).toHaveLength(0)
  })

  it('lets the reply finish unchecked when storage fails', async () => {
    const w = await world()
    await warm(w)
    const deps = { ...w.deps, write: () => Promise.reject(new Error('disk full')) }
    expect(await checkHook(stop(), context(w), deps)).toEqual({})
  })
})

describe('rule lookup states', () => {
  it('reports pending while an extraction runs and failed after one fails', async () => {
    const w = await world()
    await checkHook(start, context(w, {}, true), w.deps)
    const job = w.jobs[0]
    if (job === undefined) throw new Error('no job')

    // A second session while the first extraction holds the lease.
    w.setLeased(true)
    await checkHook(stop(), context(w, {}, true), w.deps)
    // The extraction fails; the next check starts a new one and reports the failure.
    w.files.set(
      w.state.extraction,
      JSON.stringify({
        hash: job.hash,
        status: 'failed',
        at: '2026-10-08T00:00:00.000Z',
        reason: 'the extraction failed: codex exec did not finish within 300 seconds',
      }),
    )
    w.setLeased(false)
    await checkHook(stop('t2'), context(w, {}, true), w.deps)

    const debug = w.lines(w.state.debug)
    expect(debug.filter((line) => line.type === 'extraction')).toEqual([
      expect.objectContaining({ event: 'start', hash: job.hash, project: '/repo' }),
      expect.objectContaining({ event: 'start', hash: job.hash }),
    ])
    expect(
      debug.filter((line) => line.type === 'check').map((line) => [line.reason, line.detail]),
    ).toEqual([
      ['rules-pending', undefined],
      [
        'extraction-failed',
        'the extraction failed: codex exec did not finish within 300 seconds',
      ],
    ])
    expect(w.jobs).toHaveLength(2)
    expect(w.jobs[1]?.debugPath).toBe(w.state.debug)
  })

  it('reports no rules when the project has no instruction files', async () => {
    const w = await world()
    w.files.delete('/repo/AGENTS.md')
    await checkHook(start, context(w), w.deps)
    await checkHook(stop(), context(w), w.deps)
    expect(w.jobs).toHaveLength(0)
    expect(
      w.lines(w.state.metrics).filter((line) => line.event === 'check').map((line) => line.reason),
    ).toEqual(['no-rules'])
  })
})

describe('waiting for a running extraction', () => {
  it('waits at the Stop event for the extraction, then checks the reply', async () => {
    const w = await world()
    await checkHook(start, context(w), w.deps)
    const job = w.jobs[0]
    if (job === undefined) throw new Error('no job')
    w.setLeased(true)
    w.schedule(20_000, () => {
      w.files.set(job.cachePath, JSON.stringify({ hash: job.hash, rules }))
    })

    expect(await checkHook(stop(), context(w), w.deps)).toEqual({
      decision: 'block',
      reason: rewriteRequest(rules),
    })
    expect(w.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(20_000)
    expect(w.requests).toHaveLength(1)
  })

  it('reports a failure that happens while it waits', async () => {
    const w = await world()
    await checkHook(start, context(w), w.deps)
    const job = w.jobs[0]
    if (job === undefined) throw new Error('no job')
    w.setLeased(true)
    w.schedule(5_000, () => {
      w.files.set(
        w.state.extraction,
        JSON.stringify({
          hash: job.hash,
          status: 'failed',
          at: new Date(w.deps.now()).toISOString(),
          reason: 'the extraction failed: codex exec exited with status 1',
        }),
      )
    })

    expect(await checkHook(stop(), context(w), w.deps)).toEqual({})
    expect(
      w.lines(w.state.metrics).filter((line) => line.event === 'check').map((line) => line.reason),
    ).toEqual(['extraction-failed'])
  })

  it('ignores a failure recorded before it started waiting', async () => {
    const w = await world()
    await checkHook(start, context(w), w.deps)
    const job = w.jobs[0]
    if (job === undefined) throw new Error('no job')
    w.files.set(
      w.state.extraction,
      JSON.stringify({ hash: job.hash, status: 'failed', at: '2020-01-01T00:00:00.000Z' }),
    )
    w.setLeased(true)
    w.schedule(3_000, () => {
      w.files.set(job.cachePath, JSON.stringify({ hash: job.hash, rules }))
    })

    expect((await checkHook(stop(), context(w), w.deps)).decision).toBe('block')
  })

  it('gives up after RULES_WAIT_MS and lets the reply finish unchecked', async () => {
    const w = await world()
    await checkHook(start, context(w), w.deps)
    w.setLeased(true)

    expect(await checkHook(stop(), context(w), w.deps)).toEqual({})
    const waited = w.sleeps.reduce((total, ms) => total + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(RULES_WAIT_MS)
    expect(waited).toBeLessThan(RULES_WAIT_MS + 1_000)
    expect(
      w.lines(w.state.metrics).filter((line) => line.event === 'check').map((line) => line.reason),
    ).toEqual(['rules-pending'])
  })

  it('does not wait at SessionStart', async () => {
    const w = await world()
    await checkHook(start, context(w), w.deps)
    expect(w.sleeps).toEqual([])
  })
})

describe('records', () => {
  it('writes metrics always and debug records only when debug is on', async () => {
    const w = await world()
    await warm(w)
    await checkHook(stop(), context(w), w.deps)
    expect(w.files.has(w.state.debug)).toBe(false)
    expect(w.lines(w.state.metrics)).toEqual([
      { at: 1_700_000_000_000, session: 's1', event: 'session-start' },
      {
        at: 1_700_000_000_000,
        session: 's1',
        event: 'check',
        outcome: 'rewrite-requested',
        latencyMs: 120,
      },
    ])
    expect(JSON.parse(w.files.get(w.state.project) ?? '')).toEqual({ root: '/repo' })
  })

  it('records each completed check with its inputs, result, and effect', async () => {
    const w = await world()
    await warm(w, context(w, {}, true))
    w.setAnswer(0.2)
    await checkHook(stop(), context(w, {}, true), w.deps)
    w.setAnswer(0.9)
    await checkHook(stop('t2'), context(w, {}, true), w.deps)
    await checkHook(stop('t2', true), context(w, {}, true), w.deps)

    const checks = w.lines(w.state.debug).filter((line) => line.type === 'check')
    expect(checks.map((line) => line.outcome)).toEqual([
      'passed',
      'rewrite-requested',
      'warning-shown',
    ])
    expect(checks[1]).toEqual({
      type: 'check',
      at: '2023-11-14T22:13:20.000Z',
      harness: 'codex',
      project: '/repo',
      session: 's1',
      outcome: 'rewrite-requested',
      replyLength: reply.length,
      rules,
      reply,
      probabilities: [{ rule: 'fixture rule', probability: 0.9 }],
      broken: ['fixture rule'],
      threshold: 0.85,
      latencyMs: 120,
      result: { decision: 'block', reason: rewriteRequest(rules) },
    })
    expect(checks[0]?.result).toEqual({})
    expect(checks[2]?.result).toEqual({
      systemMessage: warning(['fixture rule'], 'Codex'),
    })
    expect(w.files.get(w.state.debug)).not.toContain('fixture-key')
  })
})
