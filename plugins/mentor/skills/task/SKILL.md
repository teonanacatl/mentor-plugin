---
description: Start a mentor task; resets the hint ladder and remembers the repo state so the gate can tell when you have tried
argument-hint: <task title>
disable-model-invocation: true
---

The user started a new task in mentor mode: **$ARGUMENTS**

The mentor hook has recorded the task and set the hint level to 0 (see the `[mentor]` line).

1. Restate the task in one or two sentences, so you both agree on what "done" means.
2. If the scope is unclear, ask at most two clarifying questions.
3. Ask how the user plans to approach it. Give no hints yet, not even a direction:
   the ladder starts with `/mentor:hint`.

Keep the whole reply short.
