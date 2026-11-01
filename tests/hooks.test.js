'use strict';
// End-to-end tests of the hook scripts: each runs as Claude Code would run it,
// with JSON on stdin, against a throwaway git repo and data directory.
// Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'mentor', 'scripts');
const { looksLikeWrite } = require(path.join(SCRIPTS, 'pre-tool.js'));

function setup({ git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-test-'));
  const repo = path.join(root, 'repo');
  const data = path.join(root, 'data');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(repo);
  fs.mkdirSync(config);
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  }
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_PLUGIN_OPTION_LANGUAGE: 'pl',
    CLAUDE_PLUGIN_OPTION_OFF_MINUTES: '30',
  };
  const run = (script, input) => {
    const r = spawnSync('node', [path.join(SCRIPTS, script)], {
      input: JSON.stringify({ cwd: repo, ...input }), env, encoding: 'utf8',
    });
    let json = null;
    try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* plain output */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  const prompt = (text) => run('prompt.js', { hook_event_name: 'UserPromptSubmit', prompt: text });
  const tool = (tool_name, tool_input) => run('pre-tool.js', { hook_event_name: 'PreToolUse', tool_name, tool_input });
  const state = () => JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const events = () => fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { root, repo, data, config, env, run, prompt, tool, state, events };
}

const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

test('session start reports active mode and commands', () => {
  const s = setup();
  const r = s.run('session-start.js', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.strictEqual(r.code, 0);
  assert.match(ctx(r), /\[mentor\] ACTIVE/);
  assert.match(ctx(r), /\/mentor:hint/);
});

test('gate blocks a request for code in a clean repo, lets questions through', () => {
  const s = setup();
  const blocked = s.prompt('Napisz mi funkcję walidującą adres IP');
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.stderr, /najpierw Twoja próba/);
  assert.match(blocked.stderr, /nie ma żadnych zmian/);

  const question = s.prompt('Jak działa change detection w Angularze?');
  assert.strictEqual(question.code, 0);
  assert.match(ctx(question), /ACTIVE · no task started/);

  assert.strictEqual(s.prompt('jak to naprawić?').code, 0, 'infinitive is a question, not an order');
  assert.ok(s.events().some((e) => e.type === 'gate_block'));
});

test('task snapshot: gate opens only after the user changes something', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.repo, 'unrelated.txt'), 'dirty before the task\n');
  const started = s.prompt('/mentor:task walidacja IP');
  assert.strictEqual(started.code, 0);
  assert.match(started.json.systemMessage, /Zadanie: walidacja IP/);

  const blocked = s.prompt('pokaż mi rozwiązanie');
  assert.strictEqual(blocked.code, 2, 'pre-existing dirt does not count as an attempt');
  assert.match(blocked.stderr, /walidacja IP/);

  fs.appendFileSync(path.join(s.repo, 'app.js'), 'function isIp(s) { /* try */ }\n');
  assert.strictEqual(s.prompt('pokaż mi rozwiązanie').code, 0);
});

test('task without a title and off without a reason are refused', () => {
  const s = setup();
  assert.strictEqual(s.prompt('/mentor:task').code, 2);
  const off = s.prompt('/mentor:off');
  assert.strictEqual(off.code, 2);
  assert.match(off.stderr, /podaj powód/);
});

test('hint ladder climbs one level per call and stops at 4', () => {
  const s = setup();
  s.prompt('/mentor:task parser');
  const levels = [];
  for (let i = 0; i < 5; i++) {
    const r = s.prompt('/mentor:hint utknąłem');
    levels.push(s.state().tasks[Object.keys(s.state().tasks)[0]].hint);
    if (i === 1) assert.match(ctx(r), /level is now 2\/4.*concept/);
    if (i === 4) assert.match(ctx(r), /already at its top/);
  }
  assert.deepStrictEqual(levels, [1, 2, 3, 4, 4]);
  assert.match(ctx(s.prompt('a teraz?')), /hint level 4\/4 \(sketch\)/);
});

test('hint without a task opens an implicit one', () => {
  const s = setup();
  s.prompt('/mentor:hint routing');
  const task = Object.values(s.state().tasks)[0];
  assert.strictEqual(task.title, 'routing');
  assert.strictEqual(task.hint, 1);
});

