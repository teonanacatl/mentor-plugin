---
description: Weekly review of your mentor log (tasks done alone, hint levels, pauses and why) plus a short quiz on the topics you have not mastered yet
argument-hint: [days, default 7]
disable-model-invocation: true
---

The user asked for the review of the last $ARGUMENTS days (7 if empty). The mentor hook put
the statistics from the events log into the `[mentor] Stats` lines of this prompt.

## 1. Review

In the user's language, short and factual, no praise inflation and no guilt. **Start with the
person, not the tool:**
- the skill measures first, the ones no model judged, in this order of weight:
  1. checkpoints without AI: same difficulty, no help, so the cleanest signal;
  2. the help per topic, task by task (`rxjs: 3 → 2 → 1`). It also falls when tasks get easier,
     and the user picks hint levels, so read it together with the checkpoints. Where it shows
     `(2/122 lines yours)`, most of the change was Claude's: do not call that progress;
  3. transfer exercises done as real tasks and their hint level;
  4. understanding of code Claude wrote (`check` answers per topic).
  Say which topics improve, which do not, and where there is too little data to tell; suggest
  `#topic` tags or a `/mentor:checkpoint` where a measure is missing;
- explain mode and pauses side by side: how often Claude wrote the code, in which tasks, and
  whether the check answers show the user understood it;
- how many tasks were closed, how much work time, and at which hint level they usually ended
  (level 0 means alone);
- how many times the gate stopped a request for ready-made code, and how often the user
  described their own attempt with `/mentor:try`;
- pauses: how many, and what the reasons have in common (deadlines, routine work, fatigue…);
- escapes that happened anyway: answers of yours with a large block of new code while mentor
  mode was active (quotes of the repo, diffs and logs are already left out), repos where mentor
  mode was disabled, blocked attempts to change mentor's state, files with lasting instructions
  written during pauses. Report them as facts; at hint level 4 a sketch is expected, so say which
  ones went beyond it;
- the outcome measures, which matter more than the activity counts: false blocks and stops
  followed by a pause (friction the gate caused), delayed recall from earlier quizzes, transfer
  exercises solved alone. Fewer hints is not the goal in itself; a well-used hint can teach more
  than struggling alone. Say what the measures suggest, and when there is too little data, say so;
- one pattern worth noticing and one concrete suggestion for next week. If routine work keeps
  triggering pauses, say that mentor mode may not fit those tasks; that is a valid outcome. If
  false blocks keep coming, suggest a `gate_regex` or `/mentor:mode read` for that kind of work.

## 2. Quiz

Read `${CLAUDE_PLUGIN_DATA}/LEARNING.md`. The quiz is spaced repetition with Leitner boxes.
An open item looks like `- [ ] repeat: <topic> (box N, due YYYY-MM-DD)`. Today's date is in the
`[mentor]` lines.

- Topics come from open items that are **due**: due date today or earlier. Items without box and
  date (`- [ ] repeat: <topic>`, or the older plain `- repeat: <topic>`) count as box 1, due now.
  Items marked `- [x] repeat:` are mastered; skip them, and skip open items not due yet.
- Prefer the lowest boxes and the oldest due dates, then the user's own notes and the focus
  topics from the stats.
- Ask three to five open questions, **one at a time**, and wait for each answer.
- Questions check understanding, not trivia: why something works, when to choose A over B,
  what breaks if…, how to recognise a problem. Tie them to the user's own tasks when you can.
- After each answer: one or two sentences, what was right, what was missing, a docs link if
  a gap showed up.

If nothing is due, say when the next item is due and quiz from the focus topics instead; if the
journal has no items at all, say that it fills up through `/mentor:done` and `/mentor:whats-new`.

## 3. Transfer

After the quiz, go through the open `- [ ] transfer:` items that are due. For each, ask whether
the user tried it and how it went: solved alone, solved with hints, or not solved yet. If they
solved it, ask for one sentence on how, and check it makes sense. The user may also say an
exercise was too easy or not relevant; then close it as `(skipped: <why>)`.

## 4. Record

In `${CLAUDE_PLUGIN_DATA}/LEARNING.md`, rewrite each quizzed line in place:

- **Correct and complete:** move one box up and set the next due date: box 2 in 3 days, box 3 in
  7 days, box 4 in 14 days, box 5 in 30 days. A correct answer from box 5 makes it
  `- [x] repeat: <topic> (mastered YYYY-MM-DD)`.
- **Partly correct or wrong:** back to box 1, due tomorrow.
- Lines without box and date get them now, in the same format.
- Transfer items: `- [x] transfer: <exercise> (solved alone YYYY-MM-DD)`, `(with hints YYYY-MM-DD)`,
  `(not solved YYYY-MM-DD)` or `(skipped: <why>)`; one not tried yet stays open with a due date
  three days ahead.
- Append:

```
## Quiz YYYY-MM-DD
- score: N/M
- weak: <topics still open>
```

The `score:` line and the transfer results are read by the hook for the outcome measures of
later reviews, so keep them in exactly this format.
