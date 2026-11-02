'use strict';
// Shared state, config, git and message helpers for the mentor hooks.
// Hooks run as `node <script>` with the hook input as JSON on stdin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'mentor-data');
const STATE_DIR = path.join(DATA_DIR, 'state');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PRUNE_STAMP = path.join(DATA_DIR, 'events.pruned');
const LEARNING_FILE = path.join(DATA_DIR, 'LEARNING.md');
const ERROR_FILE = path.join(DATA_DIR, 'errors.log');
const MARKER = '.mentor';

const MAX_HINT = 4;
// A gap between interactions longer than this counts only up to this much as work time.
const IDLE_MS = 60 * 60000;
const DIFF_LIMIT = 12000;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const SESSIONS_KEPT = 5;
// From this pause of the day on, /mentor:off wants a longer reason.
const PAUSES_BEFORE_LONG_REASON = 2;
const LONG_REASON = 40;
// git's well-known empty tree, the diff base for a repository without commits.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Bumped when the way snapshots are hashed changes; older baselines are taken again.
const SNAPSHOT_V = 2;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;

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

// Generated files, lock files and build output do not count as the user's attempt and stay out of
// the review diff. gitignore-like: a leading "/" (or a slash inside) anchors at the repo root, so
// /build/ skips the build output but not scripts/build/. Ignored files are left out by git anyway.
const DEFAULT_IGNORE = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
  '/dist/', '/build/', '/out/', '/coverage/', '/target/',
  'node_modules/', '.next/', '.nuxt/', '.angular/', '.cache/', '__pycache__/', '.nyc_output/', '.pytest_cache/', '.turbo/',
  '*.log', '*.map', '*.min.js', '*.pyc', '.DS_Store', MARKER,
];

// Word boundaries that know Polish letters: JS `\b` treats ę, ż… as non-word characters,
// so `\bnapisz\b` would also match the first-person "napiszę".
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
// Built-in pattern for "do it for me" prompts, Polish (with and without diacritics) and English.
// Imperatives only; questions are filtered out separately (see isQuestion).
const DEFAULT_GATE = [
  `${B}(napisz|zaimplementuj|zakoduj|wygeneruj|dopisz|przepisz|napraw|stw[oó]rz|utw[oó]rz|doko[nń]cz|uzupe[lł]nij|` +
    `rozwi[aą][zż]|dodaj|zrefaktoryzuj|zrefaktoruj|przer[oó]b)${E}`,
  `${B}popraw${E}(?!\\s+mnie)`,
  `${B}(daj|poka[zż])\\s+(mi\\s+)?(ca[lł]y\\s+kod|gotowy\\s+kod|gotowca|gotowe|rozwi[aą]zanie)${E}`,
  `${B}zr[oó]b\\s+(to|mi)${E}`,
  `${B}(mo[zż]esz|m[oó]g[lł]by[sś]|mog[lł]aby[sś])\\s+(mi\\s+)?(to\\s+)?(napisa[cć]|zaimplementowa[cć]|naprawi[cć]|poprawi[cć]|` +
    `dopisa[cć]|stworzy[cć]|doko[nń]czy[cć]|zrobi[cć]|rozwi[aą]za[cć]|doda[cć]|przerobi[cć]|zrefaktoryzowa[cć])${E}`,
  `${B}(napiszesz|naprawisz|poprawisz|zrobisz|dopiszesz)\\s+(mi|to)${E}`,
  `${B}zmie[nń]\\s+(mi\\s+)?(to|ten|t[eę]|tego|go|j[aą])${E}`,
  `${B}zr[oó]b\\s+reszt[eę]${E}`,
  `${B}potrzebuj[eę]\\s+(gotowego|gotowy|ca[lł]ego|ca[lł]y)\\s+(kodu|kod|rozwi[aą]zania|rozwi[aą]zanie)${E}`,
  `${B}(write|create|build|add|implement|refactor|rewrite|complete|generate|code|convert|change|update|make)\\s+(me\\s+)?` +
    `(it|this|that|the|a|an|my|some|missing|new|up|these|those)${E}`,
  `${B}code\\s+(it|this|that)\\s+up${E}`,
  `${B}give\\s+me\\s+(the\\s+|a\\s+|an\\s+)?(\\w+\\s+)?(code|solution|implementation|fix|function|class|component|method|script|snippet|test)${E}`,
  `${B}show\\s+me\\s+(the\\s+)?(solution|implementation|fixed\\s+code|full\\s+code|complete\\s+code)${E}`,
  `${B}(fix|solve|finish)\\s+(it|this|that)${E}`,
  `${B}(do|finish|write)\\s+the\\s+rest${E}`,
  `${B}make\\s+it\\s+work${E}`,
  `${B}(just|please)\\s+do\\s+it${E}`,
  `${B}do\\s+it\\s+for\\s+me${E}`,
].join('|');

