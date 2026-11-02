'use strict';
// Shared state, config, git and message helpers for the mentor hooks.
// Hooks run as `node <script>` with the hook input as JSON on stdin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'mentor-data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const LEARNING_FILE = path.join(DATA_DIR, 'LEARNING.md');
const ERROR_FILE = path.join(DATA_DIR, 'errors.log');

const MAX_HINT = 4;
// A gap between interactions longer than this counts only up to this much as work time.
const IDLE_MS = 60 * 60000;
const DIFF_LIMIT = 8000;
const LEVELS = {
  en: ['none', 'direction', 'concept', 'API', 'sketch'],
  pl: ['brak', 'kierunek', 'koncept', 'API', 'szkic'],
};
// What Claude may reveal at each level (model-facing, English).
const LEVEL_SCOPE = [
  'no hints yet: questions about the plan only',
  'direction: where in the repo to look and which question to ask, no names of APIs or patterns',
  'concept: the idea or pattern that solves it and why, plus a link to official docs, no task-specific code',
  'API: the concrete functions, types or signatures to use and how they fit, no assembled solution',
  'sketch: a skeleton or pseudocode with the key lines left as TODO for the user, never a complete working solution',
];

// Word boundaries that know Polish letters: JS `\b` treats ę, ż… as non-word characters,
// so `\bnapisz\b` would also match the first-person "napiszę".
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
// Built-in pattern for "give me ready-made code" prompts, Polish (with and without diacritics) and English.
const DEFAULT_GATE = [
  `${B}(napisz|zaimplementuj|zakoduj|wygeneruj|dopisz|przepisz|napraw|popraw)${E}`,
  `${B}(daj|poka[zż])\\s+(mi\\s+)?(ca[lł]y\\s+|gotowy\\s+)?(kod|gotowca|gotowe|rozwi[aą]zanie)${E}`,
  `${B}zr[oó]b\\s+to${E}`,
  `${B}write\\s+(me\\s+)?(the\\s+|a\\s+|this\\s+)?(code|function|implementation|component|class|test|script|fix)`,
  `${B}implement\\s+(it|this|that|the)${E}`,
  `${B}(generate|give\\s+me|show\\s+me)\\s+(the\\s+)?(code|solution|implementation)`,
  `${B}fix\\s+(it|this|that)${E}`,
  `${B}just\\s+do\\s+it${E}`,
].join('|');

const MESSAGES = {
  pl: {
    gateBlocked:
      '🧭 Mentor: najpierw Twoja próba. {why}\n' +
      "Prośba o gotowy kod nie poszła do Claude'a. Możesz:\n" +
      '  • /mentor:hint — wziąć kolejny poziom podpowiedzi\n' +
      '  • /mentor:try <hipoteza> — opisać własną diagnozę albo pomysł (bez edycji plików)\n' +
      '  • zapisać w kodzie choćby szkic, a potem poprosić o review\n' +
      '  • /mentor:off <powód> — zrobić przerwę na {min} min (trafia do przeglądu tygodnia)',
    whyTask: 'Od startu zadania „{task}” w repo nic się nie zmieniło.',
    whyClean: 'W repo nie ma żadnych zmian.',
    offNeedsReason: '🧭 Mentor: podaj powód przerwy, np. /mentor:off pilny hotfix. Powód trafia do przeglądu tygodnia.',
    taskNeedsTitle: '🧭 Mentor: podaj nazwę zadania, np. /mentor:task walidacja formularza.',
    tryNeedsText: '🧭 Mentor: opisz swoją próbę albo hipotezę choć jednym pełnym zdaniem, np. /mentor:try podejrzewam, że subskrypcja nie jest odnawiana po zmianie trasy.',
    tryAccepted: '🧭 Próba zapisana. Bramka dla „{task}” otwarta.',
    paused: '🧭 Mentor wstrzymany w tym repo do {time}. Powód: {reason}',
    resumed: '🧭 Mentor znów aktywny.',
    alreadyActive: '🧭 Mentor był aktywny.',
    taskStarted: '🧭 Zadanie: {task}. Podpowiedzi od zera.',
    hintLevel: '🧭 Podpowiedź {n}/4 · {name}',
    hintMax: '🧭 Podpowiedź 4/4 · szkic (wyżej drabina nie sięga)',
    taskDone: '🧭 Zamknięte: {task} · podpowiedzi {n}/4 · {min} min pracy',
    noTask: '🧭 Brak otwartego zadania w tym repo.',
    bashAsk: 'Mentor: ta komenda wygląda na zapis do plików. Zgódź się tylko, jeśli to Twoja decyzja.',
  },
  en: {
    gateBlocked:
      '🧭 Mentor: your attempt first. {why}\n' +
      'The request for ready-made code was not sent to Claude. You can:\n' +
      '  • /mentor:hint — take the next hint level\n' +
      '  • /mentor:try <hypothesis> — describe your own diagnosis or idea (no file edits needed)\n' +
      '  • write even a rough draft in the code, then ask for a review\n' +
      '  • /mentor:off <reason> — pause for {min} min (shows up in the weekly review)',
    whyTask: 'Nothing in the repo has changed since task "{task}" started.',
    whyClean: 'The repo has no changes at all.',
    offNeedsReason: '🧭 Mentor: give a reason for the pause, e.g. /mentor:off urgent hotfix. It shows up in the weekly review.',
    taskNeedsTitle: '🧭 Mentor: name the task, e.g. /mentor:task form validation.',
    tryNeedsText: '🧭 Mentor: describe your attempt or hypothesis in at least one full sentence, e.g. /mentor:try I suspect the subscription is not renewed after the route changes.',
    tryAccepted: '🧭 Attempt recorded. The gate for "{task}" is open.',
    paused: '🧭 Mentor paused in this repo until {time}. Reason: {reason}',
    resumed: '🧭 Mentor is active again.',
    alreadyActive: '🧭 Mentor was already active.',
    taskStarted: '🧭 Task: {task}. Hints start from zero.',
    hintLevel: '🧭 Hint {n}/4 · {name}',
    hintMax: '🧭 Hint 4/4 · sketch (the ladder ends here)',
    taskDone: '🧭 Closed: {task} · hints {n}/4 · {min} min of work',
    noTask: '🧭 No open task in this repo.',
    bashAsk: 'Mentor: this command looks like it writes files. Allow it only if it is your call.',
  },
};

