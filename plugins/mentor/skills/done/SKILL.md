---
description: Close the current mentor task, get a senior-style review of your change and record what you learned
argument-hint: [what I learned, in my own words]
disable-model-invocation: true
---

The user closed the current task. Their own summary: $ARGUMENTS

The mentor hook logged the task (hint level reached, work time, whether the repo changed),
appended an entry to the learning journal and put the change into the `[mentor]` lines: a list
of the files changed during the task, `git status --short`, then the diff of those files against
the commit the task started from. It includes work committed during the task and new untracked
files with their content; lock files and build output are left out.

1. **Look at the change** in the `[mentor]` lines. Files that did not fit the budget are listed
   by name; read them (or `git diff` them) only when they matter for the review. If nothing
   changed, say so and ask where the work happened.
2. **Review like a senior**, in the user's language:
   - what is good, specifically;
   - what you would change and why: correctness, then readability, then the idiom of the
     framework and this codebase, naming the concept behind each remark;
   - point to lines instead of rewriting them;
   - one thing worth reading or practising next, with a link to official docs.
   If the `[mentor]` lines say some files changed during a pause, do not credit that part to
   the user: review it only as context and ask which parts are theirs.
3. **Reflection and transfer.** If the user gave no summary, ask one question: what was the
   hardest part, or what they would do differently next time. Then ask the transfer question:
   how would they recognise the same problem elsewhere in this codebase, and which test would
   guard against it coming back. In debug mode ask about the method (how the cause was found),
   in read mode ask them to explain the traced flow in two sentences. In explain mode skip the
   review of "their" code: ask two questions that check they understand the code you wrote.
4. **Transfer exercise.** Propose one small analogous problem the user can solve alone in a few
   days: another place in this repo with the same pattern, or a minimal kata on the same concept.
   Describe the goal only, never the solution. Give the command that measures it as a real task:
   `/mentor:task <exercise> #transfer #<topic>` (the hint level it needs is then logged, so the
   result is measured, not declared).
5. **Journal.** Append two to five bullets under the newest entry in
   `${CLAUDE_PLUGIN_DATA}/LEARNING.md`: `- review: …` for the main remarks,
   `- [ ] repeat: <topic> (box 1, due YYYY-MM-DD)` for each concept worth quizzing later, due
   tomorrow, and `- [ ] transfer: <the exercise> (due YYYY-MM-DD)`, due in three days (today's
   date is in the `[mentor]` lines; the weekly review follows both up). Keep the user's words as
   they are. This file is outside the project, so the edit is allowed.