// What the user pasted is not what they ask for: fenced and indented code, quotes, comment lines
// and inline code are removed before the gate looks at the prompt.
function stripPasted(prompt) {
  return prompt
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, ' ')
    .replace(/^\s*(```|~~~)[\s\S]*$/m, ' ') // an unclosed fence runs to the end
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^(\s{4,}|\t)\S/.test(line) && !/^\s*(>|\/\/|#|\/\*|\*|--\s)/.test(line))
    .join('\n');
}

// "I want to build a parser", "let me write the code myself": the user describes their own work.
const FIRST_PERSON_I = /(^|[^\p{L}])I(?![\p{L}])/u; // uppercase only: Polish "i" means "and"
const FIRST_PERSON = /(^|[^\p{L}])(i'll|i'd|i'm|i've|we|we'll|we're|we've|let\s+me|let's|lemme)(?![\p{L}])/iu;
const firstPerson = (prefix) => FIRST_PERSON_I.test(prefix) || FIRST_PERSON.test(prefix);

// A sentence that asks for information, not for work. "Can you…/czy możesz…" stays a request.
const QUESTION_START = new RegExp(
  `^(how|what|why|when|where|which|who|whose|is|are|was|should|shall|am)${E}(?!\\s+you${E})|` +
  `^(do|does|did)\\s+(i|we|they|it|this|that|these|those|people|my)${E}|` +
  `^(jak|jaki|jaka|jakie|co|czemu|dlaczego|gdzie|kiedy|kt[oó]ry|kt[oó]ra|kt[oó]re|ile|po\\s+co)${E}|` +
  `^czy${E}(?!\\s+(mo[zż]esz|m[oó]g[lł]by[sś]|mog[lł]aby[sś]|dasz\\s+rad[eę]|zrobisz|napiszesz|poprawisz|naprawisz))`,
  'iu');

const MESSAGES = {
  pl: {
    gateBlocked:
      '🧭 Mentor: najpierw Twoja próba. {why}\n' +
      "Prośba o gotowy kod nie poszła do Claude'a. Możesz:\n" +
      '  • /mentor:hint — wziąć kolejny poziom podpowiedzi\n' +
      '  • /mentor:try <hipoteza> — opisać własną diagnozę albo to, co już zrobiłeś (bez edycji plików)\n' +
      '  • zapisać w kodzie choćby szkic, a potem poprosić o review\n' +
      '  • /mentor:off <powód> — zrobić przerwę na {min} min (trafia do przeglądu tygodnia)',
    whyTask: 'Od startu zadania „{task}” w kodzie zmieniło się {n} z wymaganych {need} linii.',
    whySession: 'Od początku tej sesji w kodzie zmieniło się {n} z wymaganych {need} linii (pliki generowane i lockfile się nie liczą).',
    offNeedsReason: '🧭 Mentor: podaj powód przerwy, np. /mentor:off pilny hotfix. Powód trafia do przeglądu tygodnia.',
    offNeedsLonger: '🧭 Mentor: to {n}. przerwa dzisiaj. Opisz powód pełniej, co najmniej {need} znaków: co jest pilne i czemu teraz.',
    taskNeedsTitle: '🧭 Mentor: podaj nazwę zadania, np. /mentor:task walidacja formularza.',
    tryNeedsText: '🧭 Mentor: opisz swoją próbę albo hipotezę choć jednym pełnym zdaniem, np. /mentor:try podejrzewam, że subskrypcja nie jest odnawiana po zmianie trasy.',
    tryAccepted: '🧭 Próba zapisana. Bramka dla „{task}” otwarta.',
    paused: '🧭 Mentor wstrzymany w tym repo do {time}. Powód: {reason}',
    resumed: '🧭 Mentor znów aktywny.',
    alreadyActive: '🧭 Mentor był aktywny.',
    taskStarted: '🧭 Zadanie: {task}. Podpowiedzi od zera.',
    hintLevel: '🧭 Podpowiedź {n}/{max} · {name}',
    hintMax: '🧭 Podpowiedź {max}/{max} · szkic (wyżej drabina nie sięga)',
    taskDone: '🧭 Zamknięte: {task} · podpowiedzi {n}/{max} · {min} min pracy',
    noTask: '🧭 Brak otwartego zadania w tym repo.',
    bashAsk: 'Mentor: ta komenda wygląda na zapis do plików. Zgódź się tylko, jeśli to Twoja decyzja.',
    enabled: '🧭 Mentor włączony w tym repo.',
    disabled: '🧭 Mentor wyłączony w tym repo.',
    disabledMarker: '🧭 Mentor zostaje włączony: w repo jest plik .mentor. Usuń go sam, jeśli chcesz wyłączyć.',
    activationAlways: '🧭 Mentor działa w każdym repo (activation = always). Przerwa: /mentor:off <powód>; tryb per repo: ustaw activation = marker w /config.',
    inactive: '🧭 Mentor nie jest włączony w tym repo (activation = marker). Włącz: /mentor:enable albo plik .mentor w korzeniu repo.',
  },
  en: {
    gateBlocked:
      '🧭 Mentor: your attempt first. {why}\n' +
      'The request for ready-made code was not sent to Claude. You can:\n' +
      '  • /mentor:hint — take the next hint level\n' +
      '  • /mentor:try <hypothesis> — describe your own diagnosis or what you already did (no file edits needed)\n' +
      '  • write even a rough draft in the code, then ask for a review\n' +
      '  • /mentor:off <reason> — pause for {min} min (shows up in the weekly review)',
    whyTask: 'Since task "{task}" started, {n} of the required {need} lines of code have changed.',
    whySession: 'Since this session started, {n} of the required {need} lines of code have changed (generated files and lock files do not count).',
    offNeedsReason: '🧭 Mentor: give a reason for the pause, e.g. /mentor:off urgent hotfix. It shows up in the weekly review.',
    offNeedsLonger: '🧭 Mentor: this is pause no. {n} today. Describe the reason more fully, at least {need} characters: what is urgent and why now.',
    taskNeedsTitle: '🧭 Mentor: name the task, e.g. /mentor:task form validation.',
    tryNeedsText: '🧭 Mentor: describe your attempt or hypothesis in at least one full sentence, e.g. /mentor:try I suspect the subscription is not renewed after the route changes.',
    tryAccepted: '🧭 Attempt recorded. The gate for "{task}" is open.',
    paused: '🧭 Mentor paused in this repo until {time}. Reason: {reason}',
    resumed: '🧭 Mentor is active again.',
    alreadyActive: '🧭 Mentor was already active.',
    taskStarted: '🧭 Task: {task}. Hints start from zero.',
    hintLevel: '🧭 Hint {n}/{max} · {name}',
    hintMax: '🧭 Hint {max}/{max} · sketch (the ladder ends here)',
    taskDone: '🧭 Closed: {task} · hints {n}/{max} · {min} min of work',
    noTask: '🧭 No open task in this repo.',
    bashAsk: 'Mentor: this command looks like it writes files. Allow it only if it is your call.',
    enabled: '🧭 Mentor enabled in this repo.',
    disabled: '🧭 Mentor disabled in this repo.',
    disabledMarker: '🧭 Mentor stays on: the repo has a .mentor file. Remove it yourself to turn mentor mode off here.',
    activationAlways: '🧭 Mentor runs in every repo (activation = always). Pause: /mentor:off <reason>; per-repo mode: set activation = marker in /config.',
    inactive: '🧭 Mentor is not enabled in this repo (activation = marker). Turn it on: /mentor:enable or a .mentor file at the repo root.',
  },
};

function option(key, fallback) {
  const v = process.env['CLAUDE_PLUGIN_OPTION_' + key.toUpperCase()];
  return v === undefined || v === '' ? fallback : v;
}

function intOption(key, fallback, min, max) {
  const n = Number(option(key, fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

// Explicit pl/en, otherwise the system locale.
function language() {
  const v = String(option('language', '')).toLowerCase();
  if (v === 'pl' || v === 'en') return v;
  let locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  if (!locale) {
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      locale = '';
    }
  }
  return /^pl/i.test(locale) ? 'pl' : 'en';
}

const isOff = (v) => /^(false|0|no|off)$/i.test(String(v));

// ask (default), deny or off, from the bash_guard and bash_guard_deny switches.
function guardMode() {
  if (isOff(option('bash_guard', 'true'))) return 'off';
  return isOff(option('bash_guard_deny', 'false')) ? 'ask' : 'deny';
}

function config() {
  return {
    lang: language(),
    offMinutes: intOption('off_minutes', 30, 5, 240),
    focusTopics: option('focus_topics', ''),
    bashGuard: guardMode(),
    gateRegex: option('gate_regex', ''),
    activation: option('activation', 'always') === 'marker' ? 'marker' : 'always',
    minLines: intOption('attempt_min_lines', 3, 1, 100),
    ignore: String(option('attempt_ignore', '')).split(',').map((s) => s.trim()).filter(Boolean),
    keepDays: intOption('keep_days', 90, 7, 3650),
    chatCodeLines: intOption('chat_code_lines', 15, 3, 500),
  };
}

// The user's own pattern is compiled without the `u` flag, so plain regexes keep working.
function gate(cfg, flags = '') {
  if (cfg.gateRegex) {
    try {
      return new RegExp(cfg.gateRegex, 'i' + flags);
    } catch (err) {
      logError('gate_regex', err);
    }
  }
  return new RegExp(DEFAULT_GATE, 'iu' + flags);
}

const POLITE_REQUEST = /^(can|could|would|will)\s+you\b|^(czy\s+)?(mo[zż]esz|m[oó]g[lł]by[sś]|mog[lł]aby[sś]|zrobisz|napiszesz|poprawisz|naprawisz)/iu;
const FILLER = /^([\s"'„“(*_-]+|(a|i|no|ok|okej|dobra|so|and|but|ok so)[,\s]+)+/iu;

// An information question ("how do I fix this?", "czy powinienem dopisać test?"), as opposed to
// a request phrased as a question ("can you write it?") or an order with a question mark.
function isQuestion(sentence, re) {
  const s = sentence.trim().replace(FILLER, '');
  if (POLITE_REQUEST.test(s)) return false;
  if (QUESTION_START.test(s)) return true;
  if (!/\?\s*$/.test(s)) return false;
  const m = s.match(re);
  return Boolean(m && m.index > 0); // "napisz to?" starts with the order itself
}

// True when some sentence of the prompt asks Claude to do the work. A match counts unless the
// sentence is an information question or the verb belongs to the user ("I need to implement…").
function asksForCode(cfg, prompt) {
  const re = gate(cfg);
  const all = gate(cfg, 'g');
  const sentences = stripPasted(prompt).split(/(?<=[.!?…])\s+|\n+/).filter((s) => s.trim());
  return sentences.some((s) => {
    if (!re.test(s) || isQuestion(s, re)) return false;
    return [...s.matchAll(all)].some((m) => !firstPerson(s.slice(0, m.index)));
  });
}

function t(cfg, key, vars = {}) {
  return MESSAGES[cfg.lang][key].replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : k === 'max' ? String(MAX_HINT) : ''));
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

function ensureDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

// quotePath=false keeps non-ASCII file names readable instead of octal escapes.
function git(dir, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// The project is the repository root, so a session opened in repo/src shares the task and the
// pause with one opened in repo/. Outside git it is the project directory itself.
function project(input) {
  const start = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  let dir = start;
  let isGit = false;
  try {
    const top = git(start, ['rev-parse', '--show-toplevel']).trim();
    if (top) {
      dir = path.resolve(top);
      isGit = true;
    }
  } catch {
    // not a git work tree
  }
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
  return { dir, key, id: sha1(key).slice(0, 10), name: path.basename(dir), git: isGit };
}

// One state file per project: two sessions in different repos never overwrite each other.
function stateFile(proj) {
  return path.join(STATE_DIR, proj.id + '.json');
}

// The single state.json of 0.2 is read once per project as a migration.
function legacyState(proj) {
  try {
    const s = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    const pick = (map) => (map ? map[proj.key] || null : null);
    return { pause: pick(s.pauses), task: pick(s.tasks) };
  } catch {
    return {};
  }
}

function loadState(proj) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(stateFile(proj), 'utf8'));
  } catch {
    s = fs.existsSync(stateFile(proj)) ? {} : legacyState(proj);
  }
  return {
    key: proj.key, pause: s.pause || null, task: s.task || null,
    sessions: s.sessions || {}, enabled: Boolean(s.enabled),
  };
}

function saveState(proj, state) {
  ensureDir(STATE_DIR);
  const file = stateFile(proj);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function logEvent(proj, type, data = {}) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), type, project: proj.name, pid: proj.id, ...data });
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

const pad = (n) => String(n).padStart(2, '0');

// Dates the user sees and Leitner due dates are local, not UTC: between midnight and 1–2 a.m. in
// Poland toISOString() still says yesterday.
function localDate(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTime(ms) {
  const d = new Date(ms);
  return `${localDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Serialises read-modify-write of one project's state between sessions in the same repo.
// Never blocks for long: after LOCK_WAIT_MS it goes on without the lock rather than hang a prompt.
function lockState(proj) {
  const file = stateFile(proj) + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    ensureDir(STATE_DIR);
  } catch {
    return () => {};
  }
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') return () => {};
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        continue; // released in the meantime
      }
      if (Date.now() > deadline) return () => {};
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.on('exit', release); // respond() and blockPrompt() end the process directly
  return release;
}

// Drops events older than keep_days, at most once a day.
function pruneEvents(cfg, now = Date.now()) {
  const today = localDate(now);
  try {
    if (fs.readFileSync(PRUNE_STAMP, 'utf8').trim() === today) return;
  } catch {
    // never pruned
  }
  ensureDir();
  if (fs.existsSync(EVENTS_FILE)) {
    const cutoff = now - cfg.keepDays * 86400000;
    const kept = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        return Date.parse(JSON.parse(line).ts) >= cutoff;
      } catch {
        return false;
      }
    });
    const tmp = EVENTS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
    fs.renameSync(tmp, EVENTS_FILE);
  }
  fs.writeFileSync(PRUNE_STAMP, today);
}

