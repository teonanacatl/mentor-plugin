'use strict';
// UserPromptSubmit: handles /mentor:* commands, gates requests for ready-made code
// and adds a one-line mentor status to Claude's context.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const COMMAND = /^\/mentor:(task|hint|try|done|off|on|status|review-week|whats-new|enable|disable|mode|wrong|forget)\b\s*([\s\S]*)$/i;
// Only a real slash command skips the gate, not any prompt that happens to start with "/".
const SLASH_COMMAND = /^\/[\w:.-]+(\s|$)/;
const MIN_TRY_LENGTH = 20;
// /mentor:wrong takes back a block from at most this long ago.
const WRONG_WINDOW_MS = 30 * 60000;
// Normal mode is a pause without an end; this stands in for "never".
const NEVER_MS = 10 * 365 * 86400000;
// Commands that only make sense where mentor mode applies.
const NEEDS_ENABLED = new Set(['task', 'hint', 'try', 'done', 'off', 'on', 'mode', 'wrong']);

function context(text, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  if (systemMessage) out.systemMessage = systemMessage;
  lib.respond(out);
}

// An explicit /mentor:task starts from the repo as it is now: earlier changes do not count.
// An implicit task (opened by /mentor:hint or /mentor:try) keeps the session's baseline, so the
// work done in this session counts as the attempt.
function newTask(ctx, title, implicit) {
  const { cfg, proj, state, input, now } = ctx;
  const baseline = implicit
    ? lib.sessionBaseline(proj, cfg, state, input.session_id, now)
    : lib.compact(lib.snapshot(proj, cfg));
  const mode = lib.modeOf(cfg, state);
  lib.logEvent(proj, 'task_start', { title, mode, ...(implicit ? { implicit: true } : {}) });
  return { title, mode, startedAt: now, lastActiveAt: now, activeMs: 0, hint: 0, baseline, attempted: false };
}

// A task opened by /mentor:hint or /mentor:try takes its title from what the user typed there,
// which may be code or a confidential detail: with log_text off it stays untitled.
const implicitTitle = (cfg, text) => (cfg.logText && text ? text.slice(0, 60) : '(untitled)');

// The pause rule shared by /mentor:off and /mentor:mode normal: a reason, longer from the third pause of a day.
function checkPauseReason(cfg, reason, now, emptyKey) {
  if (!reason) lib.blockPrompt(lib.t(cfg, emptyKey));
  const today = lib.pausesToday(now);
  if (today >= lib.PAUSES_BEFORE_LONG_REASON && reason.length < lib.LONG_REASON) {
    lib.blockPrompt(lib.t(cfg, 'offNeedsLonger', { n: today + 1, need: lib.LONG_REASON }));
  }
  return today;
}

