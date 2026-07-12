import { execFile } from 'node:child_process';
import { resolveHelperPath } from './helperScripts.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB — bounded output for journalctl tails etc.

/**
 * Runs a whitelisted root-owned helper script via `sudo -n`. Args are always
 * passed as an array to execFile — never through a shell — so there is no
 * string-interpolation injection surface. Non-zero exit is returned, not
 * thrown, so callers can report structured failure without a try/catch dance;
 * spawn-level failures (missing sudo, timeout) do throw.
 */
export function runHelperScript(helperKey, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS, input } = {}) {
  const scriptPath = resolveHelperPath(helperKey);
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new TypeError(`Helper script args must be strings, got ${typeof a}`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      'sudo',
      ['-n', scriptPath, ...args],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: minimalEnv() },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          return reject(new Error(`Helper script ${helperKey} timed out after ${timeoutMs}ms`));
        }
        if (err && typeof err.code !== 'number') {
          // spawn-level failure (e.g. sudo not found, permission config missing)
          return reject(err);
        }
        resolve({
          exitCode: err ? err.code : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          success: !err,
        });
      }
    );
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Runs a small set of harmless, read-only local commands as the app user
 * (no sudo) for state detection — e.g. `command -v nginx`, `node -v`.
 * Restricted to an explicit binary allowlist; args are always an array.
 */
const READONLY_BINARY_ALLOWLIST = new Set([
  'command',
  'node',
  'nginx',
  'wg',
  'mosquitto',
  'systemctl',
  'dpkg-query',
  'df',
  'free',
  'uptime',
  'nproc',
  'apt-cache',
  'apt',
]);

export function execReadOnly(bin, args = [], { timeoutMs = 10_000 } = {}) {
  if (!READONLY_BINARY_ALLOWLIST.has(bin)) {
    throw new Error(`Binary not in read-only allowlist: ${bin}`);
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new TypeError('execReadOnly args must be strings');
    }
  }
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: minimalEnv() }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        success: !err,
      });
    });
  });
}

function minimalEnv() {
  return { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };
}
