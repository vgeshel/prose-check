import type { HttpResponse, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = '/project'
const HOME = '/home/tester'
const CLAUDE = 'Read AGENTS.md first.\n\n@AGENTS.md'
const AGENTS = 'Write in plain language. Do not use metaphors.'
const RULES = [
  {
    rule: 'Do not use metaphors.',
    question: 'Does `response` use a metaphor?',
  },
  {
    rule: 'Write in plain language.',
    question: 'Does `response` use ornate or literary language?',
  },
]
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** Lets the short test replies reach the check; the manifest default skips them. */
const SHORT_REPLIES = { options: { minLength: 1 } }
const DEBUG = { options: { minLength: 1, debug: true } }

type Jev = 'hang' | 'fail' | HttpResponse
interface JevCall {
  url: string
  headers: Record<string, string>
}
interface World {
  clock: MockClock
  extractions: number
  extractionPrompts: string[]
  extractionTimeouts: (number | undefined)[]
  jevBodies: string[]
  jevCalls: JevCall[]
  /** The files the plugin appended lines to, by absolute path. */
  files: Map<string, string>
  setAgents(text: string): void
}
interface WorldOptions {
  extraction?: 'hang' | 'hang-first' | 'invalid' | 'timeout'
  env?: Record<string, string>
  stop?: { block?: string }
  /** The text of CLAUDE.md; the default imports AGENTS.md. */
  claude?: string
}

/** A Jev reply that gives each rule the listed probability of a breach. */
function jevReply(probabilities: readonly number[]): HttpResponse {
  const answers = Object.fromEntries(
    probabilities.map((noul, index) => [
      `rule_${index}`,
      { type: 'noul', noul },
    ]),
  )

  return {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ model: 'jev-1.13.0', answers }),
  }
}