function handleCommand(ctx, name, args) {
  const { cfg, proj, state, now } = ctx;
  const paused = lib.isPaused(state);
  const task = state.task;
  if (task) lib.touchTask(task, paused, now);
  const save = () => lib.saveState(proj, state);

  if (NEEDS_ENABLED.has(name) && !lib.isEnabled(cfg, proj, state)) {
    return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'inactive'));
  }

  switch (name) {
    case 'task': {
      if (!args) lib.blockPrompt(lib.t(cfg, 'taskNeedsTitle'));
      state.task = newTask(ctx, args, false);
      save();
      return context(`[mentor] New task started: "${args}". Hint level 0/${lib.MAX_HINT}. ` +
        `Mode: ${lib.modeOf(cfg, state)}.`, lib.t(cfg, 'taskStarted', { task: args }));
    }

    case 'hint': {
      // `/mentor:hint 3 …` sets the level, `/mentor:hint reset` starts over, anything else climbs one step.
      const m = args.match(/^(reset|[1-4])(?![\w])\s*([\s\S]*)$/i);
      const rest = m ? m[2].trim() : args;
      const current = task || newTask(ctx, implicitTitle(cfg, rest), true);
      state.task = current;
      const before = current.hint;
      if (m && m[1].toLowerCase() === 'reset') {
        current.hint = 0;
        lib.logEvent(proj, 'hint', { title: current.title, level: 0, reset: true });
        save();
        return context(`[mentor] Hint ladder reset for task "${current.title}": level 0/${lib.MAX_HINT}. ` +
          `Scope: ${lib.LEVEL_SCOPE[0]}.`, lib.t(cfg, 'hintReset'));
      }
      const atMax = !m && before >= lib.MAX_HINT;
      current.hint = m ? Number(m[1]) : Math.min(lib.MAX_HINT, before + 1);
      const jump = current.hint > before + 1;
      lib.logEvent(proj, 'hint', { title: current.title, level: current.hint, ...(m ? { set: true } : {}), ...(jump ? { jump: true } : {}) });
      save();
      const n = current.hint;
      const text = `[mentor] Hint requested for task "${current.title}". Hint level is now ${n}/${lib.MAX_HINT}` +
        (m ? ` (set by the user, was ${before}/${lib.MAX_HINT})` : '') + `. Scope allowed at this level: ${lib.LEVEL_SCOPE[n]}. ` +
        'Hints are cumulative: build on what you already said at the lower levels and do not repeat it.' +
        (atMax ? ' The ladder was already at its top; a complete solution stays outside mentor mode, ' +
          'only the user can pause it with /mentor:off <reason>.' : '');
      const msg = atMax ? 'hintMax' : m ? 'hintSet' : 'hintLevel';
      return context(text, lib.t(cfg, msg, { n, name: lib.levelName(cfg, n) }));
    }

    case 'try': {
      if (args.length < MIN_TRY_LENGTH) lib.blockPrompt(lib.t(cfg, 'tryNeedsText'));
      const current = task || newTask(ctx, implicitTitle(cfg, args), true);
      current.attempted = true;
      state.task = current;
      lib.logEvent(proj, 'try', { title: current.title, ...lib.logText(cfg, args) });
      save();
      return context(
        `[mentor] The user describes their own attempt or hypothesis for task "${current.title}": "${args}". ` +
        `The try-first gate for this task is now open. Hint level stays ${current.hint}/${lib.MAX_HINT}. ` +
        'Respond to the hypothesis itself: is it concrete and testable, what would confirm or refute it.',
        lib.t(cfg, 'tryAccepted', { task: current.title }));
    }

    case 'done': {
      if (!task) return context('[mentor] /mentor:done was typed, but no task is open in this project.', lib.t(cfg, 'noTask'));
      const minutes = Math.round((task.activeMs || 0) / 60000);
      const wallMinutes = Math.round((now - task.startedAt) / 60000);
      const review = lib.reviewDiff(proj, cfg, task.baseline, task.pausedFiles || []);
      const changed = review ? review.stat !== '' : null;
      const pausedWork = task.pausedWork || 0;
      const mode = task.mode || lib.modeOf(cfg, state);
      lib.logEvent(proj, 'task_done', {
        title: task.title, hint: task.hint, mode, minutes, wallMinutes, changed, pausedWork, learned: args || '',
      });
      lib.appendLearning(
        `## ${lib.localDate(now)} — ${task.title}\n` +
        `- hints: ${task.hint}/${lib.MAX_HINT} (${lib.LEVELS.en[task.hint]}) · ${minutes} min of work · mode ${mode}\n` +
        (pausedWork ? `- ${pausedWork} lines changed during a pause (normal mode), not counted as mine\n` : '') +
        (args ? `- in my words: ${args}\n` : ''));
      state.task = null;
      save();
      const changedText = changed === null ? 'unknown (not a git repo)' : changed ? 'yes' : 'no';
      let text =
        `[mentor] Task closed: "${task.title}". Highest hint level: ${task.hint}/${lib.MAX_HINT} ` +
        `(${lib.LEVELS.en[task.hint]}). Mode: ${mode}. Work time: ${minutes} min (open for ${wallMinutes} min). ` +
        `Repo changed since the task started: ${changedText}. ` +
        `User's own summary: ${args ? `"${args}"` : 'none given'}. An entry was appended to the learning journal ${lib.LEARNING_FILE}. ` +
        `Today is ${lib.localDate(now)}.` +
        (pausedWork
          ? ` ${pausedWork} lines in ${task.pausedFiles.join(', ')} changed while mentor mode was paused, when you may have ` +
            'written code yourself. Do not review that part as the user\'s work, and do not call the task done alone; ' +
            'ask the user which parts are theirs.'
          : '');
      if (review) {
        const base = review.base === lib.EMPTY_TREE
          ? 'the empty tree (no commits yet)'
          : `commit ${review.base.slice(0, 7)} (${review.note ? 'moved: ' + review.note : 'where the task started'})`;
        text += `\n[mentor] Files changed during the task (against ${base}, the user's own commits during the task included, ` +
          `new untracked files with their content; lock files and build output left out):\n${review.stat || '(none)'}\n` +
          `[mentor] git status --short:\n${review.status || '(clean)'}\n` +
          `[mentor] Diff of the files changed during the task:\n${review.diff || '(no diff)'}`;
        if (review.omitted.length) {
          text += `\n[mentor] Not included, the diff budget ran out: ${review.omitted.join(', ')}. ` +
            `Run git diff ${review.base.slice(0, 7)} -- <file> (or read the file, if untracked) for these.`;
        }
      }
      return context(text, lib.t(cfg, 'taskDone', { task: task.title, n: task.hint, min: minutes }) +
        (pausedWork ? lib.t(cfg, 'taskDonePaused', { lines: pausedWork }) : ''));
    }

    case 'off': {
      const today = checkPauseReason(cfg, args, now, 'offNeedsReason');
      const until = now + cfg.offMinutes * 60000;
      lib.startPause(proj, cfg, state, args, until);
      lib.logEvent(proj, 'pause', { reason: args, minutes: cfg.offMinutes, task: task ? task.title : null, today: today + 1 });
      save();
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'paused', { time: lib.fmtTime(cfg, until), reason: args }));
    }

    case 'on': {
      if (paused) lib.endPause(proj, cfg, state, false, now);
      save();
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, paused ? 'resumed' : 'alreadyActive'));
    }

    case 'mode': {
      const [word = '', ...restWords] = args.split(/\s+/);
      const wanted = word.toLowerCase();
      const reason = restWords.join(' ').trim();
      if (wanted === 'normal') {
        const today = checkPauseReason(cfg, reason, now, 'modeNeedsReason');
        lib.startPause(proj, cfg, state, reason, now + NEVER_MS, true);
        lib.logEvent(proj, 'pause', { reason, mode: 'normal', indefinite: true, task: task ? task.title : null, today: today + 1 });
        save();
        return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'modeNormal', { reason }));
      }
      if (!lib.MODES.includes(wanted)) {
        return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'modeUnknown', { mode: lib.modeOf(cfg, state) }));
      }
      if (paused && state.pause.indefinite) lib.endPause(proj, cfg, state, false, now);
      state.mode = wanted;
      if (task) task.mode = wanted;
      lib.logEvent(proj, 'mode', { mode: wanted, task: task ? task.title : null });
      save();
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'modeSet', { mode: wanted }));
    }

    case 'wrong': {
      // Takes back the last gate stop in this repo: logged as a false block, the next prompt passes.
      const last = lib.readEvents(now - WRONG_WINDOW_MS).filter((e) => e.type === 'gate_block' && e.pid === proj.id).pop();
      if (!last) return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'wrongNothing'));
      state.passOnce = true;
      lib.logEvent(proj, 'false_block', { blockedAt: last.ts, ...lib.logText(cfg, args, 'why') });
      save();
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'wrongNoted'));
    }

    case 'forget': {
      const what = args.toLowerCase();
      if (what === 'all' || what === 'text' || /^\d+$/.test(what)) {
        const n = lib.forgetEvents(what, now);
        return context(lib.statusLine(cfg, proj, state), lib.t(cfg, what === 'text' ? 'forgottenText' : 'forgotten', { n }));
      }
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'forgetUsage'));
    }

    case 'enable':
    case 'disable': {
      if (cfg.activation === 'always') return context(lib.statusLine(cfg, proj, state), lib.t(cfg, 'activationAlways'));
      state.enabled = name === 'enable';
      lib.logEvent(proj, name);
      save();
      const marker = fs.existsSync(path.join(proj.dir, lib.MARKER));
      const msg = name === 'enable' ? 'enabled' : marker ? 'disabledMarker' : 'disabled';
      return context(lib.statusLine(cfg, proj, state), lib.t(cfg, msg));
    }

    case 'review-week': {
      if (task) save();
      const days = Math.max(1, parseInt(args, 10) || 7);
      const j = lib.journalStats(now);
      return context(
        `${lib.stats(days)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Today is ${lib.localDate(now)}. Repetition items due today or earlier: ${lib.dueRepeats(now)}. ` +
        `Transfer exercises due: ${j.transfers.due}.\n` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}\n${lib.statusLine(cfg, proj, state)}`);
    }

    case 'whats-new': {
      if (task) save();
      lib.logEvent(proj, 'whats_new', lib.logText(cfg, args, 'arg', 120));
      const exists = fs.existsSync(lib.LEARNING_FILE);
      return context(
        `[mentor] What's-new check requested${args ? ` for: ${args}` : ''}. Today is ${lib.localDate(now)}. ` +
        `Learning journal: ${lib.LEARNING_FILE} (${exists ? 'exists' : 'not created yet; append creates it'}). ` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}.\n${lib.statusLine(cfg, proj, state)}`);
    }

    default: // status
      if (task) save();
      return context(`${lib.statusLine(cfg, proj, state)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Events log: ${lib.EVENTS_FILE} (the user's text in it: ${cfg.logText ? 'kept' : 'not kept, only lengths'})\n` +
        `Focus topics: ${cfg.focusTopics || 'none'}\n` +
        `Activation: ${cfg.activation} · mode: ${lib.modeOf(cfg, state)} · shell guard: ${cfg.bashGuard} · ` +
        `an attempt needs ${cfg.minLines} changed lines of code`);
  }
}

