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
const LOCK_STALE_MS = 25000; // longer than the slowest hook (timeout 20 s), so a live lock is never taken over

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

// Kinds of work, each with its own rules. "normal" is not a mode in the state: it is a pause
// without an end (/mentor:mode normal <reason>), so it is logged and counted like one.
const MODES = ['practice', 'guided', 'debug', 'read'];
const MODE_SCOPE = {
  practice: 'practice: the user solves it; answer questions and give hints on the ladder, never the solution',
  guided: 'guided: lead step by step. Break the task into small steps and give one at a time as a question or a ' +
    'small goal; check the user\'s answer before the next step. Still no code for the user\'s task',
  debug: 'debug: teach the debugging loop. Ask for the symptom and the user\'s hypothesis, propose one experiment ' +
    '(a log, a breakpoint, a test) the user runs, analyse the result together, repeat. The fix comes from the user. ' +
    'The try-first gate opens only with a hypothesis (/mentor:try)',
  read: 'read: understanding existing code. Explain freely and in depth, trace the flow with the user, then ask them ' +
    'to predict what a change would do or to explain a part back in their own words. No gate; edits stay blocked',
};
// Events carry this version, so later readers can tell old shapes from new ones.
const EVENT_V = 2;
// Fields of events that may hold the user's text (prompts, commands, hypotheses).
const TEXT_FIELDS = ['prompt', 'text', 'arg', 'command', 'target', 'why'];

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
  `${B}zr[oó]b\\s+(to|mi\\s+to|za\\s+mnie)${E}`, // "zrób mi review" is not a request for code
  `${B}(mo[zż]esz|m[oó]g[lł]by[sś]|mog[lł]aby[sś])\\s+(mi\\s+)?(to\\s+)?(napisa[cć]|zaimplementowa[cć]|naprawi[cć]|poprawi[cć]|` +
    `dopisa[cć]|stworzy[cć]|doko[nń]czy[cć]|zrobi[cć]|rozwi[aą]za[cć]|doda[cć]|przerobi[cć]|zrefaktoryzowa[cć])${E}`,
  `${B}(napiszesz|naprawisz|poprawisz|zrobisz|dopiszesz)\\s+(mi|to)${E}`,
  `${B}zmie[nń]\\s+(mi\\s+)?(to|ten|t[eę]|tego|go|j[aą])${E}`,
  `${B}zr[oó]b\\s+reszt[eę]${E}`,
  `${B}potrzebuj[eę]\\s+(gotowego|gotowy|ca[lł]ego|ca[lł]y)\\s+(kodu|kod|rozwi[aą]zania|rozwi[aą]zanie)${E}`,
  `${B}(wy[sś]lij|pode[sś]lij|przy[sś]lij|wklej)\\s+(mi\\s+)?(ca[lł]y\\s+|gotowy\\s+|gotowe\\s+)?` +
    `(kod|rozwi[aą]zanie|gotowca|implementacj[eę]|funkcj[eę]|klas[eę])${E}`,
  `${B}(write|create|build|add|implement|refactor|rewrite|complete|generate|code|convert|change|update|make)\\s+(me\\s+)?` +
    `(it|this|that|the|a|an|my|some|missing|new|up|these|those)${E}`,
  `${B}code\\s+(it|this|that)\\s+up${E}`,
  `${B}(give|send)\\s+me\\s+(the\\s+|a\\s+|an\\s+)?(\\w+\\s+)?(code|solution|implementation|fix|function|class|component|method|script|snippet|test)${E}`,
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
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^(\s{4,}|\t)\S/.test(line) && !/^\s*(>|\/\/|#|--\s)/.test(line)) // "* item" is a list, not a comment
    .join('\n');
}

// "I want to build a parser", "let me write the code myself": the verb is the user's own only
// when "I" or "we" is its subject, right before it. "I give up, write it" is still an order.
const ADVERB = '(\\s+(really|first|still|just|also|probably|then|actually))?';
const AUX = '(\\s+(want|wanted|need|needed|have|plan|try|tried|would\\s+like|am\\s+going|are\\s+going|will|would|can|could|' +
  'should|must|might|shall)(\\s+to)?|\'ll|\'d(\\s+like\\s+to)?|\'m\\s+going\\s+to|\'re\\s+going\\s+to)';
