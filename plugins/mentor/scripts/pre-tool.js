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

// Claude's own working files stay writable: plans and memory as Markdown, todos as JSON, and the
// learning journal. Nothing that could be run as a script.
function isAllowedPath(file, cwd) {
  const target = path.resolve(cwd, file);
  if (norm(target) === norm(lib.LEARNING_FILE)) return true;
  const parts = inside(configDir(), target);
  if (!parts) return false;
  const ext = path.extname(target).toLowerCase();
  if (parts[0] === 'plans' && parts.length > 1) return ext === '.md';
  if (parts[0] === 'todos' && parts.length > 1) return ext === '.json';
  return parts[0] === 'projects' && parts[2] === 'memory' && parts.length > 3 && ext === '.md';
}

// Files that give Claude lasting instructions: CLAUDE.md, agents, skills, commands, output styles,
// hooks and rules, in the user's config or in the project. Written during a pause, they outlive it.
function isLastingInstruction(file, cwd) {
  const target = path.resolve(cwd, file);
  if (/^CLAUDE(\.local)?\.md$/i.test(path.basename(target))) return true;
  const inConfig = inside(configDir(), target);
  const dirs = /^(agents|skills|commands|output-styles|hooks|rules)$/i;
  if (inConfig && dirs.test(inConfig[0])) return true;
  const segs = norm(target).split(path.sep);
  const i = segs.lastIndexOf('.claude');
  return i >= 0 && i + 1 < segs.length - 1 && dirs.test(segs[i + 1]);
}

// Checked with quoted strings removed, so `jq 'select(.n > 0)'` or `node -e "a > 0"` is not a redirect.
const REDIRECT = /(^|[^0-9&<>=\-])>(>|\|)?\s*[^\s&|>]/;
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const FLAG_WRITE = /(^|\s)--(write|fix)\b/;