// Whether the user has made the attempt this mode asks for. Practice and guided: changed lines
// of code since the task (or else the session) started, or /mentor:try. Debug: a hypothesis
// (/mentor:try) only. Read: no gate.
function attempt(ctx) {
  const { cfg, proj, state, input } = ctx;
  const mode = lib.modeOf(cfg, state);
  const task = state.task;
  if (mode === 'read') return { ok: true };
  if (task && task.attempted) return { ok: true };
  if (mode === 'debug') return { ok: false, debug: true };
  if (!proj.git) return { ok: true }; // outside git there is nothing to compare against
  const session = state.sessions[input.session_id || 'default'];
  const baseline = task ? task.attemptBaseline || task.baseline : session && session.baseline;
  if (!baseline) return { ok: true };
  const n = lib.attemptLines(proj, cfg, baseline);
  return { ok: n >= cfg.minLines, n };
}

function main() {
  const input = lib.readInput();
  const prompt = String(input.prompt || '').trim();
  const cfg = lib.config();
  const proj = lib.project(input);
  lib.lockState(proj);
  const state = lib.loadState(proj);
  const now = Date.now();
  const ctx = { cfg, proj, state, input, now };
  let changed = lib.expirePause(proj, state, cfg);

  const cmd = prompt.match(COMMAND);
  if (cmd) return handleCommand(ctx, cmd[1].toLowerCase(), cmd[2].trim());

  if (!lib.isEnabled(cfg, proj, state)) {
    if (changed) lib.saveState(proj, state);
    return context(lib.statusLine(cfg, proj, state));
  }

  const paused = lib.isPaused(state);
  const task = state.task;
  if (task) {
    lib.touchTask(task, paused, now);
    if (!lib.isCurrent(task.baseline)) task.baseline = lib.compact(lib.snapshot(proj, cfg)); // task from an older version
    changed = true;
  }
  if (proj.git && !lib.hasSessionBaseline(state, input.session_id)) {
    lib.sessionBaseline(proj, cfg, state, input.session_id, now);
    changed = true;
  }
  // A pass from /mentor:wrong is for the one prompt that follows it.
  const pass = state.passOnce;
  if (pass) {
    state.passOnce = false;
    changed = true;
  }
  if (changed) lib.saveState(proj, state);

  if (!pass && !SLASH_COMMAND.test(prompt) && !paused && lib.asksForCode(cfg, prompt)) {
    const a = attempt(ctx);
    if (!a.ok) {
      lib.logEvent(proj, 'gate_block', {
        task: task ? task.title : null, mode: lib.modeOf(cfg, state), lines: a.n, ...lib.logText(cfg, prompt, 'prompt', 120),
      });
      const vars = { n: a.n, need: cfg.minLines, task: task ? task.title : '' };
      const why = lib.t(cfg, a.debug ? 'whyDebug' : task ? 'whyTask' : 'whySession', vars);
      lib.blockPrompt(lib.t(cfg, 'gateBlocked', { why, min: cfg.offMinutes }));
    }
  }

  context(lib.statusLine(cfg, proj, state));
}

try {
  main();
} catch (err) {
  // Fail open: a broken hook must never lock the user out of their own session.
  lib.logError('prompt', err);
  process.exit(0);
}