// Mentor mode applies here: always, or with activation = marker only after /mentor:enable or a .mentor file.
function isEnabled(cfg, proj, state) {
  return cfg.activation === 'always' || state.enabled || fs.existsSync(path.join(proj.dir, MARKER));
}

function isPaused(state) {
  return Boolean(state.pause && Date.now() < state.pause.until);
}

// Mentor rules are in force: enabled for the project and not paused.
function isActive(cfg, proj, state) {
  return isEnabled(cfg, proj, state) && !isPaused(state);
}

// Ends an expired pause. Returns true when the state changed.
function expirePause(proj, state) {
  const pause = state.pause;
  if (!pause || Date.now() < pause.until) return false;
  logEvent(proj, 'resume', { auto: true });
  if (state.task) state.task.lastActiveAt = Math.max(state.task.lastActiveAt || state.task.startedAt, pause.until);
  state.pause = null;
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

function headCommit(dir) {
  try {
    return git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  } catch {
    return null; // no commits yet
  }
}

function gitTry(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return '';
  }
}

function isAncestor(dir, a, b) {
  try {
    git(dir, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

// The commit to compare against. Starts as the task's (or session's) starting commit, but work
// that came from elsewhere is not the user's attempt: after a branch switch or rebase it moves to
// the merge base, and past the newest merge, commit by another author or commit made before the
// task started (`since`, ms) it moves to that commit.
function effectiveBase(proj, base, since = 0) {
  const dir = proj.dir;
  const head = headCommit(dir);
  if (!base || base === EMPTY_TREE || !head || head === base) return { base, note: null };
  let start = base;
  let note = null;
  if (!isAncestor(dir, base, head)) {
    start = gitTry(dir, ['merge-base', base, head]).trim() || head;
    note = 'HEAD no longer descends from the starting commit (branch switch or rebase)';
  }
  if (start === head) return { base: head, note };
  const email = gitTry(dir, ['config', 'user.email']).trim().toLowerCase();
  for (const line of gitTry(dir, ['log', '--format=%H%x09%ae%x09%ct%x09%P', `${start}..${head}`]).split('\n')) {
    if (!line.trim()) continue; // newest first
    const [sha, author, time, parents] = line.split('\t');
    const merge = (parents || '').trim().split(/\s+/).length > 1;
    const foreign = email && author.toLowerCase() !== email;
    const older = since && Number(time) * 1000 < since - 1000;
    if (merge || foreign || older) {
      const why = merge ? 'a merge' : foreign ? `a commit by ${author}` : 'a commit from before the task';
      return { base: sha, note: (note ? note + '; ' : '') + `${why} came in, so only changes after ${sha.slice(0, 7)} count` };
    }
  }
  return { base: start, note };
}

// gitignore-like: a leading "/" or a slash inside anchors the pattern at the repo root.
function pathspecs(cfg) {
  const globs = [...DEFAULT_IGNORE, ...cfg.ignore].map((p) => {
    const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
    const g = p.replace(/^\.?\//, '');
    return `:(exclude,glob)${anchored ? '' : '**/'}${g.endsWith('/') ? g + '**' : g}`;
  });
  return ['.', ...globs];
}

// Splits `git diff` output into one chunk per file with its added and deleted line counts.
function splitDiff(diff) {
  const files = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    if (!text.startsWith('diff --git ')) continue;
    const plus = text.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    const minus = text.match(/^--- (?:a\/)?(.+)$/m);
    const header = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    let file = plus && plus[1] !== '/dev/null' ? plus[1] : minus && minus[1] !== '/dev/null' ? minus[1] : header ? header[2] : null;
    if (!file) continue;
    file = file.replace(/\t$/, '');
    let added = 0;
    let deleted = 0;
    const changed = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) deleted++;
      else continue;
      changed.push(line);
    }
    // Hashing only the changed lines keeps the hash stable when other changes shift line numbers.
    files.push({ file, text, added, deleted, h: sha1(changed.join('\n')) });
  }
  return files;
}

function untrackedFiles(dir, specs) {
  const out = git(dir, ['status', '--porcelain=v1', '-z', '-uall', '--', ...specs]);
  const tokens = out.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next token is the source path
    if (xy === '??') files.push(entry.slice(3));
  }
  return files;
}

