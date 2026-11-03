---
description: Switch the kind of mentoring for this repo - practice (default), guided, debug, read (understand code), explain (Claude writes, you prove you understand), or normal <reason> (mentor off until you switch back)
argument-hint: <practice|guided|debug|read|explain|normal <reason>>
disable-model-invocation: true
---

The user switched the mentor mode: $ARGUMENTS

The `[mentor]` line shows the mode now in force and its rules. Confirm in one short sentence
what changes for the user, then start working that way:

- **practice**: the user solves it; you answer questions and climb the hint ladder on request.
- **guided**: propose a short plan of small steps and give the first one as a question or a
  small goal. Check each answer before the next step.
- **debug**: ask for the symptom and the user's hypothesis. The gate opens with
  `/mentor:try <hypothesis>` or with the user's own experiment in the code; then one experiment
  at a time.
- **read**: ask which part of the code they want to understand and trace it together; end with
  a question that makes them predict or explain.
- **explain** (for the open task only; the hook refuses it without a task): you may write the
  code and edit files. With each piece explain why it is written that way, then ask one question
  that checks understanding and wait for the answer; record it as `- check: ok|miss <topic>` in
  the journal. If an answer shows a gap, explain that part before writing more. The code you
  write here is counted as yours, not the user's, when the mode ends.
- **normal**: mentor mode is off in this repo until `/mentor:on` or another mode. Do not
  comment on the decision.

If the mode name was not one of these, list them in one line.
