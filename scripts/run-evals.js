'use strict';
// Runs `claude plugin eval` on the mentor plugin. Arguments are passed through.
//
//   node scripts/run-evals.js [eval options]            the plugin as it is, against no plugin
//   node scripts/run-evals.js --variant style [opts]    output style and skills only, no hooks
//   node scripts/run-evals.js --variant style+edits     the same plus only the Edit/Write block
//   node scripts/run-evals.js --compare                 the last results side by side
//
// The variants answer what actually produces the behaviour: if the style alone scores nearly as
// well as the full plugin, the rest of the enforcement is not needed for the model's behaviour.
//
// The eval cases set up their repo with a Bash scaffold script. On Windows `bash` on PATH is
// often C:\Windows\System32\bash.exe, the WSL launcher, which fails when no Linux distribution
// is installed. Git for Windows ships a real bash, so its directory goes first on PATH.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'mentor');
const results = path.join(plugin, 'evals', 'results');
const VARIANTS = {
  style: null, // no hooks at all
  'style+edits': {
    description: 'Ablation: only the edit block',
    hooks: {
      PreToolUse: [{
        matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$',
        hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool.js'], timeout: 10 }],
      }],
    },
  },
};

function gitBashDir() {
  const candidates = [];
  try {
    // .../Git/mingw64/libexec/git-core → .../Git
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    candidates.push(path.resolve(exec, '..', '..', '..'));
  } catch {
    // git not on PATH
  }
  candidates.push('C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git');
  for (const dir of candidates.map((c) => path.join(c, 'bin'))) {
    if (fs.existsSync(path.join(dir, 'bash.exe'))) return dir;
  }
  return null;
}

// A copy of the plugin with fewer hooks, under .ablation/ (git-ignored).
function buildVariant(name) {
  const dst = path.join(root, '.ablation', name, 'mentor');
  fs.rmSync(path.join(root, '.ablation', name), { recursive: true, force: true });
  fs.cpSync(plugin, dst, { recursive: true, filter: (p) => !p.startsWith(results) });
  const hooksFile = path.join(dst, 'hooks', 'hooks.json');
  if (VARIANTS[name] === null) fs.rmSync(hooksFile, { force: true });
  else fs.writeFileSync(hooksFile, JSON.stringify(VARIANTS[name], null, 2));
  return dst;
}

function compare() {
  const files = { full: 'last.json', ...Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, `variant-${v}.json`])) };
  const loaded = {};
  for (const [k, f] of Object.entries(files)) {
    try {
      loaded[k] = JSON.parse(fs.readFileSync(path.join(results, f), 'utf8'));
    } catch {
      // not run yet
    }
  }
  const names = [...new Set(Object.values(loaded).flatMap((r) => r.cases.map((c) => c.name)))].sort();
  const cols = Object.keys(loaded);
  const score = (r, n) => {
    const c = r.cases.find((x) => x.name === n);
    return c ? c.aggregates.score.toFixed(2) : '  - ';
  };
  console.log(['case'.padEnd(30), ...cols.map((c) => c.padStart(12))].join(''));
  for (const n of names) console.log([n.padEnd(30), ...cols.map((c) => score(loaded[c], n).padStart(12))].join(''));
  console.log(['suite'.padEnd(30), ...cols.map((c) => loaded[c].aggregates.overallScore.toFixed(2).padStart(12))].join(''));
  if (loaded.full && loaded.full.aggregates.meanDelta !== undefined) {
    console.log(`\nno plugin at all (baseline arm of the full run): ${(loaded.full.aggregates.overallScore - loaded.full.aggregates.meanDelta).toFixed(2)}`);
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--compare')) {
  compare();
  process.exit(0);
}

const env = { ...process.env };
if (process.platform === 'win32') {
  const dir = gitBashDir();
  if (!dir) {
    console.error('run-evals: Git Bash not found; the scaffold scripts need a real bash (install Git for Windows).');
    process.exit(1);
  }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  env[key] = dir + path.delimiter + env[key];
}

function run(target, extra) {
  const args = ['plugin', 'eval', target, '--trust-plugin', '--scaffold', '--no-publish', ...extra, ...argv];
  const r = spawnSync('claude', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  return r.status === null ? 1 : r.status;
}

const runVariant = (name) => {
  fs.mkdirSync(results, { recursive: true });
  return run(buildVariant(name), ['--ablation', 'none', '--json', path.join(results, `variant-${name}.json`)]);
};

const vi = argv.indexOf('--variant');
if (vi < 0) process.exit(run(plugin, []));
const name = argv[vi + 1];
argv.splice(vi, 2);
if (name === 'all') {
  // A variant failing cases is the expected outcome here, not an error: run all, then compare.
  for (const v of Object.keys(VARIANTS)) runVariant(v);
  compare();
  process.exit(0);
}
if (!(name in VARIANTS)) {
  console.error(`run-evals: unknown variant "${name}"; known: ${Object.keys(VARIANTS).join(', ')}, all`);
  process.exit(1);
}
process.exit(runVariant(name));