function readUntracked(dir, rel) {
  try {
    const full = path.join(dir, rel);
    const st = fs.statSync(full);
    if (st.size > MAX_UNTRACKED_BYTES) return { h: `size:${st.size}:${st.mtimeMs}`, added: 1, text: null, note: `${st.size} bytes, too large to show` };
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) return { h: sha1(buf), added: 1, text: null, note: `binary, ${st.size} bytes` };
    const text = buf.toString('utf8');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const code = text.split('\n').filter((l) => /\S/.test(l)).length; // blank lines are not an attempt
    return { h: sha1(buf), added: lines, code, text };
  } catch {
    return null; // vanished between status and read
  }
}

// Per-file picture of every change against `base` (a commit; the task's or session's start),
// tracked and untracked, without generated files. null outside git. For counting (the default)
// whitespace and blank lines are ignored, so reformatting or empty lines are not an attempt;
// `review` keeps the plain diff for the eyes of the reviewer.
function snapshot(proj, cfg, base, review = false) {
  if (!proj.git) return null;
  const from = base || headCommit(proj.dir) || EMPTY_TREE;
  const specs = pathspecs(cfg);
  const args = ['diff', '--no-color', '--no-ext-diff', ...(review ? [] : ['-w', '--ignore-blank-lines'])];
  let diff;
  try {
    diff = git(proj.dir, [...args, from, '--', ...specs]);
  } catch {
    diff = git(proj.dir, [...args, headCommit(proj.dir) || EMPTY_TREE, '--', ...specs]);
  }
  const files = {};
  for (const c of splitDiff(diff)) files[c.file] = { h: c.h, n: c.added + c.deleted, added: c.added, deleted: c.deleted, text: c.text };
  for (const rel of untrackedFiles(proj.dir, specs)) {
    const u = readUntracked(proj.dir, rel);
    if (u) files[rel] = { h: u.h, n: u.code === undefined ? u.added : u.code, added: u.added, deleted: 0, untracked: true, text: u.text, note: u.note };
  }
  return { base: from, files };
}

