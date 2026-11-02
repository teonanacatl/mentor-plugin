# mentor — a Claude Code plugin that teaches instead of doing

Using an AI assistant can make you faster and, at the same time, worse at programming. In
Anthropic's study on [how AI assistance affects coding skills](https://www.anthropic.com/research/AI-assistance-coding-skills),
the developers who kept learning were the ones who used AI to build understanding: asking
follow-up questions and concepts instead of taking ready-made code.

An output style can ask Claude to work like that, but nothing enforces it, and at 17:45 before a
deadline neither Claude nor you will want to. This plugin adds **hooks**, which Claude Code runs
itself, so the rules hold without anyone's good will.

| Layer | What it does | Enforced by |
| --- | --- | --- |
| Mentor output style | Claude asks, points to files, explains concepts, reviews your code. Applied automatically while the plugin is enabled (`force-for-plugin`). | instruction |
| Edit block | `Edit`, `Write`, `NotebookEdit` on project files are denied. Claude's own files (plans, memory, this plugin's journal) stay writable. | `PreToolUse` hook |
| Shell guard | Shell commands that look like they write files (`>`, `sed -i`, `Set-Content`, `git apply`, `ng g`, `--fix`…) trigger a permission prompt. Best effort. | `PreToolUse` hook |
| Try-first gate | A prompt asking for ready-made code ("napisz…", "write the code…", "fix it") does not reach Claude while the repo shows no attempt of yours. | `UserPromptSubmit` hook |
| Hint ladder | `/mentor:hint` climbs direction → concept → API → sketch, one level per call. The level lives in a state file and goes into context with every prompt. | hook + state file |
| Exit with a cost | `/mentor:off <reason>` lifts everything in this project for 30 min. No reason, no pause. Every pause is logged. | hook |
| Review with your diff | `/mentor:done` hands Claude `git status` and the diff since the task started (commits included), so the senior-style review comes in the first answer. | hook |
| Weekly review | `/mentor:review-week` sums up the log: tasks done alone, work time, hint levels, gate stops, pauses and their reasons, then quizzes you on topics you have not mastered yet (`- [ ] repeat:` items in the journal, ticked off when you get them right). | events log + journal |
| What's new | `/mentor:whats-new` compares the versions in your manifests with the latest releases and turns the changes into exercises on your own code. | skill |

## Install

From GitHub:

```
/plugin marketplace add teonanacatl/mentor-plugin
/plugin install mentor@mentor-plugin
```

Locally, for a single session:

```
claude --plugin-dir ./plugins/mentor
```

Requirements: Claude Code with plugin support and `node` on `PATH` (the hooks are Node scripts,
no other dependencies). `git` for the try-first gate.

**Enable it per project, not globally.** Use mentor mode where you want to grow (a new framework,
a domain you want to own) and normal mode for routine work you already know. Turn it on with
`/plugin` or in the project's `.claude/settings.local.json`:

```json
{ "enabledPlugins": { "mentor@mentor-plugin": true } }
```

## Commands

| Command | |
| --- | --- |
| `/mentor:task <title>` | Start a task: hint level 0, snapshot of the repo state |
| `/mentor:hint [where I'm stuck]` | Next hint level |
| `/mentor:try <what I checked / suspect>` | Describe your own attempt or hypothesis; counts as an attempt for the gate without editing files (debugging, reading unfamiliar code) |
| `/mentor:done [what I learned]` | Close the task, get a senior-style review, write the journal |
| `/mentor:off <reason>` | Pause for `off_minutes` (default 30) |
| `/mentor:on` | End the pause early |
| `/mentor:status` | Mode, task, hint level, file locations |
| `/mentor:review-week [days]` | Review of the log plus a quiz |
| `/mentor:whats-new [package]` | New releases of your stack turned into exercises |

The state-changing commands are handled by the `UserPromptSubmit` hook when **you** type them
(with the `mentor:` prefix). Claude cannot invoke them on its own (`disable-model-invocation`), so
it cannot pause mentor mode for itself.

### How the gate decides that you tried

- With an open task: something in the repo changed since `/mentor:task`: tracked diffs,
  untracked files or a new commit, so committing work in progress still counts. Changes that
  were there before the task do not count.
- A task opened implicitly by `/mentor:hint` or `/mentor:try` on a dirty repo counts the work
  you had already done.
- `/mentor:try <hypothesis>` opens the gate for the task without any file change. It is an
  explicit, logged command on purpose: guessing "I checked… I suspect…" from the wording of
  a prompt would turn the gate into a keyword game and make escapes invisible.
- Without a task: the working tree is not clean.
- Outside a git repository the gate stays open.

The built-in pattern knows Polish word boundaries, so the first person ("napiszę", "poprawię")
passes and only the imperative ("napisz", "popraw") is stopped.

### Work time

`/mentor:done` reports work time, not the time the task was open: each gap between your
prompts counts at most 60 minutes, and paused time does not count. A task left open overnight
adds an hour, not the night.

## Configuration

Asked when you enable the plugin, editable in `/config`:

| Option | Default | |
| --- | --- | --- |
| `language` | `pl` | Language of the hook messages (`pl` or `en`). Claude answers in the language you write in. |
| `off_minutes` | `30` | Length of `/mentor:off` |
| `focus_topics` | empty | Areas you want to grow in, used by the quiz and `whats-new` |
| `bash_guard` | `true` | The shell guard on or off |
| `gate_regex` | empty | Your own regex for "ready-made code" prompts instead of the built-in one |

## Data

Everything stays on your machine, in `~/.claude/plugins/data/mentor-…/`:

- `state.json`: pauses and open tasks, both per project
- `events.jsonl`: the log (task start/end with work time, hints, `/mentor:try` texts, gate stops
  with the first 120 characters of the prompt, blocked edits, pauses with reasons, what's-new checks)
- `LEARNING.md`: the learning journal written by `/mentor:done`, the quiz and `whats-new`

Uninstalling the plugin deletes this directory unless you pass `--keep-data`.

## Using it at work

The plugin is generic and contains nothing about any employer. Project knowledge belongs to the
project: architecture, conventions and the areas you want to learn go into the repo's
`CLAUDE.md` or your own `~/.claude/CLAUDE.md` on the work machine. The plugin uses that context;
it never ships it.

Check `/status` first: if your organisation sets `allowManagedHooksOnly`, plugin hooks do not run
and only the output style and the skills are left. Then add
`"permissions": { "deny": ["Edit", "Write"] }` to `.claude/settings.local.json` as the hard block.
The hint ladder keeps working without the hook: `/mentor:hint` reads the last `Hint N/4` header
from the conversation and goes one level up, or takes the level you give (`/mentor:hint 3 …`).

## Honest limits

- **There is no unbreakable lock, by design.** You can always disable the plugin. The goal is
  friction and visibility of escapes, not a prison. A lock that is too hard gets removed at the
  first deadline.
- **The gate is a regex.** Rephrasing gets around it. That still takes a conscious decision,
  which is the point.
- **The shell guard is a heuristic.** It asks, it does not deny, and it will miss creative
  commands. Keep Bash on normal permission prompts.
- **You will be slower.** That is the price of learning, not a bug.

## Development

CI runs the hook tests on Linux, macOS and Windows with Node 20 and 22.

```
node --test
claude plugin validate ./plugins/mentor
claude plugin validate .
```

## License

MIT