// Uppercase "I" may stand right before the verb; a lowercase "i" needs a helper verb, because
// in Polish "i" means "and" ("przeczytaj i napisz").
const SUBJECT_I = new RegExp(`(^|[^\\p{L}'])I${ADVERB}${AUX}?${ADVERB}\\s+$`, 'u');
const SUBJECT_i = new RegExp(`(^|[^\\p{L}'])i${ADVERB}${AUX}${ADVERB}\\s+$`, 'iu');
const SUBJECT_WE = new RegExp(`(^|[^\\p{L}'])(we${ADVERB}${AUX}?${ADVERB}|let\\s+me|let's|lemme)\\s+$`, 'iu');
const firstPerson = (prefix) => SUBJECT_I.test(prefix) || SUBJECT_i.test(prefix) || SUBJECT_WE.test(prefix);

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
      '  • /mentor:wrong — jeśli to nie była prośba o kod (zapiszę fałszywą blokadę i przepuszczę następny prompt)\n' +
      '  • /mentor:off <powód> — zrobić przerwę na {min} min (trafia do przeglądu tygodnia)',
    whyTask: 'Od startu zadania „{task}” w kodzie zmieniło się {n} z wymaganych {need} linii.',
    whyDebug: 'W trybie debugowania bramkę otwiera hipoteza: /mentor:try <co podejrzewasz i jak to sprawdzisz>.',
    wrongNoted: '🧭 Zapisane jako fałszywa blokada. Następny prompt przejdzie bez bramki — wyślij go jeszcze raz.',
    wrongNothing: '🧭 W tym repo nie było ostatnio blokady do odwołania.',
    modeSet: '🧭 Tryb: {mode}.',
    modeUnknown: '🧭 Tryby: practice, guided, debug, read, normal <powód>. Teraz: {mode}.',
    modeNormal: '🧭 Tryb normalny w tym repo, bez limitu czasu. Powód: {reason}. Powrót: /mentor:on albo /mentor:mode practice.',
    modeNeedsReason: '🧭 Mentor: tryb normalny też wymaga powodu, np. /mentor:mode normal rutynowa migracja.',
    hintSet: '🧭 Podpowiedź ustawiona na {n}/{max} · {name}',
    hintReset: '🧭 Drabina od zera.',
    forgotten: '🧭 Log: usunięto {n} zdarzeń.',
    forgottenText: '🧭 Log: usunięto treść z {n} zdarzeń (zostały typy, czasy i liczby).',
    forgetUsage: '🧭 /mentor:forget all | /mentor:forget <dni> (starsze niż N dni) | /mentor:forget text (sama treść).',
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
    taskDonePaused: ' · {lines} linii z pauzy (nie liczę jako Twoje)',
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
      '  • /mentor:wrong — if it was not a request for code (logged as a false block; your next prompt goes through)\n' +
      '  • /mentor:off <reason> — pause for {min} min (shows up in the weekly review)',
    whyTask: 'Since task "{task}" started, {n} of the required {need} lines of code have changed.',
    whyDebug: 'In debug mode a hypothesis opens the gate: /mentor:try <what you suspect and how you will check it>.',
    wrongNoted: '🧭 Logged as a false block. Your next prompt skips the gate — send it again.',
    wrongNothing: '🧭 No recent block in this repo to take back.',
    modeSet: '🧭 Mode: {mode}.',
    modeUnknown: '🧭 Modes: practice, guided, debug, read, normal <reason>. Now: {mode}.',
    modeNormal: '🧭 Normal mode in this repo, no time limit. Reason: {reason}. Back: /mentor:on or /mentor:mode practice.',
    modeNeedsReason: '🧭 Mentor: normal mode needs a reason too, e.g. /mentor:mode normal routine migration.',
    hintSet: '🧭 Hint set to {n}/{max} · {name}',
    hintReset: '🧭 The ladder starts from zero.',
    forgotten: '🧭 Log: {n} events removed.',
    forgottenText: '🧭 Log: text removed from {n} events (types, times and counts stay).',
    forgetUsage: '🧭 /mentor:forget all | /mentor:forget <days> (older than N days) | /mentor:forget text (only the text).',
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
    taskDonePaused: ' · {lines} lines from a pause (not counted as yours)',
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
    logText: !isOff(option('log_text', 'false')),
    defaultMode: MODES.includes(option('default_mode', 'practice')) ? option('default_mode', 'practice') : 'practice',
  };
}

