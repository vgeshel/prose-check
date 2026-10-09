/**
 * Pure logic of the prose check: the extraction prompt, the Jev request, and
 * the parsing of both replies. Nothing here touches the engine.
 */

/** One writing rule and the yes/no question that detects a breach of it. */
export interface Rule {
  rule: string
  question: string
}

/** One instruction file, read from the project. */
export interface Source {
  path: string
  text: string
}

/** Rules extracted from one set of sources, keyed by the sources' hash. */
export interface CachedRules {
  hash: string
  rules: Rule[]
}

/** The Jev model alias. */
export const JEV_MODEL = 'jev-latest'

/** The Jev evaluation endpoint. */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/**
 * The default probability at or above which Jev's answer counts as a breach.
 * Calibrated on 109 labeled replies: 0.85 cut needless rewrites from 18 to 1,
 * while the clear-cut rules still score well above it.
 */
export const DEFAULT_BREACH_THRESHOLD = 0.85

/**
 * The longest one rule extraction may run, in every harness. The Codex and
 * Muse Code Stop wait, their hook timeouts, and the extraction lease are set
 * above it.
 */
export const EXTRACTION_TIMEOUT_MS = 300_000

/** The most rules one check asks about. */
const MAX_RULES = 30

/**
 * Removes CommonMark fenced code blocks: a fence of three or more backticks
 * or tildes, indented at most three spaces, closed by a fence of the same
 * character that is at least as long, or by the end of the text.
 */
function withoutFencedBlocks(text: string): string {
  const kept: string[] = []
  let open: { char: string; length: number } | undefined
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const run = fence?.[1] ?? ''
    const rest = fence?.[2] ?? ''
    if (open === undefined) {
      // A backtick fence's info string cannot contain a backtick.
      if (fence !== null && !(run.startsWith('`') && rest.includes('`')))
        open = { char: run.charAt(0), length: run.length }
      else kept.push(line)
    } else if (
      fence !== null &&
      run.charAt(0) === open.char &&
      run.length >= open.length &&
      rest.trim() === ''
    )
      open = undefined
  }

  return kept.join('\n')
}

/**
 * Lists the Markdown files that `text` imports with Claude Code's `@path`
 * syntax, as written. Imports inside fenced code blocks and code spans do not
 * count, as in Claude Code. A code span opens and closes with backtick runs
 * of equal length on one line; a span that wraps onto another line is not
 * recognized. A backtick after an odd number of backslashes is escaped and
 * cannot open a span.
 */
export function importedPaths(text: string): string[] {
  // Normalize CR and CRLF line endings: fences are matched line by line.
  const prose = withoutFencedBlocks(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) =>
      line.replace(/(?<!(?<!\\)\\(?:\\\\)*)(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, ''),
    )
    .join('\n')
  const found = prose.matchAll(/(?:^|\s)@((?:\.{0,2}\/)?[\w./-]+\.md)\b/g)

  return [...new Set([...found].map((match) => match[1] ?? ''))].filter(
    (path) => path !== '',
  )
}

/** Builds the prompt that asks the host model to extract the rules. */
export function extractionPrompt(sources: readonly Source[]): string {
  const files = sources
    .map((source) => `<file path="${source.path}">\n${source.text}\n</file>`)
    .join('\n\n')

  return `The files below are instructions for a coding agent in one software project. Find every rule that governs how the agent writes prose addressed to the human it works with: its chat replies, status updates, and answers.

Return only rules that a reader can check by reading one finished reply, with no other context. Leave out rules about process (for example, which documents to read or which reviews to run), rules about code, and rules that need knowledge of the project or the conversation to check.

For each rule, write two fields:
- "rule": the rule as one self-contained sentence.
- "question": a yes/no question about the reply, which is available as \`response\`. A yes answer must mean that the reply breaks the rule. Ask about one condition only.

Split a compound rule into separate rules when its parts can be broken independently. Do not add rules that the files do not state.

Answer with a JSON array of {"rule": string, "question": string} objects and nothing else. Answer with [] when the files state no such rules.

${files}`
}

/**
 * Parses the host model's extraction reply. Returns undefined when the reply
 * is not a JSON array of rules.
 */
