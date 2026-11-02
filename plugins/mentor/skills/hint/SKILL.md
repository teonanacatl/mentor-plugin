---
description: Next step on the hint ladder (direction, concept, API, sketch) for the current task; a number sets the level, reset starts over
argument-hint: [1-4 | reset] [where you are stuck]
disable-model-invocation: true
---

The user asks for a hint. Where they are stuck: $ARGUMENTS

The mentor hook raised the hint level (or set it, or reset it to 0) and reported it in the
`[mentor]` line for this prompt, together with the scope allowed at that level. After a reset,
say in one line that the ladder starts over and ask where they are stuck; give no hint yet.
Otherwise give exactly one hint at that level, never higher.

Hints are cumulative. Each one builds on the earlier ones and must remove some uncertainty the
user still has: do not repeat a previous hint in other words, and do not skip ahead. The levels:

1. **direction**: which file, function or area to look at and which question to ask there.
   No names of APIs or patterns.
2. **concept**: the idea or pattern that solves it and why it fits, plus a link to the
   official documentation. No code for this task.
3. **API**: the concrete functions, types or signatures and how they connect. No assembled
   solution.
4. **sketch**: a skeleton or pseudocode with the essential lines left as `TODO` for the user.

Before answering, read the relevant code (Read, Grep, Glob) so the hint points at real places
in this repository.

Start the reply with `Hint N/4 · <level>` (in the user's language). Keep it under about ten
lines. End with one question that checks understanding or nudges the next step.

## Without the hook

If the context has no `[mentor]` line with a hint level, the counter did not move: the command
was typed without the `mentor:` prefix, or the organisation allows only managed hooks
(`allowManagedHooksOnly`). Keep the ladder going from the conversation instead:

1. If the arguments start with a number from 1 to 4 (`/mentor:hint 2 …`), use that level.
2. Otherwise find your most recent `Hint N/4` or `Podpowiedź N/4` header in this conversation
   and use N+1, at most 4.
3. With neither, use level 1.

Say in one short line that the level comes from the conversation, not from the hook.
