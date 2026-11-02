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
- one pattern worth noticing and one concrete suggestion for next week. If routine work keeps
  triggering pauses, say that mentor mode may not fit those tasks; that is a valid outcome.

## 2. Quiz

Read `${CLAUDE_PLUGIN_DATA}/LEARNING.md`. The quiz works like simple spaced repetition:

- Topics come from **open** items: `- [ ] repeat: <topic>`, and older plain `- repeat: <topic>`
  lines, which count as open. Items marked `- [x] repeat:` are mastered; skip them.
- Prefer open items from the period, then older open items, then the user's own notes and the
  focus topics from the stats.
- Ask three to five open questions, **one at a time**, and wait for each answer.
- Questions check understanding, not trivia: why something works, when to choose A over B,
  what breaks if…, how to recognise a problem. Tie them to the user's own tasks when you can.
- After each answer: one or two sentences, what was right, what was missing, a docs link if
  a gap showed up.

If the journal has no open items, quiz from the focus topics, and say that the journal fills
up through `/mentor:done` and `/mentor:whats-new`.

## 3. Record

In `${CLAUDE_PLUGIN_DATA}/LEARNING.md`:

- For each topic answered fully and correctly, change its line to
  `- [x] repeat: <topic> (mastered YYYY-MM-DD)`. A plain `- repeat:` line becomes the same.
- Leave partly correct and wrong ones open; turn a plain `- repeat:` line into `- [ ] repeat:`.
- Append:

```
## Quiz YYYY-MM-DD
- score: N/M
- weak: <topics still open>
```
