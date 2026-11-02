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
| Edit block | `Edit`, `Write`, `NotebookEdit` and file-writing MCP tools are denied in the project. Only Claude's plans, todos, memory and the learning journal stay writable. | `PreToolUse` hook |
| Self-protection | Claude cannot change mentor's state, Claude Code's settings files or installed plugins, by any tool, not even during a pause. | `PreToolUse` hook |
| Shell guard | Shell commands that look like they write files (`>`, `sed -i`, `Set-Content`, `git checkout`, `ng g`, `--fix`…) trigger a permission prompt, or are denied. Best effort. | `PreToolUse` hook |
| Try-first gate | A prompt asking for ready-made code ("napisz…", "dokończ…", "write the code…", "fix it") does not reach Claude until you have changed some lines of code yourself. | `UserPromptSubmit` hook |
| Hint ladder | `/mentor:hint` climbs direction → concept → API → sketch, one level per call. The level lives in a state file and goes into context with every prompt. | hook + state file |
| Exit with a cost | `/mentor:off <reason>` lifts the blocks in this project for 30 min. No reason, no pause; from the third pause of a day the reason has to be longer. Every pause is logged. | hook |
| Review with your diff | `/mentor:done` hands Claude the files you changed during the task, new files with their content, so the senior-style review comes in the first answer. | hook |
| Code in chat | A large code block in Claude's answer while mentor mode is on is logged (a hook cannot take back text already shown). | `Stop` hook |
| Weekly review | `/mentor:review-week` sums up the log: tasks done alone, work time, hint levels, gate stops, pauses and escapes, then quizzes you on topics that are due (Leitner boxes in the journal). | events log + journal |
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

**Use it per project, not everywhere.** Mentor mode is for the areas you want to grow in (a new
framework, a domain you want to own); routine work you already know goes in normal mode. Two ways:

- enable the plugin only in the projects you want, with `/plugin` or in the project's
  `.claude/settings.local.json`: `{ "enabledPlugins": { "mentor@mentor-plugin": true } }`;
- or install it globally, set `activation` to `marker`, and turn it on per repo with
  `/mentor:enable` or a `.mentor` file at the repository root. Everywhere else the hooks stay
  quiet and Claude works normally.

## Commands

| Command | |
| --- | --- |
| `/mentor:task <title>` | Start a task: hint level 0, snapshot of the repo state |
| `/mentor:hint [where I'm stuck]` | Next hint level |
| `/mentor:try <what I checked / suspect>` | Describe your own attempt or hypothesis; counts as an attempt for the gate without editing files (debugging, reading unfamiliar code, a one-line fix) |
| `/mentor:done [what I learned]` | Close the task, get a senior-style review, write the journal |
| `/mentor:off <reason>` | Pause for `off_minutes` (default 30) in this project |
| `/mentor:on` | End the pause early |
| `/mentor:enable`, `/mentor:disable` | Turn mentor mode on or off for this repo (with `activation = marker`) |
| `/mentor:status` | Mode, task, hint level, settings, file locations |
| `/mentor:review-week [days]` | Review of the log plus a quiz |
| `/mentor:whats-new [package]` | New releases of your stack turned into exercises |

The state-changing commands are handled by the `UserPromptSubmit` hook when **you** type them
(with the `mentor:` prefix). Claude cannot invoke them on its own (`disable-model-invocation`),
and the self-protection keeps it from editing the state file or the settings instead.

### How the gate decides

**Which prompts.** Imperatives and requests in Polish and English: "napisz", "dokończ",
"stwórz", "rozwiąż", "czy możesz napisać…", "write the function", "add the missing method",
"refactor this", "can you code this up?". Information questions pass: "how do I fix this?",
"czy powinienem dopisać test?", "popraw mnie, jeśli się mylę". The pattern knows Polish word
boundaries, so the first person ("napiszę", "poprawię") passes. Only real slash commands
(`/review …`) skip the gate; `/ napisz to` does not.

**What counts as your attempt.** At least `attempt_min_lines` (default 3) changed lines of code
since the task started, or, without a task, since the session started:

- tracked changes, untracked files and new commits all count, so committing work in progress
  still counts;
