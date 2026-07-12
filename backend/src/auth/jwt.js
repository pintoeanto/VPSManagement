import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/index.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, typ: 'access' }, config.JWT_ACCESS_SECRET, {
    expiresIn: config.ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.JWT_ACCESS_SECRET);
  if (payload.typ !== 'access') throw new Error('Not an access token');
  return payload;
}

function ttlToMs(ttl) {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
  const n = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return n * unit;
}

/**
 * Issues a brand-new refresh-token family (used at login). Returns the signed
 * JWT string; the caller sets it as an httpOnly cookie.
 */
export function issueRefreshToken(user, { ip, userAgent } = {}) {
  const jti = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  return persistAndSignRefresh(user, jti, familyId, { ip, userAgent });
}

/**
 * Rotates a refresh token: validates signature + DB state, revokes the
 * presented jti, and issues a new one in the same family. If the presented
 * jti was already revoked (i.e. someone is replaying a used token), the
 * entire family is revoked as a compromise signal.
 */
export function rotateRefreshToken(oldToken, { ip, userAgent } = {}) {
  let payload;
  try {
    payload = jwt.verify(oldToken, config.JWT_REFRESH_SECRET);
  } catch {
    throw new AuthError('Invalid refresh token');
  }
  if (payload.typ !== 'refresh') throw new AuthError('Not a refresh token');

  const row = db.prepare('SELECT * FROM refresh_tokens WHERE jti = ?').get(payload.jti);
  if (!row) throw new AuthError('Unknown refresh token');
  if (row.token_hash !== sha256(oldToken)) throw new AuthError('Refresh token mismatch');

  if (row.revoked_at) {
    // Reuse of a revoked token: treat as compromise, kill the whole family.
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(
      new Date().toISOString(),
      row.family_id
    );
    throw new AuthError('Refresh token reuse detected; session revoked');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AuthError('Refresh token expired');
  }

  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE jti = ?').run(new Date().toISOString(), payload.jti);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) throw new AuthError('User no longer exists');

  const newJti = crypto.randomUUID();
  const newToken = persistAndSignRefresh(user, newJti, row.family_id, { ip, userAgent });
  return { user, refreshToken: newToken };
}

function persistAndSignRefresh(user, jti, familyId, { ip, userAgent }) {
  const ttlMs = ttlToMs(config.REFRESH_TOKEN_TTL);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const token = jwt.sign({ sub: user.id, jti, familyId, typ: 'refresh' }, config.JWT_REFRESH_SECRET, {
    expiresIn: config.REFRESH_TOKEN_TTL,
  });
  db.prepare(
    `INSERT INTO refresh_tokens (jti, user_id, token_hash, family_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(jti, user.id, sha256(token), familyId, expiresAt, ip ?? null, userAgent ?? null);
  return token;
}

export function revokeRefreshToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_REFRESH_SECRET, { ignoreExpiration: true });
  } catch {
    return;
  }
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    payload.jti
  );
}

export function revokeAllSessionsForUser(userId) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    userId
  );
}

export class AuthError extends Error {}
