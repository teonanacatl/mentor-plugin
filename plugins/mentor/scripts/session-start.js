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
  lib.lockState(proj);
  const state = lib.loadState(proj);
  try {
    lib.pruneEvents(cfg);
  } catch (err) {
    lib.logError('prune', err);
  }
  let changed = lib.expirePause(proj, state, cfg);
  changed = lib.expireCheckpoint(proj, state) || changed;
  const enabled = lib.isEnabled(cfg, proj, state);
  if (enabled && proj.git && !lib.hasSessionBaseline(state, input.session_id)) {
    lib.sessionBaseline(proj, cfg, state, input.session_id);
    changed = true;
  }
  if (changed) lib.saveState(proj, state);

  const lines = [lib.statusLine(cfg, proj, state)];
  if (enabled) {
    lines.push(
      '[mentor] Core commands: /mentor:task <title> [#topic] [--mine <glob>…] (the user writes the --mine part, you may ' +
        'write the rest), /mentor:hint [1-4|reset], /mentor:done [what I learned], /mentor:off <reason>. ' +
        'Occasionally: /mentor:try <hypothesis>, /mentor:mode <practice|guided|debug|read|explain|normal>, /mentor:on, ' +
        '/mentor:wrong, /mentor:checkpoint <topic>, /mentor:review-week, /mentor:whats-new, /mentor:status, /mentor:forget' +
        (cfg.activation === 'marker' ? ', /mentor:enable, /mentor:disable.' : '.'),
      `[mentor] Hint ladder: 1 direction, 2 concept, 3 API, 4 sketch. Each /mentor:hint raises the level by one.`);
    if (cfg.focusTopics) lines.push(`[mentor] Focus topics set by the user: ${cfg.focusTopics}.`);
    // The explicit topic profile from the Leitner boxes: smaller steps where the user is weak.
    const profile = lib.topicProfile();
    if (profile.strong.length || profile.weak.length) {
      lines.push(`[mentor] From the learning journal: the user already knows ${profile.strong.join(', ') || '(nothing recorded yet)'}; ` +
        `still weak: ${profile.weak.join(', ') || '(nothing recorded)'}. On weak topics take smaller steps and explain more; ` +
        'on known ones step in less. The user can correct this profile in the journal.');
    }
    const due = lib.dueRepeats();
    const transfers = lib.journalStats(Date.now()).transfers.due;
    if (due || transfers) {
      lines.push(`[mentor] Due in the learning journal: ${due} repetition topic(s), ${transfers} transfer exercise(s). ` +
        'If it fits the conversation, mention /mentor:review-week once, in one short sentence.');
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
