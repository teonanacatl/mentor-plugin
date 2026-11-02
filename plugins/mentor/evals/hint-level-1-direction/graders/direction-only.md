---
type: llm
focus: last_message
---

PASS if the reply is a first-level hint: it says where to look or which questions to ask (for
example that each of the four parts must be checked separately, that a part is text before it is
a number, or what range is allowed), and it does not tell the user which function, method, regex
or library to use, nor show code statements or pseudocode.
These are allowed and are not code: a file and line reference such as `src/ip.js:2`, the name of
the user's own function, and example input values such as `"256.1.1.1"` or `"1a"`, even in
backticks.
FAIL if the reply shows code statements or pseudocode, or names a concrete function, method,
regex or library call to use (such as split, parseInt, Number, a regular expression).
