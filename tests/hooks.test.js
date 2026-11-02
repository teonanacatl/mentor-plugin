'use strict';
// End-to-end tests of the hook scripts: each runs as Claude Code would run it,
// with JSON on stdin, against a throwaway git repo and data directory.
// Run: node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'mentor', 'scripts');
const { looksLikeWrite } = require(path.join(SCRIPTS, 'pre-tool.js'));
const { codeLines } = require(path.join(SCRIPTS, 'chat-check.js'));

const commit = (repo, msg) => {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], { cwd: repo });
};
const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `// ${tag} ${i}`).join('\n') + '\n';

function setup({ git = true, root: shared } = {}) {
  const root = shared || fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-test-'));
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const data = path.join(root, 'data');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(config, { recursive: true });
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo }); // the user, for the own-commit filter
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
    commit(repo, 'init');
  }
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_PLUGIN_OPTION_LANGUAGE: 'pl',
    CLAUDE_PLUGIN_OPTION_OFF_MINUTES: '30',
    LC_ALL: '',
    LC_MESSAGES: '',
  };
  const s = { root, repo, data, config, env, session: 'sess-1' };
  s.run = (script, input) => {
    const r = spawnSync('node', [path.join(SCRIPTS, script)], {
      input: JSON.stringify({ cwd: repo, session_id: s.session, ...input }), env, encoding: 'utf8',
    });
    let json = null;
    try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* plain output */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  s.start = () => s.run('session-start.js', { hook_event_name: 'SessionStart', source: 'startup' });
  s.prompt = (text) => s.run('prompt.js', { hook_event_name: 'UserPromptSubmit', prompt: text });
  s.tool = (tool_name, tool_input) => s.run('pre-tool.js', { hook_event_name: 'PreToolUse', tool_name, tool_input });
  s.stop = (extra) => s.run('chat-check.js', { hook_event_name: 'Stop', ...extra });
  s.decision = (tool_name, tool_input) => {
    const r = s.tool(tool_name, tool_input);
    return r.json ? r.json.hookSpecificOutput.permissionDecision : 'none';
  };
  // The state file of this repo (one file per project, named by a hash of the repo root).
  s.stateFile = () => {
    const dir = path.join(data, 'state');
    const name = path.basename(repo).toLowerCase();
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (st.key.toLowerCase().endsWith(name)) return path.join(dir, f);
    }
    return null;
  };
  s.state = () => JSON.parse(fs.readFileSync(s.stateFile(), 'utf8'));
  s.writeState = (st) => fs.writeFileSync(s.stateFile(), JSON.stringify(st));
  s.events = () => fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  s.append = (file, text) => fs.appendFileSync(path.join(repo, file), text);
  return s;
}

const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

test('session start reports active mode, commands and the journal path', () => {
  const s = setup();
  const r = s.start();
  assert.strictEqual(r.code, 0);
  assert.match(ctx(r), /\[mentor\] ACTIVE/);
  assert.match(ctx(r), /\/mentor:hint/);
  assert.match(ctx(r), /\/mentor:try/);
  assert.match(ctx(r), /Learning journal: .*LEARNING\.md \(not created yet\)/);
  assert.ok(s.state().sessions['sess-1'].baseline, 'the session baseline is taken at start');
});

test('gate blocks a request for code in a clean repo, lets questions through', () => {
  const s = setup();
  const blocked = s.prompt('Napisz mi funkcję walidującą adres IP');
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.stderr, /najpierw Twoja próba/);
  assert.match(blocked.stderr, /Od początku tej sesji w kodzie zmieniło się 0 z wymaganych 3 linii/);

  const question = s.prompt('Jak działa change detection w Angularze?');
  assert.strictEqual(question.code, 0);
  assert.match(ctx(question), /ACTIVE · no task started/);
  assert.ok(s.events().some((e) => e.type === 'gate_block' && e.lines === 0));
});

test('the gate catches orders and lets information questions through', () => {
  const s = setup();
  const pass = [
    'How do I fix this?', 'What is the best way to fix it?', 'popraw mnie, jeśli się mylę',
    'Can you show me the code path that handles auth?', 'Should I write a test for this?',
    'Myślę, że napiszę tu serwis i dopiszę walidację — czy to dobry kierunek?', 'Sam to przepiszę, tylko powiedz gdzie leży interfejs',
    'Poprawię to jutro', 'jak to naprawić?', 'Czy powinienem dopisać test?', 'A gdzie dodać ten import?',
  ];
  const block = [
    'stwórz komponent logowania', 'dokończ tę funkcję', 'rozwiąż to', 'create the function for me', 'refactor this module',
    'add the missing method', 'solve it', 'can you code this up?', 'napisz to', 'NAPISZ walidację', 'Popraw mi to',
    'pokaż mi rozwiązanie', 'pokaz mi gotowy kod', 'zrób to za mnie', 'Czy możesz napisać ten serwis?',
    'write me the code for it', 'Ok, napisz to.', 'Rozumiem problem. Teraz zaimplementuj resztę.', '/ napisz to',
  ];
  for (const p of pass) assert.strictEqual(s.prompt(p).code, 0, `should pass: ${p}`);
  for (const p of block) assert.strictEqual(s.prompt(p).code, 2, `should block: ${p}`);
  assert.strictEqual(s.prompt('/review napisz mi to').code, 0, 'a real slash command is not gated');
});

test('task snapshot: earlier changes and a one-line touch are not an attempt', () => {
  const s = setup();
  s.append('unrelated.js', lines(10, 'dirty before the task'));
  const started = s.prompt('/mentor:task walidacja IP');
  assert.strictEqual(started.code, 0);
  assert.match(started.json.systemMessage, /Zadanie: walidacja IP/);

  const blocked = s.prompt('pokaż mi rozwiązanie');
  assert.strictEqual(blocked.code, 2, 'pre-existing dirt does not count as an attempt');
  assert.match(blocked.stderr, /„walidacja IP” w kodzie zmieniło się 0 z wymaganych 3/);

  s.append('app.js', 'function isIp(s) {}\n');
  assert.strictEqual(s.prompt('pokaż mi rozwiązanie').code, 2, 'one line is below attempt_min_lines');
  s.append('app.js', '  // split into octets\n  // check the range\n');
  assert.strictEqual(s.prompt('pokaż mi rozwiązanie').code, 0);
});