// What goes into the state file: hashes and counts, no file contents.
function compact(snap) {
  if (!snap) return null;
  const files = {};
  for (const [f, v] of Object.entries(snap.files)) files[f] = { h: v.h, n: v.n };
  return { v: SNAPSHOT_V, base: snap.base, at: Date.now(), files };
}

const isCurrent = (baseline) => Boolean(baseline && baseline.v === SNAPSHOT_V);

// Lines of code changed between two snapshots.
function changedLines(before, now) {
  let n = 0;
  for (const f of new Set([...Object.keys(before.files), ...Object.keys(now.files)])) {
    const a = before.files[f];
    const b = now.files[f];
    if (a && b && a.h === b.h) continue;
    const na = a ? a.n : 0;
    const nb = b ? b.n : 0;
    n += Math.abs(nb - na) || (na || nb ? 1 : 0); // same count, different lines: at least one changed
  }
  return n;
}

function attemptLines(proj, cfg, baseline) {
  const now = snapshot(proj, cfg, effectiveBase(proj, baseline.base, baseline.at).base);
  return now ? changedLines(baseline, now) : Infinity;
}

// The review material for /mentor:done: files changed since the task started, a stat first,
// then whole files' diffs (new files included) until the budget runs out. null outside git.
function reviewDiff(proj, cfg, baseline) {
  if (!proj.git) return null;
  const status = git(proj.dir, ['status', '--short', '-uall']).trim();
  const eb = effectiveBase(proj, baseline && baseline.base, baseline && baseline.at);
  const count = snapshot(proj, cfg, eb.base);
  const now = snapshot(proj, cfg, eb.base, true);
  const before = baseline ? baseline.files : {};
  const changed = Object.keys(count.files)
    .filter((f) => (before[f] ? before[f].h !== count.files[f].h : count.files[f].n > 0) && now.files[f])
    .sort();
  const reverted = Object.keys(before).filter((f) => !count.files[f] && before[f].n > 0);
  const stat = changed.map((f) => {
    const v = now.files[f];
    return `  ${f} | +${v.added} -${v.deleted}${v.untracked ? ' (new, untracked)' : ''}${v.note ? ` (${v.note})` : ''}`;
  });
  for (const f of reverted) stat.push(`  ${f} | changes from before the task were reverted`);

  let budget = DIFF_LIMIT;
  const parts = [];
  const omitted = [];
  for (const f of changed) {
    const v = now.files[f];
    let text = v.text;
    if (v.untracked) {
      text = `diff --git a/${f} b/${f}\nnew file (untracked)\n--- /dev/null\n+++ b/${f}\n` +
        (v.text === null ? `[${v.note}]\n` : v.text.split('\n').map((l) => '+' + l).join('\n').replace(/\n\+$/, '') + '\n');
    }
    if (text.length > budget && parts.length) {
      omitted.push(f);
      continue;
    }
    if (text.length > budget) text = text.slice(0, budget) + `\n[… ${f} cut at ${DIFF_LIMIT} characters]\n`;
    parts.push(text.trimEnd());
    budget -= text.length;
  }
  return {
    base: now.base,
    note: eb.note,
    status,
    stat: stat.join('\n'),
    diff: parts.join('\n'),
    omitted,
  };
}