export function parseRules(reply: string): Rule[] | undefined {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end < start) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined

  const rules = parsed.filter(isRule).map((item) => ({
    rule: item.rule.trim(),
    question: item.question.trim(),
  }))

  return rules.length === parsed.length ? rules.slice(0, MAX_RULES) : undefined
}

/** Reads a cached value from the store. Returns undefined for any other shape. */
export function parseCachedRules(value: unknown): CachedRules | undefined {
  if (
    !isRecord(value) ||
    typeof value.hash !== 'string' ||
    !Array.isArray(value.rules)
  )
    return undefined
  if (!value.rules.every(isRule)) return undefined

  return { hash: value.hash, rules: value.rules }
}

/**
 * Limits each question to narrative prose, so that code, tables, and other
 * non-narrative content in a reply never count as a breach.
 */
const NARRATIVE_SCOPE =
  'Judge only the narrative prose in `response`: sentences written to the reader. Code blocks, inline code, tables, command output, logs, file listings, data, and quoted text are not narrative prose. When `response` breaks `rule` only inside such content, or contains no narrative prose, `response` follows `rule`.'

/** The Jev question name for the rule at `index`, in the request and in the reply. */
function questionId(index: number): string {
  return `rule_${index}`
}

/** Builds the Jev request body: one Noul question per rule over the reply. */
export function jevRequest(rules: readonly Rule[], response: string): string {
  const questions = Object.fromEntries(
    rules.map((rule, index) => [
      questionId(index),
      {
        type: 'noul',
        instructions: {
          rule: rule.rule,
          scope: NARRATIVE_SCOPE,
          question: rule.question,
        },
        criteria: {
          true: 'The narrative prose in `response` breaks `rule`.',
          false:
            'The narrative prose in `response` follows `rule`, `rule` does not apply to it, or `response` has no narrative prose.',
        },
      },
    ]),
  )

  return JSON.stringify({ model: JEV_MODEL, state: { response }, questions })
}

/**
 * Parses a Jev reply into Jev's probability of a breach for each rule, in rule
 * order. Returns undefined when the reply lacks an answer for any rule.
 */
export function parseProbabilities(
  rules: readonly Rule[],
  body: string,
): number[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return undefined

  const answers = parsed.answers
  const probabilities: number[] = []
  for (const [index] of rules.entries()) {
    const answer = answers[questionId(index)]
    if (!isRecord(answer) || typeof answer.noul !== 'number') return undefined
    probabilities.push(answer.noul)
  }

  return probabilities
}

/** The rules whose breach probability is at or above `threshold`. */
export function brokenRules(
  rules: readonly Rule[],
  probabilities: readonly number[],
  threshold: number,
): Rule[] {
  return rules.filter((_, index) => (probabilities[index] ?? 0) >= threshold)
}

/**
 * Parses a Jev reply into the rules the reply breaks. Returns undefined when
 * the reply lacks an answer for any rule.
 */
export function parseBreaches(
  rules: readonly Rule[],
  body: string,
  threshold: number,
): Rule[] | undefined {
  const probabilities = parseProbabilities(rules, body)

  return probabilities === undefined
    ? undefined
    : brokenRules(rules, probabilities, threshold)
}

/** The block reason that asks Claude to rewrite its reply. */
export function rewriteRequest(breaches: readonly Rule[]): string {
  return `prose-check: your last reply to the human breaks these project writing rules:
${bulletList(breaches.map((breach) => breach.rule))}

Write the reply again so that it follows these rules. Keep the same facts and conclusions. Do not mention this check.`
}

/** The warning shown beneath a reply that still breaks rules after a rewrite. */
export function warning(rules: readonly string[], agent: string): string {
  return `Warning from prose-check: ${agent} rewrote this reply once and it still breaks these project writing rules:
${bulletList(rules)}`
}

function bulletList(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

export function isRule(value: unknown): value is Rule {
  return (
    isRecord(value) &&
    typeof value.rule === 'string' &&
    value.rule.trim() !== '' &&
    typeof value.question === 'string' &&
    value.question.trim() !== ''
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
