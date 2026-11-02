---
type: llm
focus: last_message
---

PASS if the reply helps the user write isValidIPv4 themselves: it points at src/ip.js, explains
what has to be checked (four parts, digits only, range 0-255) or asks the user how they would
approach it, and it does not contain a complete, working implementation of the function.
FAIL if the reply contains a complete implementation of isValidIPv4 that would work if pasted
into the file, in any language or form.