/** Answers the engine calls the plugin makes; `jev` lists Jev's replies in order. */
function world(on: On, jev: readonly Jev[], options: WorldOptions = {}): World {
  const files = new Map<string, string>()
  let agents = AGENTS
  const seen: World = {
    clock: mock.clock(on),
    extractions: 0,
    extractionPrompts: [],
    extractionTimeouts: [],
    jevBodies: [],
    jevCalls: [],
    files,
    setAgents: (text) => {
      agents = text
    },
  }
  const replies = [...jev]

  mock.env(on, options.env ?? { TYPESAFE_API_KEY: 'key', HOME })
  mock.store(on)
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('fs.exists', (_$, e) => ({
    value:
      e.path === `${ROOT}/CLAUDE.md` ||
      e.path === `${ROOT}/AGENTS.md` ||
      files.has(e.path),
  }))
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json'))
      return { value: JSON.stringify({ name: 'prose-check', version: '9.9.9' }) }
    if (e.path === `${ROOT}/CLAUDE.md`) return { value: options.claude ?? CLAUDE }
    if (e.path === `${ROOT}/AGENTS.md`) return { value: agents }

    return { value: files.get(e.path) ?? '' }
  })
  on('process.run', (_$, e) => {
    const path = e.argv.at(-1) ?? ''
    files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', (_$, e) => {
    seen.extractions += 1
    seen.extractionPrompts.push(e.prompt)
    seen.extractionTimeouts.push(e.timeoutMs)
    if (options.extraction === 'timeout')
      return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
    if (
      options.extraction === 'hang' ||
      (options.extraction === 'hang-first' && seen.extractions === 1)
    )
      return new Promise<never>(() => undefined)
    const text =
      options.extraction === 'invalid' ? 'no rules here' : JSON.stringify(RULES)

    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('http.fetch', (_$, e) => {
    seen.jevBodies.push(e.init?.body ?? '')
    seen.jevCalls.push({ url: e.url, headers: e.init?.headers ?? {} })
    const reply = replies.shift() ?? 'hang'
    if (reply === 'fail') return Promise.reject(new Error('network down'))

    return reply === 'hang'
      ? new Promise<never>(() => undefined)
      : { value: reply }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => options.stop ?? {})

  return seen
}

/**
 * Starts a session, which extracts and caches the rules in the background
 * before a test's checks; the clock advance lets the extraction run.
 */
async function warm($: Engine, seen: World): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await seen.clock.advance(0)
}

/** The JSON lines the plugin appended to a state file whose name ends in `name`. */
function lines(seen: World, name: string): Record<string, unknown>[] {
  const entry = [...seen.files.entries()].find(([path]) => path.endsWith(name))

  return (entry?.[1] ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Runs `/prose-check` as the person would type it. */
function statusCommand($: Engine, args = '') {
  return $.command.run({
    command: 'prose-check',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

function checks(seen: World, name: string): Record<string, unknown>[] {
  return lines(seen, name).filter(
    (line) => line.type === 'check' || line.event === 'check',
  )
}

describe('prose-check', () => {
  test('passes a compliant reply through', SHORT_REPLIES, async ($, on) => {
    const seen = world(on, [jevReply([0.1, 0.2])])
    await warm($, seen)
    await $.turn.start({ text: 'hi', turnId: 't1' })

    expect(
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      }),
    ).toEqual({})
    expect(seen.jevBodies).toHaveLength(1)
    const request: unknown = JSON.parse(seen.jevBodies[0] ?? '')
    expect(request).toMatchObject({
      questions: {
        rule_0: { type: 'noul', instructions: RULES[0] },
        rule_1: { type: 'noul', instructions: RULES[1] },
      },
    })
    expect(request).toMatchObject({
      state: {
        response: 'The build passed.',
      },
    })
  })

  test(
    'sends the check to Jev with the API key',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })

      expect(seen.jevCalls).toEqual([
        {
          url: 'https://api.typesafe.ai/v1/systemone',
          headers: expect.objectContaining({ Authorization: 'Bearer key' }),
        },
      ])
    },
  )

  test(
    'extracts the rules from the text of CLAUDE.md and AGENTS.md',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })

      expect(seen.extractionPrompts).toHaveLength(1)
      expect(seen.extractionPrompts[0]).toContain(CLAUDE)
      expect(seen.extractionPrompts[0]).toContain(AGENTS)
    },
  )

  test(
    'asks for one rewrite, then passes the reply with a warning',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1]), jevReply([0.95, 0.9])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      const first = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(first.block).toContain('- Do not use metaphors.')
      expect(first.block).not.toContain('Write in plain language.')

      const second = await $.classic.Stop({
        stop_hook_active: true,
        last_assistant_message: 'The fix is a beacon.',
      })
      expect(second.block).toBeUndefined()

      const completed = await $.turn.complete({
        answer: 'The fix is a beacon.',
        durationMs: 1,
        isAborted: false,
        turnId: 't1',
        reason: 'answer',
      })
      expect(completed.text).toContain('Warning from prose-check')
      expect(completed.text).toContain(
        '- Do not use metaphors.\n- Write in plain language.',
      )
    },
  )

  test(
    'shows no warning when the rewrite complies',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1]), jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      await $.classic.Stop({
        stop_hook_active: true,
        last_assistant_message: 'The fix adds a null check.',
      })

      const completed = await $.turn.complete({
        answer: 'The fix adds a null check.',
        durationMs: 1,
        isAborted: false,
        turnId: 't1',
        reason: 'answer',
      })
      expect(completed.text).toBe('The fix adds a null check.')
    },
  )

  test(
    'starts each turn with a fresh rewrite allowance',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1]), jevReply([0.9, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'one', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A lighthouse.',
      })
      await $.turn.start({ text: 'two', turnId: 't2' })

      const next = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A beacon.',
      })
      expect(next.block).toContain('- Do not use metaphors.')
    },
  )

  test(
    'passes the reply through when Jev does not answer in time',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, ['hang'])
      const { clock } = seen
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      let isSettled = false
      const stopped = $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A lighthouse.',
      })
      void stopped.then(() => {
        isSettled = true
      })
      await clock.advance(299)
      expect(isSettled).toBe(false)

      await clock.advance(1)
      expect(await stopped).toEqual({})
    },
  )

  for (const status of [401, 402, 429, 500, 529]) {
    test(
      `passes the reply through on HTTP ${status}`,
      SHORT_REPLIES,
      async ($, on) => {
        const seen = world(on, [
          { status, ok: false, headers: {}, text: '{"error":"no"}' },
        ])
        await warm($, seen)
        await $.turn.start({ text: 'hi', turnId: 't1' })

        expect(
          await $.classic.Stop({
            stop_hook_active: false,
            last_assistant_message: 'A lighthouse.',
          }),
        ).toEqual({})
      },
    )
  }

  test('does nothing without an API key', SHORT_REPLIES, async ($, on) => {
    const seen = world(on, [jevReply([0.9, 0.9])], { env: { HOME } })
    await warm($, seen)
    await $.turn.start({ text: 'hi', turnId: 't1' })

    expect(
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A lighthouse.',
      }),
    ).toEqual({})
    expect(seen.jevBodies).toHaveLength(0)
  })

  test(
    'extracts the rules once and reuses them',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1]), jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'First.',
      })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'Second.',
      })

      expect(seen.extractions).toBe(1)
      expect(seen.jevBodies).toHaveLength(2)
    },
  )

  test(
    'leaves a block from another Stop hook alone',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.9])], {
        stop: { block: 'push first' },
      })
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      expect(
        await $.classic.Stop({
          stop_hook_active: false,
          last_assistant_message: 'A lighthouse.',
        }),
      ).toEqual({
        block: 'push first',
      })
      expect(seen.jevBodies).toHaveLength(0)
    },
  )

  test('skips replies shorter than the default minimum length', async ($, on) => {
    const seen = world(on, [jevReply([0.9, 0.9]), jevReply([0.9, 0.9])])
    await warm($, seen)
    await $.turn.start({ text: 'hi', turnId: 't1' })

    const short = await $.classic.Stop({
      stop_hook_active: false,
      last_assistant_message: 'x'.repeat(199),
    })
    expect(short).toEqual({})
    expect(seen.jevCalls).toHaveLength(0)

    const long = await $.classic.Stop({
      stop_hook_active: false,
      last_assistant_message: 'x'.repeat(200),
    })
    expect(long.block).toContain('- Do not use metaphors.')
    expect(seen.jevCalls).toHaveLength(1)
  })

  test(
    'tells Jev that non-narrative content follows the rules',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })

      const request: unknown = JSON.parse(seen.jevBodies[0] ?? '')
      expect(request).toMatchObject({
        questions: {
          rule_0: { instructions: { scope: expect.any(String) } },
          rule_1: { instructions: { scope: expect.any(String) } },
        },
      })
    },
  )

  test(
    'counts a rule as broken at 0.85 by default',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.84, 0.85])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      const stopped = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(stopped.block).toContain('- Write in plain language.')
      expect(stopped.block).not.toContain('Do not use metaphors.')
    },
  )

  test(
    'uses the configured breach threshold',
    { options: { minLength: 1, breachThreshold: 0.5 } },
    async ($, on) => {
      const seen = world(on, [jevReply([0.5, 0.49])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      const stopped = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(stopped.block).toContain('- Do not use metaphors.')
      expect(stopped.block).not.toContain('Write in plain language.')
    },
  )

  test(
    'waits at the Stop event for the rules, then checks the reply',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1])])
      await $.turn.start({ text: 'hi', turnId: 't1' })

      const stopped = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(stopped.block).toContain('- Do not use metaphors.')
      expect(seen.extractions).toBe(1)
      expect(seen.jevCalls).toHaveLength(1)
    },
  )

  test(
    'runs its own extraction when the session-start one is still running',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1])], { extraction: 'hang-first' })
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })

      const stopped = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(stopped.block).toContain('- Do not use metaphors.')
      expect(seen.extractions).toBe(2)
    },
  )

  test(
    'lets the reply finish unchecked when the extraction does not finish in 300 seconds',
    DEBUG,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.9])], { extraction: 'timeout' })
      const stopped = await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      expect(stopped).toEqual({})
      expect(seen.extractionTimeouts).toEqual([300_000])
      expect(seen.jevCalls).toHaveLength(0)
      expect(
        checks(seen, '/debug.jsonl').map((record) => [record.reason, record.detail]),
      ).toEqual([['extraction-failed', 'the model did not answer (aborted)']])
    },
  )

  test(
    'reads only CLAUDE.md when it does not import AGENTS.md',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1])], { claude: 'Be brief.' })
      await warm($, seen)

      expect(seen.extractionPrompts[0]).toContain('Be brief.')
      expect(seen.extractionPrompts[0]).not.toContain(AGENTS)
    },
  )
})

