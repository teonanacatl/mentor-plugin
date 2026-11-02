'use strict';
// SessionStart: tells Claude that mentor mode exists, what state it is in and which commands the user has.
// Also takes the session's baseline (changes made before the session do not count as an attempt)
// and prunes old events.

const fs = require('fs');
const lib = require('./lib');

try {
  const input = lib.readInput();
  const cfg = lib.config();
  const proj = lib.project(input);
  const state = lib.loadState(proj);
  try {
    lib.pruneEvents(cfg);
  } catch (err) {
    lib.logError('prune', err);
  }
  let changed = lib.expirePause(proj, state);
  const enabled = lib.isEnabled(cfg, proj, state);
  if (enabled && proj.git && !state.sessions[input.session_id || 'default']) {
    lib.sessionBaseline(proj, cfg, state, input.session_id);
    changed = true;
  }
  if (changed) lib.saveState(proj, state);

  const lines = [lib.statusLine(cfg, proj, state)];
  if (enabled) {
    lines.push(
      '[mentor] Commands the user can type: /mentor:task <title>, /mentor:hint [where I am stuck], ' +
        '/mentor:try <my attempt or hypothesis>, /mentor:done [what I learned], /mentor:off <reason>, /mentor:on, ' +
        '/mentor:status, /mentor:review-week, /mentor:whats-new' +
        (cfg.activation === 'marker' ? ', /mentor:disable.' : '.'),
      `[mentor] Hint ladder: 1 direction, 2 concept, 3 API, 4 sketch. Each /mentor:hint raises the level by one.`);
    if (cfg.focusTopics) lines.push(`[mentor] Focus topics set by the user: ${cfg.focusTopics}.`);
    const due = lib.dueRepeats();
    if (due) {
      lines.push(`[mentor] ${due} repetition topic(s) in the learning journal are due. If it fits the conversation, ` +
        'mention /mentor:review-week once, in one short sentence.');
    }
  } else {
    lines.push('[mentor] The user can turn mentor mode on here with /mentor:enable.');
  }
  lines.push(`[mentor] Learning journal: ${lib.LEARNING_FILE}` + (fs.existsSync(lib.LEARNING_FILE) ? '.' : ' (not created yet).'));

  lib.respond({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
} catch (err) {
  lib.logError('session-start', err);
  process.exit(0);
}
