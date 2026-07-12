import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(config.jailRoot, { recursive: true });
const JAIL_ROOT_REAL = fs.realpathSync(config.jailRoot);

export class JailViolationError extends Error {}

/**
 * Resolves a user-supplied relative path to an absolute path guaranteed to
 * be inside the jail root, WITHOUT requiring the target to already exist.
 * Neutralizes both ".." traversal and absolute-path override by prefixing
 * with "./" before resolving so a leading "/" or drive letter can't escape
 * the jail root.
 */
export function resolveJailPath(userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new JailViolationError('Path is required');
  }
  if (userPath.includes('\0')) {
    throw new JailViolationError('Invalid path');
  }
  const candidate = path.resolve(JAIL_ROOT_REAL, '.' + path.sep + userPath);
  if (candidate !== JAIL_ROOT_REAL && !candidate.startsWith(JAIL_ROOT_REAL + path.sep)) {
    throw new JailViolationError('Path escapes the file jail');
  }
  return candidate;
}

/**
 * Same as resolveJailPath, but for an existing file/dir: also resolves
 * symlinks (realpath) and re-verifies the final target is still inside the
 * jail root, so a symlink planted inside the jail can't point outside it.
 */
export function resolveExistingJailPath(userPath) {
  const candidate = resolveJailPath(userPath);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new JailViolationError('Path does not exist');
  }
  if (real !== JAIL_ROOT_REAL && !real.startsWith(JAIL_ROOT_REAL + path.sep)) {
    throw new JailViolationError('Path escapes the file jail (symlink)');
  }
  return real;
}

export function jailRoot() {
  return JAIL_ROOT_REAL;
}