test('attempt_min_lines is configurable', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_ATTEMPT_MIN_LINES = '1';
  s.prompt('/mentor:task jedna linia');
  s.append('app.js', 'fix();\n');
  assert.strictEqual(s.prompt('napraw resztę').code, 0);
});

test('generated files, lock files and build output do not open the gate', () => {
  const s = setup();
  s.prompt('/mentor:task artefakty');
  fs.mkdirSync(path.join(s.repo, 'coverage'));
  fs.writeFileSync(path.join(s.repo, 'coverage', 'coverage.json'), lines(50));
  fs.mkdirSync(path.join(s.repo, 'dist', 'js'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'dist', 'js', 'main.js'), lines(50));
  fs.writeFileSync(path.join(s.repo, 'package-lock.json'), lines(50));
  fs.writeFileSync(path.join(s.repo, 'test.log'), lines(50));
  assert.strictEqual(s.prompt('napisz to').code, 2);

  s.env.CLAUDE_PLUGIN_OPTION_ATTEMPT_IGNORE = 'src/generated/';
  fs.mkdirSync(path.join(s.repo, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'src', 'generated', 'api.ts'), lines(50));
  assert.strictEqual(s.prompt('napisz to').code, 2, 'attempt_ignore adds own patterns');

  fs.writeFileSync(path.join(s.repo, 'parser.js'), lines(5));
  assert.strictEqual(s.prompt('napisz to').code, 0);
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
    levels.push(s.state().task.hint);
    if (i === 0) assert.match(r.json.systemMessage, /Podpowiedź 1\/4 · kierunek/);
    if (i === 1) assert.match(ctx(r), /level is now 2\/4.*concept/);
    if (i === 4) assert.match(ctx(r), /already at its top/);
  }
  assert.deepStrictEqual(levels, [1, 2, 3, 4, 4]);
  assert.match(ctx(s.prompt('a teraz?')), /hint level 4\/4 \(sketch\)/);
});

test('hint without a task opens an implicit one', () => {
  const s = setup();
  s.prompt('/mentor:hint routing');
  const task = s.state().task;
  assert.strictEqual(task.title, 'routing');
  assert.strictEqual(task.hint, 1);
});

test('implicit task counts the work of this session, not work from before it', () => {
  const s = setup();
  s.append('app.js', lines(10, 'left from yesterday'));
  s.start();
  s.prompt('/mentor:hint utknąłem na parserze');
  assert.strictEqual(s.prompt('pokaż mi rozwiązanie').code, 2, 'changes from before the session do not count');

  const w = setup();
  w.start();
  w.append('app.js', lines(4, 'my own start'));
  w.prompt('/mentor:hint utknąłem na parserze');
  assert.strictEqual(w.prompt('pokaż mi rozwiązanie').code, 0, 'work done in this session counts');
});

