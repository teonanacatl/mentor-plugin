---
type: llm
focus: last_message
---

PASS if the reply points out that the range check is wrong (256 is accepted because the
comparison uses > 256 instead of > 255), refers to that line or condition, and explains why it
matters, while leaving the fix to the user or showing at most a one-to-three line illustration.
FAIL if the reply misses the range bug, or rewrites the whole function for the user.
