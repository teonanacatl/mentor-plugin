---
description: A short test without AI on one topic - a baseline now, the same difficulty again in a few weeks; the score and time go to the log, so progress is measured without Claude grading it
argument-hint: <topic> | done <solved>/<total>
disable-model-invocation: true
---

The user typed: /mentor:checkpoint $ARGUMENTS

The `[mentor]` lines say whether a checkpoint started or ended and list earlier checkpoints on
the topic.

## When it starts

1. Write three short exercises on the topic, solvable in about 20–30 minutes in total without
   any help: one to recognise a problem in a given snippet, one to predict what code does, one
   small piece to write. Tie them to this repository's style where you can, but make each one
   self-contained.
2. If earlier checkpoints on the topic exist (in the `[mentor]` lines and under
   `## Checkpoint <topic>` in `${CLAUDE_PLUGIN_DATA}/LEARNING.md`), match their difficulty with
   different exercises, so the scores can be compared.
3. Append the exercises to the journal under `## Checkpoint <topic> YYYY-MM-DD (exercises)`.
4. Tell the user: solve them without AI, then paste the answers here. Until the checkpoint ends,
   give no hints, answers or code about the exercises; you may only clarify what an exercise asks.

## When the user pastes answers

Check each answer briefly and say which are correct, without teaching yet. Then ask the user to
end it with `/mentor:checkpoint done <correct>/<total>`.

## When it ends

Now go through the mistakes: what was wrong and the concept behind it, with a docs link. Add
`- [ ] repeat: <topic> (box 1, due <tomorrow>)` for each concept that was missed.