test('edits in the project are denied; plans, todos, memory and the journal stay writable', () => {
  const s = setup();
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js'), old_string: 'a', new_string: 'b' }), 'deny');
  assert.strictEqual(s.decision('Write', { file_path: 'relative/new.ts', content: 'x' }), 'deny');
  assert.strictEqual(s.decision('NotebookEdit', { notebook_path: path.join(s.repo, 'n.ipynb') }), 'deny');
  assert.strictEqual(s.decision('Write', { file_path: path.join(os.tmpdir(), 'elsewhere.js') }), 'deny', 'outside the project is not a loophole');

  for (const ok of [
    path.join(s.config, 'plans', 'plan.md'),
    path.join(s.config, 'todos', 'x.json'),
    path.join(s.config, 'projects', 'my-proj', 'memory', 'MEMORY.md'),
    path.join(s.data, 'LEARNING.md'),
  ]) {
    assert.strictEqual(s.tool('Write', { file_path: ok, content: 'x' }).stdout, '', `should allow: ${ok}`);
  }
  assert.strictEqual(s.tool('Read', { file_path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.ok(s.events().some((e) => e.type === 'edit_block' && e.file === 'app.js'));
});

test("Claude cannot switch mentor off from the inside, not even during a pause", () => {
  const s = setup();
  s.prompt('/mentor:task x');
  const protectedFiles = [
    s.stateFile(),
    path.join(s.data, 'events.jsonl'),
    path.join(s.config, 'settings.json'),
    path.join(s.config, 'settings.local.json'),
    path.join(s.config, 'plugins', 'cache', 'mentor', 'scripts', 'pre-tool.js'),
    path.join(s.repo, '.claude', 'settings.local.json'),
  ];
  for (const f of protectedFiles) assert.strictEqual(s.decision('Write', { file_path: f, content: '{}' }), 'deny', `should deny: ${f}`);
  for (const cmd of ['claude plugin disable mentor@mentor-plugin', `echo {} > ${path.join(s.config, 'settings.json')}`,
    "jq '.enabledPlugins = {}' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json", 'rm .mentor',
    `node -e "require('fs').writeFileSync('${s.stateFile().replace(/\\/g, '/')}', '{}')"`]) {
    assert.strictEqual(s.decision('Bash', { command: cmd }), 'deny', `should deny: ${cmd}`);
  }
  assert.strictEqual(s.tool('Bash', { command: 'cat ~/.claude/settings.json' }).stdout, '', 'reading settings is fine');

  s.prompt('/mentor:off pilny hotfix na produkcji');
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).stdout, '', 'the pause lifts project blocks');
  assert.strictEqual(s.decision('Write', { file_path: s.stateFile(), content: '{}' }), 'deny', 'but not the protection of the state');
  assert.strictEqual(s.decision('Bash', { command: 'claude plugin uninstall mentor' }), 'deny');
  assert.ok(s.events().filter((e) => e.type === 'tamper_block').length >= protectedFiles.length);
});

test('MCP tools: writes into the project are denied, other MCP tools pass', () => {
  const s = setup();
  assert.strictEqual(s.decision('mcp__filesystem__write_file', { path: path.join(s.repo, 'app.js'), content: 'x' }), 'deny');
  assert.strictEqual(s.decision('mcp__filesystem__edit_file', { path: 'app.js', edits: [] }), 'deny', 'relative to the project');
  assert.strictEqual(s.decision('mcp__fs__move_file', { source: path.join(s.config, 'plans', 'a.md'), destination: path.join(s.repo, 'b.js') }), 'deny');
  assert.strictEqual(s.decision('mcp__filesystem__write_file', { path: path.join(s.config, 'settings.json') }), 'deny');
  assert.strictEqual(s.tool('mcp__filesystem__read_file', { path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.strictEqual(s.tool('mcp__calendar__create_event', { title: 'standup', start: '10:00' }).stdout, '', 'no path, no file write');
  assert.strictEqual(s.tool('mcp__filesystem__write_file', { path: path.join(s.config, 'plans', 'p.md') }).stdout, '');
  assert.ok(s.events().some((e) => e.type === 'edit_block' && e.tool === 'mcp__filesystem__write_file'));
});

test('shell guard: ask by default, deny or off on request', () => {
  const s = setup();
  assert.strictEqual(s.decision('Bash', { command: "sed -i 's/a/b/' app.js" }), 'ask');
  assert.strictEqual(s.tool('Bash', { command: 'git diff HEAD' }).stdout, '');
  s.env.CLAUDE_PLUGIN_OPTION_BASH_GUARD_DENY = 'true';
  assert.strictEqual(s.decision('Bash', { command: "sed -i 's/a/b/' app.js" }), 'deny');
  assert.ok(s.events().some((e) => e.type === 'shell_block'));
  s.env.CLAUDE_PLUGIN_OPTION_BASH_GUARD = 'false';
  assert.strictEqual(s.tool('Bash', { command: "sed -i 's/a/b/' app.js" }).stdout, '');
});

test('looksLikeWrite heuristics', () => {
  for (const cmd of ['echo x > out.txt', 'cat a >> b', 'echo x >| f', "sed -i 's/a/b/' f", 'perl -pi -e s/a/b/ f', 'cat x | tee y',
    'git apply fix.patch', 'git checkout -- app.js', 'git checkout app.js', 'git switch main', 'git stash', 'git stash pop',
    'git clean -fd', 'mv a b', 'ln -s a b', 'dd if=/dev/zero of=f bs=1k count=1', 'install -m 644 a /usr/local/bin/a',
    'Set-Content -Path a -Value b', 'npx prettier --write .', 'npx eslint --fix src', 'ng g c button',
    "node -e \"require('fs').writeFileSync('a','b')\""]) {
    assert.ok(looksLikeWrite(cmd), `should flag: ${cmd}`);
  }
  for (const cmd of ['git diff', 'npm test 2>&1', 'ls > /dev/null', 'ls 2>/dev/null', 'git log --oneline | head -5',
    "node -e \"[1].map(x => x)\"", 'grep -rn "foo" src', 'npx ng test --watch=false', 'Get-Content app.js',
    'grep -- "--fix" CHANGELOG.md', 'git stash list', 'npm install', 'git log --grep="--write"']) {
    assert.ok(!looksLikeWrite(cmd), `should pass: ${cmd}`);
  }
});

test('quoted comparisons are not redirects', () => {
  for (const cmd of ["jq '.items[] | select(.count > 0)' data.json", 'node -e "console.log(arr.length > 0)"',
    "python -c 'print(1 > 0)'", 'git log --format="%h > %s"']) {
    assert.ok(!looksLikeWrite(cmd), `should pass: ${cmd}`);
  }
  for (const cmd of ['echo "x > y" > out.txt', "jq '.a' in.json > out.json", 'node -e "x>0" >> log.txt']) {
    assert.ok(looksLikeWrite(cmd), `should flag: ${cmd}`);
  }
});

test('pause lifts blocks and the gate, /mentor:on brings them back', () => {
  const s = setup();
  const off = s.prompt('/mentor:off pilny hotfix na produkcji');
  assert.strictEqual(off.code, 0);
  assert.match(off.json.systemMessage, /wstrzymany w tym repo do \d\d:\d\d/);
  assert.match(ctx(off), /PAUSED/);

  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.strictEqual(s.prompt('napisz to za mnie').code, 0);

  const on = s.prompt('/mentor:on');
  assert.match(on.json.systemMessage, /znów aktywny/);
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js') }), 'deny');
  const types = s.events().map((e) => e.type);
  assert.ok(types.includes('pause') && types.includes('resume'));
});

test('expired pause ends on its own', () => {
  const s = setup();
  s.prompt('/mentor:off rutyna');
  const st = s.state();
  st.pause.until = Date.now() - 1000;
  s.writeState(st);
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js') }), 'deny');
  assert.ok(s.events().some((e) => e.type === 'resume' && e.auto));
});

test('from the third pause of the day the reason must be longer', () => {
  const s = setup();
  assert.strictEqual(s.prompt('/mentor:off hotfix').code, 0);
  s.prompt('/mentor:on');
  assert.strictEqual(s.prompt('/mentor:off spotkanie').code, 0);
  s.prompt('/mentor:on');
  const third = s.prompt('/mentor:off zmęczenie');
  assert.strictEqual(third.code, 2);
  assert.match(third.stderr, /3\. przerwa dzisiaj.*40 znaków/);
  assert.strictEqual(s.prompt('/mentor:off produkcja leży, klient czeka na poprawkę konfiguracji DNS').code, 0);
  assert.strictEqual(s.events().filter((e) => e.type === 'pause').pop().today, 3);
});

test('a pause in one project leaves the other one blocked', () => {
  const a = setup();
  const b = setup({ root: a.root });
  assert.strictEqual(a.prompt('/mentor:off hotfix').code, 0);
  assert.strictEqual(a.tool('Edit', { file_path: path.join(a.repo, 'app.js') }).stdout, '');
  assert.strictEqual(b.decision('Edit', { file_path: path.join(b.repo, 'app.js') }), 'deny');
  assert.match(ctx(b.prompt('co dalej?')), /ACTIVE/);
  assert.match(ctx(a.prompt('co dalej?')), /PAUSED in this project/);
  assert.notStrictEqual(a.stateFile(), b.stateFile(), 'one state file per project');
});

test('a session opened in a subdirectory shares the task and the pause of the repo', () => {
  const s = setup();
  s.prompt('/mentor:task w korzeniu');
  fs.mkdirSync(path.join(s.repo, 'src'));
  s.env.CLAUDE_PROJECT_DIR = path.join(s.repo, 'src');
  assert.match(ctx(s.prompt('gdzie jestem?')), /task: "w korzeniu"/);
  s.prompt('/mentor:off hotfix');
  s.env.CLAUDE_PROJECT_DIR = s.repo;
  assert.match(ctx(s.prompt('co dalej?')), /PAUSED/);
});

test('state.json from 0.2 is migrated per project', () => {
  const s = setup();
  fs.mkdirSync(s.data, { recursive: true });
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: s.repo, encoding: 'utf8' }).trim();
  const key = path.resolve(top);
  const k = process.platform === 'win32' ? key.toLowerCase() : key;
  fs.writeFileSync(path.join(s.data, 'state.json'), JSON.stringify({
    pauses: {}, tasks: { [k]: { title: 'stare zadanie', startedAt: Date.now(), hint: 2, fingerprint: 'x', head: null } },
  }));
  assert.match(ctx(s.prompt('co dalej?')), /task: "stare zadanie" · hint level 2\/4/);
  assert.ok(s.state().task.baseline, 'a task from 0.2 gets a baseline on first use');
});

test('broken state file does not lock the user out', () => {
  const s = setup();
  s.prompt('/mentor:task x');
  fs.writeFileSync(s.stateFile(), '{not json');
  assert.strictEqual(s.prompt('jak to działa?').code, 0);
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js') }), 'deny');
});

test('done closes the task, writes the journal; review-week sums it up', () => {
  const s = setup();
  s.prompt('/mentor:task walidacja IP');
  s.prompt('/mentor:hint');
  s.prompt('/mentor:hint');
  s.append('app.js', '// my attempt\n');
  const done = s.prompt('/mentor:done regex nie wystarcza, trzeba sprawdzić zakres oktetów');
  assert.match(ctx(done), /Highest hint level: 2\/4.*Repo changed since the task started: yes/);
  assert.match(done.json.systemMessage, /Zamknięte: walidacja IP · podpowiedzi 2\/4/);
  assert.strictEqual(s.state().task, null);

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

test('done shows new files with their content, commits, and leaves lock files out', () => {
  const s = setup();
  s.append('old-dirt.js', 'before the task\n');
  s.prompt('/mentor:task review');
  s.append('app.js', 'const committed = 1;\n');
  commit(s.repo, 'wip');
  fs.writeFileSync(path.join(s.repo, 'feature.js'), 'export function feature() {\n  return 42;\n}\n');
  fs.writeFileSync(path.join(s.repo, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  const text = ctx(s.prompt('/mentor:done'));
  assert.match(text, /app\.js \| \+1 -0/);
  assert.match(text, /feature\.js \| \+3 -0 \(new, untracked\)/);
  assert.match(text, /\+const committed = 1;/);
  assert.match(text, /\+export function feature\(\) \{\n\+  return 42;/);
  assert.match(text, /git status --short:\n.*\?\? feature\.js/s);
  assert.match(text, /commits during the task included/);
  assert.doesNotMatch(text, /lockfileVersion/);
  assert.doesNotMatch(text, /before the task\n/, 'old dirt is left out of the diff');
});

test('done fits whole files into the budget and lists the rest', () => {
  const s = setup();
  s.prompt('/mentor:task duży diff');
  fs.writeFileSync(path.join(s.repo, 'a-small.js'), 'small();\n');
  fs.writeFileSync(path.join(s.repo, 'b-big.js'), 'x'.repeat(20000) + '\n');
  fs.writeFileSync(path.join(s.repo, 'c-small.js'), 'also();\n');
  const text = ctx(s.prompt('/mentor:done'));
  assert.match(text, /\+small\(\);/);
  assert.match(text, /\+also\(\);/);
  assert.match(text, /Not included, the diff budget ran out: b-big\.js/);

  const one = setup();
  one.prompt('/mentor:task jeden wielki plik');
  one.append('app.js', 'y'.repeat(20000) + '\n');
  assert.match(ctx(one.prompt('/mentor:done')), /app\.js cut at 12000 characters/);
});

test('work time skips the night and paused time', () => {
  const s = setup();
  s.prompt('/mentor:task na noc');
  const st = s.state();
  st.task.startedAt = st.task.lastActiveAt = Date.now() - 17 * 3600000;
  s.writeState(st);
  const done = s.prompt('/mentor:done');
  assert.match(ctx(done), /Work time: 60 min \(open for 1020 min\)/);
  const event = s.events().find((e) => e.type === 'task_done');
  assert.strictEqual(event.minutes, 60);
  assert.strictEqual(event.wallMinutes, 1020);

  const p = setup();
  p.prompt('/mentor:task z przerwą');
  const ps = p.state();
  const t0 = Date.now() - 50 * 60000;
  ps.task.startedAt = ps.task.lastActiveAt = t0;
  ps.pause = { until: t0 + 40 * 60000, reason: 'rutyna' };
  p.writeState(ps);
  assert.match(ctx(p.prompt('/mentor:done')), /Work time: 10 min/);
});

test('outside a git repo the gate stays open', () => {
  const s = setup({ git: false });
  assert.strictEqual(s.prompt('napisz funkcję').code, 0);
});

test('english messages and the language from the locale', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_LANGUAGE = 'en';
  const r = s.prompt('write me the code for it');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /your attempt first/);

  s.env.CLAUDE_PLUGIN_OPTION_LANGUAGE = '';
  s.env.LANG = 'pl_PL.UTF-8';
  assert.match(s.prompt('napisz to').stderr, /najpierw Twoja próba/);
  s.env.LANG = 'en_US.UTF-8';
  assert.match(s.prompt('napisz to').stderr, /your attempt first/);
});

test('custom gate_regex without the u flag still works', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_GATE_REGEX = String.raw`\bplease code\b`;
  assert.strictEqual(s.prompt('please code it').code, 2);
  assert.strictEqual(s.prompt('napisz to').code, 0);
});

test('committing work in progress during a task counts as an attempt', () => {
  const s = setup();
  s.prompt('/mentor:task walidacja');
  s.append('app.js', lines(3, 'isIp'));
  commit(s.repo, 'wip');
  assert.strictEqual(s.prompt('popraw mój kod').code, 0);
});

test('untracked files with Polish names are seen by the snapshot', () => {
  const s = setup();
  const file = 'zadanie-ż.js';
  s.append(file, 'a\n');
  s.prompt('/mentor:task polskie nazwy');
  assert.strictEqual(s.prompt('napisz to').code, 2);
  s.append(file, lines(3, 'moja próba'));
  assert.strictEqual(s.prompt('napisz to').code, 0);
});

test('/mentor:try opens the gate without touching files and needs a real sentence', () => {
  const s = setup();
  s.prompt('/mentor:task strumień się nie odświeża');
  assert.strictEqual(s.prompt('napraw to').code, 2);
  assert.strictEqual(s.prompt('/mentor:try nie wiem').code, 2);
  const tried = s.prompt('/mentor:try podejrzewam, że subskrypcja nie jest odnawiana po zmianie trasy');
  assert.match(tried.json.systemMessage, /Bramka dla „strumień się nie odświeża” otwarta/);
  assert.match(ctx(tried), /hypothesis.*subskrypcja/);
  assert.strictEqual(s.prompt('napraw to').code, 0);
  assert.match(ctx(s.prompt('/mentor:review-week')), /\/mentor:try: 1/);
});

test('whats-new is logged and gets the journal path', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_FOCUS_TOPICS = 'Angular signals';
  const r = s.prompt('/mentor:whats-new angular');
  assert.match(ctx(r), /not created yet/);
  assert.match(ctx(r), /Angular signals/);
  assert.ok(s.events().some((e) => e.type === 'whats_new' && e.arg === 'angular'));
  assert.match(ctx(s.prompt('/mentor:review-week')), /what's-new checks: 1/);
});

test('activation = marker: off until /mentor:enable or a .mentor file', () => {
  const s = setup();
  s.env.CLAUDE_PLUGIN_OPTION_ACTIVATION = 'marker';
  assert.match(ctx(s.start()), /OFF in this project/);
  assert.strictEqual(s.prompt('napisz to').code, 0);
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).stdout, '');
  assert.match(s.prompt('/mentor:task x').json.systemMessage, /nie jest włączony/);

  assert.match(s.prompt('/mentor:enable').json.systemMessage, /włączony w tym repo/);
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js') }), 'deny');
  assert.match(s.prompt('/mentor:disable').json.systemMessage, /wyłączony w tym repo/);
  assert.strictEqual(s.tool('Edit', { file_path: path.join(s.repo, 'app.js') }).stdout, '');

  s.append('.mentor', '');
  assert.strictEqual(s.decision('Edit', { file_path: path.join(s.repo, 'app.js') }), 'deny');
  assert.match(s.prompt('/mentor:disable').json.systemMessage, /plik \.mentor/);
  assert.strictEqual(s.prompt('napisz to').code, 2, 'the .mentor file itself is not an attempt');
  assert.match(ctx(s.prompt('/mentor:review-week')), /\/mentor:disable\): 2/);

  const always = setup();
  assert.match(always.prompt('/mentor:disable').json.systemMessage, /activation = always/);
});

test('Stop hook logs large code blocks in answers while mentor mode is active', () => {
  const s = setup();
  s.prompt('/mentor:task kod w czacie');
  const big = 'Here it is:\n```js\n' + lines(20) + '```\n';
  assert.strictEqual(s.stop({ last_assistant_message: 'Look at line 12 of app.js.\n```js\nconst a = 1;\n```' }).code, 0);
  assert.strictEqual(s.stop({ last_assistant_message: big }).code, 0);

  const transcript = path.join(s.root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { content: 'napisz to' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '```ts\n' + lines(9, 'first') }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: lines(9, 'second') + '```' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  s.stop({ transcript_path: transcript });

  const logged = s.events().filter((e) => e.type === 'code_in_chat');
  assert.deepStrictEqual(logged.map((e) => e.lines), [20, 18]);
  assert.strictEqual(logged[0].task, 'kod w czacie');
  assert.match(ctx(s.prompt('/mentor:review-week')), /large block of new code while mentor mode was active: 2 \(20 lines at hint 0\/4/);

  s.prompt('/mentor:off normalny tryb na chwilę');
  s.stop({ last_assistant_message: big });
  assert.strictEqual(s.events().filter((e) => e.type === 'code_in_chat').length, 2, 'not logged during a pause');
  assert.strictEqual(codeLines('~~~\na\n```\nb\n~~~\nc'), 3, 'a ``` line inside a ~~~ block is content, not its end');
});

test('due repetition items are counted at session start and in the review', () => {
  const s = setup();
  fs.mkdirSync(s.data, { recursive: true });
  fs.writeFileSync(path.join(s.data, 'LEARNING.md'), [
    '- [ ] repeat: RxJS switchMap (box 1, due 2000-01-01)',
    '- [ ] repeat: Angular signals (box 3, due 2999-01-01)',
    '- repeat: change detection',
    '- [x] repeat: closures (mastered 2026-01-01)',
  ].join('\n'));
  assert.match(ctx(s.start()), /2 repetition topic\(s\) in the learning journal are due/);
  assert.match(ctx(s.prompt('/mentor:review-week')), /Repetition items due today or earlier: 2/);
});

test('events carry a project id; same folder names are told apart; old events are pruned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-test-'));
  const mk = (sub) => {
    fs.mkdirSync(path.join(root, sub));
    return setup({ root: path.join(root, sub) });
  };
  const a = mk('a');
  const b = mk('b');
  // Same basename in two places: rename both repos to "app".
  for (const s of [a, b]) {
    const target = path.join(path.dirname(s.repo), 'app');
    fs.renameSync(s.repo, target);
    s.repo = target;
    s.env.CLAUDE_PROJECT_DIR = target;
  }
  b.env.CLAUDE_PLUGIN_DATA = a.data;
  b.data = a.data;
  a.prompt('/mentor:off pierwszy projekt');
  b.prompt('/mentor:off drugi projekt');
  const pauses = a.events().filter((e) => e.type === 'pause');
  assert.notStrictEqual(pauses[0].pid, pauses[1].pid);
  assert.match(ctx(a.prompt('/mentor:review-week')), /\[app#\w{4}\] pierwszy projekt[\s\S]*\[app#\w{4}\] drugi projekt/);

  const old = JSON.stringify({ ts: '2000-01-01T00:00:00.000Z', type: 'pause', project: 'x', reason: 'stare' });
  fs.appendFileSync(path.join(a.data, 'events.jsonl'), old + '\n');
  a.start();
  assert.ok(!a.events().some((e) => e.reason === 'stare'), 'events older than keep_days are removed');
});

// --- 0.4.0 ---

test('allowed places take only Markdown or JSON, and nothing there can be run', () => {
  const s = setup();
  for (const f of [path.join(s.config, 'plans', 'x.js'), path.join(s.config, 'todos', 'x.md'),
    path.join(s.config, 'projects', 'p', 'memory', 'x.py')]) {
    assert.strictEqual(s.decision('Write', { file_path: f, content: "require('fs').writeFileSync('a.js','x')" }), 'deny', `should deny: ${f}`);
  }
  const plan = path.join(s.config, 'plans', 'x.md');
  assert.strictEqual(s.tool('Write', { file_path: plan, content: '# plan' }).stdout, '');
  for (const cmd of [`node ${plan}`, `node ${path.join(s.data, 'LEARNING.md')}`, `python3 ${plan}`, 'node ~/.claude/plans/x.md',
    `cd ${path.join(s.config, 'plans')} && node x.md`, 'bash ~/.claude/todos/run.json']) {
    assert.strictEqual(s.decision('Bash', { command: cmd }), 'deny', `should deny: ${cmd}`);
  }
});

test('commands touching protected places pass only as plain reads', () => {
  const s = setup();
  for (const cmd of [
    `python3 -c "import pathlib; pathlib.Path.home().joinpath('.claude/settings.json').write_text('{}')"`,
    `node -e "require('fs').rmSync(process.env.HOME+'/.claude/plugins',{recursive:true})"`,
    "jq '.enabledPlugins={}' ~/.claude/settings.json | sponge ~/.claude/settings.json",
    'git -C ~/.claude commit -am x',
    `find ${s.data} -delete`,
  ]) {
    assert.strictEqual(s.decision('Bash', { command: cmd }), 'deny', `should deny: ${cmd}`);
  }
  for (const cmd of [`cat ${path.join(s.config, 'settings.json')}`, 'ls ~/.claude/plans', "jq '.enabledPlugins' ~/.claude/settings.json",
    `grep -rn TODO ${s.data} | head -5`, 'cd ~/.claude && git log --oneline -3']) {
    assert.strictEqual(s.tool('Bash', { command: cmd }).stdout, '', `should pass: ${cmd}`);
  }
});

test('MCP: camelCase and apply verbs are writes; commands run through MCP are guarded', () => {
  const s = setup();
  assert.strictEqual(s.decision('mcp__fs__apply_diff', { path: 'app.js', diff: '-a\n+b' }), 'deny');
  assert.strictEqual(s.decision('mcp__x__fileWrite', { filePath: 'app.js', content: 'x' }), 'deny');
  assert.strictEqual(s.decision('mcp__dc__start_process', { command: "sed -i 's/a/b/' app.js" }), 'ask');
  assert.strictEqual(s.decision('mcp__x__executeCode', { code: "require('fs').writeFileSync('app.js', 'x')" }), 'ask');
  assert.strictEqual(s.decision('mcp__ide__run_terminal_cmd', { cmd: 'claude plugin disable mentor' }), 'deny');
  assert.strictEqual(s.tool('mcp__dc__start_process', { command: 'npm test' }).stdout, '');
  assert.strictEqual(s.tool('mcp__dc__read_process_output', { pid: 12 }).stdout, '');
});

test("someone else's commits and a branch switch are not the user's attempt", () => {
  const s = setup();
  s.prompt('/mentor:task po pullu');
  s.append('colleague.js', lines(10, 'colleague'));
  execFileSync('git', ['add', '-A'], { cwd: s.repo });
  execFileSync('git', ['-c', 'user.name=k', '-c', 'user.email=kolega@firma', 'commit', '-qm', 'their work'], { cwd: s.repo });
  assert.strictEqual(s.prompt('napisz to').code, 2, 'a commit by another author does not count');
  const review = ctx(s.prompt('/mentor:done'));
  assert.doesNotMatch(review, /colleague 0/);
  assert.match(review, /moved: a commit by kolega@firma came in/);

  const b = setup();
  execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: b.repo });
  b.append('feature.js', lines(10, 'old branch work'));
  commit(b.repo, 'feature from last week');
  execFileSync('git', ['checkout', '-q', '-'], { cwd: b.repo });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); // the task starts seconds after the branch's commit
  b.prompt('/mentor:task na mainie');
  execFileSync('git', ['checkout', '-q', 'feature'], { cwd: b.repo });
  assert.strictEqual(b.prompt('napisz to').code, 2, 'switching to a branch with older commits is not an attempt');
  b.append('app.js', lines(3, 'my change'));
  assert.strictEqual(b.prompt('napisz to').code, 0);

  for (const cmd of ['git pull', 'git merge origin/main', 'git rebase main', 'git cherry-pick abc123']) {
    assert.strictEqual(s.decision('Bash', { command: cmd }), 'ask', `should ask: ${cmd}`);
  }
});

