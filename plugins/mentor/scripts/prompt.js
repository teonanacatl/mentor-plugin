'use strict';
// UserPromptSubmit: handles /mentor:* commands, gates requests for ready-made code
// and adds a one-line mentor status to Claude's context.

const lib = require('./lib');

const COMMAND = /^\/mentor:(task|hint|done|off|on|status|review-week)\b\s*([\s\S]*)$/i;

function context(text, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  if (systemMessage) out.systemMessage = systemMessage;
  lib.respond(out);
}

function handleCommand(cfg, state, dir, key, name, args) {
  const now = Date.now();
  const task = state.tasks[key];

  switch (name) {
    case 'task': {
      if (!args) lib.blockPrompt(lib.t(cfg, 'taskNeedsTitle'));
      state.tasks[key] = { title: args, startedAt: now, hint: 0, fingerprint: lib.fingerprint(dir) };
      lib.logEvent(dir, 'task_start', { title: args });
      lib.saveState(state);
      return context(`[mentor] New task started: "${args}". Hint level 0/${lib.MAX_HINT}.`,
        lib.t(cfg, 'taskStarted', { task: args }));
    }

    case 'hint': {
      const current = task || { title: args || '(untitled)', startedAt: now, hint: 0, fingerprint: lib.fingerprint(dir) };
      if (!task) lib.logEvent(dir, 'task_start', { title: current.title, implicit: true });
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

    case 'done': {
      if (!task) return context('[mentor] /mentor:done was typed, but no task is open in this project.', lib.t(cfg, 'noTask'));
      const minutes = Math.round((now - task.startedAt) / 60000);
      const fp = lib.fingerprint(dir);
      const changed = fp === null || task.fingerprint === null ? null : fp !== task.fingerprint;
      lib.logEvent(dir, 'task_done', { title: task.title, hint: task.hint, minutes, changed, learned: args || '' });
      lib.appendLearning(
        `## ${new Date(now).toISOString().slice(0, 10)} — ${task.title}\n` +
        `- hints: ${task.hint}/${lib.MAX_HINT} (${lib.LEVELS.en[task.hint]}) · ${minutes} min\n` +
        (args ? `- in my words: ${args}\n` : ''));
      delete state.tasks[key];
      lib.saveState(state);
      const changedText = changed === null ? 'unknown (not a git repo)' : changed ? 'yes' : 'no';
      return context(
        `[mentor] Task closed: "${task.title}". Highest hint level: ${task.hint}/${lib.MAX_HINT} ` +
        `(${lib.LEVELS.en[task.hint]}). Duration: ${minutes} min. Repo changed since the task started: ${changedText}. ` +
        `User's own summary: ${args ? `"${args}"` : 'none given'}. An entry was appended to the learning journal ${lib.LEARNING_FILE}.`,
        lib.t(cfg, 'taskDone', { task: task.title, n: task.hint, min: minutes }));
    }

    case 'off': {
      if (!args) lib.blockPrompt(lib.t(cfg, 'offNeedsReason'));
      const until = now + cfg.offMinutes * 60000;
      state.pause = { until, reason: args };
      lib.logEvent(dir, 'pause', { reason: args, minutes: cfg.offMinutes, task: task ? task.title : null });
      lib.saveState(state);
      return context(lib.statusLine(cfg, state, key), lib.t(cfg, 'paused', { time: lib.fmtTime(cfg, until), reason: args }));
    }

    case 'on': {
      const wasPaused = lib.isPaused(state);
      if (wasPaused) {
        lib.logEvent(dir, 'resume', { auto: false });
        state.pause = null;
        lib.saveState(state);
      }
      return context(lib.statusLine(cfg, state, key), lib.t(cfg, wasPaused ? 'resumed' : 'alreadyActive'));
    }

    case 'review-week': {
      const days = Math.max(1, parseInt(args, 10) || 7);
      return context(
        `${lib.stats(days)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Focus topics set by the user: ${cfg.focusTopics || 'none'}\n${lib.statusLine(cfg, state, key)}`);
    }

    default: // status
      return context(`${lib.statusLine(cfg, state, key)}\nLearning journal: ${lib.LEARNING_FILE}\n` +
        `Events log: ${lib.EVENTS_FILE}\nFocus topics: ${cfg.focusTopics || 'none'}`);
  }
}

// True when the user has made an attempt that the gate accepts.
function hasAttempt(dir, task) {
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
  if (lib.expirePause(state, dir)) lib.saveState(state);

  const cmd = prompt.match(COMMAND);
  if (cmd) return handleCommand(cfg, state, dir, key, cmd[1].toLowerCase(), cmd[2].trim());

  if (!prompt.startsWith('/') && !lib.isPaused(state)) {
    let gate;
    try {
      gate = new RegExp(cfg.gateRegex || lib.DEFAULT_GATE, 'i');
    } catch (err) {
      lib.logError('gate_regex', err);
      gate = new RegExp(lib.DEFAULT_GATE, 'i');
    }
    const task = state.tasks[key];
    if (gate.test(prompt) && !hasAttempt(dir, task)) {
      lib.logEvent(dir, 'gate_block', { task: task ? task.title : null, prompt: prompt.slice(0, 120) });
      const why = task ? lib.t(cfg, 'whyTask', { task: task.title }) : lib.t(cfg, 'whyClean');
      lib.blockPrompt(lib.t(cfg, 'gateBlocked', { why, min: cfg.offMinutes }));
    }
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
