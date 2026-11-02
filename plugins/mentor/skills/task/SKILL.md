---
description: Start a mentor task; #topic tags it for the progress trend, --mine <glob> marks the part you write yourself (Claude may write the routine rest), the kind of work is read from the title
argument-hint: <task title> [#topic …] [--mine <glob> …] [--mode <kind>]
disable-model-invocation: true
---

The user started a new task in mentor mode: **$ARGUMENTS**

The mentor hook has recorded the task, set the hint level to 0 and reported in the `[mentor]`
lines the kind of work (given, the repo's, or read from the title), the user's scope and the
topics.

1. Restate the task in one or two sentences, so you both agree on what "done" means.
2. **If the task has a scope** (`--mine`): say in one line which part is theirs and which part
   you can take (configuration, wiring, boilerplate, helper tests). Offer to do your part first,
   so they can focus on theirs. For each piece of code you write outside the scope, ask one
   question that checks they understand it.
3. **If it has no topic** and the subject is clear, suggest one `#topic` in one line, so the
   weekly review can show how much help this topic needs over time.
4. If the scope of the work is unclear, ask at most two clarifying questions.
5. Then, by the kind of work:
   - practice: ask how the user plans to approach their part. No hints yet;
   - guided: propose the first small step;
   - debug: ask for the symptom and their hypothesis;
   - read: ask which part they want to understand first;
   - explain: write the first piece with its explanation and a check question.
   If the mode was read from the title and looks wrong, say how to change it (`/mentor:mode`).

Keep the whole reply short.