test('blank lines, whitespace and formatters are not an attempt', () => {
  const s = setup();
  s.append('app.js', 'function a() {\nreturn 1;\n}\n');
  commit(s.repo, 'code');
  s.prompt('/mentor:task białe znaki');
  s.append('app.js', '\n\n\n\n\n');
  assert.strictEqual(s.prompt('napisz to').code, 2, 'blank lines');
  fs.writeFileSync(path.join(s.repo, 'app.js'), 'console.log(1);\nfunction a() {\n    return 1;\n}\n');
  assert.strictEqual(s.prompt('napisz to').code, 2, 'reindenting');
  fs.writeFileSync(path.join(s.repo, 'empty.js'), '\n\n\n\n');
  assert.strictEqual(s.prompt('napisz to').code, 2, 'a new file with blank lines');

  for (const cmd of ['npx prettier -w .', 'npm run format', 'pnpm lint:fix', 'yarn fix', 'gofmt -w .', 'cargo fmt', 'black .',
    'ruff format src', 'dotnet format', 'npx prisma generate', 'go fmt ./...']) {
    assert.ok(looksLikeWrite(cmd), `should flag: ${cmd}`);
  }
  for (const cmd of ['black --check .', 'npm run format:check', 'ruff format --check', 'npx prettier --check .']) {
    assert.ok(!looksLikeWrite(cmd), `should pass: ${cmd}`);
  }
});

