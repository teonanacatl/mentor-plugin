---
description: What changed in the frameworks and tools this repo uses, with two or three exercises on your own code
argument-hint: [package or tool, optional]
disable-model-invocation: true
---

The user wants to keep up with new releases of the tools in this repository. Focus requested:
$ARGUMENTS (if empty: the main frameworks of the repo and the focus topics
"${user_config.focus_topics}").

1. **Versions in use.** Find the manifests (`package.json`, lock files, `pyproject.toml`,
   `requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, `*.csproj`) and
   list the installed versions of the main frameworks and tools, not every library.
2. **Last check.** Read `${CLAUDE_PLUGIN_DATA}/LEARNING.md` if it exists and find the latest
   `## What's new` entry, so you can say what changed since then.
3. **Current state.** For each selected package look up the latest release and its notes:
   use a documentation MCP server such as Context7 when it is available, otherwise the
   official changelog or release page. Only package names and versions leave the machine;
   never send code from the repository.
4. **What matters here.** Pick three to five changes that touch this codebase: new APIs that
   replace patterns the repo uses, deprecations, breaking changes in the next major. Use Grep
   to show where the repo uses the affected API (files and lines).
5. **Exercises.** Propose two or three exercises on the user's own code: which file, what to
   rewrite to the new API or pattern, why it is better, and the docs link. Describe the goal,
   do not write the solution. Suggest starting one with `/mentor:task <title>`.
6. **Record.** Append to `${CLAUDE_PLUGIN_DATA}/LEARNING.md`:

   ```
   ## What's new YYYY-MM-DD
   - <package>: <installed> → <latest>
   - [ ] repeat: <topic for the quiz>
   ```

Answer in the user's language. Mark anything you could not verify in a source as unverified.
