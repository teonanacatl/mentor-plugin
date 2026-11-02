'use strict';
// UserPromptSubmit: handles /mentor:* commands, gates requests for ready-made code
// and adds a one-line mentor status to Claude's context.

const fs = require('fs');
const lib = require('./lib');

const COMMAND = /^\/mentor:(task|hint|try|done|off|on|status|review-week|whats-new)\b\s*([\s\S]*)$/i;
const MIN_TRY_LENGTH = 20;

function context(text, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  if (systemMessage) out.systemMessage = systemMessage;
  lib.respond(out);
}

// An implicit task (opened by /mentor:hint or /mentor:try) on a repo that is already dirty
// counts the work done so far as the attempt. An explicit /mentor:task does not.
function newTask(dir, title, now, implicit) {
  const task = {
    title, startedAt: now, lastActiveAt: now, activeMs: 0, hint: 0,
    fingerprint: lib.fingerprint(dir), head: lib.headCommit(dir), attempted: Boolean(implicit && lib.isDirty(dir)),
  };
  lib.logEvent(dir, 'task_start', implicit ? { title, implicit: true } : { title });
  return task;
}

function handleCommand(cfg, state, dir, key, name, args) {
  const now = Date.now();
  const paused = lib.isPaused(state, key);
  const task = state.tasks[key];
  if (task) lib.touchTask(task, paused, now);

  switch (name) {
    case 'task': {
      if (!args) lib.blockPrompt(lib.t(cfg, 'taskNeedsTitle'));
      state.tasks[key] = newTask(dir, args, now, false);
      lib.saveState(state);
      return context(`[mentor] New task started: "${args}". Hint level 0/${lib.MAX_HINT}.`,
        lib.t(cfg, 'taskStarted', { task: args }));
    }

    case 'hint': {
      const current = task || newTask(dir, args || '(untitled)', now, true);
      const atMax = current.hint >= lib.MAX_HINT;
      current.hint = Math.min(lib.MAX_HINT, current.hint + 1);
      state.tasks[key] = current;
      lib.logEvent(dir, 'hint', { title: current.title, level: current.hint });
      lib.saveState(state);
      const n = current.hint;
      const text = `[mentor] Hint requested for task "${current.title}". Hint level is now ${n}/${lib.MAX_HINT}. ` +
        `Scope allowed at this level: ${lib.LEVEL_SCOPE[n]}.` +
        (atMax ? ' The ladder was already at its top; a complete solution stays outside mentor mode, ' +
          'only the user can pause it with /mentor:off <reason>.' : '');
      return context(text, atMax ? lib.t(cfg, 'hintMax') : lib.t(cfg, 'hintLevel', { n, name: lib.levelName(cfg, n) }));
    }

    case 'try': {
      if (args.length < MIN_TRY_LENGTH) lib.blockPrompt(lib.t(cfg, 'tryNeedsText'));
      const current = task || newTask(dir, args.slice(0, 60), now, true);
      current.attempted = true;
      state.tasks[key] = current;
      lib.logEvent(dir, 'try', { title: current.title, text: args.slice(0, 200) });
      lib.saveState(state);
      return context(
        `[mentor] The user describes their own attempt or hypothesis for task "${current.title}": "${args}". ` +
        `The try-first gate for this task is now open. Hint level stays ${current.hint}/${lib.MAX_HINT}.`,
        lib.t(cfg, 'tryAccepted', { task: current.title }));
    }

    case 'done': {
      if (!task) return context('[mentor] /mentor:done was typed, but no task is open in this project.', lib.t(cfg, 'noTask'));
      const minutes = Math.round((task.activeMs || 0) / 60000);
      const wallMinutes = Math.round((now - task.startedAt) / 60000);
      const fp = lib.fingerprint(dir);
      const changed = fp === null || task.fingerprint === null ? null : fp !== task.fingerprint;
      const changes = lib.changesSince(dir, task.head);
      lib.logEvent(dir, 'task_done', { title: task.title, hint: task.hint, minutes, wallMinutes, changed, learned: args || '' });
      lib.appendLearning(
        `## ${new Date(now).toISOString().slice(0, 10)} — ${task.title}\n` +
        `- hints: ${task.hint}/${lib.MAX_HINT} (${lib.LEVELS.en[task.hint]}) · ${minutes} min of work\n` +
        (args ? `- in my words: ${args}\n` : ''));
      delete state.tasks[key];
      lib.saveState(state);
      const changedText = changed === null ? 'unknown (not a git repo)' : changed ? 'yes' : 'no';
      let text =
        `[mentor] Task closed: "${task.title}". Highest hint level: ${task.hint}/${lib.MAX_HINT} ` +
        `(${lib.LEVELS.en[task.hint]}). Work time: ${minutes} min (open for ${wallMinutes} min). ` +
        `Repo changed since the task started: ${changedText}. ` +
        `User's own summary: ${args ? `"${args}"` : 'none given'}. An entry was appended to the learning journal ${lib.LEARNING_FILE}.`;
      if (changes) {
        const base = task.head ? `commit ${task.head.slice(0, 7)} (where the task started)` : 'HEAD';
        text += `\n[mentor] git status --short:\n${changes.status || '(clean)'}\n` +
          `[mentor] git diff against ${base}, including work committed during the task:\n${changes.diff || '(no diff)'}`;
      }
      return context(text, lib.t(cfg, 'taskDone', { task: task.title, n: task.hint, min: minutes }));
    }

    case 'off': {
      if (!args) lib.blockPrompt(lib.t(cfg, 'offNeedsReason'));
      const until = now + cfg.offMinutes * 60000;
      state.pauses[key] = { until, reason: args };
      lib.logEvent(dir, 'pause', { reason: args, minutes: cfg.offMinutes, task: task ? task.title : null });
      lib.saveState(state);
      return context(lib.statusLine(cfg, state, key), lib.t(cfg, 'paused', { time: lib.fmtTime(cfg, until), reason: args }));
    }

    case 'on': {
      if (paused) {
        lib.logEvent(dir, 'resume', { auto: false });
        delete state.pauses[key];
        if (task) task.lastActiveAt = now;
      }
      lib.saveState(state);
      return context(lib.statusLine(cfg, state, key), lib.t(cfg, paused ? 'resumed' : 'alreadyActive'));
    }

    case 'review-week': {
      if (task) lib.saveState(state);
      const days = Math.max(1, parseInt(args, 10) || 7);
      return context(
        `${lib.stats(days)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}\n${lib.statusLine(cfg, state, key)}`);
    }

    case 'whats-new': {
      if (task) lib.saveState(state);
      lib.logEvent(dir, 'whats_new', { arg: args.slice(0, 120) });
      const exists = fs.existsSync(lib.LEARNING_FILE);
      return context(
        `[mentor] What's-new check requested${args ? ` for: ${args}` : ''}. ` +
        `Learning journal: ${lib.LEARNING_FILE} (${exists ? 'exists' : 'not created yet; append creates it'}). ` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}.\n${lib.statusLine(cfg, state, key)}`);
    }

    default: // status
      if (task) lib.saveState(state);
      return context(`${lib.statusLine(cfg, state, key)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Events log: ${lib.EVENTS_FILE}\nFocus topics: ${cfg.focusTopics || 'none'}`);
  }
}

// True when the user has made an attempt that the gate accepts.
function hasAttempt(dir, task) {
  if (task && task.attempted) return true;
  if (task && task.fingerprint) {
    const fp = lib.fingerprint(dir);
    return fp === null ? true : fp !== task.fingerprint;
  }
  const dirty = lib.isDirty(dir);
  return dirty === null ? true : dirty; // outside git there is nothing to compare against
}

function main() {
  const input = lib.readInput();
  const prompt = String(input.prompt || '').trim();
  const cfg = lib.config();
  const dir = lib.projectDir(input);
  const key = lib.projectKey(dir);
  const state = lib.loadState();
  let changed = lib.expirePause(state, dir, key);

  const cmd = prompt.match(COMMAND);
  if (cmd) return handleCommand(cfg, state, dir, key, cmd[1].toLowerCase(), cmd[2].trim());

  const paused = lib.isPaused(state, key);
  const task = state.tasks[key];
  if (task) {
    lib.touchTask(task, paused, Date.now());
    changed = true;
  }
  if (changed) lib.saveState(state);

  if (!prompt.startsWith('/') && !paused && lib.gate(cfg).test(prompt) && !hasAttempt(dir, task)) {
    lib.logEvent(dir, 'gate_block', { task: task ? task.title : null, prompt: prompt.slice(0, 120) });
    const why = task ? lib.t(cfg, 'whyTask', { task: task.title }) : lib.t(cfg, 'whyClean');
    lib.blockPrompt(lib.t(cfg, 'gateBlocked', { why, min: cfg.offMinutes }));
  }

  context(lib.statusLine(cfg, state, key));
}

try {
  main();
} catch (err) {
  // Fail open: a broken hook must never lock the user out of their own session.
  lib.logError('prompt', err);
  process.exit(0);
}