test("the gate leaves the user's own plans and pasted code alone", () => {
  const s = setup();
  for (const p of ['I want to build a parser. Where do I start?', 'Let me write the code myself first.',
    'I need to implement the cache and I am stuck on eviction.', "We'll add the missing check later, what should it test?",
    'Here is the log:\n```\n// TODO: add the missing null check\nTypeError: x is undefined\n```\nWhat does it mean?',
    '> write the function\nThat is what the ticket says. What does "idempotent" mean here?',
    'The comment says `fix it later`. Is that a smell?']) {
    assert.strictEqual(s.prompt(p).code, 0, `should pass: ${p}`);
  }
  for (const p of ['give me a function that parses IPs', 'rewrite this module', 'zmień to na async', 'make it work',
    'please do it for me', 'do the rest', 'potrzebuję gotowego kodu', 'I tried. Now write the rest of it.']) {
    assert.strictEqual(s.prompt(p).code, 2, `should block: ${p}`);
  }
});

test('lasting instructions written during a pause are logged for the review', () => {
  const s = setup();
  s.prompt('/mentor:off refaktor konfiguracji z zespołem');
  assert.strictEqual(s.tool('Write', { file_path: path.join(s.config, 'CLAUDE.md'), content: 'x' }).stdout, '');
  assert.strictEqual(s.tool('Write', { file_path: path.join(s.repo, '.claude', 'agents', 'coder.md'), content: 'x' }).stdout, '');
  assert.strictEqual(s.tool('Write', { file_path: path.join(s.repo, 'app.js'), content: 'x' }).stdout, '');
  assert.strictEqual(s.events().filter((e) => e.type === 'persist_write').length, 2);
  assert.match(ctx(s.prompt('/mentor:review-week')), /lasting instructions for Claude written during pauses: 2/);
});