function option(key, fallback) {
  const v = process.env['CLAUDE_PLUGIN_OPTION_' + key.toUpperCase()];
  return v === undefined || v === '' ? fallback : v;
}

function config() {
  const minutes = Number(option('off_minutes', 30));
  return {
    lang: option('language', 'pl') === 'en' ? 'en' : 'pl',
    offMinutes: Number.isFinite(minutes) ? Math.min(240, Math.max(5, minutes)) : 30,
    focusTopics: option('focus_topics', ''),
    bashGuard: !/^(false|0|no|off)$/i.test(String(option('bash_guard', 'true'))),
    gateRegex: option('gate_regex', ''),
  };
}

// The user's own pattern is compiled without the `u` flag, so plain regexes keep working.
function gate(cfg) {
  if (cfg.gateRegex) {
    try {
      return new RegExp(cfg.gateRegex, 'i');
    } catch (err) {
      logError('gate_regex', err);
    }
  }
  return new RegExp(DEFAULT_GATE, 'iu');
}

function t(cfg, key, vars = {}) {
  return MESSAGES[cfg.lang][key].replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
}

function levelName(cfg, n) {
  return LEVELS[cfg.lang][n];
}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Pauses and tasks are both kept per project. A global `pause` from 0.1 is dropped.
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { pauses: s.pauses || {}, tasks: s.tasks || {} };
  } catch {
    return { pauses: {}, tasks: {} };
  }
}

function saveState(state) {
  ensureDir();
  const tmp = STATE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function projectDir(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

function projectKey(dir) {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

function logEvent(dir, type, data = {}) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), type, project: path.basename(dir), ...data });
  fs.appendFileSync(EVENTS_FILE, line + '\n');
}

function logError(where, err) {
  try {
    ensureDir();
    fs.appendFileSync(ERROR_FILE, `${new Date().toISOString()} ${where}: ${err && err.stack ? err.stack : err}\n`);
  } catch {
    // nothing left to report to
  }
}

function isPaused(state, key) {
  const pause = state.pauses[key];
  return Boolean(pause && Date.now() < pause.until);
}

// Ends an expired pause of this project. Returns true when the state changed.
function expirePause(state, dir, key) {
  const pause = state.pauses[key];
  if (!pause || Date.now() < pause.until) return false;
  logEvent(dir, 'resume', { auto: true });
  const task = state.tasks[key];
  if (task) task.lastActiveAt = Math.max(task.lastActiveAt || task.startedAt, pause.until);
  delete state.pauses[key];
  return true;
}

// Adds the time since the last interaction to the task's work time, capped at IDLE_MS
// so a task left open overnight does not count the night. Paused time is not counted.
function touchTask(task, paused, now = Date.now()) {
  const last = task.lastActiveAt || task.startedAt;
  if (!paused) task.activeMs = (task.activeMs || 0) + Math.min(Math.max(0, now - last), IDLE_MS);
  task.lastActiveAt = now;
}