const WRITE_PATTERNS = [
  /\b(sed|perl)\s+(-\w*i|--in-place)/,
  /\b(tee|sponge)\b/,
  /\bgit\s+(apply|am|restore|checkout|switch|reset\s+--hard|pull|merge|rebase|cherry-pick|revert)\b|\bgit\s+clean\s+-\w*f/,
  /\bgit\s+stash\b(?!\s+(list|show)\b)/,
  /\bpatch\s+-p/,
  /\b(mv|cp|rm|touch|truncate|ln)\s/,
  /\bdd\b[^|;&]*\bof=/,
  /(^|[;&|(]\s*|\bsudo\s+)install\s/,
  /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
  /WriteAll(Text|Lines|Bytes)|writeFile(Sync)?\b|appendFile(Sync)?\b|fs\.write|open\([^)]*['"][wa]\+?['"]/,
  /\b(rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync|rmdirSync|cpSync)\b|\.write_(text|bytes)\(|\bshutil\.(copy\w*|move|rmtree)|\bos\.(remove|unlink|rename|replace|makedirs)\(/,
  /\bng\s+(g|generate)\b/,
  // Formatters and generators rewrite files, and with them the user's attempt.
  /\bprettier\b[^|;&]*\s-w\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fmt|lint:fix|lint-fix|fix)(?![\w:-])/,
  /\bgofmt\b[^|;&]*\s-w\b|\bgo\s+fmt\b|\bcargo\s+(fmt|fix)\b|\brustfmt\b|\bterraform\s+fmt\b|\bmix\s+format\b/,
  /\b(black|isort)\b(?![^|;&]*--(check|diff))|\bruff\s+format\b(?![^|;&]*--(check|diff))/,
  /\bdotnet\s+format\b|\bprisma\s+generate\b|\bclang-format\b[^|;&]*\s-i\b/,
];

function looksLikeWrite(command) {
  const cleaned = String(command || '')
    .replace(/\d?>\s*&\s*\d/g, ' ')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, ' ');
  const unquoted = cleaned.replace(QUOTED, '""');
  return REDIRECT.test(unquoted) || FLAG_WRITE.test(unquoted) || WRITE_PATTERNS.some((re) => re.test(cleaned));
}

// Anything under a .claude directory (the user's config, a project's settings), mentor's data,
// the .mentor marker or the settings keys.
const PROTECTED_IN_SHELL = [
  /(^|[^\w.-])\.claude([\\/'"\s]|$)/i, /settings(\.local)?\.json/i, /enabledPlugins/, /mentor-data/i,
  /(^|[\s'"\\/=])\.mentor\b/, /CLAUDE_(CONFIG_DIR|PLUGIN_DATA)/,
];
const PLUGIN_CLI = /\bclaude\s+plugins?\s+(disable|uninstall|remove|rm|marketplace\s+(remove|rm))\b/i;

// Commands that only read. Everything else touching a protected place is refused, so a write by
// a route the heuristics do not know (an interpreter, sponge, a script under ~/.claude) fails too.
const SAFE_READERS = new Set([
  'cat', 'type', 'ls', 'dir', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'stat',
  'file', 'tree', 'du', 'echo', 'printf', 'pwd', 'cd', 'pushd', 'popd', 'test', '[', 'true', 'which', 'where',
  'realpath', 'readlink', 'basename', 'dirname', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'find', 'git',
  'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'test-path', 'get-item', 'resolve-path',
]);
const GIT_READS = /^(status|log|diff|show|ls-files|rev-parse|blame|grep|config\s+(--get|-l|--list))\b/;

function isSafeRead(command) {
  const unquoted = String(command || '').replace(QUOTED, '""');
  if (REDIRECT.test(unquoted)) return false;
  for (const raw of String(command).split(/\|\||&&|[|;&\n]/)) {
    const seg = raw.trim().replace(/^(\w+=\S*\s+)+/, '');
    if (!seg) continue;
    const [first, ...rest] = seg.split(/\s+/);
    const name = path.basename(first.replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.exe$/, '');
    if (!SAFE_READERS.has(name)) return false;
    const args = rest.join(' ');
    if (name === 'find' && /-(delete|exec|execdir|ok|fprint)/.test(args)) return false;
    if (name === 'git' && !GIT_READS.test(args)) return false;
  }
  return true;
}

// A shell command that could change mentor's own state, the settings or the installed plugins.
function isTamper(command) {
  const cmd = String(command || '');
  if (PLUGIN_CLI.test(cmd)) return true;
  const slashes = (s) => (process.platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/');
  const touches = PROTECTED_IN_SHELL.some((re) => re.test(cmd)) ||
    slashes(cmd).includes(slashes(lib.DATA_DIR)) || slashes(cmd).includes(slashes(configDir()));
  return touches && !isSafeRead(cmd);
}

// MCP tool names are split into words, so `fileWrite`, `apply_diff` and `start-process` are read.
const MCP_WRITE = new Set(['write', 'edit', 'create', 'move', 'delete', 'remove', 'rename', 'patch', 'replace', 'insert',
  'append', 'upload', 'mkdir', 'copy', 'update', 'save', 'put', 'apply', 'set', 'modify', 'overwrite']);
const MCP_EXEC = new Set(['exec', 'execute', 'run', 'command', 'terminal', 'process', 'shell', 'eval', 'spawn', 'script']);
const PATH_KEY = /path|file|source|destination|target|dir|uri/i;
const CODE_KEY = /^(command|commands|cmd|code|script|source_code|input|args|argv)$/i;

function toolWords(tool) {
  return tool.split('__').pop()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter(Boolean);
}

// String values of the arguments whose key matches (nested objects and arrays included).
function collect(value, keyRe, key = '', depth = 0, out = []) {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (keyRe.test(key) && value) out.push(value);
  } else if (Array.isArray(value)) {
    if (keyRe.test(key) && value.every((v) => typeof v === 'string')) out.push(value.join(' '));
    else for (const v of value) collect(v, keyRe, key, depth + 1, out);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, keyRe, k, depth + 1, out);
  }
  return out;
}

// Paths an MCP tool would write to, or [] for a tool that does not write files.
function mcpWriteTargets(tool, toolInput) {
  if (!toolWords(tool).some((w) => MCP_WRITE.has(w))) return [];
  return collect(toolInput, PATH_KEY).map((p) => p.replace(/^file:\/\//, ''));
}

// Commands or code an MCP tool would run, or [] for a tool that does not run anything.
function mcpCommands(tool, toolInput) {
  if (!toolWords(tool).some((w) => MCP_EXEC.has(w))) return [];
  return collect(toolInput, CODE_KEY);
}

function decide(decision, reason) {
  lib.respond({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

const EDIT_REASON =
  'Mentor mode is active: Claude does not edit project files. The user writes the code. ' +
  'Point to the file and place, explain what to change and why at the current hint level, then let the user do it. ' +
  'Only the user can pause mentor mode.';
const TAMPER_REASON =
  "Mentor mode: Claude does not change mentor's state, Claude Code's settings or installed plugins, and does not run " +
  'anything from those places. Only the user can pause or disable mentor mode, with /mentor:off <reason> or in /plugin.';
const ERROR_REASON =
  "Mentor mode: the mentor hook failed, so this file change is denied to be safe (details in the plugin's errors.log). " +
  'Tell the user; they can disable the plugin if it keeps happening.';

let current = null; // the parsed input, for the fail-closed path

function main() {
  const input = (current = lib.readInput());
  const cfg = lib.config();
  const proj = lib.project(input);
  let state = lib.loadState(proj);
  if (state.pause && Date.now() >= state.pause.until) {
    lib.lockState(proj);
    state = lib.loadState(proj);
    if (lib.expirePause(proj, state)) lib.saveState(proj, state);
  }
  if (!lib.isEnabled(cfg, proj, state)) process.exit(0);

  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || proj.dir;
  const rel = (p) => path.relative(real(proj.dir), real(path.resolve(cwd, p)));
  const isMcp = tool.startsWith('mcp__');
  const editFile = EDIT_TOOLS.has(tool) ? toolInput.file_path || toolInput.notebook_path || '' : '';
  const mcpTargets = isMcp ? mcpWriteTargets(tool, toolInput) : [];
  const commands = SHELL_TOOLS.has(tool) ? [String(toolInput.command || '')] : isMcp ? mcpCommands(tool, toolInput) : [];

  // Tampering is refused even during a pause.
  const tampered = (editFile && isProtectedPath(editFile, cwd)) ||
    mcpTargets.some((p) => isProtectedPath(p, cwd)) ||
    commands.some(isTamper);
  if (tampered) {
    lib.logEvent(proj, 'tamper_block', { tool, target: editFile || mcpTargets[0] || commands.join(' ').slice(0, 120) });
    decide('deny', TAMPER_REASON);
  }

  if (lib.isPaused(state)) {
    // Allowed, but the weekly review sees lasting instructions written while mentor mode was off.
    const lasting = [editFile, ...mcpTargets].filter((f) => f && isLastingInstruction(f, cwd));
    for (const f of lasting) lib.logEvent(proj, 'persist_write', { tool, file: f });
    process.exit(0);
  }

  if (EDIT_TOOLS.has(tool)) {
    if (editFile && isAllowedPath(editFile, cwd)) process.exit(0);
    lib.logEvent(proj, 'edit_block', { tool, file: editFile ? rel(editFile) : '' });
    decide('deny', EDIT_REASON);
  }

  const blocked = mcpTargets.find((p) => !isAllowedPath(p, cwd));
  if (blocked) {
    lib.logEvent(proj, 'edit_block', { tool, file: rel(blocked) });
    decide('deny', EDIT_REASON);
  }

  if (cfg.bashGuard !== 'off' && commands.some(looksLikeWrite)) {
    if (cfg.bashGuard === 'deny') {
      lib.logEvent(proj, 'shell_block', { tool, command: commands.join(' ').slice(0, 120) });
      decide('deny', EDIT_REASON + ' This command looks like it writes files.');
    }
    decide('ask', lib.t(cfg, 'bashAsk'));
  }

  process.exit(0);
}

// A broken hook fails open for reading and running, but closed for file changes.
function failClosed(input) {
  if (!input) return false;
  const tool = String(input.tool_name || '');
  return EDIT_TOOLS.has(tool) || (tool.startsWith('mcp__') && mcpWriteTargets(tool, input.tool_input || {}).length > 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    lib.logError('pre-tool', err);
    try {
      if (failClosed(current)) decide('deny', ERROR_REASON);
    } catch {
      // nothing more to do
    }
    process.exit(0);
  }
}

module.exports = { looksLikeWrite, isAllowedPath, isProtectedPath, isLastingInstruction, isTamper, isSafeRead, mcpWriteTargets, mcpCommands };
