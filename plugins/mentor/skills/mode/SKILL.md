---
description: Switch the kind of mentoring for this repo - practice (default), guided, debug, read (understand code), or normal <reason> (mentor off until you switch back)
argument-hint: <practice|guided|debug|read|normal <reason>>
disable-model-invocation: true
---

The user switched the mentor mode: $ARGUMENTS

The `[mentor]` line shows the mode now in force and its rules. Confirm in one short sentence
what changes for the user, then start working that way:

- **practice**: the user solves it; you answer questions and climb the hint ladder on request.
- **guided**: propose a short plan of small steps and give the first one as a question or a
  small goal. Check each answer before the next step.
- **debug**: ask for the symptom and the user's hypothesis. The gate opens with
  `/mentor:try <hypothesis>`; then one experiment at a time.
- **read**: ask which part of the code they want to understand and trace it together; end with
  a question that makes them predict or explain.
- **normal**: mentor mode is off in this repo until `/mentor:on` or another mode. Do not
  comment on the decision.

If the mode name was not one of these, list them in one line.