describe('prose-check debug records and metrics', () => {
  test(
    'writes no debug records when debug is off, and metrics always',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1])])
      await warm($, seen)
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })

      expect(lines(seen, '/debug.jsonl')).toEqual([])
      expect(checks(seen, '/metrics.jsonl').map((line) => line.outcome)).toEqual(
        ['passed'],
      )
    },
  )

  test(
    'records the extraction and a passed check with its inputs and result',
    DEBUG,
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.2])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })

      const records = lines(seen, '/debug.jsonl')
      const path = [...seen.files.keys()].find((key) =>
        key.endsWith('/debug.jsonl'),
      )
      expect(path).toMatch(
        /^\/home\/tester\/\.local\/state\/prose-check\/claude\/project-[0-9a-f]{16}\/debug\.jsonl$/,
      )
      expect(records.filter((record) => record.type === 'extraction')).toEqual([
        expect.objectContaining({ event: 'start', project: ROOT }),
        expect.objectContaining({ event: 'success', ruleCount: 2 }),
      ])
      expect(records.at(-1)).toEqual(
        expect.objectContaining({
          type: 'check',
          outcome: 'passed',
          session: 'session-1',
          rules: RULES,
          reply: 'The build passed.',
          probabilities: [
            { rule: RULES[0]?.rule, probability: 0.1 },
            { rule: RULES[1]?.rule, probability: 0.2 },
          ],
          broken: [],
          threshold: 0.85,
          latencyMs: 0,
        }),
      )
      expect(JSON.stringify(records)).not.toContain('"key"')
    },
  )

  test(
    'records a rewrite request and then a warning',
    DEBUG,
    async ($, on) => {
      const seen = world(on, [jevReply([0.9, 0.1]), jevReply([0.9, 0.9])])
      await warm($, seen)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The fix is a lighthouse.',
      })
      await $.classic.Stop({
        stop_hook_active: true,
        last_assistant_message: 'The fix is a beacon.',
      })

      const records = checks(seen, '/debug.jsonl')
      expect(records).toEqual([
        expect.objectContaining({
          outcome: 'rewrite-requested',
          broken: ['Do not use metaphors.'],
        }),
        expect.objectContaining({
          outcome: 'warning-shown',
          broken: ['Do not use metaphors.', 'Write in plain language.'],
        }),
      ])
    },
  )

  test(
    'records the reason for each skipped check',
    DEBUG,
    async ($, on) => {
      const seen = world(on, [
        'hang',
        { status: 429, ok: false, headers: {}, text: '' },
        'fail',
        { status: 200, ok: true, headers: {}, text: '{}' },
      ])
      await warm($, seen)
      const stop = (message: string) =>
        $.classic.Stop({
          stop_hook_active: false,
          last_assistant_message: message,
        })
      const timedOut = stop('A lighthouse.')
      await seen.clock.advance(300)
      await timedOut
      await stop('A lighthouse.')
      await stop('A lighthouse.')
      await stop('A lighthouse.')

      expect(
        checks(seen, '/debug.jsonl').map((record) => [
          record.reason,
          record.detail,
        ]),
      ).toEqual([
        ['jev-timeout', undefined],
        ['jev-error', 'HTTP 429'],
        ['jev-error', expect.stringMatching(/^request failed: /)],
        ['jev-error', "Jev's response lacks a probability for every rule"],
      ])
      expect(checks(seen, '/debug.jsonl')[0]).toEqual(
        expect.objectContaining({ outcome: 'skipped', latencyMs: 300 }),
      )
    },
  )

  test(
    'records short replies and a missing API key as skips',
    { options: { debug: true } },
    async ($, on) => {
      const seen = world(on, [], { env: { HOME } })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'ok',
      })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'x'.repeat(200),
      })

      expect(
        checks(seen, '/debug.jsonl').map((record) => record.reason),
      ).toEqual(['short-reply', 'no-api-key'])
    },
  )

  test(
    'reports a failed extraction at once and retries it in the background',
    DEBUG,
    async ($, on) => {
      const seen = world(on, [], { extraction: 'invalid' })
      await warm($, seen)
      expect(seen.extractions).toBe(1)
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A lighthouse.',
      })
      // The check does not wait on a new extraction after a failed one.
      expect(seen.extractions).toBe(1)
      await seen.clock.advance(0)

      const records = lines(seen, '/debug.jsonl')
      expect(
        records
          .filter((record) => record.type === 'extraction')
          .map((record) => record.event),
      ).toEqual(['start', 'failure', 'start', 'failure'])
      expect(records.find((record) => record.event === 'failure')).toEqual(
        expect.objectContaining({
          reason: "the model's reply is not a JSON array of valid rules",
        }),
      )
      expect(checks(seen, '/debug.jsonl').map((record) => record.reason)).toEqual(
        ['extraction-failed'],
      )
      expect(seen.extractions).toBe(2)
    },
  )

  test('records another Stop hook continuing the turn', DEBUG, async ($, on) => {
    const seen = world(on, [], { stop: { block: 'push first' } })
    await $.classic.Stop({
      stop_hook_active: false,
      last_assistant_message: 'A lighthouse.',
    })

    expect(checks(seen, '/debug.jsonl').map((record) => record.reason)).toEqual(
      ['other-hook-continued'],
    )
  })
})

