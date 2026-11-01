'use strict';
// SessionStart: tells Claude that mentor mode exists, what state it is in and which commands the user has.

const fs = require('fs');
const lib = require('./lib');

try {
  const input = lib.readInput();
  const cfg = lib.config();
  const dir = lib.projectDir(input);
  const state = lib.loadState();
  if (lib.expirePause(state, dir)) lib.saveState(state);

  const lines = [
    lib.statusLine(cfg, state, lib.projectKey(dir)),
    '[mentor] Commands the user can type: /mentor:task <title>, /mentor:hint [where I am stuck], ' +
      '/mentor:done [what I learned], /mentor:off <reason>, /mentor:on, /mentor:status, /mentor:review-week, /mentor:whats-new.',
    `[mentor] Hint ladder: 1 direction, 2 concept, 3 API, 4 sketch. Each /mentor:hint raises the level by one.`,
  ];
  if (cfg.focusTopics) lines.push(`[mentor] Focus topics set by the user: ${cfg.focusTopics}.`);
  if (fs.existsSync(lib.LEARNING_FILE)) lines.push(`[mentor] Learning journal: ${lib.LEARNING_FILE}.`);

  lib.respond({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
} catch (err) {
  lib.logError('session-start', err);
  process.exit(0);
}
