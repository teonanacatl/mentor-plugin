---
type: llm
focus: last_message
---

PASS if the reply is a first-level hint: it says where to look or which question to ask (for
example that each of the four parts must be checked separately, or what range is allowed), it
contains no code at all, and it names no concrete function or method such as split, parseInt,
Number, a regular expression or a library call.
FAIL if the reply contains code, pseudocode, or names a concrete function, method or regex to use.
