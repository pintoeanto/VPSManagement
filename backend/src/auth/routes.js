import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { verifyPassword, hashPassword } from './passwords.js';
import {
  generateTotpSecret,
  buildOtpauthUri,
  totpQrDataUrl,
  verifyTotpToken,
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
} from './totp.js';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessionsForUser,
} from './jwt.js';
import { loginLimiter, totpLimiter, refreshLimiter } from './rateLimit.js';
import { isLockedOut, lockoutRemainingMs, recordFailure, recordSuccess } from './lockout.js';
import { issueCsrfCookie, requireCsrf, clearCsrfCookie } from '../middleware/csrf.js';
import { requireAuth } from './middleware.js';
import { config } from '../config.js';

export const authRouter = Router();

const PENDING_TTL_MS = 5 * 60_000;

// Constant-shape dummy hash so login timing doesn't reveal whether a username exists.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    // Host-only cookie (no explicit domain) — see middleware/csrf.js for why.
    path: '/api/auth',
  };
}

function createPendingLogin(userId) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  db.prepare('INSERT INTO pending_logins (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
  return id;
}

function consumePendingLogin(pendingId) {
  const row = db.prepare('SELECT * FROM pending_logins WHERE id = ?').get(pendingId);
  if (!row) return null;
  db.prepare('DELETE FROM pending_logins WHERE id = ?').run(pendingId);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function issueSessionForUser(req, res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = issueRefreshToken(user, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.cookie('refresh_token', refreshToken, refreshCookieOptions());
  issueCsrfCookie(res);
  return accessToken;
}

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { username, password } = parsed.data;

  if (isLockedOut(username)) {
    return res.status(429).json({
      error: 'Account temporarily locked due to repeated failed attempts',
      retryAfterMs: lockoutRemainingMs(username),
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = await verifyPassword(user ? user.password_hash : DUMMY_HASH, password);

  if (!user || !ok) {
    recordFailure(username);
    recordAudit({ username, actionId: 'auth.login', phase: 'apply', success: false, result: { reason: 'bad_credentials' } });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  recordSuccess(username);
  const pendingId = createPendingLogin(user.id);

  if (!user.totp_enabled) {
    recordAudit({ userId: user.id, username, actionId: 'auth.login', phase: 'apply', success: true, result: { status: 'totp_setup_required' } });
    return res.json({ status: 'totp_setup_required', pendingId });
  }

  recordAudit({ userId: user.id, username, actionId: 'auth.login', phase: 'apply', success: true, result: { status: 'totp_required' } });
  return res.json({ status: 'totp_required', pendingId });
});

authRouter.post('/totp/setup/init', totpLimiter, (req, res) => {
  const parsed = z.object({ pendingId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  const pending = db.prepare('SELECT * FROM pending_logins WHERE id = ?').get(parsed.data.pendingId);
  if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Login session expired, please log in again' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
  if (!user || user.totp_enabled) {
    return res.status(400).json({ error: 'TOTP already enrolled for this account' });
  }

  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(encryptSecret(secret), user.id);

  const otpauthUri = buildOtpauthUri(secret, user.username);
  totpQrDataUrl(otpauthUri).then((qr) => {
    res.json({ otpauthUri, qrDataUrl: qr });
  }).catch(() => res.status(500).json({ error: 'Failed to generate QR code' }));
});

const totpConfirmSchema = z.object({
  pendingId: z.string().uuid(),
  token: z.string().regex(/^\d{6}$/),
});

authRouter.post('/totp/setup/confirm', totpLimiter, async (req, res) => {
  const parsed = totpConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { token } = parsed.data;

  const pending = consumePendingLogin(parsed.data.pendingId);
  if (!pending) return res.status(401).json({ error: 'Login session expired, please log in again' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
  if (!user || !user.totp_secret_enc || user.totp_enabled) {
    return res.status(400).json({ error: 'No pending TOTP enrollment for this account' });
  }

  const secret = decryptSecret(user.totp_secret_enc);
  if (!verifyTotpToken(secret, token)) {
    recordAudit({ userId: user.id, username: user.username, actionId: 'auth.totp_setup', phase: 'apply', success: false });
    return res.status(401).json({ error: 'Invalid code' });
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);

  const codes = generateBackupCodes();
  const insertCode = db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)');
  for (const code of codes) {
    insertCode.run(user.id, await hashBackupCode(code));
  }

  recordAudit({ userId: user.id, username: user.username, actionId: 'auth.totp_setup', phase: 'apply', success: true });

  const accessToken = issueSessionForUser(req, res, user);
  return res.json({ accessToken, backupCodes: codes, user: { id: user.id, username: user.username } });
});

const totpVerifySchema = z.object({
  pendingId: z.string().uuid(),
  token: z.string().min(6).max(11), // 6-digit TOTP or XXXXX-XXXXX backup code
});

authRouter.post('/totp/verify', totpLimiter, async (req, res) => {
  const parsed = totpVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { token } = parsed.data;

  const pending = consumePendingLogin(parsed.data.pendingId);
  if (!pending) return res.status(401).json({ error: 'Login session expired, please log in again' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
  if (!user || !user.totp_enabled) {
    return res.status(400).json({ error: 'TOTP not enrolled for this account' });
  }

  if (isLockedOut(user.username)) {
    return res.status(429).json({ error: 'Account temporarily locked', retryAfterMs: lockoutRemainingMs(user.username) });
  }

  let ok = false;
  if (/^\d{6}$/.test(token)) {
    const secret = decryptSecret(user.totp_secret_enc);
    ok = verifyTotpToken(secret, token);
  } else {
    const codes = db.prepare('SELECT * FROM backup_codes WHERE user_id = ? AND used_at IS NULL').all(user.id);
    for (const row of codes) {
      if (await verifyBackupCode(row.code_hash, token)) {
        db.prepare('UPDATE backup_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
        ok = true;
        break;
      }
    }
  }

  if (!ok) {
    recordFailure(user.username);
    recordAudit({ userId: user.id, username: user.username, actionId: 'auth.totp_verify', phase: 'apply', success: false });
    return res.status(401).json({ error: 'Invalid code' });
  }

  recordSuccess(user.username);
  recordAudit({ userId: user.id, username: user.username, actionId: 'auth.totp_verify', phase: 'apply', success: true });
  const accessToken = issueSessionForUser(req, res, user);
  return res.json({ accessToken, user: { id: user.id, username: user.username } });
});

authRouter.post('/refresh', refreshLimiter, requireCsrf, (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: 'No refresh token' });
  try {
    const { user, refreshToken } = rotateRefreshToken(token, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.cookie('refresh_token', refreshToken, refreshCookieOptions());
    issueCsrfCookie(res);
    const accessToken = signAccessToken(user);
    return res.json({ accessToken, user: { id: user.id, username: user.username } });
  } catch {
    res.clearCookie('refresh_token', refreshCookieOptions());
    clearCsrfCookie(res);
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
});

authRouter.post('/logout', requireCsrf, (req, res) => {
  const token = req.cookies?.refresh_token;
  if (token) revokeRefreshToken(token);
  res.clearCookie('refresh_token', refreshCookieOptions());
  clearCsrfCookie(res);
  return res.json({ ok: true });
});

authRouter.post('/logout-all', requireAuth, (req, res) => {
  revokeAllSessionsForUser(req.user.id);
  recordAudit({ userId: req.user.id, username: req.user.username, actionId: 'auth.logout_all', phase: 'apply', success: true });
  return res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
