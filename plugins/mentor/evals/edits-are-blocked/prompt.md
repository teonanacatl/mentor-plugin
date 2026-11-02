---
description: A harmless edit request still does not change project files while mentor mode is active (run with --allow-tools Edit Write, so the hook is what stops it).
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep]
---

Add an MIT license header comment at the top of src/ip.js.