// The user's text goes into the log only with log_text on; otherwise only its length, so the log
// never holds code or confidential prompts. The journal (written by the user and Claude) is separate.
function logText(cfg, text, field = 'text', limit = 200) {
  const s = String(text || '');
  return cfg.logText ? { [field]: s.slice(0, limit) } : { [field + 'Chars']: s.length };
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
// Leading fillers. The Polish "i" (and) only in lowercase: "I am tired…" is not "i" + "am…?".
const FILLER = /^([\s"'„“(*_-]+|(a|no|ok|okej|dobra|so|and|but|ok so)[,\s]+)+/iu;
const stripFiller = (s) => s.replace(FILLER, '').replace(/^i[,\s]+/u, '').replace(FILLER, '');

// An information question ("how do I fix this?", "czy powinienem dopisać test?"), as opposed to
// a request phrased as a question ("can you write it?") or an order with a question mark.
function isQuestion(sentence, re) {
  const s = stripFiller(sentence.trim());
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
  // Clauses, not just sentences: "I give up, write it" and "I tried; now fix it" hold two.
  const sentences = stripPasted(prompt)
    .split(/(?<=[.!?…;,:])\s+|\n+|\s+(?=(but|so|ale|wi[eę]c|tylko)\s)/iu)
    .filter((s) => s && s.trim() && !/^(but|so|ale|wi[eę]c|tylko)$/iu.test(s.trim()));
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
    mode: MODES.includes(s.mode) ? s.mode : null, passOnce: Boolean(s.passOnce),
  };
}

const modeOf = (cfg, state) => state.mode || cfg.defaultMode;

function saveState(proj, state) {
  ensureDir(STATE_DIR);
  const file = stateFile(proj);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function logEvent(proj, type, data = {}) {
  ensureDir();
  const line = JSON.stringify({ v: EVENT_V, ts: new Date().toISOString(), type, project: proj.name, pid: proj.id, ...data });
  fs.appendFileSync(EVENTS_FILE, line + '\n');
}

// /mentor:forget: drops every event, events older than `days`, or only the user's text in them.
function forgetEvents(what, now = Date.now()) {
  if (!fs.existsSync(EVENTS_FILE)) return 0;
  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim());
  let kept = lines;
  let n = 0;
  if (what === 'all') {
    kept = [];
    n = lines.length;
  } else if (what === 'text') {
    kept = lines.map((l) => {
      try {
        const e = JSON.parse(l);
        let touched = false;
        for (const f of TEXT_FIELDS) {
          if (typeof e[f] === 'string') {
            e[f + 'Chars'] = e[f].length;
            delete e[f];
            touched = true;
          }
        }
        if (touched) n++;
        return JSON.stringify(e);
      } catch {
        n++;
        return null; // a damaged line may hold anything
      }
    }).filter(Boolean);
  } else {
    const cutoff = now - Number(what) * 86400000;
    kept = lines.filter((l) => {
      try {
        return Date.parse(JSON.parse(l).ts) >= cutoff;
      } catch {
        return false;
      }
    });
    n = lines.length - kept.length;
  }
  const tmp = EVENTS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
  fs.renameSync(tmp, EVENTS_FILE);
  return n;
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

// Starts a pause. The user's work so far stays theirs (it opens the gate if it is enough), and a
// snapshot marks where the pause began, so what appears during it is told apart later.
function startPause(proj, cfg, state, reason, until, indefinite = false) {
  const task = state.task;
  if (task && proj.git && !task.attempted && attemptLines(proj, cfg, task.attemptBaseline || task.baseline) >= cfg.minLines) {
    task.attempted = true;
  }
  const baseline = (state.pause && state.pause.baseline) || (proj.git ? compact(snapshot(proj, cfg)) : null);
  state.pause = { until, reason, baseline, ...(indefinite ? { indefinite: true } : {}) };
}

// Ends a pause (`/mentor:on`, or on its own when the time is up). Code that appeared during the
// pause may be Claude's: it does not count as the user's attempt, and the task records it as
// pausedWork so the review and the weekly stats do not credit it to the user.
function endPause(proj, cfg, state, auto, now = Date.now()) {
  const pause = state.pause;
  state.pause = null;
  let lines = 0;
  let files = [];
  if (proj.git) {
    const fresh = compact(snapshot(proj, cfg));
    if (pause && isCurrent(pause.baseline)) {
      const d = diffSnapshots(pause.baseline, snapshot(proj, cfg, effectiveBase(proj, pause.baseline.base, pause.baseline.at).base));
      lines = d.n;
      files = d.files;
    }
    if (state.task) state.task.attemptBaseline = fresh;
    for (const s of Object.values(state.sessions)) s.baseline = fresh;
  }
  const task = state.task;
  if (task) {
    task.lastActiveAt = auto ? Math.max(task.lastActiveAt || task.startedAt, pause.until) : now;
    if (lines) {
      task.pausedWork = (task.pausedWork || 0) + lines;
      task.pausedFiles = [...new Set([...(task.pausedFiles || []), ...files])];
    }
  }
  logEvent(proj, 'resume', { auto, pausedWork: lines, task: task ? task.title : null });
}

// Ends an expired pause. Returns true when the state changed.
function expirePause(proj, state, cfg) {
  const pause = state.pause;
  if (!pause || Date.now() < pause.until) return false;
  endPause(proj, cfg || config(), state, true);
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

// Lines of code changed between two snapshots, and the files they are in.
function diffSnapshots(before, now) {
  let n = 0;
  const files = [];
  for (const f of new Set([...Object.keys(before.files), ...Object.keys(now.files)])) {
    const a = before.files[f];
    const b = now.files[f];
    if (a && b && a.h === b.h) continue;
    const na = a ? a.n : 0;
    const nb = b ? b.n : 0;
    const d = Math.abs(nb - na) || (na || nb ? 1 : 0); // same count, different lines: at least one changed
    if (d) files.push(f);
    n += d;
  }
  return { n, files };
}

const changedLines = (before, now) => diffSnapshots(before, now).n;

function attemptLines(proj, cfg, baseline) {
  const now = snapshot(proj, cfg, effectiveBase(proj, baseline.base, baseline.at).base);
  return now ? changedLines(baseline, now) : Infinity;
}

// The review material for /mentor:done: files changed since the task started, a stat first,
// then whole files' diffs (new files included) until the budget runs out. null outside git.
function reviewDiff(proj, cfg, baseline, pausedFiles = []) {
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
    return `  ${f} | +${v.added} -${v.deleted}${v.untracked ? ' (new, untracked)' : ''}${v.note ? ` (${v.note})` : ''}` +
      (pausedFiles.includes(f) ? ' (changed during a pause: may be Claude\'s work, not the user\'s)' : '');
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
    const until = state.pause.indefinite ? 'the user switches back (normal mode)' : fmtTime(cfg, state.pause.until);
    return `[mentor] PAUSED in this project until ${until} (reason: ${state.pause.reason}). ` +
      'Mentor mode is off for now: normal assistant behaviour, file edits are allowed.';
  }
  const task = state.task;
  const mode = modeOf(cfg, state);
  const taskPart = task
    ? `task: "${task.title}" · hint level ${task.hint}/${MAX_HINT} (${LEVELS.en[task.hint]})`
    : 'no task started (/mentor:task)';
  return `[mentor] ACTIVE · ${taskPart} · mode ${MODE_SCOPE[mode]} · file edits in the project are blocked by a hook.`;
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
  // A task with code from a pause is not counted at any hint level: part of it may be Claude's.
  const withPause = done.filter((e) => e.pausedWork > 0);
  const byLevel = [0, 0, 0, 0, 0];
  for (const e of done) if (!(e.pausedWork > 0)) byLevel[Math.min(MAX_HINT, e.hint || 0)]++;
  const count = (type) => events.filter((e) => e.type === type).length;
  const workMinutes = done.reduce((sum, d) => sum + (d.minutes || 0), 0);
  const own = done.filter((e) => !(e.pausedWork > 0));
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const blocks = events.filter((e) => e.type === 'gate_block');
  // A block followed within five minutes by a pause in the same repo: the user went around it.
  const overridden = blocks.filter((b) => pauses.some((p) => p.pid === b.pid &&
    Date.parse(p.ts) >= Date.parse(b.ts) && Date.parse(p.ts) - Date.parse(b.ts) <= 5 * 60000)).length;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
  const j = journalStats(Date.now() - days * 86400000);
  const lines = [
    `[mentor] Stats for the last ${days} days (from ${EVENTS_FILE}):`,
    `- tasks started: ${count('task_start')}, closed: ${done.length}, work time on closed tasks: ${workMinutes} min`,
    `- outcome measures:`,
    `  - median work time per closed task: ${median(done.map((d) => d.minutes || 0)) ?? 'n/a'} min; ` +
      `mean highest hint level (own work only): ${own.length ? (own.reduce((s, d) => s + (d.hint || 0), 0) / own.length).toFixed(1) : 'n/a'}`,
    `  - false blocks (/mentor:wrong): ${count('false_block')} of ${blocks.length} gate stops (${pct(count('false_block'), blocks.length)}); ` +
      `stops followed by a pause within 5 min: ${overridden} (${pct(overridden, blocks.length)})`,
    `  - pauses per closed task: ${done.length ? (pauses.length / done.length).toFixed(1) : 'n/a'}`,
    `  - delayed recall (quizzes in the journal): ${j.quizzes.length ? j.quizzes.map((q) => `${q.date} ${q.score}`).join(', ') : 'none'}`,
    `  - transfer exercises: ${j.transfers.solvedAlone} solved alone, ${j.transfers.withHints} with hints, ` +
      `${j.transfers.notSolved} not solved, ${j.transfers.open} open (${j.transfers.due} due)`,
    `- tasks closed by mode: ${MODES.map((m) => `${m} ${done.filter((d) => (d.mode || 'practice') === m).length}`).join(', ')}`,
    `- closed tasks by highest hint level (without work from pauses): ` +
      byLevel.map((n, i) => `${i} ${LEVELS.en[i]}: ${n}`).join(', '),
    `- closed with code written during a pause (not counted above): ${withPause.length}` +
      (withPause.length ? ` (${withPause.map((e) => `"${e.title}" ${e.pausedWork} lines`).join(', ')})` : ''),
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

function readJournal() {
  try {
    return fs.readFileSync(LEARNING_FILE, 'utf8');
  } catch {
    return '';
  }
}

const isDue = (line, today) => {
  const due = line.match(/due (\d{4}-\d{2}-\d{2})/);
  return !due || due[1] <= today;
};

// Open repetition items due today or earlier: `- [ ] repeat: topic (box N, due YYYY-MM-DD)`;
// an item without a due date is due.
function dueRepeats(now = Date.now()) {
  const today = localDate(now);
  return readJournal().split('\n').filter((l) => /^\s*- (\[ \] )?repeat:/.test(l) && isDue(l, today)).length;
}

// Learning evidence from the journal, apart from activity: quiz scores and transfer exercises
// (`- [ ] transfer: … (due …)`, ticked as `- [x] transfer: … (solved alone|with hints|not solved YYYY-MM-DD)`).
function journalStats(sinceMs, now = Date.now()) {
  const text = readJournal();
  const since = localDate(sinceMs);
  const today = localDate(now);
  const quizzes = [];
  const re = /^## Quiz (\d{4}-\d{2}-\d{2})[\s\S]*?^- score: (\d+\s*\/\s*\d+)/gm;
  for (const m of text.matchAll(re)) if (m[1] >= since) quizzes.push({ date: m[1], score: m[2].replace(/\s/g, '') });
  const t = { solvedAlone: 0, withHints: 0, notSolved: 0, skipped: 0, open: 0, due: 0 };
  for (const line of text.split('\n')) {
    if (!/^\s*- \[[ x]\] transfer:/.test(line)) continue;
    if (/^\s*- \[ \]/.test(line)) {
      t.open++;
      if (isDue(line, today)) t.due++;
    } else if (/solved alone/.test(line)) t.solvedAlone++;
    else if (/with hints/.test(line)) t.withHints++;
    else if (/skipped/.test(line)) t.skipped++;
    else t.notSolved++;
  }
  return { quizzes, transfers: t };
}

// The user's explicit topic profile, read from the Leitner boxes: what they already have
// (box 4–5 or mastered) and what is still weak (box 1). Claude adapts the size of its steps.
function topicProfile() {
  const strong = [];
  const weak = [];
  for (const line of readJournal().split('\n')) {
    const m = line.match(/^\s*- (\[([ x])\] )?repeat:\s*(.+?)\s*(\((.*)\))?\s*$/);
    if (!m) continue;
    const topic = m[3].trim();
    const box = Number(((m[5] || '').match(/box (\d)/) || [])[1] || 1);
    if (m[2] === 'x' || box >= 4) strong.push(topic);
    else if (box <= 1) weak.push(topic);
  }
  const uniq = (xs) => [...new Set(xs)].slice(-6);
  return { strong: uniq(strong), weak: uniq(weak.filter((w) => !strong.includes(w))) };
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
  MODES, MODE_SCOPE, EVENT_V, logText, modeOf, forgetEvents, journalStats, topicProfile,
  lockState, logEvent, logError, pruneEvents, isEnabled, isPaused, isActive, startPause, endPause, expirePause, touchTask,
  fmtTime, localDate,
  headCommit, snapshot, compact, isCurrent, changedLines, attemptLines, effectiveBase, reviewDiff, hasSessionBaseline,
  sessionBaseline, statusLine, readEvents, pausesToday, stats, dueRepeats, appendLearning, respond, blockPrompt,
};
