# AGENTS.md

prose-check is a plugin that checks a coding agent's final reply against the
project's writing rules with TypeSafe Jev. It runs in Claude Code (a
function-hooks module, `hooks/register.ts`), Codex, and Muse Code (command
hooks that run `adapters/*.ts` with Bun). `core/` holds the logic all three
share. [README.md](./README.md) is the user documentation and the behavior
contract; its Development section lists the commands and the integration
suite.

Treat `main` as live. The README's install steps add this repository's
default branch as the marketplace, without pinning a commit, so every push to
`main` reaches every user at their next update. Push to `main` only changes
that pass the checks under [Validation and delivery](#validation-and-delivery).

## Writing

These rules apply to the README, code comments, commit messages, and the
plugin's messages to agents and humans.

- Write complete English sentences in a plain, direct style. Prefer short
  sentences. Use active voice.
- Name the thing itself rather than a figure for it: no metaphors, analogies,
  literary phrasing, or invented terminology.
- State specific facts. Name files, paths, commands, versions, and command
  output when those details matter.

## Harness behavior

The three harnesses differ in when hooks run, what they show the human, which
instruction files they load, and how long a hook may run. These facts change
between harness versions.

- Establish each fact from the harness's current documentation and confirm it
  by experiment before the plugin depends on it. Never infer one harness's
  behavior from another's.
- Run experiments in an isolated home directory with only the harness's
  sign-in files copied in, as `integration/lib.ts` does. Leave your own
  `~/.claude`, `~/.codex`, and Muse configuration unchanged. Delete copied
  credentials and API keys when the experiment ends.
- To learn what a harness does with a hook's output, install a throwaway
  plugin whose hook prints the output under test, and observe the
  interactive view, the headless output, and the session log.
- When a problem cannot be fixed inside the plugin, such as a harness that
  does not show a hook's output, document the limitation in the README rather
  than ship a workaround that has not been shown to work.
- Record the harness versions you tested in the README's Requirements
  section.

## Engineering constraints

- The plugin imports no npm packages at run time. `adapters/` may import
  `node:*` built-ins and the plugin's own files. `core/` imports only its
  own files: the Claude Code mod imports `core/` and runs without Node or a
  DOM. `hooks/register.ts` may also import `claude-code`.
- A Claude Code hook has a 10-second budget of its own time; the clock stops
  only while one of the hook's own `$` calls runs (`HookBudget` in the
  `claude-code` type declarations that Claude Code writes to
  `.claude-plugin/types/`). A hook that must wait does the slow work through
  its own `$` call.
- Do not use hardcoded sentences, keyword lists, substring checks, or regular
  expressions to judge the meaning of instructions, replies, or prompts, in
  production code or tests. Jev judges meaning. Regular expressions remain
  allowed for machine formats, such as `@path` import syntax and JSON.
- Work test-first. For a bug, observe a focused regression test fail because
  of the bug before you change the implementation. Unit tests for the
  adapters and core are in `tests/unit/`; Claude Code mod tests are in
  `tests/mod/`.
- A behavior change updates the README in the same commit and raises the
  version in `package.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, and
  `.muse-plugin/plugin.json`. Codex installs each version into its own
  directory (`~/.codex/plugins/cache/prose-check/prose-check/<version>/`), and
  Muse Code picks up a new version only through a reinstall.

## Validation and delivery

- Before every push: `bun run test`, `bun run typecheck`, and
  `bun run validate`, all passing. The README's Development section lists
  their prerequisites.
- Before pushing a change to hook behavior, extraction, or installation to
  `main`: run `bun run integration`. The suite installs the default branch of
  the GitHub repository that `PROSE_CHECK_SOURCE` names
  (`vgeshel/prose-check` by default). To test a change before it reaches
  `main`, push it to the default branch of a fork and name that fork. The
  README's Integration suite section lists the suite's requirements.
- After a change to installation or to what the human sees, test by hand. For
  each harness, create a new project, follow the README's instructions
  literally to install the plugin, and confirm that it checks the prose: a
  reply that breaks a rule is rewritten or warned about.
- Before a code change reaches `main`, have its diff reviewed by a reviewer
  that did not write it, against this file's rules and the README. Evaluate
  each finding by the review rules below and fix the accepted ones.
- Never commit secrets. `TYPESAFE_API_KEY` comes from the environment or a
  project's ignored `.env.local`. Scan the history with `gitleaks git` before
  the repository's visibility changes.

## Review rules

These rules govern every review of this repository and every agent that
evaluates or fixes a finding.

- Decide correctness and materiality separately. Correctness requires a
  violation of a requirement, the README's documented behavior, or a rule in
  this file. Materiality requires a concrete adverse consequence. Report or
  accept a finding only when both hold.
- For a behavioral defect, name the supported caller (a harness event, a
  README command, or a test), the input or starting state, the actual
  result, and the required result. Support it with a reproduction or a code
  trace. Verify the premises: a mock of a harness or of Jev does not prove
  the real one behaves that way.
- Do not report optional cleanup, extra robustness, or future features unless
  the requested scope includes them.
- Verify a diagnosis independently of the suggested repair, and keep the
  repair within the accepted finding. A rejection names the unsupported
  premise, the contradicting evidence, or the scope boundary.

Exclude generated and local output from review: `integration/runs/`,
`node_modules/`, `.claude-plugin/types/`, and `bun.lock`.
