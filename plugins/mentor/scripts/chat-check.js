'use strict';
// Stop: a hook cannot take back text already shown, so this only makes it visible. When Claude's
// answer carries a large code block while mentor mode is active, the event goes to the log and
// to the weekly review. It never blocks.

const fs = require('fs');
const os = require('os');
const path = require('path');
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

// Blocks that show rather than hand over: diffs, logs, terminal output and commands.
const SHOWN = /^(diff|patch|text|txt|plain|plaintext|console|log|logs|output|sh|bash|zsh|shell|powershell|ps|ps1|pwsh|cmd|bat)$/i;

// Non-empty lines inside fenced code blocks, without the blocks that only show something.
function codeBlockLines(text) {
  let inside = false;
  let fence = '';
  let counted = false;
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (m && (!inside || m[1][0] === fence[0])) {
      inside = !inside;
      fence = m[1];
      counted = inside && !SHOWN.test(m[2]);
      continue;
    }
    if (inside && counted && line.trim()) out.push(line);
  }
  return out;
}

const codeLines = (text) => codeBlockLines(text).length;

// Lines that are already in the repository are quotes of the user's code, not new code.
// Short lines (braces, `return;`) prove nothing either way and are not counted.
function newCodeLines(proj, lines) {
  const candidates = [...new Set(lines.map((l) => l.trim()).filter((l) => l.replace(/\s/g, '').length >= 4))];
  if (!candidates.length || !proj.git) return candidates.length;
  const patterns = path.join(os.tmpdir(), `mentor-grep-${process.pid}.txt`);
  let found = new Set();
  try {
    fs.writeFileSync(patterns, candidates.join('\n') + '\n');
    const out = lib.gitTry(proj.dir, ['grep', '-h', '-o', '-I', '-F', '--untracked', '-f', patterns]);
    found = new Set(out.split('\n').map((l) => l.trim()));
  } finally {
    try {
      fs.unlinkSync(patterns);
    } catch {
      // already gone
    }
  }
  return candidates.filter((l) => !found.has(l)).length;
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
  const block = codeBlockLines(text);
  const lines = block.length >= cfg.chatCodeLines ? newCodeLines(proj, block) : 0;
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

module.exports = { codeLines, codeBlockLines, fromTranscript };