function fmtTime(cfg, ms) {
  return new Date(ms).toLocaleTimeString(cfg.lang === 'pl' ? 'pl-PL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

// quotePath=false keeps non-ASCII file names readable instead of octal escapes.
function git(dir, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function isGitRepo(dir) {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function headCommit(dir) {
  try {
    return git(dir, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null; // not a repo, or no commits yet
  }
}

// Hash of everything the user could have changed: the current commit (so committing
// work in progress still counts), tracked diffs and untracked files.
// null when dir is not a git work tree.
function fingerprint(dir) {
  if (!isGitRepo(dir)) return null;
  const hash = crypto.createHash('sha1');
  hash.update(`HEAD:${headCommit(dir) || ''}\n`);
  const status = git(dir, ['status', '--porcelain=v1', '-uall']);
  hash.update(status);
  try {
    hash.update(git(dir, ['diff', 'HEAD']));
  } catch {
    hash.update(git(dir, ['diff'])); // repository without commits yet
  }
  const root = git(dir, ['rev-parse', '--show-toplevel']).trim();
  for (const line of status.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    try {
      const st = fs.statSync(path.join(root, line.slice(3).replace(/^"|"$/g, '')));
      hash.update(`${line}:${st.size}:${st.mtimeMs}`);
    } catch {
      // file vanished between status and stat
    }
  }
  return hash.digest('hex');
}

function isDirty(dir) {
  if (!isGitRepo(dir)) return null;
  return git(dir, ['status', '--porcelain=v1']).trim() !== '';
}

// `git status --short` plus the diff against the commit the task started from,
// so work committed during the task is part of the review. null outside git.
function changesSince(dir, head) {
  if (!isGitRepo(dir)) return null;
  const status = git(dir, ['status', '--short', '-uall']).trim();
  let diff = '';
  try {
    diff = git(dir, ['diff', head || 'HEAD']);
  } catch {
    diff = git(dir, ['diff']);
  }
  if (diff.length > DIFF_LIMIT) {
    diff = diff.slice(0, DIFF_LIMIT) + `\n[… diff truncated at ${DIFF_LIMIT} characters; run git diff ${head ? head.slice(0, 7) : 'HEAD'} for the rest]`;
  }
  return { status, diff: diff.trim() };
}

// One factual line about the current mode, injected into Claude's context.
function statusLine(cfg, state, key) {
  if (isPaused(state, key)) {
    const pause = state.pauses[key];
    return `[mentor] PAUSED in this project until ${fmtTime(cfg, pause.until)} (reason: ${pause.reason}). ` +
      'Mentor mode is off for now: normal assistant behaviour, file edits are allowed.';
  }
  const task = state.tasks[key];
  const taskPart = task
    ? `task: "${task.title}" · hint level ${task.hint}/${MAX_HINT} (${LEVELS.en[task.hint]})`
    : 'no task started (/mentor:task)';
  return `[mentor] ACTIVE · ${taskPart} · file edits in the project are blocked by a hook.`;
}

function readEvents(sinceMs) {
  let text = '';
  try {
    text = fs.readFileSync(EVENTS_FILE, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.ts) >= sinceMs) events.push(e);
    } catch {
      // skip a damaged line
    }
  }
  return events;
}

// Plain-text summary of the last `days` days for the weekly review.
function stats(days) {
  const events = readEvents(Date.now() - days * 86400000);
  const done = events.filter((e) => e.type === 'task_done');
  const pauses = events.filter((e) => e.type === 'pause');
  const byLevel = [0, 0, 0, 0, 0];
  for (const e of done) byLevel[Math.min(MAX_HINT, e.hint || 0)]++;
  const count = (type) => events.filter((e) => e.type === type).length;
  const workMinutes = done.reduce((sum, d) => sum + (d.minutes || 0), 0);
  const lines = [
    `[mentor] Stats for the last ${days} days (from ${EVENTS_FILE}):`,
    `- tasks started: ${count('task_start')}, closed: ${done.length}, work time on closed tasks: ${workMinutes} min`,
    `- closed tasks by highest hint level: ` +
      byLevel.map((n, i) => `${i} ${LEVELS.en[i]}: ${n}`).join(', '),
    `- hints requested: ${count('hint')}`,
    `- attempts described with /mentor:try: ${count('try')}`,
    `- "ready-made code" prompts stopped by the gate: ${count('gate_block')}`,
    `- file edits blocked: ${count('edit_block')}`,
    `- what's-new checks: ${count('whats_new')}`,
    `- pauses (/mentor:off): ${pauses.length}`,
  ];
  for (const p of pauses) lines.push(`  - ${p.ts.slice(0, 16).replace('T', ' ')} [${p.project}] ${p.reason}`);
  if (done.length) lines.push('- closed tasks:');
  for (const d of done) {
    lines.push(`  - ${d.ts.slice(0, 10)} [${d.project}] "${d.title}" · hint ${d.hint}/${MAX_HINT} · ${d.minutes} min` +
      (d.learned ? ` · user's note: ${d.learned}` : ''));
  }
  return lines.join('\n');
}

function appendLearning(entry) {
  ensureDir();
  if (!fs.existsSync(LEARNING_FILE)) {
    fs.writeFileSync(LEARNING_FILE, '# Learning journal\n\nWritten by the mentor plugin (/mentor:done, /mentor:review-week).\n');
  }
  fs.appendFileSync(LEARNING_FILE, '\n' + entry.trim() + '\n');
}

// Prints a hook JSON result and exits 0.
function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Blocks the prompt; the message is shown to the user, not to Claude.
function blockPrompt(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

module.exports = {
  DATA_DIR, EVENTS_FILE, LEARNING_FILE, MAX_HINT, IDLE_MS, LEVELS, LEVEL_SCOPE, DEFAULT_GATE,
  config, gate, t, levelName, readInput, loadState, saveState, projectDir, projectKey, logEvent, logError,
  isPaused, expirePause, touchTask, fmtTime, headCommit, fingerprint, isDirty, changesSince, statusLine, stats,
  appendLearning, respond, blockPrompt,
};
