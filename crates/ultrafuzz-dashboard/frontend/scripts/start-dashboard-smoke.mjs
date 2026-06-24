import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const port = process.argv[2] ?? process.env.ULTRAFUZZ_DASHBOARD_SMOKE_PORT ?? '4875';
const projectRoot = mkdtempSync(path.join(tmpdir(), 'ultrafuzz-dashboard-smoke-'));

function repoRelativeEnvPath(name, fallback) {
  const value = process.env[name] ?? fallback;
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

const cargoEnv = {
  ...process.env,
  CARGO_HOME: repoRelativeEnvPath('CARGO_HOME', '.cargo-home'),
  CARGO_TARGET_DIR: repoRelativeEnvPath('CARGO_TARGET_DIR', '.cargo-target')
};
const cargoArgs = ['run', '--manifest-path', path.join(repoRoot, 'Cargo.toml'), '-p', 'ultrafuzz-cli', '--'];

const init = spawnSync('cargo', [...cargoArgs, 'init'], {
  cwd: projectRoot,
  env: cargoEnv,
  stdio: 'inherit'
});

if (init.error) {
  removeProjectRoot();
  throw init.error;
}

if (init.status !== 0) {
  removeProjectRoot();
  process.exit(init.status ?? 1);
}

const child = spawn('cargo', [...cargoArgs, 'dashboard', '--host', '127.0.0.1', '--port', port], {
  cwd: projectRoot,
  env: cargoEnv,
  stdio: 'inherit'
});

function removeProjectRoot() {
  rmSync(projectRoot, { force: true, recursive: true });
}

function stop(signal) {
  child.kill(signal);
  removeProjectRoot();
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

child.on('exit', (code, signal) => {
  removeProjectRoot();
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
