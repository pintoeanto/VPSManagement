import crypto from 'node:crypto';
import { db } from '../db/index.js';

const GENESIS_HASH = '0'.repeat(64);

function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function getLastHash() {
  const row = db.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return row ? row.entry_hash : GENESIS_HASH;
}

/**
 * Appends a tamper-evident audit entry. Every privileged action and every
 * auth security event goes through here, success or failure.
 */
export function recordAudit({
  userId = null,
  username = null,
  actionId,
  phase,
  params = null,
  detect = null,
  result = null,
  success,
  backupPath = null,
}) {
  const prevHash = getLastHash();
  const ts = new Date().toISOString();
  const paramsJson = params === null ? null : JSON.stringify(params);
  const detectJson = detect === null ? null : JSON.stringify(detect);
  const resultJson = result === null ? null : JSON.stringify(result);

  const entryForHash = {
    ts,
    userId,
    username,
    actionId,
    phase,
    paramsJson,
    detectJson,
    resultJson,
    success: success ? 1 : 0,
    backupPath,
    prevHash,
  };
  const entryHash = crypto.createHash('sha256').update(canonicalize(entryForHash)).digest('hex');

  db.prepare(
    `INSERT INTO audit_log
      (ts, user_id, username, action_id, phase, params_json, detect_json, result_json, success, backup_path, prev_hash, entry_hash)
     VALUES (@ts, @userId, @username, @actionId, @phase, @paramsJson, @detectJson, @resultJson, @success, @backupPath, @prevHash, @entryHash)`
  ).run({
    ts,
    userId,
    username,
    actionId,
    phase,
    paramsJson,
    detectJson,
    resultJson,
    success: success ? 1 : 0,
    backupPath,
    prevHash,
    entryHash,
  });

  return entryHash;
}

export function listRecentAudit(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(n)
    .map((row) => ({
      ...row,
      params: row.params_json ? JSON.parse(row.params_json) : null,
      detect: row.detect_json ? JSON.parse(row.detect_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      success: !!row.success,
    }));
}

/**
 * Recomputes the hash chain from scratch and verifies it matches stored
 * entry_hash values. Returns { valid, brokenAtId } for UI tamper-evidence display.
 */
export function verifyAuditChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const entryForHash = {
      ts: row.ts,
      userId: row.user_id,
      username: row.username,
      actionId: row.action_id,
      phase: row.phase,
      paramsJson: row.params_json,
      detectJson: row.detect_json,
      resultJson: row.result_json,
      success: row.success,
      backupPath: row.backup_path,
      prevHash,
    };
    const expected = crypto.createHash('sha256').update(canonicalize(entryForHash)).digest('hex');
    if (expected !== row.entry_hash || row.prev_hash !== prevHash) {
      return { valid: false, brokenAtId: row.id };
    }
    prevHash = row.entry_hash;
  }
  return { valid: true, brokenAtId: null };
}
