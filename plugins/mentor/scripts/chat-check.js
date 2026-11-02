'use strict';
// Stop: a hook cannot take back text already shown, so this only makes it visible. When Claude's
// answer carries a large code block while mentor mode is active, the event goes to the log and
// to the weekly review. It never blocks.

const fs = require('fs');
const lib = require('./lib');

const TRANSCRIPT_TAIL = 1024 * 1024;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}

// The assistant's text since the user's last prompt, read from the end of the transcript.
function fromTranscript(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch {
    return '';
  }
  const parts = [];
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the first line of the tail is usually cut
    }
    const content = entry.message && entry.message.content;
    if (entry.type === 'assistant') parts.unshift(textOf(content));
    if (entry.type === 'user') {
      const isPrompt = typeof content === 'string' || (Array.isArray(content) && content.some((c) => c && c.type === 'text'));
      if (isPrompt) break;
    }
  }
  return parts.join('\n');
}

// Lines inside fenced code blocks.
function codeLines(text) {
  let inside = false;
  let fence = '';
  let n = 0;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m && (!inside || m[1][0] === fence[0])) {
      inside = !inside;
      fence = m[1];
      continue;
    }
    if (inside && line.trim()) n++;
  }
  return n;
}

function main() {
  const input = lib.readInput();
  if (input.stop_hook_active) process.exit(0);
  const cfg = lib.config();
  const proj = lib.project(input);
  const state = lib.loadState(proj);
  if (!lib.isActive(cfg, proj, state)) process.exit(0);

  const last = input.last_assistant_message;
  const text = typeof last === 'string' ? last : last ? textOf(last.content || last) : fromTranscript(input.transcript_path);
  const lines = codeLines(text);
  if (lines >= cfg.chatCodeLines) {
    const task = state.task;
    lib.logEvent(proj, 'code_in_chat', { lines, hint: task ? task.hint : 0, task: task ? task.title : null });
  }
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    lib.logError('chat-check', err);
    process.exit(0);
  }
}

module.exports = { codeLines, fromTranscript };