- lock files, build output and generated files do not (`dist/`, `build/`, `coverage/`,
  `node_modules/`, `*.log`, `package-lock.json`… plus your own `attempt_ignore`), so a test run
  that writes `coverage.json` does not open the gate;
- changes made before the task or the session do not count: a repo that is always a bit dirty
  is not a permanent pass. If that earlier work is your attempt, say so with `/mentor:try`;
- a task opened implicitly by `/mentor:hint` or `/mentor:try` keeps the session's starting point,
  so what you wrote in this session counts;
- `/mentor:try <hypothesis>` opens the gate for the task without any file change. It is an
  explicit, logged command on purpose: guessing "I checked… I suspect…" from the wording of a
  prompt would turn the gate into a keyword game and make escapes invisible;
- outside a git repository the gate stays open.

The project is the repository root, so a session opened in `repo/src` shares the task and the
pause with one opened in `repo/`.

### Work time

`/mentor:done` reports work time, not the time the task was open: each gap between your
prompts counts at most 60 minutes, and paused time does not count. A task left open overnight
adds an hour, not the night.

### Spaced repetition

`/mentor:done` and `/mentor:whats-new` add topics to the journal as
`- [ ] repeat: <topic> (box 1, due <tomorrow>)`. The weekly quiz asks only about items that are
due; a correct answer moves the item up a box (3, 7, 14, 30 days), a wrong one sends it back to
box 1, and a correct answer from box 5 ticks it off. Session start mentions it when items are due.

## Configuration

Asked when you enable the plugin, editable in `/config`:

| Option | Default | |
| --- | --- | --- |
| `language` | from the system locale | Language of the hook messages (`pl` or `en`). Claude answers in the language you write in. |
| `activation` | `always` | `always`, or `marker`: only in repos with `.mentor` or `/mentor:enable` |
| `off_minutes` | `30` | Length of `/mentor:off` |
| `attempt_min_lines` | `3` | Changed lines of code that count as an attempt |
| `attempt_ignore` | empty | Extra globs that do not count, e.g. `src/generated/, *.snap` |
| `focus_topics` | empty | Areas you want to grow in, used by the quiz and `whats-new` |
| `bash_guard` | `true` | The shell guard on or off |
| `bash_guard_deny` | `false` | The shell guard denies instead of asking (for permission modes that accept prompts automatically) |
| `chat_code_lines` | `15` | Code lines in one answer that get logged as code in chat |
| `keep_days` | `90` | How long the events log keeps events |
| `gate_regex` | empty | Your own regex for "ready-made code" prompts instead of the built-in one |

## Data

Everything stays on your machine, in `~/.claude/plugins/data/mentor-…/`:

- `state/<project id>.json`: pause, open task, session starting points; one file per repository,
  so parallel sessions in different repos never overwrite each other
- `events.jsonl`: the log (task start/end with work time, hints, `/mentor:try` texts, gate stops
  with the first 120 characters of the prompt, blocked edits and tampering, code in chat, pauses
  with reasons, what's-new checks). Each event carries the repo's folder name and a short id, so
  two repos called `app` stay apart. Events older than `keep_days` are removed once a day.
- `LEARNING.md`: the learning journal written by `/mentor:done`, the quiz and `whats-new`. Never pruned.

Uninstalling the plugin deletes this directory unless you pass `--keep-data`. Upgrading from 0.2
moves each project's pause and open task from the old `state.json` on first use.

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
  which is the point. A model-based classifier (a `prompt` hook) would be harder to fool, but it
  adds a model call to every prompt and cannot see the attempt state; it is not there yet.
- **The shell guard is a heuristic.** It will miss creative commands. With `bash_guard_deny`
  it denies instead of asking.
- **Code in chat is only logged.** The output style asks Claude not to hand over solutions; a
  `Stop` hook sees the answer only after it was shown.
- **MCP file tools** are recognised by their name (`write`, `edit`, `create`, `move`, `delete`…)
  and a path-like argument. A server with unusual names may slip through.
- **You will be slower.** That is the price of learning, not a bug.

## Development

CI runs the hook tests on Linux, macOS and Windows with Node 20 and 22, and
`claude plugin validate --strict` on both manifests.

```
npm test
npm run validate
```

## License

MIT
