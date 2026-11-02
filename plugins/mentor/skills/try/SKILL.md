---
description: Describe your own attempt or hypothesis (a diagnosis, a plan, what you checked); counts as an attempt for the try-first gate without touching files
argument-hint: <what I checked / what I suspect>
disable-model-invocation: true
---

The user describes their own attempt or hypothesis: $ARGUMENTS

The mentor hook recorded it and opened the try-first gate for the current task (see the
`[mentor]` line). The hint level did not change.

Respond to their reasoning, not to the problem from scratch:

1. Say what in the hypothesis holds up and what does not, pointing at real code (read it first
   with Read, Grep or Glob).
2. If the hypothesis can be tested, suggest how they can check it themselves: what to log,
   where to set a breakpoint, which command to run, what result would confirm or refute it.
3. Stay at the current hint level. Do not turn the answer into a solution.
4. End with one question that moves their investigation forward.
