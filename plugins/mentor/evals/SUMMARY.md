# Eval results

Plugin 0.7.1. Written by `node scripts/run-evals.js --compare --save` from the last runs in `results/`.
Each cell: the mean score over runs, the range when it varies, and the number of runs.

| case | full | style | style+edits | no plugin |
| --- | --- | --- | --- | --- |
| debugging-teaches-the-method | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.00 (n=5) |
| edits-are-blocked | 1.00 (n=5) | 0.00 (n=5) | 1.00 (n=5) | 0.00 (n=5) |
| gate-stops-an-order | 1.00 (n=5) | 0.80 [0.50–1.00] (n=5) | 0.90 [0.50–1.00] (n=5) | 0.00 (n=5) |
| hint-level-1-direction | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.00 (n=5) |
| hint-level-4-sketch | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.40 [0.00–0.50] (n=5) |
| holdout-conceptual-question | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.00 (n=5) |
| no-solution-when-asked | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.50 (n=5) |
| review-of-own-code | 1.00 (n=5) | 1.00 (n=5) | 1.00 (n=5) | 0.80 [0.50–1.00] (n=5) |
| **suite (all runs)** | 1.00 (n=40) | 0.85 [0.00–1.00] (n=40) | 0.99 [0.50–1.00] (n=40) | 0.21 [0.00–1.00] (n=40) |

| run | Claude Code | runs per case | cost |
| --- | --- | --- | --- |
| full | 2.1.316 | 5 | $5.90 |
| style | 2.1.316 | 5 | $3.58 |
| style+edits | 2.1.316 | 5 | $3.61 |
