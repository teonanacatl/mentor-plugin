'use strict';
// UserPromptSubmit: handles /mentor:* commands, gates requests for ready-made code
// and adds a one-line mentor status to Claude's context.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const COMMAND = /^\/mentor:(task|hint|try|done|off|on|status|review-week|whats-new|enable|disable)\b\s*([\s\S]*)$/i;
// Only a real slash command skips the gate, not any prompt that happens to start with "/".
const SLASH_COMMAND = /^\/[\w:.-]+(\s|$)/;
const MIN_TRY_LENGTH = 20;
// Commands that only make sense where mentor mode applies.
const NEEDS_ENABLED = new Set(['task', 'hint', 'try', 'done', 'off', 'on']);

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
  lib.logEvent(proj, 'task_start', implicit ? { title, implicit: true } : { title });
  return { title, startedAt: now, lastActiveAt: now, activeMs: 0, hint: 0, baseline, attempted: false };
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
      return context(`[mentor] New task started: "${args}". Hint level 0/${lib.MAX_HINT}.`,
        lib.t(cfg, 'taskStarted', { task: args }));
    }

    case 'hint': {
      const current = task || newTask(ctx, args || '(untitled)', true);
      const atMax = current.hint >= lib.MAX_HINT;
      current.hint = Math.min(lib.MAX_HINT, current.hint + 1);
      state.task = current;
      lib.logEvent(proj, 'hint', { title: current.title, level: current.hint });
      save();
      const n = current.hint;
      const text = `[mentor] Hint requested for task "${current.title}". Hint level is now ${n}/${lib.MAX_HINT}. ` +
        `Scope allowed at this level: ${lib.LEVEL_SCOPE[n]}.` +
        (atMax ? ' The ladder was already at its top; a complete solution stays outside mentor mode, ' +
          'only the user can pause it with /mentor:off <reason>.' : '');
      return context(text, atMax ? lib.t(cfg, 'hintMax') : lib.t(cfg, 'hintLevel', { n, name: lib.levelName(cfg, n) }));
    }

    case 'try': {
      if (args.length < MIN_TRY_LENGTH) lib.blockPrompt(lib.t(cfg, 'tryNeedsText'));
      const current = task || newTask(ctx, args.slice(0, 60), true);
      current.attempted = true;
      state.task = current;
      lib.logEvent(proj, 'try', { title: current.title, text: args.slice(0, 200) });
      save();
      return context(
        `[mentor] The user describes their own attempt or hypothesis for task "${current.title}": "${args}". ` +
        `The try-first gate for this task is now open. Hint level stays ${current.hint}/${lib.MAX_HINT}.`,
        lib.t(cfg, 'tryAccepted', { task: current.title }));
    }

    case 'done': {
      if (!task) return context('[mentor] /mentor:done was typed, but no task is open in this project.', lib.t(cfg, 'noTask'));
      const minutes = Math.round((task.activeMs || 0) / 60000);
      const wallMinutes = Math.round((now - task.startedAt) / 60000);
      const review = lib.reviewDiff(proj, cfg, task.baseline, task.pausedFiles || []);
      const changed = review ? review.stat !== '' : null;
      const pausedWork = task.pausedWork || 0;
      lib.logEvent(proj, 'task_done', {
        title: task.title, hint: task.hint, minutes, wallMinutes, changed, pausedWork, learned: args || '',
      });
      lib.appendLearning(
        `## ${lib.localDate(now)} — ${task.title}\n` +
        `- hints: ${task.hint}/${lib.MAX_HINT} (${lib.LEVELS.en[task.hint]}) · ${minutes} min of work\n` +
        (pausedWork ? `- ${pausedWork} lines changed during a pause (normal mode), not counted as mine\n` : '') +
        (args ? `- in my words: ${args}\n` : ''));
      state.task = null;
      save();
      const changedText = changed === null ? 'unknown (not a git repo)' : changed ? 'yes' : 'no';
      let text =
        `[mentor] Task closed: "${task.title}". Highest hint level: ${task.hint}/${lib.MAX_HINT} ` +
        `(${lib.LEVELS.en[task.hint]}). Work time: ${minutes} min (open for ${wallMinutes} min). ` +
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
      if (!args) lib.blockPrompt(lib.t(cfg, 'offNeedsReason'));
      const today = lib.pausesToday(now);
      if (today >= lib.PAUSES_BEFORE_LONG_REASON && args.length < lib.LONG_REASON) {
        lib.blockPrompt(lib.t(cfg, 'offNeedsLonger', { n: today + 1, need: lib.LONG_REASON }));
      }
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
      return context(
        `${lib.stats(days)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Today is ${lib.localDate(now)}. Repetition items due today or earlier: ${lib.dueRepeats(now)}.\n` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}\n${lib.statusLine(cfg, proj, state)}`);
    }

    case 'whats-new': {
      if (task) save();
      lib.logEvent(proj, 'whats_new', { arg: args.slice(0, 120) });
      const exists = fs.existsSync(lib.LEARNING_FILE);
      return context(
        `[mentor] What's-new check requested${args ? ` for: ${args}` : ''}. Today is ${lib.localDate(now)}. ` +
        `Learning journal: ${lib.LEARNING_FILE} (${exists ? 'exists' : 'not created yet; append creates it'}). ` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}.\n${lib.statusLine(cfg, proj, state)}`);
    }

    default: // status
      if (task) save();
      return context(`${lib.statusLine(cfg, proj, state)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Events log: ${lib.EVENTS_FILE}\nFocus topics: ${cfg.focusTopics || 'none'}\n` +
        `Activation: ${cfg.activation} · shell guard: ${cfg.bashGuard} · an attempt needs ${cfg.minLines} changed lines of code`);
  }
}

// How much the user has changed since the task (or else the session) started.
function attempt(ctx) {
  const { cfg, proj, state, input } = ctx;
  if (!proj.git) return { ok: true }; // outside git there is nothing to compare against
  const task = state.task;
  if (task && task.attempted) return { ok: true };
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
  if (changed) lib.saveState(proj, state);

  if (!SLASH_COMMAND.test(prompt) && !paused && lib.asksForCode(cfg, prompt)) {
    const a = attempt(ctx);
    if (!a.ok) {
      lib.logEvent(proj, 'gate_block', { task: task ? task.title : null, lines: a.n, prompt: prompt.slice(0, 120) });
      const vars = { n: a.n, need: cfg.minLines, task: task ? task.title : '' };
      const why = lib.t(cfg, task ? 'whyTask' : 'whySession', vars);
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