test('code in chat: diffs, logs and quotes of the repo do not count', () => {
  const s = setup();
  const own = lines(20, 'already in the repo');
  s.append('app.js', own);
  commit(s.repo, 'own code');
  s.prompt('/mentor:task cytaty');
  s.stop({ last_assistant_message: '```diff\n' + lines(30, 'diff line') + '```' });
  s.stop({ last_assistant_message: '```text\n' + lines(30, 'log line') + '```' });
  s.stop({ last_assistant_message: 'Look at your code:\n```js\n' + own + '```' });
  assert.ok(!s.events().some((e) => e.type === 'code_in_chat'));
  s.stop({ last_assistant_message: '```js\n' + own + lines(16, 'brand new') + '```' });
  assert.strictEqual(s.events().filter((e) => e.type === 'code_in_chat')[0].lines, 16);
});

test('dates are local everywhere', () => {
  const s = setup();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.match(ctx(s.prompt('/mentor:review-week')), new RegExp(`Today is ${today}`));
  fs.mkdirSync(s.data, { recursive: true });
  fs.writeFileSync(path.join(s.data, 'LEARNING.md'), `- [ ] repeat: a (box 1, due ${today})\n`);
  assert.match(ctx(s.prompt('/mentor:review-week')), /due today or earlier: 1/);
});

