'use strict';
// Runs `claude plugin eval` on the mentor plugin. Arguments are passed through.
//
// The eval cases set up their repo with a Bash scaffold script. On Windows `bash` on PATH is
// often C:\Windows\System32\bash.exe, the WSL launcher, which fails when no Linux distribution
// is installed. Git for Windows ships a real bash, so its directory goes first on PATH.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

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
  for (const root of candidates) {
    const dir = path.join(root, 'bin');
    if (fs.existsSync(path.join(dir, 'bash.exe'))) return dir;
  }
  return null;
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

const root = path.join(__dirname, '..');
const args = ['plugin', 'eval', path.join(root, 'plugins', 'mentor'), '--trust-plugin', '--scaffold', '--no-publish',
  ...process.argv.slice(2)];
const r = spawnSync('claude', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status === null ? 1 : r.status);