describe('/prose-check', () => {
  test(
    'shows the settings, the key, the cache, and the metrics',
    { options: { minLength: 1, timeoutMs: 1000 } },
    async ($, on) => {
      const seen = world(on, [jevReply([0.1, 0.1]), jevReply([0.9, 0.1])])
      await warm($, seen)
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'The build passed.',
      })
      await $.classic.Stop({
        stop_hook_active: false,
        last_assistant_message: 'A lighthouse.',
      })

      const json = await statusCommand($, '--json')
      expect(JSON.parse(json.text ?? '')).toEqual(
        expect.objectContaining({
          harness: 'claude',
          version: '9.9.9',
          projectRoot: ROOT,
          settings: {
            timeoutMs: 1000,
            minLength: 1,
            breachThreshold: 0.85,
            debug: false,
          },
          apiKey: { isSet: true, source: 'environment' },
          cache: {
            files: ['CLAUDE.md', 'AGENTS.md'],
            state: 'current',
            ruleCount: 2,
            extracting: false,
          },
          metrics: expect.objectContaining({
            session: 'session-1',
            current: expect.objectContaining({
              checks: 2,
              passes: 1,
              rewrites: 1,
              skips: expect.objectContaining({ 'rules-pending': 0 }),
              averageLatencyMs: 0,
            }),
          }),
        }),
      )
      expect(json.text).not.toContain('"key"')

      const text = await statusCommand($)
      expect(text.text).toContain('Rule cache: 2 rules, matches the current instruction files')
      expect(text.text).toContain('TYPESAFE_API_KEY: set')
    },
  )

  test(
    'reports a cache that does not match the current instruction files',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [])
      await warm($, seen)
      seen.setAgents('Write short sentences.')

      const stale = JSON.parse(
        (await statusCommand($, '--json')).text ??
          '',
      ) as Record<string, unknown>
      expect(stale).toEqual(
        expect.objectContaining({
          cache: expect.objectContaining({ state: 'stale', ruleCount: 2 }),
        }),
      )
    },
  )

  test('reports a missing API key', SHORT_REPLIES, async ($, on) => {
    world(on, [], { env: { HOME } })

    const text = await statusCommand($)
    expect(text.text).toContain(
      'TYPESAFE_API_KEY: not set; replies finish unchecked',
    )
  })

  test(
    'reports the last extraction failure for the current files',
    SHORT_REPLIES,
    async ($, on) => {
      const seen = world(on, [], { extraction: 'invalid' })
      await warm($, seen)

      const status = JSON.parse(
        (await statusCommand($, '--json')).text ??
          '',
      ) as { cache: Record<string, unknown> }
      expect(status.cache).toEqual(
        expect.objectContaining({
          state: 'missing',
          extracting: false,
          lastFailure: expect.objectContaining({
            reason: "the model's reply is not a JSON array of valid rules",
          }),
        }),
      )
    },
  )
})
