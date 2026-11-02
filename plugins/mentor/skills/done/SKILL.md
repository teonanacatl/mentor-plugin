---
description: Close the current mentor task, get a senior-style review of your change and record what you learned
argument-hint: [what I learned, in my own words]
disable-model-invocation: true
---

The user closed the current task. Their own summary: $ARGUMENTS

The mentor hook logged the task (hint level reached, work time, whether the repo changed),
appended an entry to the learning journal and put `git status --short` and the diff against
the commit the task started from into the `[mentor]` lines. That diff includes work the user
committed during the task.

1. **Look at the change** in the `[mentor]` lines. Run `git diff` yourself only when the diff
   there is missing or truncated and the rest matters for the review. If nothing changed, say
   so and ask where the work happened.
2. **Review like a senior**, in the user's language:
   - what is good, specifically;
   - what you would change and why: correctness, then readability, then the idiom of the
     framework and this codebase, naming the concept behind each remark;
   - point to lines instead of rewriting them;
   - one thing worth reading or practising next, with a link to official docs.
3. **Reflection.** If the user gave no summary, ask one question: what was the hardest part,
   or what they would do differently next time.
4. **Journal.** Append two to four bullets under the newest entry in
   `${CLAUDE_PLUGIN_DATA}/LEARNING.md`: `- review: …` for the main remarks and
   `- [ ] repeat: <topic>` for each concept worth quizzing later (an open checkbox; the weekly
   quiz ticks it off once the user has it). Keep the user's words as they are. This file is
   outside the project, so the edit is allowed.