test('edits in the project are denied, Claude config dir and plugin data stay writable', () => {
  const s = setup();
  const denied = s.tool('Edit', { file_path: path.join(s.repo, 'app.js'), old_string: 'a', new_string: 'b' });
  assert.strictEqual(denied.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(s.tool('Write', { file_path: 'relative/new.ts', content: 'x' }).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(s.tool('NotebookEdit', { notebook_path: path.join(s.repo, 'n.ipynb') }).json.hookSpecificOutput.permissionDecision, 'deny');

  const plan = s.tool('Write', { file_path: path.join(s.config, 'plans', 'plan.md'), content: 'x' });
  assert.strictEqual(plan.code, 0);
  assert.strictEqual(plan.stdout, '');
  const journal = s.tool('Edit', { file_path: path.join(s.data, 'LEARNING.md') });
  assert.strictEqual(journal.stdout, '');

  assert.strictEqual(s.tool('Read', { file_path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.ok(s.events().some((e) => e.type === 'edit_block' && e.file === 'app.js'));
});

test('shell commands that write files ask, read-only ones pass', () => {
  const s = setup();
  assert.strictEqual(s.tool('Bash', { command: "sed -i 's/a/b/' app.js" }).json.hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(s.tool('Bash', { command: 'git diff HEAD' }).stdout, '');
});

test('looksLikeWrite heuristics', () => {
  for (const cmd of ['echo x > out.txt', 'cat a >> b', "sed -i 's/a/b/' f", 'perl -pi -e s/a/b/ f', 'cat x | tee y',
    'git apply fix.patch', 'git checkout -- app.js', 'mv a b', 'Set-Content -Path a -Value b', 'npx prettier --write .',
    'npx eslint --fix src', 'ng g c button', "node -e \"require('fs').writeFileSync('a','b')\""]) {
    assert.ok(looksLikeWrite(cmd), `should flag: ${cmd}`);
  }
  for (const cmd of ['git diff', 'npm test 2>&1', 'ls > /dev/null', 'ls 2>/dev/null', 'git log --oneline | head -5',
    "node -e \"[1].map(x => x)\"", 'grep -rn "foo" src', 'npx ng test --watch=false', 'Get-Content app.js']) {
    assert.ok(!looksLikeWrite(cmd), `should pass: ${cmd}`);
  }
});

test('pause lifts blocks and the gate, /mentor:on brings them back', () => {
  const s = setup();
  const off = s.prompt('/mentor:off pilny hotfix na produkcji');
  assert.strictEqual(off.code, 0);
  assert.match(off.json.systemMessage, /wstrzymany do \d\d:\d\d/);
  assert.match(ctx(off), /PAUSED/);

  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.strictEqual(s.prompt('napisz to za mnie').code, 0);

  const on = s.prompt('/mentor:on');
  assert.match(on.json.systemMessage, /znów aktywny/);
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).json.hookSpecificOutput.permissionDecision, 'deny');
  const types = s.events().map((e) => e.type);
  assert.ok(types.includes('pause') && types.includes('resume'));
});

test('expired pause ends on its own', () => {
  const s = setup();
  s.prompt('/mentor:off rutyna');
  const st = s.state();
  st.pause.until = Date.now() - 1000;
  fs.writeFileSync(path.join(s.data, 'state.json'), JSON.stringify(st));
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(s.events().some((e) => e.type === 'resume' && e.auto));
});

test('done closes the task, writes the journal; review-week sums it up', () => {
  const s = setup();
  s.prompt('/mentor:task walidacja IP');
  s.prompt('/mentor:hint');
  s.prompt('/mentor:hint');
  fs.appendFileSync(path.join(s.repo, 'app.js'), '// my attempt\n');
  const done = s.prompt('/mentor:done regex nie wystarcza, trzeba sprawdzić zakres oktetów');
  assert.match(ctx(done), /Highest hint level: 2\/4.*Repo changed since the task started: yes/);
  assert.match(done.json.systemMessage, /Zamknięte: walidacja IP · podpowiedzi 2\/4/);
  assert.deepStrictEqual(s.state().tasks, {});

  const journal = fs.readFileSync(path.join(s.data, 'LEARNING.md'), 'utf8');
  assert.match(journal, /— walidacja IP/);
  assert.match(journal, /in my words: regex nie wystarcza/);

  s.prompt('/mentor:off deadline');
  const review = s.prompt('/mentor:review-week');
  assert.match(ctx(review), /closed: 1/);
  assert.match(ctx(review), /2 concept: 1/);
  assert.match(ctx(review), /deadline/);
  assert.match(ctx(review), /hint 2\/4/);
});

test('done without a task says so', () => {
  const s = setup();
  const r = s.prompt('/mentor:done');
  assert.strictEqual(r.code, 0);
  assert.match(r.json.systemMessage, /Brak otwartego zadania/);
});

test('outside a git repo the gate stays open', () => {
  const s = setup({ git: false });
  assert.strictEqual(s.prompt('napisz funkcję').code, 0);
});

test('other slash commands pass untouched by the gate', () => {
  const s = setup();
  assert.strictEqual(s.prompt('/review napisz mi to').code, 0);
});

test('english messages', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_LANGUAGE = 'en';
  const r = s.prompt('write me the code for it');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /your attempt first/);
});

test('broken state file does not lock the user out', () => {
  const s = setup();
  fs.mkdirSync(s.data, { recursive: true });
  fs.writeFileSync(path.join(s.data, 'state.json'), '{not json');
  assert.strictEqual(s.prompt('jak to działa?').code, 0);
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).json.hookSpecificOutput.permissionDecision, 'deny');
});
