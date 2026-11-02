---
description: Weekly review of your mentor log (tasks done alone, hint levels, pauses and why) plus a short quiz on the topics you have not mastered yet
argument-hint: [days, default 7]
disable-model-invocation: true
---

The user asked for the review of the last $ARGUMENTS days (7 if empty). The mentor hook put
the statistics from the events log into the `[mentor] Stats` lines of this prompt.

## 1. Review

In the user's language, short and factual, no praise inflation and no guilt:
- how many tasks were closed, how much work time, and at which hint level they usually ended
  (level 0 means alone);
- how many times the gate stopped a request for ready-made code, and how often the user
  described their own attempt with `/mentor:try`;
- pauses: how many, and what the reasons have in common (deadlines, routine work, fatigue…);
- escapes that happened anyway: answers of yours with a large code block while mentor mode was
  active, repos where mentor mode was disabled, blocked attempts to change mentor's state.
  Report them as facts; at hint level 4 a sketch is expected, so say which ones went beyond it;
- one pattern worth noticing and one concrete suggestion for next week. If routine work keeps
  triggering pauses, say that mentor mode may not fit those tasks; that is a valid outcome.

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

## 3. Record

In `${CLAUDE_PLUGIN_DATA}/LEARNING.md`, rewrite each quizzed line in place:

- **Correct and complete:** move one box up and set the next due date: box 2 in 3 days, box 3 in
  7 days, box 4 in 14 days, box 5 in 30 days. A correct answer from box 5 makes it
  `- [x] repeat: <topic> (mastered YYYY-MM-DD)`.
- **Partly correct or wrong:** back to box 1, due tomorrow.
- Lines without box and date get them now, in the same format.
- Append:

```
## Quiz YYYY-MM-DD
- score: N/M
- weak: <topics still open>
```
