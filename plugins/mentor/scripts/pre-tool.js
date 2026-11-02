'use strict';
// PreToolUse: denies file edits in the project while mentor mode is active, asks (or denies)
// before shell commands that look like they write files, and never lets Claude change
// mentor's own state, Claude Code's settings or installed plugins.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const configDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

// The canonical spelling of a path that may not exist yet: symlinks resolved (/var → /private/var
// on macOS) and Windows short names expanded (RUNNER~1), so two spellings of one place compare equal.
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

const norm = (p) => {
  const r = real(path.resolve(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// Path of `target` below `root`, as segments, or null when it is not inside.
function inside(root, target) {
  const rel = path.relative(norm(root), norm(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

// Mentor's state, Claude Code's settings files and installed plugins: off limits for Claude
// even during a pause, because changing them would switch mentor mode off from the inside.
function isProtectedPath(file, cwd) {
  const target = path.resolve(cwd, file);
  if (norm(target) === norm(lib.LEARNING_FILE)) return false;
  if (inside(path.resolve(lib.DATA_DIR), target)) return true;
  const inConfig = inside(configDir(), target);
  if (inConfig && inConfig[0] === 'plugins') return true;
  if (!/^settings(\.local)?\.json$/i.test(path.basename(target))) return false;
  return (inConfig && inConfig.length === 1) || /^\.claude$/i.test(path.basename(path.dirname(target)));
}

// Claude's own working files stay writable: plans, todos, its memory and the learning journal.
function isAllowedPath(file, cwd) {
  const target = path.resolve(cwd, file);
  if (norm(target) === norm(lib.LEARNING_FILE)) return true;
  const parts = inside(configDir(), target);
  if (!parts) return false;
  if ((parts[0] === 'plans' || parts[0] === 'todos') && parts.length > 1) return true;
  return parts[0] === 'projects' && parts[2] === 'memory' && parts.length > 3;
}

// Checked with quoted strings removed, so `jq 'select(.n > 0)'` or `node -e "a > 0"` is not a redirect.
const REDIRECT = /(^|[^0-9&<>=\-])>(>|\|)?\s*[^\s&|>]/;
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const FLAG_WRITE = /(^|\s)--(write|fix)\b/;

const WRITE_PATTERNS = [
  /\b(sed|perl)\s+(-\w*i|--in-place)/,
  /\btee\b/,
  /\bgit\s+(apply|am|restore|checkout|switch|reset\s+--hard)\b|\bgit\s+clean\s+-\w*f/,
  /\bgit\s+stash\b(?!\s+(list|show)\b)/,
  /\bpatch\s+-p/,
  /\b(mv|cp|rm|touch|truncate|ln)\s/,
  /\bdd\b[^|;&]*\bof=/,
  /(^|[;&|(]\s*|\bsudo\s+)install\s/,
  /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
  /WriteAll(Text|Lines|Bytes)|writeFile(Sync)?\b|fs\.write|open\([^)]*['"][wa]\+?['"]/,
  /\bng\s+(g|generate)\b/,
];

function looksLikeWrite(command) {
  const cleaned = String(command || '')
    .replace(/\d?>\s*&\s*\d/g, ' ')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, ' ');
  const unquoted = cleaned.replace(QUOTED, '""');
  return REDIRECT.test(unquoted) || FLAG_WRITE.test(unquoted) || WRITE_PATTERNS.some((re) => re.test(cleaned));
}

const PROTECTED_IN_SHELL = [
  /settings(\.local)?\.json/i, /enabledPlugins/, /[\\/]\.claude[\\/]plugins\b/i, /plugins[\\/](data|cache|marketplaces)\b/i,
  /mentor-data/i, /(^|[\s'"\\/=])\.mentor\b/,
];
const PLUGIN_CLI = /\bclaude\s+plugins?\s+(disable|uninstall|remove|rm|marketplace\s+(remove|rm))\b/i;

// A shell command that would change mentor's own state, the settings or the installed plugins.
function isTamper(command) {
  const cmd = String(command || '');
  if (PLUGIN_CLI.test(cmd)) return true;
  const slashes = (s) => (process.platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/');
  const touches = PROTECTED_IN_SHELL.some((re) => re.test(cmd)) || slashes(cmd).includes(slashes(lib.DATA_DIR));
  return touches && looksLikeWrite(cmd);
}

const MCP_WRITE = /(^|[_-])(write|edit|create|move|delete|remove|rename|patch|replace|insert|append|upload|mkdir|copy|update|save|put)/i;
const PATH_KEY = /path|file|source|destination|target|dir|uri/i;

// String values of path-like arguments of an MCP tool (nested objects and arrays included).
function mcpPaths(value, key = '', depth = 0, out = []) {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (PATH_KEY.test(key) && value) out.push(value.replace(/^file:\/\//, ''));
  } else if (Array.isArray(value)) {
    for (const v of value) mcpPaths(v, key, depth + 1, out);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) mcpPaths(v, k, depth + 1, out);
  }
  return out;
}

// Paths an MCP tool would write to, or [] for a tool that does not write files.
function mcpWriteTargets(tool, toolInput) {
  const verb = tool.split('__').pop();
  return MCP_WRITE.test(verb) ? mcpPaths(toolInput) : [];
}

function decide(decision, reason) {
  lib.respond({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

const EDIT_REASON =
  'Mentor mode is active: Claude does not edit project files. The user writes the code. ' +
  'Point to the file and place, explain what to change and why at the current hint level, then let the user do it. ' +
  'Only the user can pause mentor mode.';
const TAMPER_REASON =
  "Mentor mode: Claude does not change mentor's state, Claude Code's settings or installed plugins. " +
  'Only the user can pause or disable mentor mode, with /mentor:off <reason> or in /plugin.';

function main() {
  const input = lib.readInput();
  const cfg = lib.config();
  const proj = lib.project(input);
  const state = lib.loadState(proj);
  if (lib.expirePause(proj, state)) lib.saveState(proj, state);
  if (!lib.isEnabled(cfg, proj, state)) process.exit(0);

  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || proj.dir;
  const rel = (p) => path.relative(real(proj.dir), real(path.resolve(cwd, p)));
  const isMcp = tool.startsWith('mcp__');
  const editFile = EDIT_TOOLS.has(tool) ? toolInput.file_path || toolInput.notebook_path || '' : '';
  const mcpTargets = isMcp ? mcpWriteTargets(tool, toolInput) : [];

  // Tampering is refused even during a pause.
  const tampered = (editFile && isProtectedPath(editFile, cwd)) ||
    mcpTargets.some((p) => isProtectedPath(p, cwd)) ||
    (SHELL_TOOLS.has(tool) && isTamper(toolInput.command));
  if (tampered) {
    lib.logEvent(proj, 'tamper_block', { tool, target: editFile || mcpTargets[0] || String(toolInput.command || '').slice(0, 120) });
    decide('deny', TAMPER_REASON);
  }

  if (lib.isPaused(state)) process.exit(0);

  if (EDIT_TOOLS.has(tool)) {
    if (editFile && isAllowedPath(editFile, cwd)) process.exit(0);
    lib.logEvent(proj, 'edit_block', { tool, file: editFile ? rel(editFile) : '' });
    decide('deny', EDIT_REASON);
  }

  if (isMcp) {
    const blocked = mcpTargets.find((p) => !isAllowedPath(p, cwd));
    if (blocked) {
      lib.logEvent(proj, 'edit_block', { tool, file: rel(blocked) });
      decide('deny', EDIT_REASON);
    }
  }

  if (SHELL_TOOLS.has(tool) && cfg.bashGuard !== 'off' && looksLikeWrite(toolInput.command)) {
    if (cfg.bashGuard === 'deny') {
      lib.logEvent(proj, 'shell_block', { command: String(toolInput.command || '').slice(0, 120) });
      decide('deny', EDIT_REASON + ' This shell command looks like it writes files.');
    }
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

module.exports = { looksLikeWrite, isAllowedPath, isProtectedPath, isTamper, mcpWriteTargets };
