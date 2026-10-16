# prose-check

prose-check checks a coding agent's final reply in each turn against the
writing rules in the project instruction file that the agent loads,
`CLAUDE.md` or `AGENTS.md` (see [Instruction files](#instruction-files)). It uses
[TypeSafe Jev](https://docs.typesafe.ai) for the check. When the reply breaks a
rule, the plugin asks the agent to rewrite it once. It works in Claude Code,
Codex, and Muse Code.

- [Requirements](#requirements)
- [Claude Code](#claude-code)
- [Codex](#codex)
- [Muse Code](#muse-code)
- [Settings](#settings)
- [Behavior](#behavior)
- [Debug records](#debug-records)
- [Doctor](#doctor)
- [Status and metrics](#status-and-metrics)
- [State directory](#state-directory)
- [Data and cost](#data-and-cost)
- [Development](#development)

## Requirements

- A TypeSafe API key, in `TYPESAFE_API_KEY`. Jev is TypeSafe's judgment
  model; the plugin sends it one request per checked reply. Each harness
  section says where to put the key.
- For Claude Code: Claude Code with function-hooks support. The plugin was
  tested on Claude Code 2.1.301.
- For Codex and Muse Code: [Bun](https://bun.com), on `PATH` or at
  `~/.bun/bin/bun`, where Bun's installer puts it. The plugin's hooks run its
  TypeScript files with Bun. They import no packages, so you do not run
  `bun install` in the plugin directory. Without Bun, every reply finishes
  unchecked and the session start shows a warning that says so (each
  harness's "Check the setup" section says where). The plugin was tested on
  Codex 0.163.0, Muse Code 1.4.9, and Bun 1.4.3.

The repository is the marketplace for all three harnesses. The marketplace is
named `prose-check`, so the plugin ID is `prose-check@prose-check` everywhere.

## Claude Code

The Claude Code plugin uses Claude Code's function-hooks API, which Claude
Code marks as early access. Its `hooks/hooks.json` names a TypeScript module
instead of shell commands.

### Install on a new machine

```bash
claude plugin marketplace add vgeshel/prose-check
```

```bash
claude plugin install prose-check@prose-check
```

The install command reports that four `userConfig` options are not set. The
plugin then uses the defaults in [Settings](#settings).

Then set the API key (next section) and check the setup:

```bash
claude -p "/prose-check doctor"
```

The command tests the key against Jev and prints `Result: no problems found.`
when the plugin can check replies; otherwise it prints each problem with its
fix and exits 1. [Doctor](#doctor) lists the checks.

### Set the API key

Add the key to the `env` block of your user settings, `~/.claude/settings.json`.
Claude Code passes that block to the plugin's environment in every session:

```json
{
  "env": { "TYPESAFE_API_KEY": "<your key>" }
}
```

A `TYPESAFE_API_KEY` exported in the shell that starts Claude Code works too.

When the key is missing, or Jev rejects it with HTTP 401 or 403, the plugin
adds a line to the transcript when the session starts:

```text
prose-check: Jev rejected TYPESAFE_API_KEY with HTTP 401, so replies go unchecked. Run /prose-check doctor for the fix.
```

`claude -p` does not show that line; run `claude -p "/prose-check doctor"`
instead.

### Enable it for everyone who works in a repository

Commit this `.claude/settings.json` in the repository:

```json
{
  "extraKnownMarketplaces": {
    "prose-check": {
      "source": { "source": "github", "repo": "vgeshel/prose-check" }
    }
  },
  "enabledPlugins": { "prose-check@prose-check": true }
}
```

Each team member then:

1. Sets the API key as in [Set the API key](#set-the-api-key).
2. Removes any earlier copy of prose-check that they installed from another
   marketplace, by removing that marketplace:

   ```bash
   claude plugin marketplace remove <marketplace>
   ```

3. Starts `claude` in the repository. In a checkout they have not opened in
   Claude Code before, they answer "Yes, I trust this folder". Claude Code
   then adds the marketplace and loads the plugin in that session.
4. Runs `/prose-check doctor` to confirm that the plugin is loaded and can
   check replies (see [Doctor](#doctor)).

In a checkout that the member trusted before the repository enabled
prose-check, Claude Code does not install the plugin, so `/prose-check` is an
unknown command. The member installs the plugin once,
from the `/plugin` menu or with this command, then starts a new session:

```bash
claude plugin install prose-check@prose-check --scope project
```

That command also rewrites the repository's `.claude/settings.json`: it moves
the two prose-check keys to the end of the file without changing their values.
Restore the file so the checkout stays clean; the install stays in place:

```bash
git checkout -- .claude/settings.json
```

### Confirm that it is running

Run `/prose-check` in a session. It prints the status view described in
[Status and metrics](#status-and-metrics). The plugin extracts the rules in
the background when a session starts, which takes about 10 seconds. The
plugin is loaded and has the rules when the view shows lines like these:

```text
prose-check: prose-check 0.4.0 (claude)
TYPESAFE_API_KEY: set (from environment)
Rule cache: 12 rules, matches the current instruction files
```

`claude -p "/prose-check"` prints the same view without starting an
interactive session. `/prose-check --json` prints it as JSON. The other
states the view can show are listed under
[Status and metrics](#status-and-metrics).

### Update and uninstall

```bash
claude plugin marketplace update prose-check
```

```bash
claude plugin update prose-check@prose-check
```

Start a new session, or run `/reload-plugins`, to use the new version.

```bash
claude plugin uninstall prose-check@prose-check
```

Uninstalling leaves the `env` key, the `pluginConfigs` entry, and the
[state directory](#state-directory). Remove them by hand if you no longer
need them.

## Codex

### Install on a new machine

```bash
codex plugin marketplace add vgeshel/prose-check
```

```bash
codex plugin add prose-check@prose-check
```

Installing does not trust the plugin's hooks. Codex skips them until you
trust them:

1. Start `codex` in a project.
2. If Codex asks whether to trust the folder, choose "Trust and continue".
3. Codex shows "Hooks need review". Choose "Review hooks". You can also open
   the same view later with the `/hooks` command.
4. Press `t` to trust all hooks. The SessionStart and Stop rows then show `1`
   in the Active column.
5. Press `Esc` and quit Codex. The hooks run from the next session on.

Codex stores the trust in `~/.codex/config.toml`, keyed by each hook's hash.
An update that changes a hook requires trusting it again.

### Set the API key

Put the key in the project root's `.env.local`, and keep that file out of Git:

```text
TYPESAFE_API_KEY=<your key>
```

An exported `TYPESAFE_API_KEY` overrides `.env.local`: Codex passes the
shell's environment to hooks, and the plugin reads its environment first.

### Check the setup

Start a new `codex` session in the project, send one prompt, and quit. The
plugin's SessionStart hook runs when you send the first prompt and installs
the doctor command. Then run, in the project directory:

```bash
~/.local/state/prose-check/bin/prose-check doctor codex
```

It prints `Result: no problems found.` when the plugin can check replies;
otherwise it prints each problem with its fix and exits 1. [Doctor](#doctor)
lists the checks. If the shell reports `no such file or directory`, the hooks
have not run: trust them as in steps 1–5 above and send a prompt in a new
session.

When the key is missing, Jev rejects it with HTTP 401 or 403, or Bun cannot
be found, the SessionStart hook returns a warning as its `systemMessage`.
Codex 0.163.0 shows it in the transcript above the first reply, as a line that
starts with `Hook · prose-check:`. `codex exec` does not show it; run the
doctor command instead.

### Enable it for everyone who works in a repository

Commit this entry in the repository's `.codex/config.toml`:

```toml
[plugins."prose-check@prose-check"]
enabled = true
```

The entry enables the plugin in that repository even when a member's
`~/.codex/config.toml` disables it. Codex does not install a plugin from
project configuration, so each team member still runs the two install
commands, trusts the hooks as in steps 1–5 above, and sets the API key.

### Confirm that it is running

Run the status command in the project directory:

```bash
~/.local/state/prose-check/bin/prose-check status codex
```

Codex runs the plugin's SessionStart hook when you send the first prompt of
a session, not when the session opens. That hook installs the status command
and starts the rule extraction, which takes about 20 seconds. So the command
exists only after you have sent one prompt in a Codex session that started
after you trusted the hooks. In a new project, the first reply waits for the
extraction before Codex shows it (see [Behavior](#behavior)). The plugin is
loaded and has the rules when the view shows lines like these:

```text
prose-check 0.4.0 (codex)
TYPESAFE_API_KEY: set (from .env.local)
Instruction files: AGENTS.md
Rule cache: 14 rules, matches the current instruction files
```

Add `--json` for JSON output. The other states the view can show are listed
under [Status and metrics](#status-and-metrics).

### Update and uninstall

```bash
codex plugin marketplace upgrade prose-check
```

```bash
codex plugin add prose-check@prose-check
```

If Codex shows "Hooks need review" in the next session, the update changed a
hook; repeat steps 3–5 of the install.

```bash
codex plugin remove prose-check@prose-check
```

Uninstalling leaves `.env.local`, `.prose-check.json`, and the
[state directory](#state-directory).

## Muse Code

### Install on a new machine

```bash
muse plugins marketplace add prose-check vgeshel/prose-check
```

```bash
muse plugins install prose-check@prose-check
```

```bash
muse plugins inspect prose-check
```

```bash
muse plugins approve prose-check
```

`install` prints a `multiple-manifests` warning: the repository holds a
manifest for each harness, and Muse Code reports that it selected
`.muse-plugin/plugin.json` and ignored the other two. That is the intended
result. `inspect` lists the two hooks, `warm-rules` and `check-reply`, with
`status=review_needed`. They run after `approve`.

### Set the API key

Put the key in the project root's `.env.local`, and keep that file out of Git:

```text
TYPESAFE_API_KEY=<your key>
```

Muse Code runs hooks with a reduced environment that does not include the
shell's variables, so `.env.local` is how the hooks receive the key. It does
pass the `PATH` that `muse` was started with, so the hooks find Bun when it is
on that `PATH` or at `~/.bun/bin/bun`.

### Trust the workspace

When you start `muse` in a project for the first time, choose "Trust and
continue". Muse Code loads the project's `AGENTS.md` only in a trusted
workspace. `muse exec` treats a workspace as untrusted unless you pass
`--trust-workspace`. The plugin's hooks run in both cases and check the reply
against the project's rules, so an agent that never saw the rules gets them
in the rewrite request.

### Enable it for everyone who works in a repository

Muse Code installs marketplace plugins for one user only. Each team member
runs the four install commands above, creates `.env.local`, and checks the
setup as in the next section. Commit a `.prose-check.json` if the repository
needs settings other than the defaults.

### Check the setup

Start a new `muse` session in the project, send one prompt, and quit. The
plugin's SessionStart hook runs when you send the first prompt and installs
the doctor command. Then run, in the project directory:

```bash
~/.local/state/prose-check/bin/prose-check doctor muse
```

It prints `Result: no problems found.` when the plugin can check replies;
otherwise it prints each problem with its fix and exits 1. [Doctor](#doctor)
lists the checks. If the shell reports `no such file or directory`, the hooks
have not run: `muse plugins inspect prose-check` must show both hooks with
`trusted_enabled`; run `muse plugins approve prose-check` if it does not, and
send a prompt in a new session.

When the key is missing, Jev rejects it with HTTP 401 or 403, or Bun cannot
be found, the SessionStart hook returns a warning as its `systemMessage`.
Muse Code 1.4.9 shows it at the right end of the footer line, as
`Hook · SessionStart · prose-check: ...`, for about five seconds after you send
the first prompt, or until the turn ends if that is sooner. `muse exec` does
not show it. No other hook output stays on screen longer: plain output and
`additionalContext` go only to the model, and a failing hook's standard error
shows in the same footer for the same time. So run the doctor command after
you install the plugin or change the key. Muse Code also records the warning
in the session log under `~/.local/share/muse/sessions/`, as the
`system_message` of a `hook_run_terminal` event.

### Confirm that it is running

Run the status command in the project directory:

```bash
~/.local/state/prose-check/bin/prose-check status muse
```

Muse Code runs the plugin's SessionStart hook when you send the first prompt
of a session, not when the session opens. So the command exists only after
you have sent one prompt in a session with approved hooks. Rule extraction
takes two to three minutes, and in a new project the first reply waits for it
(see [Behavior](#behavior)). The plugin is loaded and has the rules when the
view shows lines like these (other states are listed under
[Status and metrics](#status-and-metrics)):

```text
prose-check 0.4.0 (muse)
TYPESAFE_API_KEY: set (from .env.local)
Instruction files: AGENTS.md
Rule cache: 10 rules, matches the current instruction files
```

### Update and uninstall

`muse plugins update` does not pick up a refreshed Git marketplace. To
update, remove and reinstall the plugin, then approve its hooks again:

```bash
muse plugins marketplace update prose-check
```

```bash
muse plugins remove prose-check
```

```bash
muse plugins install prose-check@prose-check
```

```bash
muse plugins approve prose-check
```

To uninstall:

```bash
muse plugins remove prose-check --delete-data
```

`--delete-data` deletes Muse Code's data directory for the plugin, which
prose-check does not use. Uninstalling leaves `.env.local`,
`.prose-check.json`, and the [state directory](#state-directory).

## Settings

| Option            | Default | Meaning                                                                    |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `timeoutMs`       | `300`   | Milliseconds to wait for Jev before the turn ends without a check.         |
| `minLength`       | `200`   | Replies with fewer characters than this end the turn without a check.      |
| `breachThreshold` | `0.85`  | Jev's probability, from 0 to 1, at or above which a rule counts as broken. |
| `debug`           | `false` | Writes [debug records](#debug-records).                                    |

**Claude Code** reads the options from the `/config` menu or from
`pluginConfigs` in your user settings, `~/.claude/settings.json`. It does not
read plugin options from a project's settings.

```json
{
  "pluginConfigs": {
    "prose-check@prose-check": { "options": { "timeoutMs": 1000, "debug": true } }
  }
}
```

A plugin loaded with `--plugin-dir` uses the key `prose-check@inline`.

**Codex and Muse Code** read the options from `.prose-check.json` in the
project root:

```json
{ "timeoutMs": 1000, "minLength": 200, "breachThreshold": 0.85, "debug": false }
```

An invalid `.prose-check.json` lets every reply finish unchecked. The status
view names the invalid field.

Apart from the wait for the rule extraction (step 3 under
[Behavior](#behavior)), each check delays the end of the turn by up to
`timeoutMs`. In measurements
in October 2026, Jev answered a 10-to-14-rule check in 100 to 315 ms. With
the 300 ms default, some checks time out. A `timeoutMs` of 1000 covered every
measured request.

## Behavior

1. **Rule extraction.** The plugin reads the instruction files that the
   harness gives its model (see [Instruction files](#instruction-files)). A
   model then extracts the rules for prose addressed to the human. It keeps
   only rules that can be checked from the reply text alone, up to 30 rules.
   Claude Code uses the session's model. Codex and Muse Code run a separate
   `codex exec` or `muse exec` process with the session's model, or with the
   CLI's default when the hook event names none. An extraction that runs
   longer than five minutes fails.

   Codex extracts at medium reasoning effort and Muse Code at high, whatever
   your own CLI setting. On a 30 KB `AGENTS.md`, that took about 20 seconds
   in Codex and 2 to 3 minutes in Muse Code. Muse Code at medium effort took
   20 to 40 seconds but dropped rules such as "prefer short sentences" in 2
   of 5 runs, so the plugin accepts the longer wait. The wait happens once
   per version of the instruction files.
2. **Rule cache.** The cache holds the rules with a SHA-256 hash of the files
   the plugin read. When the hash changes, the plugin extracts the rules
   again. Extraction starts in the background when the session starts. Codex
   and Muse Code run the SessionStart hook when you send the session's first
   prompt, so their extraction starts then.
3. **Waiting for the rules.** When the rules for the current files are not
   cached at the end of a turn, as for the first reply in a new project or
   after an edit to an instruction file, the check waits for the extraction.
   Codex and Muse Code wait for the running extraction for up to 310 seconds.
   In Claude Code, the Stop hook runs the extraction itself and waits for it,
   up to the five-minute extraction limit, because a Claude Code hook cannot
   wait on work that another hook started. When the first reply ends before
   the extraction that session start began has finished, for example in a
   short `claude -p` run, this means a second extraction alongside it. The reply
   appears after the wait. When the extraction fails or does not finish, the
   reply finishes unchecked. After a failed extraction, the next check does
   not wait: it lets the turn end unchecked with the skip reason
   `extraction-failed` and starts a new extraction in the background.
4. **Check.** At the end of each turn, the plugin sends the final reply to Jev
   with one yes/no question per rule. A rule counts as broken when Jev's
   probability of a breach is at least `breachThreshold`. Each question tells
   Jev to judge only narrative prose. Code blocks, inline code, tables,
   command output, logs, file listings, data, and quoted text never count as
   a breach.
5. **Rewrite.** When the reply breaks rules for the first time in a turn, the
   plugin blocks the stop. The block reason lists the broken rules. The agent
   reads it and writes a new reply.
6. **Warning.** When the rewritten reply still breaks rules, the plugin ends
   the turn with a warning that lists the rules the reply still breaks:
   - Claude Code shows it beneath the reply in the interactive transcript.
   - Codex shows the hook's `systemMessage` beneath the reply, as a line that
     starts with `Hook ·`.
   - Muse Code records the hook's `systemMessage` in its session log under
     `~/.local/share/muse/sessions/`. Muse Code 1.4.4 showed it nowhere else.
     Muse Code 1.4.9 shows it at the end of the footer line as
     `Hook · Stop · ...`, but clears it when the turn ends, about 0.2
     seconds later, which is too short to read. It does not appear in
     `muse exec` output or in the `muse exec --json` event stream. In
     practice the warning is visible only in that session log and in the
     status view's `warnings shown` count. Muse Code 1.4.4 also did not show
     a hook's `stopReason`, and its model did not relay a notice that a hook
     asked it to send, so the plugin has no reliable way to show the warning
     to the human.

### Instruction files

The plugin checks a reply against the rules in the project-root instruction
files that the harness itself loads, so that the agent is held only to rules
it was given. The one exception is a Muse Code workspace that you have not
trusted: Muse Code then loads no project rules, and the agent first sees them
in a rewrite request.

| Harness     | Files the plugin reads                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Claude Code | `CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md`, with the files they import with `@path`, up to four hops deep |
| Codex       | `AGENTS.override.md`, or `AGENTS.md` when there is no non-empty override. Codex does not read `CLAUDE.md`, and the plugin follows no imports |
| Muse Code   | `AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`. Muse Code does not follow imports                    |

A repository that serves all three harnesses keeps its rules in `AGENTS.md`
and has `CLAUDE.md` import it with a line `@AGENTS.md`. Then every harness
checks against the same rules.

The plugin reads only the project root. It does not read instruction files in
subdirectories or in your home directory, `CLAUDE.local.md`,
`.claude/CLAUDE.md`, or Codex's `project_doc_fallback_filenames`. It follows
Claude Code's default **Project instructions** setting; if you change that
setting, for example to load both `CLAUDE.md` and `AGENTS.md`, the plugin
still reads the default set. Imports that leave the project root, and imports
inside code spans and fenced code blocks, do not count. A code span that wraps
onto a second line is not recognized, so an import inside it counts.

The plugin lets the turn end without a check in these cases. Each is a skip
reason in the debug records and the metrics:

| Reason                 | Case                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `short-reply`          | The reply is shorter than `minLength` characters.                                                         |
| `no-api-key`           | `TYPESAFE_API_KEY` is not set.                                                                            |
| `no-rules`             | The project has none of the files the harness reads, or they state no writing rules.                      |
| `rules-pending`        | Codex and Muse Code: the extraction did not finish within 310 seconds.                                    |
| `extraction-failed`    | The extraction for the current files failed, or the last one failed and the check started a new one.      |
| `jev-timeout`          | Jev did not answer within `timeoutMs`.                                                                    |
| `jev-error`            | Jev returned a non-2xx status, such as 401, 429, or 529; the request failed; or the response lacks a probability for a rule. |
| `other-hook-continued` | Claude Code only: another Stop hook already blocked the stop. The plugin checks the reply that ends the turn. |

An extraction fails when the model's reply is not a JSON array of valid rules,
when it runs longer than five minutes, or, for Codex and Muse Code, when the
CLI exits with an error.

### Scope

The plugin checks the final text of each main-loop turn: the Stop hook's
`last_assistant_message`. It does not check text that the agent writes between
tool calls, subagent output, or the text of tool calls.

In `claude -p`, `codex exec`, `muse exec`, and the Agent SDK, the rewrite
works the same way, and the result is the rewritten reply. None of them shows
the warning from step 6: `codex exec` logs only `hook: Stop Completed`.

### Codex and Muse Code details

Codex and Muse Code run native command hooks: SessionStart and Stop. Each hook
runs `hooks/codex.sh` or `hooks/muse.sh` from the installed plugin copy, which
runs `adapters/codex.ts` or `adapters/muse.ts` with Bun. The adapters share
the extraction prompt, the Jev request, the parsing, and the messages with
the Claude Code mod. The project root is the Git work tree root of the
session's directory, or that directory outside Git.

- The extraction process runs in an empty temporary directory outside Git.
  The plugin's own hooks do nothing there. An exclusive lease file prevents
  simultaneous sessions from starting the same extraction; a lease older than
  six minutes is replaced.
- The Stop hook may run for up to 320 seconds, so that it can wait for the
  extraction. The SessionStart hook may run for 5 seconds.
- Whether the plugin already requested a rewrite in the current turn is
  stored per session and resets for the next human turn. A continuation that
  another hook requested does not count as the plugin's rewrite request.
- Storage failures and unusable Jev responses let the reply finish unchecked.

## Debug records

With `debug` on, the plugin appends one JSON line per event to `debug.jsonl`
in the project's [state directory](#state-directory). The records never
contain the API key.

- Rule extraction: `{"type": "extraction", "event": "start" | "success" | "failure", ...}`
  with the instruction-file `hash`, `ruleCount` on success, and `reason` on
  failure.
- Each check at the end of a turn: `{"type": "check", "outcome": ...}`, where
  `outcome` is `skipped`, `passed`, `rewrite-requested`, or `warning-shown`.
  - A skipped check has `reason` (from the table above), `detail` for
    `jev-error` and `extraction-failed`, and `latencyMs` for Jev timeouts and
    errors.
  - A completed check has `rules` (the rules sent), `reply` (the reply text),
    `probabilities` (Jev's probability for each rule), `broken` (the rules
    counted as broken), `threshold`, and `latencyMs`.
  - Codex and Muse Code records also have `result`: the exact hook result,
    such as `{"decision": "block", "reason": ...}` or `{"systemMessage": ...}`.

Every record has `at`, `harness`, `project`, and, for checks, `session` and
`replyLength`.

```bash
tail -n 5 ~/.local/state/prose-check/<harness>/*/debug.jsonl
```

## Doctor

The doctor command tests each condition the hooks depend on, prints a fix for
each failure, and exits 1 when any condition fails:

| Harness     | Command, run in the project                                 |
| ----------- | ----------------------------------------------------------- |
| Claude Code | `/prose-check doctor` in a session, or `claude -p "/prose-check doctor"` |
| Codex       | `~/.local/state/prose-check/bin/prose-check doctor codex`   |
| Muse Code   | `~/.local/state/prose-check/bin/prose-check doctor muse`    |

`~/.local/state/prose-check/bin/prose-check doctor claude` runs
`claude -p "/prose-check doctor"`. Add `--json` for JSON output.

| Check               | Passes when                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `Bun`               | Codex and Muse Code: Bun is on `PATH` or at `~/.bun/bin/bun`, where the hook launchers look for it. |
| `TYPESAFE_API_KEY`  | The key is set. The line names its source: the environment or `.env.local`.                       |
| `Jev`               | Jev accepts the key. The command sends one one-question request to `https://api.typesafe.ai/v1/systemone` and waits up to 10 seconds. It reports HTTP 401 or 403 as a rejected key, and another HTTP status, a timeout, and a failed request each as itself. |
| `Hooks`             | Codex and Muse Code: a hook has recorded a session start in this project.                         |
| `Instruction files` | The project root has the instruction files the harness reads (see [Instruction files](#instruction-files)). |
| `Rules`             | The rules for the current instruction files are extracted. An extraction that has not finished is `pending`, which is not a failure. |
| `State directory`   | The plugin can write the project's [state directory](#state-directory).                          |

Each line starts with `ok`, `FAIL`, `pending`, or `skipped`. A failure looks
like this:

```text
FAIL     Jev: rejected the key with HTTP 401
         Fix: The key from .env.local is not a valid TypeSafe API key. Replace it. Set it in the project root's .env.local, or export it in the shell that starts Codex, then start a new session.
```

The doctor command runs in your shell and reads the key the way the hooks
do: for Codex from your shell's environment, then `.env.local`; for Muse Code
from `.env.local` only, because Muse Code does not pass the shell's variables
to hooks.

### Warnings at session start

When a session starts, each harness's hook tests the key: a missing key, or
a key that Jev rejects with HTTP 401 or 403, produces a one-line warning that
names the problem and the doctor command, which prints the fix. Where the
warning appears is described for Claude Code under
[Set the API key](#set-the-api-key) and for Codex and Muse Code in their
"Check the setup" sections. The plugin caches an accepted verdict per key (see
[State directory](#state-directory)), so a working key costs one request the
first time it is used and none after that. A rejected key is tested again at
each session start until it works. A check that gets HTTP 401 or 403 from Jev
clears the accepted verdict, so the next session start tests the key again.
The session-start test waits at most 3 seconds; a timeout or another error
produces no warning.

## Status and metrics

The status view shows:

- the plugin version and the settings in effect;
- whether `TYPESAFE_API_KEY` is set, and where it came from (never its value);
- the instruction files found and the rule cache for the current project: the
  rule count, whether it matches the current instruction files, and whether
  an extraction is running or last failed;
- metrics for the current harness and project, for the current session and
  for all sessions: checks completed, passes, rewrites requested, warnings
  shown, skips by reason, Jev timeouts, Jev errors, and the average Jev
  latency of completed checks. For `jev-error` and `extraction-failed`, the
  skips line adds the cause the last such skip recorded, such as
  `Jev error 22 (latest: HTTP 401)`; the JSON output has it under `details`;
- the state directory and the debug file.

In Claude Code the current session is the session that runs `/prose-check`.
For Codex and Muse Code it is the session that started last in the project;
`--session <id>` selects another.

These lines show a state other than a working plugin:

| Line                                                           | Meaning and action                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY: not set; replies finish unchecked`          | Set the key as the harness section says, then start a new session.                    |
| `Rule cache: no rules cached for the current instruction files` | The extraction has not finished, or has not started. Wait and run the command again.  |
| `Rule cache: N rules, does not match the current instruction files` | The instruction files changed. The next session or check starts a new extraction. |
| `Extraction: running`                                          | Wait and run the command again.                                                        |
| `Extraction: last attempt failed at <time>: <reason>`          | The next session or check retries. A repeated failure names its cause in `<reason>`.  |
| `Settings: invalid (<reason>); replies finish unchecked`       | Fix `.prose-check.json`.                                                               |

The metrics come from `metrics.jsonl` in the state directory, which the plugin
writes whether or not `debug` is on. Each check line records the skip
`reason`, and for `jev-error` and `extraction-failed` also its `detail`, such
as `HTTP 401` or `request failed: ...`, cut to 300 characters. The lines never
hold the request body or the key. Delete the file to reset the metrics.

## State directory

The plugin keeps its per-user state in `~/.local/state/prose-check/`, outside
the project:

```text
~/.local/state/prose-check/
  bin/prose-check                     the status and doctor command
  keys/<key id>.json                  Jev's verdict on one API key
  <harness>/plugin-root               the plugin copy that harness last ran
  <harness>/<project>-<id>/
    debug.jsonl                       debug records
    metrics.jsonl                     one line per session start and per check
    project.json                      the project root
    extraction.json                   Codex and Muse Code: the last extraction's outcome
    rules/<hash>.json                 Codex and Muse Code: the rule cache
    turns/<session hash>.json         Codex and Muse Code: whether a rewrite was requested this turn
```

`<harness>` is `claude`, `codex`, or `muse`. `<project>-<id>` is the project
root's directory name and the first 16 hex digits of the SHA-256 of its path.
`<key id>` is the first 16 hex digits of the SHA-256 of the API key; the file
holds `accepted` or `rejected`, the HTTP status, and the time, never the key.
Delete the `keys` directory to make the next session test the key again.
The plugin ignores `XDG_STATE_HOME`.

Claude Code keeps the rule cache in the plugin's store, a file under
`~/.claude/plugins/store/` whose name starts with `prose-check`. The store
holds the rules of every project. To force a new extraction, delete that file
for Claude Code, which forces it in every project, or delete the project's
`rules` directory and `extraction.json` for Codex and Muse Code.

## Data and cost

- Each check sends the final reply and the rule text to
  `https://api.typesafe.ai/v1/systemone`. A turn makes one Jev request, or
  two when the plugin requests a rewrite.
- The key test at session start and the doctor command send Jev one question
  about the text `ok`. A session start sends it only for a key without an
  accepted verdict.
- Each extraction is one model call with the instruction files as input. It
  normally runs once per version of the instruction files and harness; in
  Claude Code a Stop hook can start a second one (step 3 under
  [Behavior](#behavior)). It counts
  against the harness's model usage. In Claude Code it is capped at 8192
  output tokens.

## Development

```bash
bun install
```

```bash
bun run test
```

`bun run test` runs the Bun unit tests in `tests/unit/` (the Codex and Muse
Code adapters, the shared core, and their process boundaries) and the Claude
Code mod tests in `tests/mod/` through `claude plugin test .`, so it needs
`claude` on `PATH`. The mod tests replace Jev, the session's model, the file
system, the store, and the clock with test doubles.

```bash
bun run validate
```

`bun run validate` runs `claude plugin validate .`, and
`muse plugins validate` on a copy of the tracked files, so it needs `claude`
and `muse`.

```bash
bun run typecheck
```

The mod's type declarations come from Claude Code, which writes them to
`.claude-plugin/types/` each time it loads the plugin from a folder. Load the
plugin once before running `bun run typecheck`:

```bash
claude --plugin-dir . -p /prose-check
```

### Integration suite

```bash
bun run integration
```

The suite installs the plugin from `vgeshel/prose-check` in the real Claude
Code, Codex, and Muse Code CLIs and runs it against the real Jev API. It
installs from the default branch on GitHub, so push a change before you test
it. Set `PROSE_CHECK_SOURCE` to another `owner/repo` to test a fork, and
`PROSE_CHECK_REF` to a branch or tag to install that instead of the default
branch, for example `PROSE_CHECK_REF=my-branch bun run integration`. Each CLI
then adds the marketplace as `owner/repo#ref` (Claude Code, Muse Code) or
`owner/repo@ref` (Codex). Name one or more harnesses to run only those:
`bun run integration claude`.

For each harness, the suite follows this README: it installs from the
marketplace, trusts or approves the hooks the way a person does (driving
`codex` in a terminal for `/hooks`), sets the key, and runs these cases in
the fixture project, whose `CLAUDE.md` imports its `AGENTS.md`:

- the first reply in a new project (in Claude Code, the first reply after an
  edit to `AGENTS.md`), which is checked after the extraction it waits for,
  and the instruction files each harness reads: `CLAUDE.md` and `AGENTS.md`
  for Claude Code, `AGENTS.md` for Codex and Muse Code;
- a reply that passes;
- a reply that breaks a rule and is rewritten, where the final result is the
  rewritten reply;
- a reply that still breaks a rule after the rewrite (with
  `breachThreshold` 0.01): Claude Code's warning in the interactive
  transcript, and the Codex and Muse Code hooks' `systemMessage`;
- the skips for a short reply, a missing API key, and a Jev timeout
  (`timeoutMs` 1);
- the status view and its metrics after these cases;
- the doctor command after the first reply;
- the session-start warning for a rejected key, read from the screen: the
  Claude Code transcript when the session opens, the Codex transcript line
  `Hook · prose-check: ...` after the first prompt, and the Muse Code footer
  after the first prompt; and the doctor command's failure for that key;
- Muse Code only, with Muse Code's `echo` provider in a project without
  instruction files: the session-start warning when Bun is on neither the
  `PATH` that Muse Code passes to hooks nor at `~/.bun/bin/bun`; the hooks
  running Bun from `~/.bun/bin/bun` when it is not on that `PATH`; and the
  warnings for a missing and a rejected key, read from the session log;
- Muse Code only: a rejected key's `HTTP 401` in the metrics, the status
  view, and the doctor command;
- enabling the plugin for a repository with a second, new home directory
  (Claude Code and Codex);
- updating and uninstalling.

It judges each outcome from the plugin's debug records and status output.
The two cases that depend on a model's wording, the pass and the rewrite, may
take a second attempt; the report shows the attempts.

**Requirements:** about 600 MB of free disk space per harness (the suite
stops before it starts when there is less, because the hooks cannot write
their records on a full disk), `claude`, `codex`, and `muse` signed in (the suite copies
`~/.claude/.credentials.json`, `~/.codex/auth.json`, and
`~/.config/muse/auth.json` into its isolated homes), `TYPESAFE_API_KEY`,
`git`, `bun`, and `tmux`. While the repository is private, the suite also
copies `~/.gitconfig` and `~/.config/gh/` so Git can clone it.

**Isolation:** each harness runs with its own `HOME` under the output
directory and an environment that holds only `HOME`, `PATH`, `TERM`, `USER`,
`SHELL`, and `LANG`. Besides the sign-in files, the suite copies the
onboarding and account fields of `~/.claude.json` and
`~/.config/muse/settings.json`. It never changes your own CLI configuration.

On macOS, Claude Code and Muse Code can keep their sign-in in the login
keychain instead of a file: Claude Code when `~/.claude/.credentials.json`
does not exist, Muse Code when `~/.config/muse/auth.json` says
`"storage": "keychain"`. A CLI finds the login keychain through
`$HOME/Library/Keychains`, so an isolated home has none. For such a sign-in
the suite links `~/Library/Keychains` into that harness's sandbox home, and
removes the link when the run ends. While the run lasts, the CLIs in the
sandbox can read and update every item in your login keychain, as they can
outside the suite; a CLI that refreshes its token updates your own sign-in.
A copy of the single sign-in item in a separate keychain did not work:
Claude Code 2.1.301 reported `Not logged in`. On other systems, a Muse Code
`auth.json` that says `"storage": "keychain"` stops the Muse Code flow at
setup.

**Cost per run**, measured on 2026-10-08 at version 0.3.0 with every case
passing on its first attempt:

| Harness     | Sessions with prose-check loaded | Extractions | Jev requests |
| ----------- | -------------------------------- | ----------- | ------------ |
| Claude Code | 13                               | 2           | 7            |
| Codex       | 9                                | 1           | 7            |
| Muse Code   | 8                                | 1           | 7            |

The Claude Code sessions include `claude -p /prose-check` runs and one
interactive team-member session without a prompt; the Codex sessions include
two interactive sessions for hook trust without a prompt.

A case that takes a second attempt adds one session and one or two Jev
requests. The three harnesses run at the same time; the measured run took
5 minutes.

**Output:** `integration/runs/<time>/report.md` lists each step with its
result and evidence. The directory also keeps each harness's home, project,
session logs, and terminal captures.

## Files

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`: the Claude
  Code manifest, its options, and the marketplace.
- `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`: the Codex
  manifest and marketplace. Muse Code reads the same marketplace file.
- `.muse-plugin/plugin.json`: the Muse Code manifest.
- `hooks/register.ts`: the Claude Code mod. `hooks/hooks.json` names it.
- `hooks/codex.json`, `hooks/codex.sh`, `hooks/muse.sh`,
  `hooks/muse-start.sh`, `hooks/run.sh`: the Codex and Muse Code hook
  declarations and launchers. `hooks/run.sh` finds Bun and runs the adapter.
- `core/`: the logic every harness shares: rules, settings, the check,
  records, metrics, the status view, the key test, the doctor report, and the
  state location.
- `adapters/`: the Codex and Muse Code hook commands, the background
  extractor, and the status and doctor commands.
- `bin/prose-check`: the status and doctor commands for a checkout of this
  repository.
- `types/index.d.ts`: the per-turn state that the Claude Code hooks share.
- `tests/`, `integration/`: the tests and the integration suite.

## License

MIT. See [LICENSE](./LICENSE).
