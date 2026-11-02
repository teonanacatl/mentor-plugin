'use strict';
// PreToolUse: denies file edits in the project while mentor mode is active,
// and asks before shell commands that look like they write files.

const os = require('os');
const path = require('path');
const lib = require('./lib');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Claude's own files (plans, memory, this plugin's journal) stay writable.
function isAllowedPath(file, cwd) {
  const norm = (p) => {
    const r = path.resolve(cwd, p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const target = norm(file);
  const roots = [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), lib.DATA_DIR].map(norm);
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

// Checked with quoted strings removed, so `jq 'select(.n > 0)'` or `node -e "a > 0"` is not a redirect.
const REDIRECT = /(^|[^0-9&<>=\-])>>?\s*[^\s&|>]/;
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;

const WRITE_PATTERNS = [
  /\b(sed|perl)\s+(-\w*i|--in-place)/,
  /\btee\b/,
  /\bgit\s+(apply|am|restore|reset\s+--hard|stash\s+pop)\b|\bgit\s+checkout\s+--(\s|$)/,
  /\bpatch\s+-p/,
  /\b(mv|cp|rm|touch|truncate)\s/,
  /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
  /WriteAll(Text|Lines|Bytes)|writeFile(Sync)?\b|fs\.write|open\([^)]*['"][wa]\+?['"]/,
  /--write\b|--fix\b/,
  /\bng\s+(g|generate)\b/,
];

function looksLikeWrite(command) {
  const cleaned = String(command || '')
    .replace(/\d?>\s*&\s*\d/g, ' ')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, ' ');
  return REDIRECT.test(cleaned.replace(QUOTED, '""')) || WRITE_PATTERNS.some((re) => re.test(cleaned));
}

function decide(decision, reason) {
  lib.respond({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

function main() {
  const input = lib.readInput();
  const cfg = lib.config();
  const dir = lib.projectDir(input);
  const key = lib.projectKey(dir);
  const state = lib.loadState();
  if (lib.expirePause(state, dir, key)) lib.saveState(state);
  if (lib.isPaused(state, key)) process.exit(0);

  const tool = input.tool_name;
  const toolInput = input.tool_input || {};

  if (EDIT_TOOLS.has(tool)) {
    const file = toolInput.file_path || toolInput.notebook_path || '';
    if (file && isAllowedPath(file, input.cwd || dir)) process.exit(0);
    lib.logEvent(dir, 'edit_block', { tool, file: file ? path.relative(dir, path.resolve(dir, file)) : '' });
    decide('deny',
      'Mentor mode is active: Claude does not edit project files. The user writes the code. ' +
      'Point to the file and place, explain what to change and why at the current hint level, then let the user do it. ' +
      'Only the user can pause mentor mode.');
  }

  if (SHELL_TOOLS.has(tool) && cfg.bashGuard && looksLikeWrite(toolInput.command)) {
    decide('ask', lib.t(cfg, 'bashAsk'));
  }

  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    lib.logError('pre-tool', err);
    process.exit(0);
  }
}

module.exports = { looksLikeWrite, isAllowedPath };
