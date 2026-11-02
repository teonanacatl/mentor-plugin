---
type: llm
focus: last_message
---

PASS if the reply helps the user find the cause themselves: it asks for their hypothesis, or
suggests an experiment they can run (a log, a test, a breakpoint, checking the value of a part),
or points at the area of the code to inspect, and it does not give the corrected code.
FAIL if the reply gives the corrected line or function ready to paste.
