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
| Edit block | `Edit`, `Write`, `NotebookEdit` and file-writing MCP tools are denied in the project. Only Claude's plans and memory (as `.md`), todos (as `.json`) and the learning journal stay writable. | `PreToolUse` hook |
| Self-protection | Claude cannot change mentor's state, Claude Code's settings files or installed plugins, nor run anything stored under `~/.claude`, by any tool, not even during a pause. A shell command that touches those places passes only as a plain read (`cat`, `ls`, `grep`, `jq`…). | `PreToolUse` hook |
| Shell guard | Commands that look like they write files (`>`, `sed -i`, `Set-Content`, `git checkout`, `git pull`, formatters such as `prettier -w` or `cargo fmt`, `ng g`, `--fix`…), in the shell or through an MCP tool that runs commands, trigger a permission prompt, or are denied. Best effort. | `PreToolUse` hook |
| Try-first gate | A prompt asking for ready-made code ("napisz…", "dokończ…", "write the code…", "fix it") does not reach Claude until you have changed some lines of code yourself. | `UserPromptSubmit` hook |
| Kinds of work | `/mentor:mode practice` (you solve it), `guided` (Claude leads in small steps), `debug` (hypothesis → experiment → analysis; the gate opens with a hypothesis), `read` (understanding existing code, no gate), `normal <reason>` (mentor off until you switch back, logged like a pause). | hook + style |
| Hint ladder | `/mentor:hint` climbs direction → concept → API → sketch, one level per call; `/mentor:hint 3` sets a level, `/mentor:hint reset` starts over. Levels are cumulative. The level lives in a state file and goes into context with every prompt. | hook + state file |
| Exit with a cost | `/mentor:off <reason>` lifts the blocks in this project for 30 min. No reason, no pause; from the third pause of a day the reason has to be longer. Every pause is logged. | hook |
| Review with your diff | `/mentor:done` hands Claude the files you changed during the task, new files with their content, so the senior-style review comes in the first answer. | hook |
| Code in chat | A large block of new code in Claude's answer while mentor mode is on is logged (a hook cannot take back text already shown). Diffs, logs, terminal blocks and lines already in the repo do not count. | `Stop` hook |
| Weekly review | `/mentor:review-week` sums up the log and, apart from activity, outcome measures: false blocks, stops followed by a pause, delayed recall from earlier quizzes, transfer exercises solved alone. Then it quizzes you on topics that are due (Leitner boxes) and follows up the transfer exercises. | events log + journal |
| Transfer | `/mentor:done` ends with a transfer question and one small analogous exercise to solve alone in a few days; the weekly review asks how it went. | skill + journal |
| Topic profile | Session start reads the journal's boxes: topics you know well, topics still weak. Claude takes smaller steps on the weak ones and steps in less on the known ones. You can correct it in the journal. | journal |
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
| `/mentor:hint [1-4 \| reset] [where I'm stuck]` | Next hint level, a given level, or back to 0 |
| `/mentor:mode <practice\|guided\|debug\|read\|normal <reason>>` | The kind of work in this repo (default from `default_mode`) |
| `/mentor:wrong [why]` | The last gate stop was not a request for code: logged as a false block, your next prompt goes through |
| `/mentor:forget <all\|days\|text>` | Remove the events log, events older than N days, or only the text in them |
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
"refactor this", "give me a function that…", "make it work", "zmień to na async", "can you code
this up?". Information questions pass: "how do I fix this?", "czy powinienem dopisać test?",
"popraw mnie, jeśli się mylę". So do your own plans ("I want to build a parser", "let me write it
myself", "I'm going to implement the cache"): a verb is yours when "I", "we" or "let me" is its
subject, right before it. An "I" earlier in the sentence does not count: "I give up, write the
code for me" is an order, and so is each clause after a comma, semicolon, "but" or "so". Pasted
material is not read as a request: fenced and indented code, `> quotes`, `//` and `/* */`
comments and `inline code` are removed first (a `* item` list line stays: it is not a comment). The pattern knows Polish word boundaries, so the first person
("napiszę", "poprawię") passes. Only real slash commands (`/review …`) skip the gate; `/ napisz to`
does not.

**What counts as your attempt.** At least `attempt_min_lines` (default 3) changed lines of code
since the task started, or, without a task, since the session started:

- tracked changes, untracked files and your own new commits all count, so committing work in
  progress still counts;
- blank lines and whitespace do not (the count ignores both), so reformatting is not an attempt;
- commits that are not yours do not count either: after a merge, a commit by another author
  (`git pull` during the task) or a commit older than the task (switching to an existing branch),
  only changes after it count, and the review in `/mentor:done` says where it started;
- lock files, build output and generated files do not count (`/dist/`, `/build/`, `/out/`,
  `/coverage/`, `/target/` at the repo root, `node_modules/` and caches anywhere, `*.log`,
  `package-lock.json`… plus your own `attempt_ignore`, gitignore-style), so a test run that writes
  `coverage.json` does not open the gate, while `scripts/build/release.js` still counts;
- changes made before the task or the session do not count: a repo that is always a bit dirty
  is not a permanent pass. If that earlier work is your attempt, say so with `/mentor:try`;
- code that appeared during a pause (`/mentor:off`) does not count either, uncommitted or
  committed: in normal mode Claude may have written it. Your work from before the pause still
  opens the gate. `/mentor:done` lists those lines and files apart, the journal notes them, and
  the weekly stats count such a task as "closed with code from a pause", not at any hint level;
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

### What is measured

Fewer hints is not the goal: a well-used hint can teach more than struggling alone. So besides
activity (tasks, hints, stops, pauses), the weekly review reports outcome measures:

| Measure | Source |
| --- | --- |
| False blocks | `/mentor:wrong` after a gate stop, as a share of all stops |
| Stops worked around | a gate stop followed by a pause in the same repo within 5 minutes |
| Work time and hint depth | median work minutes and mean highest hint level of closed tasks (own work only) |
| Work from pauses | tasks closed with code that appeared during a pause, counted apart |
| Delayed recall | the `score:` lines of earlier quizzes in the journal |
| Transfer | transfer exercises solved alone, with hints, not solved, skipped |

### Model behaviour (evals)

The hook tests check the hooks; whether Claude itself keeps to the rules is checked by an eval
suite in `plugins/mentor/evals/`, run with `claude plugin eval` against a no-plugin baseline:
the gate stops an order, Claude does not hand over the implementation when asked how to write
it, edits are blocked, hint 1 names no API, hint 4 leaves `TODO`s, the review finds the user's
off-by-one bug without rewriting the function, and a debugging question gets the method, not the
fix. Each case sets up a small git repo with `fixture.sh`.

```
npm run eval        # all cases, with the no-plugin baseline; needs a logged-in Claude Code
npm run eval:free   # the case that needs no model call (also run in CI)
```

## Configuration

Asked when you enable the plugin, editable in `/config`:

| Option | Default | |
| --- | --- | --- |
| `language` | from the system locale | Language of the hook messages (`pl` or `en`). Claude answers in the language you write in. |
| `activation` | `always` | `always`, or `marker`: only in repos with `.mentor` or `/mentor:enable` |
| `default_mode` | `practice` | The kind of work in a repo until `/mentor:mode` changes it: `practice`, `guided`, `debug` or `read` |
| `log_text` | `false` | Keep your text (prompts, commands, hypotheses) in the events log. Off: only lengths |
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
  so parallel sessions in different repos never overwrite each other, and a short lock file
  serialises sessions in the same repo
- `events.jsonl`: the log (task start/end with work time and mode, hints, `/mentor:try`, gate
  stops, false blocks, blocked edits and tampering, code in chat, pauses with reasons, files with
  lasting instructions for Claude (`CLAUDE.md`, agents, skills, commands, output styles) written
  during a pause, what's-new checks). **Your text is not kept by default**: of a prompt, a
  command or a hypothesis only the length is logged, and a task opened by `/mentor:hint` or
  `/mentor:try` stays untitled, so no code or confidential prompt ends up in the log. Turn
  `log_text` on to keep the first 120–200 characters. Each event carries a schema version
  (`v`), the repo's folder name and a short id, so two repos called `app` stay apart. Events
  older than `keep_days` are removed once a day; `/mentor:forget` removes them on request.
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
- **The gate is a regex.** Rephrasing gets around it, and the list of phrasings will never be
  complete. That still takes a conscious decision, which is the point. A model-based classifier
  (a `prompt` hook) would be harder to fool, but a plugin's hooks cannot be switched by a
  `userConfig` option, so it would add a model call to every prompt of every user, and it cannot
  see whether the attempt was already made; it is not there yet.
- **Protected places are recognised by name.** A command that builds the path at run time
  (`HOME + '/.cl' + 'aude'`) is not recognised. Protected are `~/.claude`, settings files,
  plugins, mentor's data and removing `.mentor`; a project's other `.claude/` files (shared
  commands and agents) are team work, free in a pause and logged when written then.
- **Timeouts fail open.** When a hook errors, file changes are denied and everything else passes;
  when it runs out of time, Claude Code lets the tool call through.
- **The shell guard is a heuristic.** It will miss creative commands. With `bash_guard_deny`
  it denies instead of asking.
- **Code in chat is only logged.** The output style asks Claude not to hand over solutions; a
  `Stop` hook sees the answer only after it was shown.
- **MCP file tools** are recognised by their name (`write`, `edit`, `create`, `move`, `delete`…,
  camelCase too) and an argument that looks like a local path. Remote ids (`fileId`) and URLs are
  not paths, so Drive or Docs keep working. A server with unusual names may slip through.
- **You will be slower.** That is the price of learning, not a bug.

## Development

CI runs the hook tests on Linux, macOS and Windows with Node 20 and 22, then, with a pinned
Claude Code version, `claude plugin validate --strict` on both manifests and the eval case that
needs no model call. The model cases need credentials and run locally.

```
npm test
npm run validate
npm run eval
```

## License

MIT