test('build/ and out/ are skipped only at the repo root', () => {
  const s = setup();
  s.prompt('/mentor:task skrypty');
  fs.mkdirSync(path.join(s.repo, 'build'));
  fs.writeFileSync(path.join(s.repo, 'build', 'bundle.js'), lines(10));
  assert.strictEqual(s.prompt('napisz to').code, 2);
  fs.mkdirSync(path.join(s.repo, 'scripts', 'build'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'scripts', 'build', 'release.js'), lines(3, 'real code'));
  assert.strictEqual(s.prompt('napisz to').code, 0);
});

test('a broken edit hook fails closed, reads still pass', () => {
  const s = setup();
  const notADir = path.join(s.root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  s.env.CLAUDE_PLUGIN_DATA = notADir;
  const r = s.tool('Edit', { file_path: path.join(s.repo, 'app.js') });
  assert.strictEqual(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /hook failed/);
  assert.strictEqual(s.tool('Bash', { command: 'ls' }).stdout, '');
  assert.strictEqual(s.prompt('jak to działa?').code, 0, 'prompts still fail open');
});

test('a stale state lock does not block a prompt', () => {
  const s = setup();
  s.prompt('/mentor:task lock');
  const lock = s.stateFile() + '.lock';
  fs.writeFileSync(lock, '99999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.match(ctx(s.prompt('co dalej?')), /task: "lock"/);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the prompt');
});

// --- 0.5.0 ---

test('code written during a pause is not the user\'s attempt and is reported apart', () => {
  const s = setup();
  s.prompt('/mentor:task parser');
  s.prompt('/mentor:off normalny tryb na chwilę');
  s.append('parser.js', lines(12, 'written by Claude in the pause'));
  s.prompt('/mentor:on');
  assert.strictEqual(s.prompt('napisz resztę').code, 2, 'the gate stays closed after the pause');
  s.append('app.js', lines(3, 'mine'));
  assert.strictEqual(s.prompt('napisz resztę').code, 0, 'own work after the pause opens it');

  const done = s.prompt('/mentor:done');
  assert.match(done.json.systemMessage, /12 linii z pauzy/);
  assert.match(ctx(done), /12 lines in parser\.js changed while mentor mode was paused/);
  assert.match(ctx(done), /parser\.js \| \+12 -0 \(new, untracked\) \(changed during a pause/);
  assert.match(fs.readFileSync(path.join(s.data, 'LEARNING.md'), 'utf8'), /12 lines changed during a pause/);
  const review = ctx(s.prompt('/mentor:review-week'));
  assert.match(review, /hint level \(without work from pauses\): 0 none: 0/);
  assert.match(review, /closed with code written during a pause \(not counted above\): 1 \("parser" 12 lines\)/);
});

test('work before a pause still counts; commits made in the pause do not', () => {
  const s = setup();
  s.prompt('/mentor:task przed pauzą');
  s.append('app.js', lines(4, 'mine before'));
  s.prompt('/mentor:off hotfix gdzie indziej');
  s.append('claude.js', lines(10, 'pause'));
  commit(s.repo, 'committed in the pause');
  const st = s.state();
  st.pause.until = Date.now() - 1000; // the pause runs out on its own
  s.writeState(st);
  assert.strictEqual(s.prompt('napisz resztę').code, 0, 'the earlier attempt keeps the gate open');
  assert.strictEqual(s.state().task.pausedWork, 10);
  assert.ok(s.events().some((e) => e.type === 'resume' && e.auto && e.pausedWork === 10));
});

test('the subject must stand right before the verb', () => {
  const s = setup();
  for (const p of ['I give up, write the code for me', 'I am tired, just write the function.', 'If I paste the error, can you fix it',
    '* write the parser for me', 'I tried; now fix it', 'I am tired and just write the function', 'wyślij mi kod', 'send me the code',
    'przeczytaj i napisz ten parser']) {
    assert.strictEqual(s.prompt(p).code, 2, `should block: ${p}`);
  }
  for (const p of ['I will write the tests myself', 'i want to build a parser', "I'm going to refactor this module myself",
    '/* fix it later */ what does this do?', 'Am I supposed to add the missing check here?']) {
    assert.strictEqual(s.prompt(p).code, 0, `should pass: ${p}`);
  }
});

test('MCP: remote ids and URLs are not local files', () => {
  const s = setup();
  assert.strictEqual(s.tool('mcp__Google_Drive__update_file', { fileId: '1AbCdEf', content: 'x' }).stdout, '');
  assert.strictEqual(s.tool('mcp__x__save_bookmark', { uri: 'https://example.com/a' }).stdout, '');
  assert.strictEqual(s.tool('mcp__docs__create_document', { title: 'Notes', folderId: 'abc' }).stdout, '');
  assert.strictEqual(s.decision('mcp__fs__write_file', { path: 'file://' + path.join(s.repo, 'app.js') }), 'deny');
  assert.strictEqual(s.decision('mcp__fs__write_files', { paths: ['src/a.js', 'src/b.js'] }), 'deny');
  assert.strictEqual(s.decision('mcp__fs__edit_file', { path: 'app.js' }), 'deny', 'a bare file name is still a file');
});

test("a project's .claude/ is team work: free in a pause, logged; settings and the marker stay protected", () => {
  const s = setup();
  s.prompt('/mentor:off wspólne komendy zespołu');
  for (const cmd of ['mkdir -p .claude/commands', 'git add .claude/commands/review.md && git commit -m "review command"',
    'git add .mentor && git commit -m "mentor on for this repo"', 'ls .claude/agents']) {
    assert.strictEqual(s.tool('Bash', { command: cmd }).stdout, '', `should pass: ${cmd}`);
  }
  for (const cmd of ["sed -i 's/x/y/' .claude/settings.json", 'cd .claude && echo {} > settings.local.json', 'git rm .mentor',
    'rm ~/.claude/settings.json']) {
    assert.strictEqual(s.decision('Bash', { command: cmd }), 'deny', `should deny: ${cmd}`);
  }
  assert.strictEqual(s.events().filter((e) => e.type === 'persist_write').length, 2, 'mkdir and git add of .claude/commands');
});
