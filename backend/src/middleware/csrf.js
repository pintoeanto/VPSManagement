import crypto from 'node:crypto';
import { config } from '../config.js';

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Only /auth/refresh and /auth/logout authenticate via the httpOnly refresh
 * cookie (everything else uses the bearer access token, which isn't
 * cookie-based and so isn't CSRF-exposed). Those two routes require a
 * double-submit CSRF token: a value stored in a readable cookie that the
 * frontend must echo back in a header, which a cross-site form/fetch cannot do.
 */
export function issueCsrfCookie(res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  });
  return token;
}

export function requireCsrf(req, res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  next();
}

export function clearCsrfCookie(res) {
  res.clearCookie(CSRF_COOKIE, { domain: config.COOKIE_DOMAIN, path: '/' });
}