const hasSessionBaseline = (state, sessionId) => {
  const s = state.sessions[sessionId || 'default'];
  return Boolean(s && isCurrent(s.baseline));
};

// Baseline of the current session: changes made before it do not count as an attempt.
function sessionBaseline(proj, cfg, state, sessionId, now = Date.now()) {
  const id = sessionId || 'default';
  if (hasSessionBaseline(state, id)) return state.sessions[id].baseline;
  const baseline = compact(snapshot(proj, cfg));
  state.sessions[id] = { at: now, baseline };
  const ids = Object.keys(state.sessions).sort((a, b) => state.sessions[b].at - state.sessions[a].at);
  for (const old of ids.slice(SESSIONS_KEPT)) delete state.sessions[old];
  return baseline;
}

// One factual line about the current mode, injected into Claude's context.
function statusLine(cfg, proj, state) {
  if (!isEnabled(cfg, proj, state)) {
    return '[mentor] OFF in this project (activation = marker; no .mentor file, not enabled with /mentor:enable). ' +
      'Mentor mode does not apply here: normal assistant behaviour, file edits are allowed.';
  }
  if (isPaused(state)) {
    return `[mentor] PAUSED in this project until ${fmtTime(cfg, state.pause.until)} (reason: ${state.pause.reason}). ` +
      'Mentor mode is off for now: normal assistant behaviour, file edits are allowed.';
  }
  const task = state.task;
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

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pausesToday(now = Date.now()) {
  return readEvents(startOfToday(now)).filter((e) => e.type === 'pause').length;
}

// Plain-text summary of the last `days` days for the weekly review.
function stats(days) {
  const events = readEvents(Date.now() - days * 86400000);
  // Two repos with the same folder name get a short id so they do not blend together.
  const ids = {};
  for (const e of events) if (e.pid) (ids[e.project] = ids[e.project] || new Set()).add(e.pid);
  const label = (e) => (e.pid && ids[e.project] && ids[e.project].size > 1 ? `${e.project}#${e.pid.slice(0, 4)}` : e.project);

  const done = events.filter((e) => e.type === 'task_done');
  const pauses = events.filter((e) => e.type === 'pause');
  const chat = events.filter((e) => e.type === 'code_in_chat');
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
    `- file edits blocked: ${count('edit_block')}, attempts to change mentor's own state or settings blocked: ${count('tamper_block')}`,
    `- answers with a large block of new code while mentor mode was active: ${chat.length}` +
      (chat.length ? ` (${chat.map((c) => `${c.lines} lines at hint ${c.hint}/${MAX_HINT}`).join(', ')})` : ''),
    `- what's-new checks: ${count('whats_new')}`,
    `- mentor mode disabled for a repo (/mentor:disable): ${count('disable')}`,
    `- pauses (/mentor:off): ${pauses.length}`,
  ];
  const at = (e) => localDateTime(Date.parse(e.ts));
  for (const p of pauses) lines.push(`  - ${at(p)} [${label(p)}] ${p.reason}`);
  const persist = events.filter((e) => e.type === 'persist_write');
  if (persist.length) {
    lines.push(`- files with lasting instructions for Claude written during pauses: ${persist.length}`);
    for (const p of persist) lines.push(`  - ${at(p)} [${label(p)}] ${p.tool} ${p.file}`);
  }
  if (done.length) lines.push('- closed tasks:');
  for (const d of done) {
    lines.push(`  - ${at(d).slice(0, 10)} [${label(d)}] "${d.title}" · hint ${d.hint}/${MAX_HINT} · ${d.minutes} min` +
      (d.learned ? ` · user's note: ${d.learned}` : ''));
  }
  return lines.join('\n');
}

// Open repetition items due today or earlier: `- [ ] repeat: topic (box N, due YYYY-MM-DD)`;
// an item without a due date is due.
function dueRepeats(now = Date.now()) {
  let text = '';
  try {
    text = fs.readFileSync(LEARNING_FILE, 'utf8');
  } catch {
    return 0;
  }
  const today = localDate(now);
  let n = 0;
  for (const line of text.split('\n')) {
    if (!/^\s*- (\[ \] )?repeat:/.test(line)) continue;
    const due = line.match(/due (\d{4}-\d{2}-\d{2})/);
    if (!due || due[1] <= today) n++;
  }
  return n;
}

function appendLearning(entry) {
  ensureDir();
  if (!fs.existsSync(LEARNING_FILE)) {
    fs.writeFileSync(LEARNING_FILE, '# Learning journal\n\nWritten by the mentor plugin (/mentor:done, /mentor:review-week).\n');
  }
  fs.appendFileSync(LEARNING_FILE, '\n' + entry.trim() + '\n');
}

// Synchronous write that survives process.exit(). process.stdout.write is asynchronous
// for pipes on macOS, so a large result (a review with its diff) got cut off on exit.
function writeAll(fd, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // pipe full, let the reader drain it
    }
  }
}

// Prints a hook JSON result and exits 0.
function respond(obj) {
  writeAll(1, JSON.stringify(obj));
  process.exit(0);
}

// Blocks the prompt; the message is shown to the user, not to Claude.
function blockPrompt(message) {
  writeAll(2, message + '\n');
  process.exit(2);
}

module.exports = {
  DATA_DIR, EVENTS_FILE, LEARNING_FILE, MARKER, EMPTY_TREE, MAX_HINT, IDLE_MS, LEVELS, LEVEL_SCOPE, DEFAULT_GATE,
  PAUSES_BEFORE_LONG_REASON, LONG_REASON,
  config, gate, asksForCode, isQuestion, stripPasted, t, levelName, readInput, git, gitTry, project, loadState, saveState,
  lockState, logEvent, logError, pruneEvents, isEnabled, isPaused, isActive, expirePause, touchTask, fmtTime, localDate,
  headCommit, snapshot, compact, isCurrent, changedLines, attemptLines, effectiveBase, reviewDiff, hasSessionBaseline,
  sessionBaseline, statusLine, readEvents, pausesToday, stats, dueRepeats, appendLearning, respond, blockPrompt,
};
